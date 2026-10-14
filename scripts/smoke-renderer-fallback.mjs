import { managedFixture } from "./managed-test-runtime.mjs";
import { componentFixture } from "./component-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-renderer-"));
const pkg = componentFixture(directory, "glass-easel");
const file = path.join(pkg, "app-config.json");
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.renderer = { default: "skyline" };
fs.writeFileSync(file, JSON.stringify(config));
const original = fs.readFileSync(file, "utf8");
let t;
try {
  t = await managedFixture({ packageDir: pkg });
  const { call } = t;
  await call("runner_wait", { kind: "text", text: "nested:child:1" });
  const status = await call("runner_status");
  assert.equal(status.current.declaredRenderer, "skyline");
  assert.equal(status.current.effectiveRenderer, "webview");
  const runtime = await call("runner_evaluate", {
    expression: `({renderer:getCurrentPages()[0].renderer,noDOM:typeof document==='undefined',skyline:wx.getSkylineInfoSync(),hasWorklet:!!wx.worklet,canUseWorklet:wx.canIUse('worklet')})`,
  });
  assert.equal(runtime.result.value.renderer, "webview");
  assert.equal(runtime.result.value.noDOM, true);
  assert.equal(runtime.result.value.hasWorklet, false);
  assert.equal(runtime.result.value.canUseWorklet, false);
  assert.equal(runtime.result.value.skyline.isSupported, false);
  assert.equal(runtime.result.value.skyline.reason, "client not supported");
  const callbacks = await call("runner_evaluate", {
    expression: `new Promise(resolve=>{const events=[];wx.getSkylineInfo({success:r=>events.push({callback:'success',supported:r.isSupported}),fail:r=>events.push({callback:'fail'}),complete:r=>{events.push({callback:'complete',supported:r.isSupported});resolve(events)}})})`,
    awaitPromise: true,
  });
  assert.deepEqual(callbacks.result.value, [
    { callback: "success", supported: false },
    { callback: "complete", supported: false },
  ]);
  await call("runner_click", { text: "nested:child:1" });
  await call("runner_wait", { kind: "text", text: "nested:child:2" });
  assert.equal(fs.readFileSync(file, "utf8"), original);
  const report = {
    passed: true,
    platform: process.platform,
    declaredSkylineActualWebView: true,
    originalConfigPreserved: true,
    realNestedComponentClickAndSetData: true,
    logicWithoutDOM: true,
    nativeSkylineInfoSyncAndCallbacks: true,
  };
  fs.writeFileSync(
    "docs/renderer-fallback-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  if (t) await t.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
