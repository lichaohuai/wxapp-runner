import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { bridgeWxToRealm } from "../src/wx-shim/realm";
import { unsupported } from "../src/wx-shim/unsupported";

test("host responses, storage and binary data use business-realm constructors without truncation", async () => {
  const context = vm.createContext({});
  const records = Array.from({ length: 80 }, (_, i) => ({
    name: `条目${i}`,
    text: "中文😀".repeat(4000),
  }));
  const shared = { nested: [1, 2] };
  context.wx = bridgeWxToRealm(context, {
    request(o: any) {
      queueMicrotask(() => {
        o.success({ data: records });
        o.complete({});
      });
      return { abort() {} };
    },
    getStorageSync: () => shared,
    binary: () => new Uint8Array([1, 2, 3]).buffer,
    typed: () => new Uint16Array([1000, 2000]),
    promise: async () => ({ nested: [3] }),
    fail() {
      throw Object.assign(new Error("test failure"), {
        runnerCode: "EXPECTED",
      });
    },
  });
  assert.equal(
    await vm.runInContext(
      `new Promise(resolve=>{let calls=0;wx.request({success:r=>{globalThis.records=r.data;calls++;},complete:()=>resolve(calls===1&&records instanceof Array&&records[0] instanceof Object&&records[79].text.length===16000)})})`,
      context,
    ),
    true,
  );
  assert.equal(
    vm.runInContext(
      "wx.getStorageSync().nested instanceof Array && wx.binary() instanceof ArrayBuffer && wx.typed() instanceof Uint16Array",
      context,
    ),
    true,
  );
  shared.nested.push(3);
  assert.equal(
    vm.runInContext("wx.getStorageSync().nested.length", context),
    3,
  );
  assert.equal(
    await vm.runInContext(
      "wx.promise().then(r=>r.nested instanceof Array)",
      context,
    ),
    true,
  );
  assert.equal(
    vm.runInContext(
      "(()=>{try{wx.fail()}catch(e){return e instanceof Error&&e.runnerCode==='EXPECTED'}})()",
      context,
    ),
    true,
  );
});

test("task receivers, on/off callback identity and base-library APIs survive the realm bridge", () => {
  const context = vm.createContext({});
  const listeners = new Set<Function>();
  const native = vm.runInContext(
    "({marker:[],call(){return this.marker}})",
    context,
  );
  context.wx = bridgeWxToRealm(context, {
    cloud: native,
    createTask() {
      return {
        count: 0,
        increment() {
          return ++this.count;
        },
        on(fn: Function) {
          listeners.add(fn);
        },
        off(fn: Function) {
          listeners.delete(fn);
        },
      };
    },
  });
  assert.equal(
    vm.runInContext("wx.cloud.call()===wx.cloud.marker", context),
    true,
  );
  assert.equal(
    vm.runInContext(
      "globalThis.task=wx.createTask();task.increment()+task.increment()",
      context,
    ),
    3,
  );
  vm.runInContext(
    "globalThis.listener=v=>{globalThis.delivered=v instanceof Object && v.items instanceof Array};task.on(listener)",
    context,
  );
  for (const fn of listeners) fn({ items: [1] });
  assert.equal(context.delivered, true);
  vm.runInContext("task.off(listener)", context);
  assert.equal(listeners.size, 0);
});
test("optional unsupported managers retain their dynamic methods and explicit failure", async () => {
  const context = vm.createContext({});
  const logs: string[] = [];
  context.wx = bridgeWxToRealm(context, {
    createOptional: unsupported("createOptional", (s: string) => logs.push(s)),
  });
  assert.equal(
    await vm.runInContext(
      "(async()=>{const manager=wx.createOptional();manager.onError(()=>{});try{await manager.load()}catch(e){return e.errMsg.includes('not implemented')}})()",
      context,
    ),
    true,
  );
  assert.ok(logs.some((s) => s.includes("onError")));
});

test("guest wx properties preserve descriptors, accessors, deletion and freeze invariants", () => {
  const host = {
    request() {
      return { data: [1] };
    },
    optional() {
      return 2;
    },
  };
  const context = vm.createContext({});
  context.wx = bridgeWxToRealm(context, host);
  assert.equal(
    vm.runInContext(
      `(()=>{const original=wx.request;Object.defineProperty(wx,'request',{value:original});return wx.request===original && wx.request().data instanceof Array})()`,
      context,
    ),
    true,
  );
  assert.equal(
    vm.runInContext(
      `(()=>{let value=3;Object.defineProperty(wx,'state',{get(){return value},set(v){value=v},configurable:true});wx.state=4;return wx.state===4 && delete wx.state && wx.state===undefined})()`,
      context,
    ),
    true,
  );
  assert.equal(
    vm.runInContext(
      `delete wx.optional && wx.optional===undefined && !('optional' in wx)`,
      context,
    ),
    true,
  );
  assert.equal(
    vm.runInContext(
      `Object.freeze(wx);Object.isFrozen(wx) && wx.request().data[0]===1`,
      context,
    ),
    true,
  );
  assert.throws(
    () => vm.runInContext(`'use strict';wx.request=()=>{};`, context),
    { name: "TypeError" },
  );
  assert.equal(host.optional(), 2);
});
