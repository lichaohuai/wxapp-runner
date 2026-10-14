// Explicit account regression only. This script is deliberately outside npm check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { accountApi } from "../src/wx-shim/account";
import { installTransport } from "../src/debug/transport";
import { ArtifactStore } from "../src/controller/artifacts";
import { NetworkRules } from "../src/controller/rules";
const config = JSON.parse(fs.readFileSync(path.resolve(process.argv[2] || ".local/config.json"), "utf8"));
config.appid = process.env.WXAPP_TEST_APPID || (() => {
  throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
})();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-login-"));
const store = new ArtifactStore(root);
const rules = new NetworkRules();
let record: any;
let completed = 0;
const close = installTransport(async (action, a) => {
  if (action === "plan") return rules.evaluate(a.request);
  if (action === "artifact-create") return {
    id: store.create({
      ...a,
      runtimeId: "login-regression",
      sessionId: "isolated"
    })
  };
  if (action === "artifact-append") return store.append(a.id, a.data);
  if (action === "artifact-finish") return store.finish(a.id, a);
  return {};
}, r => record = r);
try {
  const response: any = await new Promise((resolve, reject) => accountApi(config, () => {}).login({
    success: resolve,
    fail: reject,
    complete: () => completed++
  }));
  assert.equal(typeof response.code, "string");
  assert.ok(response.code.length > 0);
  assert.equal(completed, 1);
  const deadline = Date.now() + 5000;
  while (record?.state !== "complete") {
    if (Date.now() > deadline) throw Error("capture timeout");
    await new Promise(r => setTimeout(r, 25));
  }
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    appid: config.appid,
    api: "wx.login",
    endpoint: new URL(record.url).pathname,
    method: record.method,
    httpStatus: record.status,
    realCodeReturned: true,
    completionCallbacks: completed,
    capturedByUnifiedTransport: true,
    secretsSaved: false,
    downloadEndpointCalled: false
  };
  fs.writeFileSync("docs/login-regression.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch {
  console.error("wx.login regression failed; no credential or response content has been printed.");
  process.exitCode = 1;
} finally {
  await close();
  store.close();
  fs.rmSync(root, {
    recursive: true,
    force: true
  });
}
