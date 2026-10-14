import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { vmFunction } from "./serialize";
/** Optional standard WebCrypto facade. Keys stay opaque; never export key material for taps. */
export function installAnalysisWebCrypto(context: vm.Context) {
  if (vm.runInContext('typeof crypto!=="undefined"', context)) return;
  const host = {
    random: (a: any) => webcrypto.getRandomValues(a),
    call: (name: string, args: any[]) =>
      Reflect.apply((webcrypto.subtle as any)[name], webcrypto.subtle, args),
  };
  vm.runInContext(vmFunction(cryptoRealm), context)(host);
}
function cryptoRealm(host: any) {
  const keyMap = new WeakMap<object, any>();
  const copy = (v: any): any => {
    const tag = Object.prototype.toString.call(v);
    if (tag === "[object ArrayBuffer]") {
      const a = new ArrayBuffer(v.byteLength);
      new Uint8Array(a).set(new Uint8Array(v));
      return a;
    }
    if (tag === "[object CryptoKey]") {
      const key = Object.freeze({
        type: v.type,
        extractable: v.extractable,
        algorithm: JSON.parse(JSON.stringify(v.algorithm)),
        usages: [...v.usages],
      });
      keyMap.set(key, v);
      return key;
    }
    if (v && typeof v === "object")
      return Array.isArray(v)
        ? v.map(copy)
        : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
  };
  const unwrap = (v: any): any => {
    if (v && typeof v === "object" && keyMap.has(v)) return keyMap.get(v);
    if (v && Object.getPrototypeOf(v) === Object.prototype)
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, unwrap(x)]),
      );
    return v;
  };
  const subtle: any = {};
  for (const name of [
    "digest",
    "sign",
    "verify",
    "encrypt",
    "decrypt",
    "generateKey",
    "deriveBits",
    "deriveKey",
    "importKey",
    "exportKey",
    "wrapKey",
    "unwrapKey",
  ])
    subtle[name] = function (...args: any[]) {
      return Promise.resolve()
        .then(() => host.call(name, args.map(unwrap)))
        .then(copy);
    };
  Object.defineProperty(globalThis, "crypto", {
    value: {
      getRandomValues: function (a: any) {
        host.random(a);
        return a;
      },
      subtle,
    },
    configurable: true,
    writable: true,
  });
}
