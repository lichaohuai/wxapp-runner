import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
if (!process.argv[2]) throw Error("Pass private wxbot configuration explicitly");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const t = await managedFixture({
  packageDir: path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })())),
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(),
  config
});
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  remoteWrites: false,
  checks: []
};
try {
  const registry = await t.call("runner_device", {
    action: "capabilities"
  });
  fs.writeFileSync("docs/capability-registry.json", JSON.stringify({
    at: report.at,
    profile: registry.profile,
    simulationEnabled: registry.simulationEnabled,
    apiRegistry: registry.apiRegistry,
    nativeEffects: registry.nativeEffects,
    acceptance: registry.acceptance
  }, null, 2) + "\n");
  for (const args of [{
    operation: "function",
    name: "login",
    data: {},
    confirm: true
  }, {
    operation: "databaseQuery",
    collection: "todos",
    limit: 1
  }]) {
    const start = await t.call("runner_cloud", {
      action: "start",
      ...args
    });
    assert.equal(start.status, "submitted");
    assert.equal(start.businessCompleted, false);
    const job = await until(async () => {
      const j = await t.call("runner_cloud", {
        action: "get",
        jobId: start.jobId
      });
      return j.state !== "pending" && j;
    }, 60000);
    const row = {
      operation: args.operation,
      jobId: start.jobId,
      state: job.state,
      status: job.state === "complete" ? "验收通过" : "失败",
      sdkCompleted: job.sdkCompleted === true,
      errorCode: job.error?.errCode || job.error?.remoteCode || null,
      hasArrayResult: Array.isArray(job.result?.data)
    };
    report.checks.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  fs.writeFileSync("docs/cloud-jobs-result.json", JSON.stringify(report, null, 2) + "\n");
  await t.close();
}
