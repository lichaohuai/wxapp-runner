import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createWxShim } from "../src/wx-shim";
import { bridgeWxToRealm } from "../src/wx-shim/realm";
import { RunnerError, diagnostic } from "../src/diagnostics";
test("wx preserves guest namespace queues and missing properties while SDK-only APIs retain their own failure contract", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-namespace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let called = false;
  const logs: string[] = [];
  const shim = createWxShim(
    {
      knownOptionalAPI(o: any) {
        called = true;
        queueMicrotask(() =>
          o.fail?.({
            errMsg: "knownOptionalAPI:fail native backend unavailable",
          }),
        );
      },
    },
    {
      dataDir: dir,
      packageDir: dir,
      storageFile: path.join(dir, "storage.json"),
      app: {},
    },
    async () => ({}),
    (s) => logs.push(s),
  );
  const ctx = vm.createContext({});
  ctx.wx = bridgeWxToRealm(ctx, shim);
  assert.equal(
    vm.runInContext(
      "wx.missingCache===undefined && wx[Symbol.iterator]===undefined && wx.then===undefined",
      ctx,
    ),
    true,
  );
  assert.equal(
    vm.runInContext(
      "wx.queue=wx.queue||[];wx.queue.push(4);wx.queue instanceof Array && wx.queue.length===1",
      ctx,
    ),
    true,
  );
  assert.equal(
    await vm.runInContext(
      'new Promise(resolve=>wx.knownOptionalAPI({fail:e=>resolve(e.errMsg.includes("fail"))}))',
      ctx,
    ),
    true,
  );
  assert.equal(called, true);
  assert.deepEqual(logs, []);
  assert.equal(shim.canIUse("knownOptionalAPI"), false);
});
test("boot diagnostics preserve cross-realm cause and original source location", () => {
  let cause;
  try {
    vm.runInNewContext(
      'throw new TypeError("fixture failure")',
      {},
      { filename: "fixture-business.js" },
    );
  } catch (e) {
    cause = e;
  }
  const error = new RunnerError(
    diagnostic(
      "SCRIPT_EXECUTION_FAILED",
      "logic",
      "fixture failure",
      "Inspect original source",
    ),
    cause,
  );
  assert.equal(error.cause, cause);
  assert.match(error.stack!, /Caused by:.*fixture-business.js/s);
});
test("renderer UA resolves to a string and preserves the object callback contract in the guest realm", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-ua-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const shim = createWxShim(
    {},
    {
      dataDir: dir,
      packageDir: dir,
      storageFile: path.join(dir, "storage.json"),
      app: {},
    },
    async (name) => {
      assert.equal(name, "getRendererUserAgent");
      calls++;
      return { userAgent: "actual-renderer-fixture" };
    },
    () => {},
  );
  const ctx = vm.createContext({});
  ctx.wx = bridgeWxToRealm(ctx, shim);
  const result = await vm.runInContext(
    `(async()=>{
    let callback, complete=0;
    const value=await wx.getRendererUserAgent({success:r=>callback=r,complete:()=>complete++});
    return {value,callback:callback.userAgent,ok:callback.errMsg,local:callback instanceof Object,complete};
  })()`,
    ctx,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    value: "actual-renderer-fixture",
    callback: "actual-renderer-fixture",
    ok: "getRendererUserAgent:ok",
    local: true,
    complete: 1,
  });
  assert.equal(calls, 1);
});

test("plugin page navigation preserves the official code-space resolver and callback identity", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-plugin-navigation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls: any[] = [];
  const original: any = {};
  for (const name of ["navigateTo", "redirectTo", "switchTab", "reLaunch"])
    original[name] = function (this: any, options: any) {
      assert.equal(this, original);
      calls.push({ name, options });
      return "sdk-result";
    };
  const rpcCalls: any[] = [];
  const shim = createWxShim(
    original,
    {
      dataDir: dir,
      packageDir: dir,
      storageFile: path.join(dir, "storage.json"),
      app: {},
    },
    async (name, args) => {
      rpcCalls.push({ name, args });
      return {};
    },
    () => {},
  );
  for (const name of Object.keys(original)) {
    const options = {
      url: "plugin://example/public-page?q=a%2Bb",
      success() {},
    };
    assert.equal(shim[name](options), "sdk-result");
    assert.equal(calls.at(-1).options, options);
  }
  assert.equal(rpcCalls.length, 0);
  await shim.navigateTo({ url: "../detail?q=a+b" });
  assert.deepEqual(rpcCalls, [
    { name: "navigateTo", args: { url: "../detail?q=a+b" } },
  ]);
});
