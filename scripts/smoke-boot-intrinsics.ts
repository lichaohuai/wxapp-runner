import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readConfig } from "../src/config";
import { inspectPackage } from "../src/loader";
import { LogicInspector } from "../src/mcp/inspector";
const packageDir = path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })())),
  script = path.join(packageDir, "app-service.js");
const fingerprint = () => createHash("sha256").update(fs.readFileSync(script)).digest("hex");
const before = fingerprint();
async function run(mode: "normal" | "analysis" | "too-late") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-boot-intrinsics-"));
  fs.writeFileSync(path.join(tmp, "config.json"), "{}");
  const cfg: any = readConfig(["--package", packageDir, "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--config", path.join(tmp, "config.json"), "--user-data", tmp]);
  for (const key of ["wxbot", "appKey", "appSecret", "deviceId"]) delete cfg[key];
  cfg.dataDir = path.join(tmp, "files");
  cfg.storageFile = path.join(tmp, "storage.json");
  cfg.plan = inspectPackage(cfg);
  cfg.managedBoot = true;
  cfg.analysis = mode === "normal" ? {
    enabled: false
  } : {
    enabled: true,
    defeatAntiHook: mode === "analysis",
    cryptoTap: true,
    ttlMs: 120000,
    capacity: 2000,
    captureBytes: 4096,
    bootScript: "globalThis.__bootChar=String.prototype.charCodeAt;",
    taps: [{
      target: "String.prototype.charCodeAt",
      algo: "fixture-charCodeAt"
    }, {
      target: "String.fromCharCode",
      algo: "fixture-fromCharCode"
    }, {
      target: "encodeURIComponent",
      algo: "fixture-encodeURIComponent"
    }]
  };
  const inspector = new LogicInspector();
  const worker = new Worker(path.resolve("dist/logic.cjs"), {
    workerData: cfg,
    stdout: true,
    stderr: true
  });
  const errors: any[] = [];
  let blockedRpc = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result: any = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(Error("boot timeout")), 15000);
      worker.on("error", reject);
      worker.on("message", m => {
        if (m.type === "structured-log" && m.level === "error") errors.push(m);
        // No route/onLaunch is sent. Every native/transport action is rejected before
        // transmission. The actual package and baselib are executed without edits.
        if (m.type === "rpc") {
          blockedRpc++;
          worker.postMessage({
            type: "rpc-result",
            id: m.id,
            error: "Offline regression: action blocked"
          });
        }
        if (m.type === "inspector-ready") void inspector.connect(m.url).then(() => worker.postMessage({
          type: "boot-continue"
        }), reject);
        if (["ready", "fatal"].includes(m.type)) {
          clearTimeout(timeout);
          resolve(m);
        }
      });
    });
    const context = [...inspector.contexts.values()].find(c => c.name.includes("Mini-program business"));
    assert.ok(context);
    const evaluate = async (expression: string) => {
      const r = await inspector.raw("Runtime.evaluate", {
        contextId: context.id,
        returnByValue: true,
        expression
      });
      assert.ok(!r.exceptionDetails, r.exceptionDetails?.text);
      return r.result.value;
    };
    if (mode === "too-late") {
      assert.equal(result.type, "fatal");
      assert.equal(result.error.code, "ACCESSOR_TARGET");
      assert.ok(result.error.stack.includes("wxapp-analysis-runtime"));
      assert.ok(errors.some(e => e.args?.[0] === "BOOT ERROR"));
      return {
        mode,
        expectedFailure: true,
        structuredError: true
      };
    }
    assert.equal(result.type, "ready", result.message);
    assert.equal(await evaluate("!!getApp()"), true);
    const kind = await evaluate(`'value' in Object.getOwnPropertyDescriptor(String.prototype,'charCodeAt')?'data':'accessor'`);
    if (mode === "normal") {
      assert.equal(kind, "accessor");
      return {
        mode,
        appRegistered: true,
        intrinsicKind: kind
      };
    }
    assert.equal(kind, "data");
    assert.equal(await evaluate("String.prototype.nv_charCodeAt===__bootChar"), true);
    const status = await evaluate("__wxappBootAnalysisV1.status()");
    assert.ok(status.preparation.skippedAccessors > 0);
    for (const name of ["fixture-charCodeAt", "fixture-fromCharCode", "fixture-encodeURIComponent"]) assert.ok(status.taps.some((t: any) => t.label === name));
    const cursor = status.latestCursor;
    assert.equal(await evaluate(`String.prototype.nv_charCodeAt.call('AB',1)`), 66);
    const md5 = await evaluate(`require('utils/md5.min.js')('boot-intrinsics-fixture')`);
    assert.equal(md5, createHash("md5").update("boot-intrinsics-fixture").digest("hex"));
    const records = await evaluate(`__wxappBootAnalysisV1.read({after:${cursor},limit:100}).entries`);
    assert.ok(records.some((e: any) => e.algo === "module:utils/md5.min.js" && e.input === "boot-intrinsics-fixture" && e.output === md5));
    await evaluate(`__wxappBootAnalysisV1.command({action:'stop'})`);
    const stopped = await evaluate("__wxappBootAnalysisV1.status().latestCursor");
    assert.equal(await evaluate(`String.prototype.nv_charCodeAt.call('AB',0)`), 65);
    assert.equal(await evaluate("__wxappBootAnalysisV1.status().latestCursor"), stopped);
    return {
      mode,
      appRegistered: true,
      intrinsicKind: kind,
      nvAliasCapturedBootWrapper: true,
      configuredTapsInstalled: true,
      realMd5Captured: true,
      stopDisablesAlias: true,
      reservedSlots: status.preparation.skippedAccessors,
      bootExhaustedTaps: status.taps.filter((t: any) => t.remaining === 0).map((t: any) => t.label),
      blockedRpc
    };
  } finally {
    clearTimeout(timeout);
    inspector.close();
    await worker.terminate();
    fs.rmSync(tmp, {
      recursive: true,
      force: true
    });
  }
}
const scenarios = [];
for (const mode of ["normal", "too-late", "analysis"] as const) scenarios.push(await run(mode));
assert.equal(fingerprint(), before);
const report = {
  passed: true,
  date: new Date().toISOString(),
  platform: process.platform,
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(),
  packageSha256: before,
  packageUnchanged: true,
  realBaselib: true,
  noAppLaunchOrRoutes: true,
  externalRequests: 0,
  scenarios
};
fs.writeFileSync("docs/boot-intrinsics-result.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
