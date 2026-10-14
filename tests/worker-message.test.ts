import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createWorkerMessageAdopter } from "../src/loader/worker-message";

test("Worker message realm preserves cycles, collection keys, sparse arrays and binary aliases", () => {
  const realm = vm.createContext({}),
    adopt = createWorkerMessageAdopter(realm);
  const b = new ArrayBuffer(16),
    key = { label: "key" };
  const input: any = {
    b,
    same: b,
    byte: new Uint8Array(b, 2, 6),
    view: new DataView(b, 4, 4),
    big: new BigInt64Array(b),
    key,
    map: new Map([[key, b]]),
    set: new Set([key]),
    array: [, key],
    date: new Date(1234),
    regex: /中文/gi,
    error: new TypeError("cause", { cause: key }),
  };
  input.self = input;
  realm.message = adopt(structuredClone(input));
  assert.equal(
    vm.runInContext(
      `(()=>{const m=message;
    m.view.setUint8(0,77);m.map.get(m.key);return m instanceof Object && m.self===m &&
    m.b instanceof ArrayBuffer && m.same===m.b && m.byte.buffer===m.b && m.view.buffer===m.b &&
    m.big instanceof BigInt64Array && m.big.buffer===m.b && m.byte[2]===77 &&
    m.map instanceof Map && m.map.get(m.key)===m.b && m.set instanceof Set && m.set.has(m.key) &&
    m.array instanceof Array && !(0 in m.array) && m.array[1]===m.key &&
    m.date instanceof Date && m.date.getTime()===1234 && m.regex instanceof RegExp &&
    m.error instanceof TypeError && m.error.cause===m.key})()`,
      realm,
    ),
    true,
  );
  assert.equal(new Uint8Array(b)[4], 0, "ordinary ArrayBuffer remains copied");
  assert.equal(
    Object.getPrototypeOf(input),
    Object.prototype,
    "sender graph not reparented",
  );
});

test("shared buffers share memory while adopting a separate receiver wrapper", () => {
  const realm = vm.createContext({}),
    adopt = createWorkerMessageAdopter(realm);
  const b = new SharedArrayBuffer(16);
  realm.message = adopt(
    structuredClone({ b, ints: new Int32Array(b), again: b }),
  );
  assert.equal(
    vm.runInContext(
      `message.b instanceof SharedArrayBuffer && message.b===message.again &&
    message.ints instanceof Int32Array && message.ints.buffer===message.b`,
      realm,
    ),
    true,
  );
  vm.runInContext("Atomics.store(message.ints,1,123)", realm);
  assert.equal(Atomics.load(new Int32Array(b), 1), 123);
  assert.equal(Object.getPrototypeOf(b), SharedArrayBuffer.prototype);
});

test("Worker adopter captures constructors before base-library global cleanup", () => {
  const realm = vm.createContext({}),
    adopt = createWorkerMessageAdopter(realm);
  vm.runInContext(
    "globalThis.savedArray=Array;globalThis.Array=undefined;globalThis.Map=undefined",
    realm,
  );
  realm.message = adopt(structuredClone([1, 2]));
  assert.equal(vm.runInContext("message instanceof savedArray", realm), true);
});
