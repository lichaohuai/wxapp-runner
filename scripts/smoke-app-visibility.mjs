import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { isolatedRuntime } from "./test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import { until } from "./managed-test-runtime.mjs";
const isolated = isolatedRuntime(),
  pkg = interactionFixture(isolated.directory, "http://127.0.0.1:1/unused");
const service = path.join(pkg, "app-service.js");
let source = fs.readFileSync(service, "utf8");
assert.ok(source.includes("App({"));
source = source.replace("App({", 'App({onShow(){console.log("visibility-app-show");},onHide(){console.log("visibility-app-hide");},');
source += `
const removed=()=>console.log('visibility-removed-listener');
wx.onAppShow(removed);wx.offAppShow(removed);wx.onAppHide(removed);wx.offAppHide(removed);
wx.onAppShow(()=>console.log('visibility-sdk-show'));
wx.onAppHide(()=>console.log('visibility-sdk-hide'));
`;
source = source.replace("Page({data:", 'Page({onReady(){console.log("visibility-page-ready")},data:');
fs.writeFileSync(service, source);
let app;
const logs = [];
try {
  app = await electron.launch({
    cwd: process.cwd(),
    env: isolated.env,
    args: [".", "--package", pkg, "--appid", process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(), ...isolated.args]
  });
  await app.evaluate(async ({
    app
  }) => {
    await app.whenReady();
  });
  app.process().stdout.on("data", b => logs.push(String(b)));
  app.process().stderr.on("data", b => logs.push(String(b)));
  const count = marker => logs.join("").split(/\r?\n/).filter(line => line === marker).length;
  await until(() => logs.join("").includes("visibility-page-ready"));
  const baseline = count("visibility-app-show");
  const sdkBaseline = count("visibility-sdk-show");
  await app.evaluate(({
    BrowserWindow
  }) => BrowserWindow.getAllWindows()[0].hide());
  await until(() => logs.join("").includes("visibility-app-hide"));
  await app.evaluate(({
    BrowserWindow
  }) => BrowserWindow.getAllWindows()[0].show());
  await until(() => count("visibility-app-show") > baseline);
  await until(() => count("visibility-sdk-show") > sdkBaseline && count("visibility-sdk-hide") === 1);
  assert.equal(count("visibility-sdk-show"), sdkBaseline + 1);
  assert.equal(count("visibility-removed-listener"), 0);
  assert.equal(count("visibility-app-hide"), 1);
  assert.equal(count("visibility-app-show"), baseline + 1);
  const report = {
    passed: true,
    platform: process.platform,
    actualHideRestore: true,
    originalSdkListeners: true,
    removedListenersNotCalled: true,
    onHideOnce: true,
    onShowOnceAfterRestore: true
  };
  fs.writeFileSync("docs/app-visibility-result.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} catch (e) {
  console.error(logs.join("").slice(-10000));
  throw e;
} finally {
  await app?.close();
  isolated.cleanup();
}
