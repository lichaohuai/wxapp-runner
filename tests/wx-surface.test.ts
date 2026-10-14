import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createWxShim } from "../src/wx-shim";
import { bridgeWxToRealm } from "../src/wx-shim/realm";

test("copied wx namespaces retain SDK entries and original failure callbacks across realms", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-wx-surface-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const original = {
    marker: "original-receiver",
    getLogManager() {
      assert.equal(this.marker, "original-receiver");
      return { log: (s: string) => calls.push(s) };
    },
    createAnimation() {
      return { step: () => "step" };
    },
    loadFontFace(o: any) {
      calls.push("original-font-entry");
      queueMicrotask(() => {
        const r = { errMsg: "loadFontFace:fail native backend unavailable" };
        o.fail?.(r);
        o.complete?.(r);
      });
    },
    worklet() {
      throw Error("absent in WebView");
    },
  };
  const host = createWxShim(
    original,
    {
      app: {},
      packageDir: dir,
      dataDir: dir,
      storageFile: path.join(dir, "storage.json"),
    },
    async () => ({}),
    (...a) => calls.push(a.join(" ")),
  );
  const context = vm.createContext({});
  context.wx = bridgeWxToRealm(context, host);
  const result = await vm.runInContext(
    `new Promise(resolve=>{
    const copy={};for(const name in wx)copy[name]=wx[name];
    copy.getLogManager().log('from-copy');
    let failed=0;
    copy.loadFontFace({fail(r){failed++;globalThis.error=r.errMsg},complete(){resolve({failed,error:globalThis.error,step:copy.createAnimation().step(),available:wx.canIUse('loadFontFace'),worklet:'worklet' in copy})}});
  })`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    failed: 1,
    error: "loadFontFace:fail native backend unavailable",
    step: "step",
    available: false,
    worklet: false,
  });
  assert.ok(calls.includes("from-copy"));
  assert.ok(calls.includes("original-font-entry"));
  assert.equal(
    vm.runInContext(
      `Object.assign({},wx).getLogManager instanceof Function`,
      context,
    ),
    true,
  );
});
