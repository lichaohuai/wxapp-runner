/** Serialized into the selected VM. No imports and no global prototype changes. */
export function hookRuntime() {
  const g: any = globalThis,
    key = "__wxappControlledHooksV1";
  if (g[key]) return g[key];
  const define = Object.defineProperty,
    descriptor = Object.getOwnPropertyDescriptor,
    ownKeys = Reflect.ownKeys,
    apply = Reflect.apply,
    construct = Reflect.construct;
  const getProto = Object.getPrototypeOf,
    now = Date.now.bind(Date),
    timer = setTimeout,
    cancel = clearTimeout;
  const map = new Map<string, any>();
  let sequence = 0;
  const fail = (code: string, message: string) => {
    throw Object.assign(new Error(message), { code });
  };
  const property = (obj: any, k: string) => {
    for (let x = obj; x != null; x = getProto(x)) {
      const d = descriptor(x, k);
      if (d) {
        if (!("value" in d))
          fail(
            "ACCESSOR_TARGET",
            "Accessors are not evaluated by hook inspection",
          );
        return d.value;
      }
    }
  };
  const resolve = (p: any) => {
    const observedOwner =
      p.root === "module"
        ? g.__wxappBootAnalysisV1?.moduleOwner(p.module)
        : undefined;
    if (p.root === "module" && !p.keys.length && observedOwner) {
      const fn = property(observedOwner, "exports");
      if (typeof fn !== "function")
        fail("TARGET_NOT_FUNCTION", "Default export is not a function");
      return { obj: observedOwner, name: "exports", fn };
    }
    let obj: any =
      p.root === "app"
        ? g.getApp()
        : p.root === "module"
          ? observedOwner
            ? property(observedOwner, "exports")
            : g.require(p.module)
          : g;
    if (!p.keys.length)
      fail(
        "FUNCTION_PROPERTY_REQUIRED",
        "Default function exports require a writable owner property",
      );
    for (const k of p.keys.slice(0, -1)) {
      obj = property(obj, k);
      if (obj == null) fail("TARGET_NOT_FOUND", "Function owner is missing");
    }
    const name = p.keys[p.keys.length - 1],
      fn = property(obj, name);
    if (typeof fn !== "function")
      fail("TARGET_NOT_FUNCTION", "Target is not a function");
    return { obj, name, fn };
  };
  const copy = (value: any) => {
    let budget = 6000;
    const seen = new WeakSet<object>();
    const walk = (v: any, depth: number): any => {
      if (budget <= 0) return "[truncated]";
      if (v === null || ["boolean", "number", "undefined"].includes(typeof v))
        return v;
      if (typeof v === "string") {
        const s = v.slice(0, Math.min(budget, 2048));
        budget -= s.length;
        return s + (s.length < v.length ? "…[truncated]" : "");
      }
      if (typeof v === "bigint") return String(v) + "n";
      if (typeof v === "symbol") return String(v);
      if (typeof v === "function") return "[function]";
      if (seen.has(v)) return "[circular]";
      if (depth >= 4) return "[depth limit]";
      seen.add(v);
      const out: any = Array.isArray(v) ? [] : {};
      let count = 0;
      for (const k of ownKeys(v)) {
        if (typeof k !== "string") continue;
        if (count++ >= 40 || budget <= 0) {
          out.__truncated = true;
          break;
        }
        budget -= k.length;
        const d = descriptor(v, k);
        if (d?.enumerable)
          define(out, k, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: d && "value" in d ? walk(d.value, depth + 1) : "[accessor]",
          });
      }
      return out;
    };
    try {
      return walk(value, 0);
    } catch {
      return "[uninspectable]";
    }
  };
  const condition = (n: any, args: any[], thisArg: any): any => {
    if (!n) return true;
    if (n.type === "literal") return n.value;
    if (n.type === "root") return n.name === "args" ? args : thisArg;
    if (n.type === "member")
      return property(condition(n.object, args, thisArg), n.key);
    if (n.type === "unary") {
      const v = condition(n.arg, args, thisArg);
      if (n.op === "!") return !v;
      if (n.op === "typeof") return typeof v;
      if (v !== null && typeof v === "object")
        fail("CONDITION_TYPE", "Object coercion is not allowed");
      return n.op === "-" ? -v : +v;
    }
    const a = condition(n.left, args, thisArg);
    if (n.op === "&&") return a && condition(n.right, args, thisArg);
    if (n.op === "||") return a || condition(n.right, args, thisArg);
    const b = condition(n.right, args, thisArg);
    if (n.op === "===") return a === b;
    if (n.op === "!==") return a !== b;
    if (
      [a, b].some(
        (x) => x !== null && ["object", "function"].includes(typeof x),
      )
    )
      fail("CONDITION_TYPE", "Object coercion is not allowed");
    switch (n.op) {
      case "==":
        return a == b;
      case "!=":
        return a != b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        return a / b;
      case "%":
        return a % b;
    }
  };
  const info = (h: any) => ({
    hookId: h.id,
    status: h.status,
    reason: h.reason,
    count: h.count,
    captured: h.entries.length,
    latestCursor: h.entries.at(-1)?.id || 0,
    expiresAt: h.expiresAt,
    target: h.label,
    conditionErrors: h.conditionErrors,
    restore: h.restore,
  });
  const remove = (h: any, reason: string) => {
    if (h.status !== "active") return info(h);
    cancel(h.timer);
    const coordinated = g.__wxappBootAnalysisV1?.releaseFunctionPatch?.(
      h.wrapper,
      h.obj,
      h.name,
    );
    if (coordinated) {
      h.reason = reason;
      return info(h);
    }
    try {
      const d = descriptor(h.obj, h.name);
      if (d?.value !== h.wrapper) {
        h.restore = "conflict";
        h.status = "detached";
        h.reason = "Target changed externally; newer value preserved";
        return info(h);
      }
      if (h.original) define(h.obj, h.name, h.original);
      else delete h.obj[h.name];
      h.restore = "restored";
    } catch {
      h.restore = "failed";
    }
    h.status = h.restore === "restored" ? "removed" : "restore-failed";
    h.reason = reason;
    return info(h);
  };
  const api = {
    coordinate(coordinator: any) {
      for (const h of map.values())
        if (h.status === "active")
          coordinator.registerFunctionPatch(
            h.obj,
            h.name,
            h.wrapper,
            h.original,
            (status: string) => {
              h.restore = status;
              h.status =
                status === "restored"
                  ? "removed"
                  : status === "deferred" || status === "conflict"
                    ? "detached"
                    : "restore-failed";
            },
          );
    },
    resolve,
    list: () => ({ hooks: [...map.values()].map(info) }),
    read: (id: string, after: number, limit: number) => {
      const h = map.get(id);
      if (!h) fail("HOOK_NOT_FOUND", "Unknown hook in this context/session");
      const rows = h.entries.filter((e: any) => e.id > after),
        entries = rows.slice(0, limit);
      return {
        ...info(h),
        entries,
        nextCursor: entries.at(-1)?.id ?? after,
        hasMore: rows.length > entries.length,
        gap: after < (h.evictedThrough || 0),
        oldestCursor: h.entries[0]?.id || 0,
      };
    },
    remove: (id: string) => {
      const h = map.get(id);
      if (!h) fail("HOOK_NOT_FOUND", "Unknown hook in this context/session");
      return remove(h, "explicit");
    },
    install: (a: any) => {
      if ([...map.values()].filter((h) => h.status === "active").length >= 16)
        fail("HOOK_LIMIT", "At most 16 active hooks per context");
      const { obj, name, fn } = resolve(a.plan),
        original = descriptor(obj, name);
      if (
        [...map.values()].some(
          (h) => h.status === "active" && h.obj === obj && h.name === name,
        )
      )
        fail("HOOK_CONFLICT", "Target already has an active hook");
      if (original && !original.configurable && !original.writable)
        fail("HOOK_READ_ONLY", "Function property cannot be replaced");
      if (!original && !Object.isExtensible(obj))
        fail("HOOK_READ_ONLY", "Function owner is not extensible");
      const h: any = {
        id: a.hookId,
        obj,
        name,
        original,
        entries: [],
        status: "active",
        restore: "pending",
        count: 0,
        conditionErrors: 0,
        expiresAt: now() + a.ttlMs,
        label: a.target,
      };
      let inObserver = false;
      const wrapper = new Proxy(fn, {
        apply: (target, thisArg, args) =>
          run(() => apply(target, thisArg, args), thisArg, args),
        construct: (target, args, newTarget) =>
          run(
            () =>
              construct(
                target,
                args,
                newTarget === wrapper ? target : newTarget,
              ),
            undefined,
            args,
          ),
      });
      const run = (invoke: () => any, thisArg: any, args: any[]) => {
        if (h.status !== "active" || inObserver) return invoke();
        if (now() >= h.expiresAt) {
          remove(h, "expired");
          return invoke();
        }
        let selected = false;
        inObserver = true;
        try {
          selected = !!condition(a.condition, args, thisArg);
        } catch {
          h.conditionErrors++;
        } finally {
          inObserver = false;
        }
        if (!selected) return invoke();
        h.count++;
        const entry: any = { id: ++sequence, at: now(), call: h.count };
        inObserver = true;
        try {
          if (a.capture.includes("args")) entry.args = copy(args);
          if (a.capture.includes("this")) entry.this = copy(thisArg);
          if (a.capture.includes("stack"))
            entry.stack = String(new Error().stack || "").slice(0, 6000);
        } catch {
          entry.captureError = true;
        } finally {
          inObserver = false;
        }
        inObserver = true;
        try {
          h.entries.push(entry);
          if (h.entries.length > a.capacity)
            h.evictedThrough = h.entries.shift().id;
        } catch {
          entry.captureError = true;
        } finally {
          inObserver = false;
        }
        // Restore before invocation on the last hit; recursive calls cannot exceed count.
        if (h.count >= a.count) remove(h, "count");
        try {
          const result = invoke();
          inObserver = true;
          try {
            if (a.capture.includes("return")) {
              entry.return = copy(result);
              entry.returnObservation =
                "synchronous; promises are not awaited or chained";
            }
          } catch {
            entry.captureError = true;
          }
          return result;
        } catch (error) {
          inObserver = true;
          try {
            entry.threw = copy(error);
            entry.errorMessage =
              typeof error === "object" && error
                ? property(error, "message")
                : String(error);
          } catch {
            entry.captureError = true;
          }
          remove(h, "throw");
          throw error;
        } finally {
          inObserver = false;
        }
      };
      h.wrapper = wrapper;
      try {
        define(
          obj,
          name,
          original
            ? { ...original, value: wrapper }
            : {
                value: wrapper,
                writable: true,
                configurable: true,
                enumerable: false,
              },
        );
        h.timer = timer(() => remove(h, "expired"), a.ttlMs);
        map.set(h.id, h);
        g.__wxappBootAnalysisV1?.registerFunctionPatch?.(
          obj,
          name,
          wrapper,
          original,
          (status: string) => {
            h.restore = status;
            h.status =
              status === "restored"
                ? "removed"
                : status === "deferred" || status === "conflict"
                  ? "detached"
                  : "restore-failed";
          },
        );
      } catch (e) {
        if (descriptor(obj, name)?.value === wrapper) {
          if (original) define(obj, name, original);
          else delete obj[name];
        }
        throw e;
      }
      // Keep bounded metadata as well as bounded call records.
      if (map.size > 100)
        for (const [id, row] of map) {
          if (row.status !== "active") {
            map.delete(id);
            if (map.size <= 100) break;
          }
        }
      return info(h);
    },
  };
  Object.freeze(api);
  define(g, key, {
    value: api,
    configurable: false,
    writable: false,
    enumerable: false,
  });
  return api;
}
