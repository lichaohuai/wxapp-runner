/** Shared, explicit scope for opt-in intrinsic hardening control. */
export const analysisIntrinsicNames = [
  "Object",
  "Function",
  "String",
  "Number",
  "Boolean",
  "Array",
  "RegExp",
  "Date",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "DataView",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Math",
  "JSON",
  "Reflect",
];

/** Before WASubContext initializes: reserve only the slots that the later boot
 * analyzer needs. No business taps or user script execute in this phase.
 * The plugin-enabled baselib converts these data properties into irreversible
 * no-op-setter accessors. Do not invoke unknown getters to undo that afterwards.
 */
export function reserveAnalysisIntrinsics(names: string[]) {
  const g: any = globalThis,
    D = Object.defineProperty,
    G = Object.getOwnPropertyDescriptor,
    A = Reflect.apply,
    ownKeys = Reflect.ownKeys,
    protectedObjects = new WeakSet<object>(),
    labels = new WeakMap<object, string>();
  const globalSlots = new Set([
    ...names,
    "encodeURI",
    "encodeURIComponent",
    "decodeURI",
    "decodeURIComponent",
    "escape",
    "unescape",
    "parseInt",
    "parseFloat",
    "isFinite",
    "isNaN",
    "getApp",
    "getCurrentPages",
    "define",
    "require",
    "definePlugin",
    "requirePlugin",
  ]);
  for (const name of names) {
    const obj = g[name];
    if (obj && (typeof obj === "object" || typeof obj === "function")) {
      protectedObjects.add(obj);
      labels.set(obj, name);
      if (obj.prototype) {
        protectedObjects.add(obj.prototype);
        labels.set(obj.prototype, name + ".prototype");
      }
    }
  }
  let active = true,
    skippedAccessors = 0,
    relaxedDescriptors = 0;
  const patches: any[] = [],
    slots: any[] = [];
  const selected = (obj: any, key: any) =>
    protectedObjects.has(obj) ||
    (obj === g && typeof key === "string" && globalSlots.has(key));
  function descriptor(obj: any, key: any, value: any) {
    if (!active || !selected(obj, key)) return value;
    const previous = G(obj, key);
    if (!previous?.configurable || !("value" in previous)) return value;
    if (
      typeof value?.get === "function" &&
      typeof value?.set === "function" &&
      value.configurable === false
    ) {
      skippedAccessors++;
      if (slots.length < 256)
        slots.push({
          property: String(key),
          owner: obj === g ? "globalThis" : labels.get(obj),
        });
      // Preserve the actual current data value, including any earlier baselib
      // replacement. The newly supplied hardening getter is never evaluated.
      return { ...previous, writable: true };
    }
    if (value?.configurable === false || value?.writable === false) {
      relaxedDescriptors++;
      return {
        ...value,
        configurable: true,
        ...(!("get" in value) && !("set" in value) ? { writable: true } : {}),
      };
    }
    return value;
  }
  function patch(obj: any, key: string, wrap: (fn: any) => any) {
    const before = G(obj, key);
    if (!before || !("value" in before) || !before.configurable)
      throw Error("BOOT_RESERVATION_TOO_LATE: " + key);
    const wrapper = wrap(before.value);
    D(obj, key, { ...before, value: wrapper });
    patches.push({ obj, key, before, wrapper });
  }
  function finish() {
    active = false;
    for (const p of patches.slice().reverse())
      if (G(p.obj, p.key)?.value === p.wrapper) D(p.obj, p.key, p.before);
    return {
      phase: "before-baselib",
      scope: "allowlisted intrinsic slots",
      skippedAccessors,
      slotsTruncated: skippedAccessors > slots.length,
      relaxedDescriptors,
      slots,
      reversible: false,
      fullRestore: "recreate-analysis-realm",
    };
  }
  try {
    for (const name of ["freeze", "seal", "preventExtensions"])
      patch(
        Object,
        name,
        (fn) =>
          function (obj: any) {
            return active && protectedObjects.has(obj)
              ? obj
              : A(fn, Object, [obj]);
          },
      );
    patch(
      Object,
      "defineProperty",
      (fn) =>
        function (obj: any, key: any, d: any) {
          return A(fn, Object, [obj, key, descriptor(obj, key, d)]);
        },
    );
    patch(
      Reflect,
      "defineProperty",
      (fn) =>
        function (obj: any, key: any, d: any) {
          return A(fn, Reflect, [obj, key, descriptor(obj, key, d)]);
        },
    );
    patch(
      Object,
      "defineProperties",
      (fn) =>
        function (obj: any, ds: any) {
          if (!active || !protectedObjects.has(obj))
            return A(fn, Object, [obj, ds]);
          const changed: any = {};
          for (const k of ownKeys(ds))
            if (G(ds, k)?.enumerable)
              D(changed, k, {
                value: descriptor(obj, k, ds[k]),
                enumerable: true,
              });
          return A(fn, Object, [obj, changed]);
        },
    );
    patch(
      Reflect,
      "preventExtensions",
      (fn) =>
        function (obj: any) {
          return active && protectedObjects.has(obj)
            ? true
            : A(fn, Reflect, [obj]);
        },
    );
    return { finish };
  } catch (error) {
    finish();
    throw error;
  }
}
