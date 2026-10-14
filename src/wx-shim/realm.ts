import vm from "node:vm";

/** Host API payloads must belong to the business realm, just like native JSON callbacks.
 * In particular, WXML processing uses realm-local Array/Object checks. Passing Node
 * arrays directly can update page.data while leaving the original view empty.
 */
export function bridgeWxToRealm(context: vm.Context, hostWx: any) {
  // tsx's development transform may add its function-name helper. Keep that
  // helper local to the factory; never install host globals into the VM.
  return vm.runInContext(
    `((__name) => (${realmBridge.toString()}))((fn) => fn)`,
    context,
  )(hostWx);
}

function realmBridge(hostWx: any) {
  const callbacks = new WeakMap<Function, Function>();
  const apiFunctions = new WeakMap<Function, Function>();
  const originalObjects = new WeakMap<object, object>();
  function toHost(value: any, seen = new WeakMap<object, any>()): any {
    if (typeof value === "function") {
      let callback = callbacks.get(value);
      if (!callback) {
        callback = function (this: any, ...args: any[]) {
          return value.apply(
            toGuest(this),
            args.map((arg) => toGuest(arg)),
          );
        };
        callbacks.set(value, callback);
      }
      return callback;
    }
    if (!value || typeof value !== "object") return value;
    // RequestTask/manager objects carry host state and are not copied back as data.
    if (originalObjects.has(value)) return originalObjects.get(value);
    const tag = Object.prototype.toString.call(value);
    if (tag !== "[object Object]" && tag !== "[object Array]") return value;
    if (seen.has(value)) return seen.get(value);
    const out: any = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    for (const key of Object.keys(value))
      Object.defineProperty(out, key, {
        value: toHost(value[key], seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  function toGuest(
    value: any,
    seen = new WeakMap<object, any>(),
    owner?: any,
  ): any {
    if (typeof value === "function") {
      // Base-library functions already belong to this realm and keep their identity.
      if (value instanceof Function) return value;
      let fn = apiFunctions.get(value);
      if (!fn) {
        fn = function (this: any, ...args: any[]) {
          try {
            return toGuest(
              value.apply(
                owner ?? originalObjects.get(this) ?? this,
                args.map((arg) => toHost(arg)),
              ),
            );
          } catch (error) {
            throw toGuest(error);
          }
        };
        apiFunctions.set(value, fn);
      }
      return fn;
    }
    if (!value || typeof value !== "object" || value instanceof Object)
      return value;
    if (seen.has(value)) return seen.get(value);
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object WxappUnsupportedAPI]") {
      const api = new Proxy(
        {},
        { get: (_, key) => toGuest(value[key], new WeakMap(), value) },
      );
      originalObjects.set(api, value);
      return api;
    }
    if (tag === "[object Promise]")
      return Promise.resolve(value).then(
        (v) => toGuest(v),
        (e) => {
          throw toGuest(e);
        },
      );
    if (tag === "[object ArrayBuffer]") {
      const out = new ArrayBuffer(value.byteLength);
      new Uint8Array(out).set(new Uint8Array(value));
      return out;
    }
    if (ArrayBuffer.isView(value)) {
      const buffer = toGuest(value.buffer, seen);
      const name = tag.slice(8, -1);
      const Type = (globalThis as any)[name];
      return name === "DataView"
        ? new DataView(buffer, value.byteOffset, value.byteLength)
        : new Type(buffer, value.byteOffset, (value as any).length);
    }
    if (tag === "[object Date]") return new Date(value.getTime());
    const out: any = Array.isArray(value)
      ? []
      : tag.endsWith("Error]")
        ? new Error(value.message)
        : {};
    seen.set(value, out);
    if (tag.endsWith("Error]")) {
      out.name = value.name;
      out.stack = value.stack;
    }
    // Only API objects containing functions need a stable host receiver. Ordinary
    // response data is copied on every crossing, with no stale snapshot cache.
    if (Object.values(value).some((v) => typeof v === "function"))
      originalObjects.set(out, value);
    for (const key of Object.keys(value))
      Object.defineProperty(out, key, {
        value: toGuest(value[key], seen, value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  const deleted = new Set<PropertyKey>();
  return new Proxy(
    {},
    {
      get: (target, key, receiver) =>
        Object.hasOwn(target, key)
          ? Reflect.get(target, key, receiver)
          : deleted.has(key)
            ? undefined
            : toGuest(hostWx[key], new WeakMap(), hostWx),
      has: (target, key) =>
        key in target || (!deleted.has(key) && key in hostWx),
      ownKeys: (target) => [
        ...new Set([
          ...Reflect.ownKeys(target),
          ...(Reflect.isExtensible(target)
            ? Reflect.ownKeys(hostWx).filter((key) => !deleted.has(key))
            : []),
        ]),
      ],
      getOwnPropertyDescriptor: (target, key) =>
        Reflect.getOwnPropertyDescriptor(target, key) ||
        (!deleted.has(key) && Reflect.isExtensible(target) && key in hostWx
          ? {
              configurable: true,
              enumerable: true,
              writable: true,
              value: toGuest(hostWx[key], new WeakMap(), hostWx),
            }
          : undefined),
      // Business mutations belong to the guest object. Forwarding only `set`
      // to the host while defineProperty targeted an empty object violated
      // Proxy invariants as soon as an app hardened or froze a wx property.
      set: (target, key, value, receiver) =>
        Reflect.set(target, key, value, receiver),
      defineProperty(target, key, descriptor) {
        if (
          !Object.hasOwn(target, key) &&
          !deleted.has(key) &&
          Reflect.isExtensible(target) &&
          key in hostWx
        ) {
          const previous: PropertyDescriptor = {
            value: toGuest(hostWx[key], new WeakMap(), hostWx),
            configurable: true,
            enumerable: true,
            writable: true,
          };
          if ("get" in descriptor || "set" in descriptor) {
            delete previous.value;
            delete previous.writable;
          }
          return Reflect.defineProperty(target, key, {
            ...previous,
            ...descriptor,
          });
        }
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty(target, key) {
        const removed = Reflect.deleteProperty(target, key);
        if (removed) deleted.add(key);
        return removed;
      },
      preventExtensions(target) {
        for (const key of Reflect.ownKeys(hostWx))
          if (!deleted.has(key) && !Object.hasOwn(target, key))
            Object.defineProperty(target, key, {
              value: toGuest(hostWx[key], new WeakMap(), hostWx),
              configurable: true,
              enumerable: true,
              writable: true,
            });
        return Reflect.preventExtensions(target);
      },
    },
  );
}
