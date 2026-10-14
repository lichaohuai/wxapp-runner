/** Runs inside the business realm after baselib, before any package script. */
export function bootAnalysisRuntime(options: any = {}) {
  const g: any = globalThis;
  if (g.__wxappBootAnalysisV1) return g.__wxappBootAnalysisV1;
  const D = Object.defineProperty,
    G = Object.getOwnPropertyDescriptor,
    P = Object.getPrototypeOf,
    A = Reflect.apply,
    C = Reflect.construct,
    keys = Reflect.ownKeys,
    freeze = Object.freeze,
    stringify = JSON.stringify,
    arrayIs = Array.isArray,
    isView = ArrayBuffer.isView,
    now = Date.now.bind(Date),
    timer = setTimeout,
    clear = clearTimeout;
  const optionsCopy = { ...options };
  const realmId =
    g.__runnerAnalysisContext?.realmId ||
    options.realmId ||
    String(now()) + "-" + Math.random().toString(36).slice(2);
  const capacity = options.capacity || 300,
    byteLimit = options.captureBytes || 4096;
  let quiet = 0,
    seq = 0,
    idSeq = 0,
    callSeq = 0,
    localContext: any = null,
    disposed = false,
    initializationFailure: any;
  const rows: any[] = [],
    patches: any[] = [],
    watches = new Map<string, any>(),
    runs = new Map<string, any>(),
    oracles = new Map<string, any>(),
    properties = new Map<string, any>(),
    modules = new Map<string, any>(),
    moduleFactories = new Map<string, any>(),
    moduleStates = new Map<string, string>();
  const notices: any[] = [],
    pending = options.taps || [];
  const protectedObjects = new WeakSet<object>();
  // Cooperating function observers may be removed in either order. An inner
  // inactive wrapper remains a transparent pass-through until its outer owner
  // is removed; restoration then skips every inactive layer. Foreign writes
  // are never overwritten. This does not intercept arbitrary app properties.
  const functionPatches = new WeakMap<Function, any[]>();
  const functionPatch = (fn: Function, obj: any, name: PropertyKey) =>
    functionPatches.get(fn)?.find((r) => r.obj === obj && r.name === name);
  function registerFunctionPatch(
    obj: any,
    name: PropertyKey,
    wrapper: Function,
    descriptor: PropertyDescriptor | undefined,
    changed: (status: string) => void,
  ) {
    const records = functionPatches.get(wrapper) || [];
    records.push({
      obj,
      name,
      wrapper,
      descriptor,
      active: true,
      changed,
    });
    functionPatches.set(wrapper, records);
  }
  function releaseFunctionPatch(
    wrapper: Function,
    obj: any,
    name: PropertyKey,
  ): string | undefined {
    const row = functionPatch(wrapper, obj, name);
    if (!row) return undefined;
    row.active = false;
    const mark = (r: any, status: string) => {
      r.status = status;
      r.changed(status);
      return status;
    };
    const current = G(row.obj, row.name);
    let cursor = current?.value,
      found = false;
    for (let i = 0; i < 1024; i++) {
      const layer = functionPatch(cursor, obj, name);
      if (!layer || layer.obj !== row.obj || layer.name !== row.name) break;
      if (layer === row) {
        found = true;
        break;
      }
      cursor = layer.descriptor?.value;
    }
    if (!found) return mark(row, "conflict");
    if (current?.value !== wrapper) return mark(row, "deferred");
    const removed = [row];
    let next = row.descriptor;
    for (let i = 0; i < 1024; i++) {
      const layer = functionPatch(next?.value, obj, name);
      if (
        !layer ||
        layer.active ||
        layer.obj !== row.obj ||
        layer.name !== row.name
      )
        break;
      removed.push(layer);
      next = layer.descriptor;
    }
    try {
      if (next) D(row.obj, row.name, next);
      else if (!Reflect.deleteProperty(row.obj, row.name))
        throw Error("Property cannot be deleted");
      for (const layer of removed) mark(layer, "restored");
      return "restored";
    } catch {
      return mark(row, "failed");
    }
  }
  const fail = (code: string, message: string): never => {
    throw Object.assign(Error(message), { code });
  };
  const mute = (fn: () => any) => {
    quiet++;
    try {
      return fn();
    } finally {
      quiet--;
    }
  };
  const get = (o: any, k: PropertyKey): any => {
    for (let x = o; x != null; x = P(x)) {
      const d = G(x, k);
      if (d) return "value" in d ? d.value : undefined;
    }
  };
  const context = () => g.__runnerAnalysisContext?.get() || localContext;
  const inContext = (c: any, fn: () => any) => {
    if (g.__runnerAnalysisContext) return g.__runnerAnalysisContext.run(c, fn);
    const old = localContext;
    localContext = c;
    try {
      return fn();
    } finally {
      localContext = old;
    }
  };
  const push = (v: any) => {
    const r = { id: ++seq, time: now(), ...v };
    rows.push(r);
    if (rows.length > capacity) rows.shift();
    try {
      g.__runnerAnalysisContext?.emit({
        id: r.id,
        kind: r.kind,
        phase: r.phase,
        algo: r.algo,
        runId: r.runId,
        callId: r.callId,
        parentCallId: r.parentCallId,
        matches: r.matches,
      });
    } catch {}
    return r;
  };
  const notice = (message: string) => {
    if (notices.length < 100) notices.push({ time: now(), message });
  };
  const hex = (bytes: Uint8Array) => {
    let out = "";
    for (let i = 0; i < bytes.length; i++)
      out += bytes[i].toString(16).padStart(2, "0");
    return out;
  };
  function snapshot(v: any, depth = 0, seen = new WeakSet<object>()): any {
    if (v == null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string")
      return v.length > byteLimit
        ? { text: v.slice(0, byteLimit), characters: v.length, truncated: true }
        : v;
    if (typeof v === "bigint") return String(v) + "n";
    if (typeof v === "function") return "[function]";
    if (typeof v !== "object") return String(v);
    if (seen.has(v)) return "[circular]";
    if (depth >= 3) return "[depth limit]";
    seen.add(v);
    try {
      if (isView(v) || v instanceof ArrayBuffer) {
        const b = isView(v)
          ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
          : new Uint8Array(v);
        return {
          encoding: "hex",
          data: hex(b.subarray(0, byteLimit)),
          bytes: b.length,
          truncated: b.length > byteLimit,
        };
      }
      if (
        typeof get(v, "data") === "string" &&
        typeof get(v, "read") === "number" &&
        typeof get(v, "getBytes") === "function"
      ) {
        const data = get(v, "data").slice(get(v, "read"));
        const bytes = new Uint8Array(Math.min(data.length, byteLimit));
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = data.charCodeAt(i) & 255;
        return {
          encoding: "hex",
          data: hex(bytes),
          bytes: data.length,
          truncated: data.length > byteLimit,
          representation: "forge ByteBuffer",
        };
      }
      const words = get(v, "words"),
        sig = get(v, "sigBytes");
      if (
        arrayIs(words) &&
        Number.isInteger(sig) &&
        sig >= 0 &&
        sig <= 64 * 1024 * 1024
      ) {
        const b = new Uint8Array(Math.min(sig, byteLimit));
        for (let i = 0; i < b.length; i++)
          b[i] = (get(words, i >>> 2) >>> (24 - (i % 4) * 8)) & 255;
        return {
          encoding: "hex",
          data: hex(b),
          bytes: sig,
          truncated: sig > b.length,
          representation: "WordArray",
        };
      }
      const out: any = arrayIs(v) ? [] : {};
      let count = 0;
      for (const k of keys(v)) {
        if (typeof k !== "string") continue;
        if (count++ >= 20) {
          out.__truncated = true;
          break;
        }
        const d = G(v, k);
        if (d?.enumerable)
          D(out, k, {
            value:
              "value" in d ? snapshot(d.value, depth + 1, seen) : "[accessor]",
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      return out;
    } catch {
      return "[uninspectable]";
    }
  }
  const snap = (v: any) => {
    const s = snapshot(v);
    const text = A(stringify, JSON, [s]);
    return text && text.length > byteLimit * 2
      ? { preview: text.slice(0, byteLimit), truncated: true }
      : s;
  };
  function resolve(p: any) {
    let obj =
      p.root === "app"
        ? g.getApp()
        : p.root === "module"
          ? modules.get(p.module)?.exports
          : g;
    if (p.root === "module" && !obj)
      fail(
        "MODULE_NOT_OBSERVED",
        "Module was not observed by the boot loader; no require was executed",
      );
    if (!p.keys.length) {
      const m = modules.get(p.module);
      if (m) return { obj: m, name: "exports", value: m.exports };
      fail("PROPERTY_REQUIRED", "A concrete property is required");
    }
    for (const k of p.keys.slice(0, -1)) {
      obj = get(obj, k);
      if (obj == null) fail("TARGET_NOT_FOUND", "Target owner is missing");
    }
    const name = p.keys[p.keys.length - 1];
    if (obj == null) fail("TARGET_NOT_FOUND", "Target owner is missing");
    return { obj, name, value: get(obj, name) };
  }
  function restore(p: any, reason = "stopped") {
    if (!p.active) return p.restore;
    p.active = false;
    p.stopReason = reason;
    clear(p.timer);
    if (p.wrapper && functionPatch(p.wrapper, p.obj, p.name))
      return releaseFunctionPatch(p.wrapper, p.obj, p.name);
    const current = G(p.obj, p.name);
    if (
      (p.wrapper && current?.value !== p.wrapper) ||
      (p.getter && current?.get !== p.getter)
    ) {
      p.restore = "conflict";
      return p.restore;
    }
    try {
      if (p.unassigned?.()) Reflect.deleteProperty(p.obj, p.name);
      else if (p.descriptor)
        D(p.obj, p.name, p.finalDescriptor?.() || p.descriptor);
      else if (p.finalDescriptor) D(p.obj, p.name, p.finalDescriptor());
      else Reflect.deleteProperty(p.obj, p.name);
      p.restore = "restored";
    } catch {
      p.restore = "failed";
    }
    return p.restore;
  }
  function replace(
    obj: any,
    name: PropertyKey,
    make: (original: any) => any,
    ttl = options.ttlMs || 60000,
  ) {
    if (patches.length >= 512)
      fail("TAP_LIMIT", "At most 512 managed patches per realm");
    const descriptor = G(obj, name),
      original = get(obj, name);
    if (descriptor && !("value" in descriptor))
      fail(
        "ACCESSOR_TARGET",
        `Cannot replace accessor '${String(name)}' after base-library hardening; start a new analysis instance with defeatAntiHook:true and the pre-baselib reservation enabled`,
      );
    if (descriptor && !descriptor.configurable && !descriptor.writable)
      fail(
        "READ_ONLY_TARGET",
        "Target was already frozen before instrumentation",
      );
    const p: any = {
      id: "tap-" + ++idSeq,
      obj,
      name,
      descriptor,
      active: true,
      installedAt: now(),
      expiresAt: now() + ttl,
    };
    const replacement = make(original);
    p.wrapper =
      typeof original === "function"
        ? new Proxy(original, {
            apply(fn, receiver, args) {
              return A(p.active ? replacement : fn, receiver, args);
            },
            construct(fn, args, target) {
              return C(p.active ? replacement : fn, args, target);
            },
          })
        : replacement;
    g.__wxappExecutionV1?.alias(original, p.wrapper);
    D(obj, name, {
      ...(descriptor || { enumerable: true }),
      value: p.wrapper,
      configurable: descriptor?.configurable ?? true,
      writable: true,
    });
    if (typeof p.wrapper === "function")
      registerFunctionPatch(obj, name, p.wrapper, descriptor, (status) => {
        p.restore = status;
      });
    patches.push(p);
    p.timer = timer(() => mute(() => restore(p, "expired")), ttl);
    return p;
  }
  const signatures = new WeakMap<object, Map<PropertyKey, any>>();
  function tap(
    obj: any,
    name: PropertyKey,
    label: string,
    spec: any = {},
    run?: any,
  ) {
    if (typeof get(obj, name) !== "function") return null;
    const previous = signatures.get(obj)?.get(name);
    if (previous?.active) {
      if (run)
        fail(
          "TARGET_ALREADY_TAPPED",
          "Choose a different slice root or stop the existing tap",
        );
      if (spec.observePromise) previous.spec.observePromise = true;
      return previous;
    }
    let p: any;
    p = replace(
      obj,
      name,
      (original: any) =>
        new Proxy(original, {
          apply(fn, receiver, args) {
            return invoke(fn, receiver, args);
          },
          construct(fn, args, newTarget) {
            return invoke(fn, null, args, newTarget);
          },
        }),
      spec.ttlMs,
    );
    function invoke(fn: any, receiver: any, args: any[], newTarget?: any): any {
      if (!quiet && p.active && p.expiresAt <= now())
        mute(() => restore(p, "expired"));
      if (quiet || !p.active || disposed)
        return newTarget ? C(fn, args, newTarget) : A(fn, receiver, args);
      const current = context();
      const inScope =
        p.scope === "all" ||
        (p.scope === "execution" &&
          current?.executionRunId &&
          g.__wxappExecutionV1?.isRecording(current.executionRunId)) ||
        (p.scope === "operation" &&
          (current?.rootOperationId || current?.operationId)) ||
        (p.scope === "armed" &&
          p.armed &&
          (p.runId
            ? current?.executionRunId === p.runId &&
              g.__wxappExecutionV1?.isRecording(p.runId)
            : current?.operationId === p.operationId ||
              current?.rootOperationId === p.operationId));
      if (!inScope || p.remaining <= 0)
        return newTarget ? C(fn, args, newTarget) : A(fn, receiver, args);
      let c: any,
        record: any,
        stack: string | undefined,
        callId: number,
        ownRun = false;
      try {
        mute(() => {
          c = context();
          if (--p.remaining <= 0 && !run) {
            p.stopReason = "exhausted";
            if (p.scope === "all") restore(p, "exhausted");
          }
          if (run && run.remaining > 0) {
            ownRun = true;
            run.remaining--;
            c = { ...c, runId: run.id };
            run.calls++;
            if (!run.remaining) restore(p, "exhausted");
          }
          callId = ++callSeq;
          stack = new Error().stack?.split("\n").slice(2, 16).join("\n");
          const input = snap(args[spec.inputIndex || 0]);
          record = {
            callId,
            runId: c?.runId,
            parentCallId: c?.callId,
            executionRunId: c?.executionRunId,
            executionEventId: c?.executionEventId,
            executionLocation: g.__wxappExecutionV1?.describe(
              c?.executionEventId,
            ),
            kind: spec.kind || "crypto",
            algo: label,
            input,
            thisArg: snap(receiver),
            args: snap(args),
            key:
              spec.keyIndex === undefined
                ? undefined
                : snap(args[spec.keyIndex]),
            iv:
              spec.ivIndex === undefined
                ? spec.ivOption === undefined
                  ? undefined
                  : snap(get(args[spec.ivOption], "iv"))
                : snap(args[spec.ivIndex]),
            stack,
          };
          // Adapter metadata uses observed references/descriptors only. Never call
          // application serializers/getters while describing a crypto operation.
          if (spec.describe) {
            record.crypto = spec.describe(args, receiver);
            record.verificationVector = {
              input: snap(
                spec.vectorInput
                  ? spec.vectorInput(args)
                  : args[spec.inputIndex || 0],
              ),
            };
          }
          if (spec.streamState) {
            const state = spec.streamState;
            if (spec.streamOp === "update" && state.parts.length < 128)
              state.parts.push(snap(args[0]));
            const chunks = [...state.parts];
            if (spec.streamOp === "final" && args[0] !== undefined)
              chunks.push(snap(args[0]));
            record.streamId = state.id;
            record.chunks = chunks;
            record.streamTruncated = state.parts.length >= 128;
            if (spec.streamOp === "final")
              record.input = chunks.every((x) => typeof x === "string")
                ? snap(chunks.join(""))
                : { chunks };
          }
          if (spec.receiverKey) record.key = snap(get(receiver, "key"));
          if (spec.aesReceiver) {
            record.key = snap(get(get(receiver, "_aes"), "key"));
            record.iv = snap(
              get(receiver, "_lastCipherblock") ||
                get(receiver, "_shiftRegister") ||
                get(receiver, "_lastPrecipher") ||
                get(get(receiver, "_counter"), "_counter"),
            );
          }
          if (spec.webCrypto)
            record.keyPolicy =
              "Native key material is not exported by observation";
          push({ ...record, phase: "call" });
        });
      } catch {
        return newTarget ? C(fn, args, newTarget) : A(fn, receiver, args);
      }
      p.inFlight = (p.inFlight || 0) + 1;
      let finished = false;
      const finish = (phase: string, result: any) =>
        mute(() => {
          if (!finished) {
            finished = true;
            p.inFlight--;
          }
          const output = snap(result),
            matches: string[] = [];
          const verificationVector = record.verificationVector && {
            ...record.verificationVector,
            output: snap(
              spec.vectorOutput ? spec.vectorOutput(result) : result,
            ),
          };
          if (phase === "return")
            for (const w of watches.values()) {
              if (w.remaining <= 0 || w.expiresAt <= now()) continue;
              const values = outputValues(output);
              if (
                values.some((value) =>
                  w.match === "regex"
                    ? w.regex.test(value)
                    : w.match === "includes"
                      ? value.includes(w.target)
                      : value === w.target,
                )
              ) {
                matches.push(w.id);
                w.remaining--;
              }
            }
          push({ ...record, phase, output, matches, verificationVector });
          if (ownRun) {
            run.lastPhase = phase;
            run.lastCursor = seq;
          }
        });
      try {
        const result = inContext(
          { ...c, runId: c?.runId, callId: callId! },
          () => (newTarget ? C(fn, args, newTarget) : A(fn, receiver, args)),
        );
        if (spec.afterReturn)
          try {
            mute(() => spec.afterReturn(result, args, receiver));
          } catch (e: any) {
            notice(label + ": " + e.message);
          }
        // Promise observation is explicit: attaching a rejection observer changes unhandled-rejection accounting.
        if (spec.observePromise && result instanceof Promise) {
          A(Promise.prototype.then, result, [
            (v: any) => {
              try {
                finish("return", v);
              } catch {}
            },
            (e: any) => {
              try {
                finish("reject", e);
              } catch {}
            },
          ]);
          mute(() => push({ ...record, phase: "promise-pending" }));
        } else {
          try {
            finish("return", result);
          } catch {}
        }
        return result;
      } catch (e) {
        try {
          finish("throw", e);
        } catch {}
        throw e;
      }
    }
    let map = signatures.get(obj);
    if (!map) {
      map = new Map();
      signatures.set(obj, map);
    }
    map.set(name, p);
    p.label = label;
    p.target = spec.target || label;
    p.scope = spec.scope || "all";
    p.armed = p.scope !== "armed";
    p.remaining = spec.count || 1000;
    p.spec = spec;
    return p;
  }
  const autoTap = (obj: any, name: string, label: string, spec: any = {}) => {
    try {
      tap(obj, name, label, spec);
    } catch (e: any) {
      notice(label + ": " + e.message);
    }
  };
  function scan(obj: any, label: string, observePromise = false) {
    if (!obj || !["object", "function"].includes(typeof obj)) return;
    const enc = get(obj, "enc"),
      mode = get(obj, "mode"),
      pad = get(obj, "pad"),
      cryptoJS = !!get(get(obj, "lib"), "WordArray") && !!get(enc, "Hex");
    const refName = (table: any, value: any): string => {
      if (!value || !table) return "unknown";
      for (const k of keys(table))
        if (typeof k === "string" && get(table, k) === value) return k;
      return "unknown";
    };
    // Signature names are adapter contracts, never proof from minified byte patterns.
    for (const name of [
      "MD5",
      "SHA1",
      "SHA224",
      "SHA256",
      "SHA384",
      "SHA512",
      "SHA3",
      "RIPEMD160",
      "HmacMD5",
      "HmacSHA1",
      "HmacSHA256",
      "HmacSHA512",
      "PBKDF2",
      "sm3",
      "sm2",
      "sm4",
    ])
      if (typeof get(obj, name) === "function")
        autoTap(obj, name, label + "." + name, {
          keyIndex: /Hmac|PBKDF/.test(name) ? 1 : undefined,
          observePromise,
          ...(cryptoJS && name !== "PBKDF2"
            ? {
                describe: () => ({
                  adapter: "CryptoJS",
                  basis: "adapter-contract",
                  algorithm: name,
                  operation: /^Hmac/.test(name) ? "hmac" : "digest",
                  inputEncoding: "utf8-or-bytes",
                  outputEncoding: "bytes",
                }),
              }
            : {}),
        });
    for (const name of [
      "AES",
      "DES",
      "TripleDES",
      "RC4",
      "Rabbit",
      "sm2",
      "sm4",
    ]) {
      const part = get(obj, name);
      if (part && typeof part === "object")
        for (const op of [
          "encrypt",
          "decrypt",
          "doEncrypt",
          "doDecrypt",
          "doSignature",
          "doVerifySignature",
        ])
          autoTap(part, op, label + "." + name + "." + op, {
            keyIndex: 1,
            ivOption: 2,
            observePromise,
            ...(cryptoJS && ["encrypt", "decrypt"].includes(op)
              ? {
                  describe: (args: any[]) => {
                    const config = args[2],
                      defaults = get(get(get(obj, "algo"), name), "cfg");
                    // An own accessor/explicit undefined shadows defaults; do not read it.
                    const option = (k: string) =>
                      config && G(config, k)
                        ? get(config, k)
                        : get(defaults, k);
                    return {
                      adapter: "CryptoJS",
                      basis: "adapter-contract-and-option-reference",
                      algorithm: name,
                      operation: op,
                      mode: refName(mode, option("mode")),
                      padding: refName(pad, option("padding")),
                      inputEncoding:
                        op === "encrypt" ? "utf8-or-bytes" : "bytes",
                      outputEncoding: "bytes",
                      keyEncoding:
                        typeof args[1] === "string" ? "passphrase" : "bytes",
                    };
                  },
                  vectorInput: (args: any[]) =>
                    op === "decrypt" ? get(args[0], "ciphertext") : args[0],
                  vectorOutput: (result: any) =>
                    op === "encrypt" ? get(result, "ciphertext") : result,
                }
              : {}),
          });
    }
    for (const child of ["CryptoJS", "default", "nacl", "sm2", "sm3", "sm4"]) {
      const v = get(obj, child);
      if (v && v !== obj && child === "CryptoJS")
        scan(v, label + "." + child, observePromise);
    }
    if (/(?:sm2|sm4|aes)/i.test(label))
      for (const op of [
        "encrypt",
        "decrypt",
        "doEncrypt",
        "doDecrypt",
        "doSignature",
        "doVerifySignature",
      ])
        autoTap(obj, op, label + "." + op, { keyIndex: 1, observePromise });
    const algorithms = get(obj, "algo");
    if (algorithms)
      for (const name of ["MD5", "SHA1", "SHA256", "SHA512", "SHA3", "HMAC"]) {
        const part = get(algorithms, name);
        if (part)
          autoTap(part, "create", label + "." + name + ".create", {
            afterReturn: (v: any) => stream(v, label + "." + name),
          });
      }
    if (/sha|md5|sm3/i.test(label))
      autoTap(obj, "create", label + ".create", {
        afterReturn: (v: any) => stream(v, label),
      });
    const md = get(obj, "md");
    if (md)
      for (const algo of ["md5", "sha1", "sha256", "sha384", "sha512"]) {
        const digest = get(md, algo);
        if (digest)
          autoTap(digest, "create", "forge." + algo + ".create", {
            afterReturn: (instance: any) => {
              stream(instance, "forge." + algo);
            },
          });
      }
    const modes = get(obj, "ModeOfOperation");
    if (modes)
      for (const mode of ["ecb", "cbc", "cfb", "ofb", "ctr"]) {
        const cls = get(modes, mode),
          proto = cls && get(cls, "prototype");
        if (proto)
          for (const op of ["encrypt", "decrypt"])
            autoTap(proto, op, "aes-js." + mode + "." + op, {
              aesReceiver: true,
            });
      }
    const subtle = get(obj, "subtle");
    if (subtle)
      for (const op of [
        "digest",
        "sign",
        "verify",
        "encrypt",
        "decrypt",
        "deriveBits",
        "deriveKey",
        "importKey",
        "exportKey",
      ])
        autoTap(subtle, op, "WebCrypto." + op, {
          inputIndex: op === "digest" ? 1 : op === "verify" ? 3 : 2,
          webCrypto: true,
          keyIndex: op === "digest" ? undefined : 1,
          observePromise,
          describe: (args: any[]) => ({
            adapter: "WebCrypto",
            basis: "adapter-contract",
            operation: op,
            algorithm:
              typeof args[0] === "string" ? args[0] : get(args[0], "name"),
            inputEncoding: "bytes",
            outputEncoding: "bytes",
            keyEncoding: "opaque-handle",
          }),
        });
    const prototype = get(obj, "prototype");
    if (prototype && /jsencrypt/i.test(label))
      for (const op of ["encrypt", "decrypt", "sign", "verify"])
        autoTap(prototype, op, "JSEncrypt." + op, {
          observePromise,
          receiverKey: true,
        });
    if (/nacl/i.test(label))
      for (const op of ["hash", "secretbox", "box", "sign"]) {
        autoTap(obj, op, "tweetnacl." + op, {
          keyIndex: op === "hash" ? undefined : op === "sign" ? 1 : 2,
          ivIndex: ["box", "secretbox"].includes(op) ? 1 : undefined,
          observePromise,
        });
        const f = get(obj, op);
        if (f)
          autoTap(f, "detached", "tweetnacl." + op + ".detached", {
            keyIndex: 1,
            ivOption: 2,
            observePromise,
          });
      }
    if (/sha|md5|sm3/i.test(label))
      for (const name of [
        "hex",
        "array",
        "arrayBuffer",
        "digest",
        "md5",
        "sha1",
        "sha224",
        "sha256",
        "sha384",
        "sha512",
        "sm3",
      ])
        autoTap(obj, name, label + "." + name, { observePromise });
  }
  // Detects a crypto library object by shape (crypto-js / forge / aes-js /
  // tweetnacl / WebCrypto), so aliased or re-exported instances are recognized
  // without knowing their module id. Data-descriptor reads only — never invokes
  // app getters or functions.
  function looksLikeCryptoLib(o: any): boolean {
    try {
      if (get(get(o, "lib"), "WordArray") && get(get(o, "enc"), "Hex"))
        return true; // crypto-js (same signature scan() uses)
      if (get(o, "md") && (get(o, "cipher") || get(o, "util"))) return true; // node-forge
      if (get(o, "ModeOfOperation")) return true; // aes-js
      if (
        typeof get(o, "secretbox") === "function" &&
        typeof get(o, "hash") === "function"
      )
        return true; // tweetnacl
      const s = get(o, "subtle");
      if (s && typeof get(s, "digest") === "function") return true; // WebCrypto
    } catch {
      /* shape probe must never throw into the caller */
    }
    return false;
  }
  // Bounded, cycle-guarded walk of the reachable own-enumerable-data graph from
  // `root`, routing any crypto-shaped node to the existing scan(). Reaches
  // crypto-js/forge/etc. bundled or aliased inside a module's exports (e.g.
  // app-service.js module export -> a.default = CryptoJS) without needing module
  // ids. Efficacy limit: a purely closure-local webpack binding is NOT reachable
  // here — use an explicit module-scoped tap / runner_slice for that residual
  // case. `seen`/`budgetRef` are shared across roots by the caller to cap work.
  function scanGraph(
    root: any,
    label: string,
    observePromise = false,
    seen = new WeakSet<object>(),
    budgetRef: { n: number } = { n: 4000 },
  ) {
    const stack: any[] = [{ v: root, label, depth: 0 }];
    while (stack.length && budgetRef.n-- > 0) {
      const { v, label: lbl, depth } = stack.pop();
      if (!v || (typeof v !== "object" && typeof v !== "function")) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (isView(v) || v instanceof ArrayBuffer) continue;
      try {
        if (looksLikeCryptoLib(v)) scan(v, lbl, observePromise);
      } catch {
        /* one bad node must not abort the walk */
      }
      if (depth >= 6) continue;
      let ks: any[];
      try {
        ks = keys(v) as any[];
      } catch {
        continue;
      }
      let fan = 0;
      for (const k of ks) {
        if (typeof k !== "string") continue;
        if (k === "prototype" || k === "constructor" || k === "__proto__")
          continue;
        if (++fan > 64) break;
        let d: any;
        try {
          d = G(v, k);
        } catch {
          continue;
        }
        if (!d || !d.enumerable || !("value" in d)) continue;
        const child = d.value;
        if (
          child &&
          (typeof child === "object" || typeof child === "function") &&
          !seen.has(child)
        )
          stack.push({ v: child, label: lbl + "." + k, depth: depth + 1 });
      }
    }
  }
  function outputValues(output: any) {
    const value =
      typeof output === "string"
        ? output
        : output?.encoding === "hex" && !output.truncated
          ? output.data
          : null;
    if (value === null) return [];
    const out = [value];
    if (/^(?:[0-9a-fA-F]{2})+$/.test(value) && value.length <= byteLimit * 2) {
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let b64 = "";
      for (let i = 0; i < value.length; i += 6) {
        const bytes = [0, 2, 4].map((j) =>
            parseInt(value.slice(i + j, i + j + 2) || "0", 16),
          ),
          n = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
        b64 +=
          alphabet[(n >>> 18) & 63] +
          alphabet[(n >>> 12) & 63] +
          (i + 2 < value.length ? alphabet[(n >>> 6) & 63] : "=") +
          (i + 4 < value.length ? alphabet[n & 63] : "=");
      }
      out.push(b64, value.toLowerCase(), value.toUpperCase());
    }
    return out;
  }
  function restrictedRegex(pattern: string) {
    if (
      pattern.length > 256 ||
      /[()*+?|\\]/.test(pattern) ||
      [...pattern.matchAll(/\{([^}]+)\}/g)].some(
        (m) => !/^\d{1,3}$/.test(m[1]) || +m[1] > 256,
      )
    )
      fail(
        "REGEX_UNSUPPORTED",
        "Use literals, character classes, anchors and fixed repetitions <=256 only",
      );
    return new RegExp(pattern);
  }
  function stream(instance: any, label: string) {
    const state = { id: "stream-" + ++idSeq, parts: [] as any[] };
    for (const op of [
      "update",
      "finalize",
      "digest",
      "hex",
      "array",
      "arrayBuffer",
    ])
      autoTap(instance, op, label + "." + op, {
        streamState: state,
        streamOp: op === "update" ? "update" : "final",
      });
  }
  function validateTap(spec: any) {
    const t = resolve(spec.plan),
      d = G(t.obj, t.name);
    if (typeof t.value !== "function")
      fail("TARGET_NOT_FUNCTION", "Tap target is not a function");
    if (d && (!("value" in d) || (!d.configurable && !d.writable)))
      fail("READ_ONLY_TARGET", "Tap target is an accessor or frozen");
    if (!d && !Object.isExtensible(t.obj))
      fail("READ_ONLY_TARGET", "Tap owner cannot accept an own property");
    return t;
  }
  function explicit(spec: any) {
    const t = resolve(spec.plan);
    const p = tap(t.obj, t.name, spec.algo, spec);
    if (!p) fail("TARGET_NOT_FUNCTION", "Target is not a function");
    return p!.id;
  }
  function observeModule(m: any, name: string, factory: Function) {
    modules.set(name, m);
    moduleFactories.set(name, factory);
    moduleStates.set(name, "loaded");
    if (optionsCopy.cryptoTap) {
      scan(m.exports, name, !!optionsCopy.observePromise);
      try {
        scanGraph(m.exports, name, !!optionsCopy.observePromise);
      } catch {
        /* graph walk is best-effort; never break module observation */
      }
      if (
        typeof m.exports === "function" &&
        /(?:^|\/)(?:md5|sha(?:1|224|256|384|512)|sm3)(?:[.-]|$)/i.test(name)
      )
        autoTap(m, "exports", "module:" + name, {
          observePromise: !!optionsCopy.observePromise,
        });
    }
    for (const s of pending)
      if (s.plan?.module === name)
        try {
          explicit(s);
        } catch (e: any) {
          notice(name + ": " + e.message);
        }
  }
  function watchGlobal(name: string) {
    if (name === "crypto" || G(g, name)) return;
    let value: any,
      assigned = false;
    const p: any = { id: "global-" + ++idSeq, obj: g, name, active: true };
    p.unassigned = () => !assigned;
    p.getter = () => value;
    D(g, name, {
      get: p.getter,
      set: (v: any) => {
        assigned = true;
        value = v;
        if (p.active)
          try {
            mute(() => scan(v, name, !!optionsCopy.observePromise));
          } catch (e: any) {
            notice(name + ": " + e.message);
          }
      },
      configurable: true,
      enumerable: false,
    });
    p.finalDescriptor = () => ({
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    patches.push(p);
    p.timer = timer(
      () =>
        mute(() => {
          if (!assigned) delete p.finalDescriptor;
          restore(p);
        }),
      options.ttlMs || 60000,
    );
  }
  function guardIntrinsics() {
    for (const name of options.intrinsicNames || [
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
    ]) {
      const obj = g[name];
      if (obj) {
        protectedObjects.add(obj);
        if (obj.prototype) protectedObjects.add(obj.prototype);
      }
    }
    for (const obj of [Math, JSON, Reflect]) protectedObjects.add(obj);
    for (const name of ["freeze", "seal", "preventExtensions"])
      replace(
        Object,
        name,
        (original: any) =>
          function (obj: any) {
            if (protectedObjects.has(obj)) {
              mute(() =>
                push({ kind: "hardening-bypass", method: "Object." + name }),
              );
              return obj;
            }
            return A(original, Object, [obj]);
          },
      );
    const relax = (obj: any, name: any, d: any) => {
      if (!protectedObjects.has(obj)) return d;
      const v: any = { ...d, configurable: G(obj, name)?.configurable ?? true };
      if (!("get" in v) && !("set" in v)) v.writable = true;
      mute(() =>
        push({
          kind: "hardening-bypass",
          method: "defineProperty",
          property: String(name),
        }),
      );
      return v;
    };
    replace(
      Object,
      "defineProperty",
      (original: any) =>
        function (obj: any, k: any, d: any) {
          return A(original, Object, [obj, k, relax(obj, k, d)]);
        },
    );
    replace(
      Reflect,
      "defineProperty",
      (original: any) =>
        function (obj: any, k: any, d: any) {
          return A(original, Reflect, [obj, k, relax(obj, k, d)]);
        },
    );
    replace(
      Object,
      "defineProperties",
      (original: any) =>
        function (obj: any, descriptors: any) {
          if (!protectedObjects.has(obj))
            return A(original, Object, [obj, descriptors]);
          const ds: any = {};
          for (const k of keys(descriptors)) {
            const d = G(descriptors, k);
            if (d?.enumerable)
              D(ds, k, {
                value: relax(obj, k, descriptors[k]),
                enumerable: true,
              });
          }
          return A(original, Object, [obj, ds]);
        },
    );
    replace(
      Reflect,
      "preventExtensions",
      (original: any) =>
        function (obj: any) {
          return protectedObjects.has(obj) ? true : A(original, Reflect, [obj]);
        },
    );
  }
  let randomState = (options.randomSeed ?? 0) >>> 0,
    randomCalls = 0;
  const random = () => {
    randomCalls++;
    randomState = (randomState + 0x6d2b79f5) >>> 0;
    let t = randomState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  function pinRandom() {
    replace(Math, "random", () => () => random());
    if (g.crypto && typeof get(g.crypto, "getRandomValues") === "function")
      replace(
        g.crypto,
        "getRandomValues",
        (original: any) =>
          function (this: any, array: any) {
            // Preserve the native receiver, integer-view validation and 65536-byte quota before overwriting with deterministic bytes.
            const result = A(original, this, [array]);
            const b = new Uint8Array(
              array.buffer,
              array.byteOffset,
              array.byteLength,
            );
            for (let i = 0; i < b.length; i++)
              b[i] = Math.floor(random() * 256);
            return result;
          },
      );
  }
  const read = (a: any) => {
    const after = a.after || 0,
      filter = (r: any) =>
        (!a.runId || r.runId === a.runId || r.executionRunId === a.runId) &&
        (!a.watchId || r.matches?.includes(a.watchId)) &&
        (!a.matchedOnly || r.matches?.length);
    const eligible = rows.filter((r) => r.id > after && filter(r)),
      entries = eligible.slice(0, a.limit || 20);
    return {
      entries,
      nextCursor: entries.at(-1)?.id ?? seq,
      hasMore: eligible.length > entries.length,
      gap: after < (rows[0]?.id || 1) - 1,
      cursorResetRequired: after > seq,
      oldestCursor: rows[0]?.id || seq + 1,
      latestCursor: seq,
    };
  };
  function propertyWatch(a: any) {
    const { obj, name } = resolve(a.plan),
      d = G(obj, name);
    if (!d || !("value" in d) || !d.configurable || !d.writable)
      fail(
        "PROPERTY_WATCH_UNSUPPORTED",
        "Watch requires an existing own configurable writable data property; no Object.prototype trap is installed",
      );
    let value = d!.value;
    const p: any = {
      id: "property-" + ++idSeq,
      obj,
      name,
      descriptor: d,
      active: true,
    };
    p.getter = function () {
      return value;
    };
    const setter = function (this: any, v: any) {
      if (this !== obj) {
        D(this, name, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return;
      }
      const before = value;
      value = v;
      if (!quiet && p.active)
        mute(() =>
          push({
            kind: "property-write",
            propertyId: p.id,
            property: String(name),
            before: snap(before),
            value: snap(v),
            ...context(),
            stack: new Error().stack?.slice(0, 6000),
          }),
        );
    };
    p.finalDescriptor = () => ({ ...d, value });
    D(obj, name, {
      get: p.getter,
      set: setter,
      enumerable: d!.enumerable,
      configurable: true,
    });
    patches.push(p);
    properties.set(p.id, p);
    p.timer = timer(() => mute(() => restore(p)), a.ttlMs);
    return {
      propertyId: p.id,
      status: "watching",
      scope: "one existing object property",
    };
  }
  const status = () => {
    for (const p of patches)
      if (p.active && p.expiresAt <= now()) restore(p, "expired");
    return {
      enabled: !disposed,
      state: initializationFailure
        ? "failed"
        : disposed
          ? "stopped"
          : patches.some((p) => p.label && p.inFlight > 0)
            ? "recording"
            : patches.some(
                  (p) => p.label && p.active && p.remaining > 0 && p.armed,
                )
              ? "armed"
              : "idle",
      activeTapCount: patches.filter(
        (p) => p.label && p.active && p.remaining > 0 && p.armed,
      ).length,
      installedTapCount: patches.filter((p) => p.label && p.active).length,
      oldestCursor: rows[0]?.id || seq + 1,
      evictedRecords: Math.max(0, seq - rows.length),
      initializationFailure,
      phase: options.phase || "live",
      preparation: options.preparation,
      defeatAntiHook: !!options.defeatAntiHook,
      randomSeed: options.randomSeed,
      randomCalls,
      now: options.now,
      latestCursor: seq,
      capacity,
      taps: patches
        .filter((p) => p.label)
        .map((p) => ({
          tapId: p.id,
          label: p.label,
          target: p.target,
          scope: p.scope,
          active: p.active,
          installed: p.active,
          state:
            p.inFlight > 0
              ? "recording"
              : !p.active
                ? p.stopReason || "stopped"
                : p.remaining <= 0
                  ? "exhausted"
                  : p.armed
                    ? "armed"
                    : "installed",
          inFlight: p.inFlight || 0,
          armed: p.active && p.armed && p.remaining > 0,
          runId: p.runId,
          operationId: p.operationId,
          installedAt: p.installedAt,
          expiresAt: p.expiresAt,
          ttlRemainingMs: Math.max(0, p.expiresAt - now()),
          stopReason: p.stopReason,
          remaining: p.remaining,
          restore: p.restore,
        })),
      watches: [...watches.values()].map(({ target, regex, ...w }) => w),
      notices,
      coverage: {
        opcodeTrace: false,
        arbitraryPropertyWrites: false,
        inlineCryptoDetection: false,
        asyncContext: !!g.__runnerAnalysisContext,
        webCrypto: !!g.crypto,
      },
      restoration: disposed
        ? patches.map((p) => ({ id: p.id, restore: p.restore }))
        : undefined,
    };
  };
  const api: any = {
    registerFunctionPatch,
    releaseFunctionPatch,
    status,
    read,
    // Observed cache owners only: inspection never invokes require or a factory.
    moduleOwner(name: string) {
      return modules.get(name);
    },
    moduleFactory(name: string) {
      return moduleFactories.get(name);
    },
    moduleStatus(name: string) {
      return {
        name,
        state: moduleStates.get(name) || "unknown",
        observed: modules.has(name),
      };
    },
    command(a: any) {
      return mute(() => {
        if (a.action === "status") return status();
        if (a.action === "arm" || a.action === "disarm") {
          const selected = (a.tapIds || []).map((id: string) =>
            patches.find((p) => p.id === id && p.label),
          );
          if (
            !selected.length ||
            selected.some((p) => !p?.active || p.expiresAt <= now())
          )
            fail(
              "TAP_NOT_INSTALLED",
              "The original wrapper is absent or expired; start a fresh boot analysis instance",
            );
          if (
            a.action === "arm" &&
            Number(!!a.runId) + Number(!!a.operationId) !== 1
          )
            fail(
              "TAP_SCOPE_REQUIRED",
              "Specify exactly one runId or operationId",
            );
          if (a.runId && !g.__wxappExecutionV1?.isRecording(a.runId))
            fail(
              "EXECUTION_NOT_RECORDING",
              "Start an execution run before arming its probes",
            );
          for (const p of selected) {
            p.scope = "armed";
            p.armed = a.action === "arm";
            if (p.armed) {
              p.remaining = a.count || p.spec.count || 1000;
              p.runId = a.runId;
              p.operationId = a.operationId;
              p.stopReason = undefined;
            }
          }
          return status();
        }
        if (a.action === "resetRandom") {
          if (options.randomSeed === undefined || disposed)
            fail(
              "RANDOM_NOT_PINNED",
              "Enable randomSeed at boot in a fresh analysis realm",
            );
          const p = patches.find((p) => p.obj === Math && p.name === "random");
          if (!p?.active)
            fail(
              "RANDOM_PIN_EXPIRED",
              "The random patch expired; start a new analysis realm",
            );
          randomState = (a.seed ?? options.randomSeed) >>> 0;
          randomCalls = 0;
          return {
            status: "reset",
            seed: randomState,
            scope: "Math.random and exposed crypto.getRandomValues only",
            now: options.now,
          };
        }
        if (a.action === "read") return read(a);
        if (a.action === "stop") {
          if (a.tapIds)
            return {
              restored: a.tapIds.map((id: string) => {
                const p = patches.find((x) => x.id === id);
                return { id, status: p ? restore(p) : "absent" };
              }),
            };
          if (a.watchId) {
            const w = watches.get(a.watchId);
            if (w) w.remaining = 0;
            return { watchId: a.watchId, status: "stopped" };
          }
          disposed = true;
          oracles.clear();
          for (const p of [...patches].reverse()) restore(p);
          return status();
        }
        if (a.action === "start") {
          if (disposed)
            fail(
              "ANALYSIS_STOPPED",
              "Start a fresh analysis runtime after full restoration",
            );
          if (a.target && watches.size >= 64)
            fail("WATCH_LIMIT", "At most 64 watches per realm");
          if (patches.length + (a.taps?.length || 0) > 512)
            fail("TAP_LIMIT", "Managed patch limit reached");
          const regex =
            a.match === "regex" && a.target
              ? restrictedRegex(a.target)
              : undefined;
          // A module-rooted tap whose factory has not executed yet has no
          // exports object to wrap, and boot-runtime never invokes require
          // itself (the side-effect-free invariant). Rather than fail with
          // MODULE_NOT_OBSERVED, arm such a tap PENDING: observeModule()
          // installs it the instant the module's factory actually runs — the
          // same path boot-time module taps already use. Defer only
          // genuinely-unobserved modules; an already-loaded module still
          // resolves/throws immediately as today.
          const deferred: any[] = [],
            immediate: any[] = [];
          for (const spec of a.taps || [])
            (spec.plan?.root === "module" && !modules.has(spec.plan.module)
              ? deferred
              : immediate
            ).push(spec);
          if (pending.length + deferred.length > 512)
            fail("TAP_LIMIT", "Managed patch limit reached");
          for (const spec of immediate) validateTap(spec);
          const tapIds: any[] = [];
          for (const spec of immediate)
            tapIds.push(explicit({ ...spec, ttlMs: a.ttlMs }));
          const pendingTaps = deferred.map((spec) => {
            const entry = {
              ...spec,
              ttlMs: a.ttlMs,
              pendingId: "pending-" + ++idSeq,
            };
            pending.push(entry);
            return { pendingId: entry.pendingId, module: spec.plan.module };
          });
          if (a.auto) {
            optionsCopy.cryptoTap = true;
            optionsCopy.observePromise = !!a.observePromise;
            // Walk each root's reachable graph (single shared seen + budget)
            // so aliased/re-exported crypto libs are found without module ids.
            try {
              const seen = new WeakSet<object>();
              const budgetRef = { n: 20000 };
              for (const name of [
                "CryptoJS",
                "crypto",
                "forge",
                "nacl",
                "JSEncrypt",
                "sm2",
                "sm3",
                "sm4",
                "aesjs",
              ])
                scanGraph(g[name], name, !!a.observePromise, seen, budgetRef);
              for (const [name, m] of modules)
                scanGraph(m.exports, name, !!a.observePromise, seen, budgetRef);
              const app = typeof g.getApp === "function" && g.getApp();
              if (app) scanGraph(app, "app", !!a.observePromise, seen, budgetRef);
            } catch {
              /* auto scan is best-effort; a throw must not fail start */
            }
          }
          let watchId;
          if (a.target) {
            if (watches.size >= 64)
              fail("WATCH_LIMIT", "At most 64 watches per realm");
            watchId = "watch-" + ++idSeq;
            watches.set(watchId, {
              id: watchId,
              target: a.target,
              match: a.match,
              regex,
              remaining: a.count,
              expiresAt: now() + a.ttlMs,
            });
          }
          return {
            watchId,
            tapIds,
            pendingTaps,
            cursor: seq,
            status: "armed",
            captures: "observed calls only",
            promiseObservation: !!a.observePromise,
          };
        }
        if (a.action === "diff") {
          const aRows = rows.filter(
              (r) =>
                (r.runId === a.runA || r.executionRunId === a.runA) &&
                r.phase === "return",
            ),
            bRows = rows.filter(
              (r) =>
                (r.runId === a.runB || r.executionRunId === a.runB) &&
                r.phase === "return",
            );
          const group = (rows: any[]) => {
            const count = new Map(),
              map = new Map();
            for (const row of rows) {
              const key = A(stringify, JSON, [
                  [
                    row.algo,
                    row.executionLocation?.site,
                    row.executionLocation?.callPath,
                    row.executionLocation ? undefined : row.stack,
                  ],
                ]),
                n = count.get(key) || 0;
              count.set(key, n + 1);
              map.set(key + ":" + n, row);
            }
            return map;
          };
          const left = group(aRows),
            right = group(bRows),
            changes: any[] = [];
          for (const key of new Set([...left.keys(), ...right.keys()])) {
            const x = left.get(key),
              y = right.get(key);
            if (
              !x ||
              !y ||
              A(stringify, JSON, [[x.input, x.output]]) !==
                A(stringify, JSON, [[y.input, y.output]])
            )
              changes.push({
                key,
                kind: !x ? "only-b" : !y ? "only-a" : "changed",
                a: x,
                b: y,
              });
          }
          return {
            changes: changes.slice(a.after, a.after + a.limit),
            nextCursor:
              a.after +
              Math.min(a.limit, Math.max(0, changes.length - a.after)),
            hasMore: changes.length > a.after + a.limit,
            basis:
              "algorithm + source site/call path (or exact stack) + occurrence; alignment is not a causal proof",
            incomplete:
              !runs.has(a.runA) ||
              !runs.has(a.runB) ||
              (rows[0]?.id || 1) >
                Math.min(
                  runs.get(a.runA)?.start || 0,
                  runs.get(a.runB)?.start || 0,
                ),
          };
        }
        fail("UNKNOWN_ACTION", "Unknown crypto action");
      });
    },
    slice(a: any) {
      return mute(() => {
        if (disposed && ["start", "watchProperty"].includes(a.action))
          fail("ANALYSIS_STOPPED", "Start a fresh analysis realm");
        if (a.action === "list")
          return {
            runs: [...runs.values()],
            properties: [...properties.values()].map((p) => ({
              propertyId: p.id,
              active: p.active,
              restore: p.restore,
            })),
          };
        if (a.action === "read")
          return {
            ...read(a),
            representation:
              "observed execution slice; not devirtualized source",
            unobserved: [
              "JS opcodes",
              "direct + concatenation",
              "arbitrary object reads/writes",
              "unhooked closure-local crypto",
            ],
          };
        if (a.action === "watchProperty") return propertyWatch(a);
        if (a.action === "removeProperty") {
          const p = properties.get(a.propertyId);
          if (!p) fail("PROPERTY_NOT_FOUND", "Unknown property watch");
          return { propertyId: p.id, restore: restore(p) };
        }
        if (a.action === "stop") {
          const r = runs.get(a.runId);
          if (!r) fail("RUN_NOT_FOUND", "Unknown run");
          r.remaining = 0;
          return { runId: r.id, restore: restore(r.patch) };
        }
        if (runs.size >= 100) fail("RUN_LIMIT", "At most 100 runs per realm");
        const t = validateTap({ plan: a.plan });
        for (const spec of a.probes || []) validateTap(spec);
        const run: any = {
          id: "run-" + ++idSeq,
          start: seq + 1,
          calls: 0,
          remaining: a.count,
        };
        const installed: any[] = [];
        try {
          for (const probe of a.probes || []) {
            const x = resolve(probe.plan);
            installed.push(
              tap(x.obj, x.name, probe.algo, {
                ...probe,
                kind: "probe",
                ttlMs: a.ttlMs,
              }),
            );
          }
          const p = tap(
            t.obj,
            t.name,
            "slice-root",
            { kind: "root", ttlMs: a.ttlMs },
            run,
          );
          D(run, "patch", { value: p });
          runs.set(run.id, run);
          return {
            runId: run.id,
            cursor: seq,
            status: "armed",
            doesNotInvoke: true,
          };
        } catch (e) {
          for (const p of installed) if (p) restore(p);
          throw e;
        }
      });
    },
    oracle(a: any): any {
      if (a.action === "list")
        return { oracles: [...oracles.values()].map(({ fn, obj, ...x }) => x) };
      if (a.action === "export")
        return mute(() => {
          if (disposed)
            fail("ANALYSIS_STOPPED", "Start a fresh analysis realm");
          if (oracles.size >= 64) fail("ORACLE_LIMIT", "At most 64 oracles");
          const t = resolve(a.plan);
          if (typeof t.value !== "function")
            fail("TARGET_NOT_FUNCTION", "Oracle target is not a function");
          const id = "oracle-" + realmId + "-" + ++idSeq;
          oracles.set(id, {
            id,
            fn: t.value,
            obj: t.obj,
            expiresAt: now() + a.ttlMs,
          });
          return {
            oracleId: id,
            scope: "current realm and session",
            standalone: false,
            doesNotInvoke: true,
          };
        });
      const o = oracles.get(a.oracleId);
      if (!o) fail("ORACLE_NOT_FOUND", "Oracle is absent or expired");
      if (a.action === "remove") {
        oracles.delete(o.id);
        return { oracleId: o.id, status: "removed" };
      }
      if (o.expiresAt <= now()) {
        oracles.delete(o.id);
        fail("ORACLE_EXPIRED", "Export the current function again");
      }
      // Exactly one explicit call; no handler replay and no automatic retries.
      const result = A(o.fn, o.obj, a.args);
      if (a.awaitPromise && result instanceof Promise)
        return A(Promise.prototype.then, result, [
          (v: any) =>
            mute(() => ({ oracleId: o.id, result: snap(v), calls: 1 })),
        ]);
      return mute(() => ({
        oracleId: o.id,
        result: snap(result),
        calls: 1,
        promisePending: result instanceof Promise,
      }));
    },
  };
  D(g, "__wxappBootAnalysisV1", {
    value: freeze(api),
    configurable: false,
    writable: false,
  });
  g.__wxappControlledHooksV1?.coordinate?.(api);
  mute(() => {
    try {
      if (options.defeatAntiHook) guardIntrinsics();
      if (options.randomSeed !== undefined) pinRandom();
      if (options.now !== undefined) {
        const OriginalDate = Date;
        replace(OriginalDate, "now", () => () => options.now);
        const datePatch = replace(
          g,
          "Date",
          () =>
            new Proxy(OriginalDate, {
              apply() {
                return new OriginalDate(options.now).toString();
              },
              construct(target, args, newTarget) {
                return C(target, args.length ? args : [options.now], newTarget);
              },
            }),
        );
        const ctor = replace(
          OriginalDate.prototype,
          "constructor",
          () => datePatch.wrapper,
        );
        D(OriginalDate.prototype, "constructor", {
          ...G(OriginalDate.prototype, "constructor"),
          value: datePatch.wrapper,
        });
        ctor.wrapper = datePatch.wrapper;
      }
      if (typeof g.define === "function")
        replace(
          g,
          "define",
          (original: any) =>
            new Proxy(original, {
              apply(fn, receiver, args) {
                const input = [...args],
                  index = input.findIndex(
                    (v: any, i: number) => i > 0 && typeof v === "function",
                  );
                if (index >= 0 && typeof input[0] === "string") {
                  const name = input[0],
                    factory = input[index];
                  if (!moduleStates.has(name))
                    moduleStates.set(name, "defined");
                  input[index] = new Proxy(factory, {
                    apply(f, self, argv) {
                      moduleStates.set(name, "executing");
                      let result: any;
                      try {
                        result = A(f, self, argv);
                      } catch (e) {
                        moduleStates.set(name, "failed");
                        throw e;
                      }
                      try {
                        mute(() => observeModule(argv[1], name, factory));
                      } catch (e: any) {
                        notice("module scan: " + e.message);
                      }
                      return result;
                    },
                  });
                }
                return A(fn, receiver, input);
              },
            }),
        );
      if (options.cryptoTap)
        for (const name of [
          "CryptoJS",
          "crypto",
          "forge",
          "nacl",
          "JSEncrypt",
          "sm2",
          "sm3",
          "sm4",
          "aesjs",
        ]) {
          scan(g[name], name, !!options.observePromise);
          watchGlobal(name);
        }
      for (const spec of pending)
        if (spec.plan.root !== "module") explicit(spec);
    } catch (e: any) {
      initializationFailure = {
        code: e.code || "ANALYSIS_BOOT_FAILED",
        message: e.message,
      };
      for (const p of [...patches].reverse()) restore(p);
      disposed = true;
      throw e;
    }
  });
  return api;
}
