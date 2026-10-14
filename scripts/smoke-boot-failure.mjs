import assert from "node:assert/strict";
import fs from "node:fs";
import { managedFixture, until } from "./managed-test-runtime.mjs";
const t = await managedFixture();
try {
  const original = await t.call("runner_status");
  const failed = await t.call("runner_runtime", {
    action: "start",
    packageDir: original.packageDir,
    appid: original.appid,
    analysis: {
      enabled: true,
      defeatAntiHook: true,
      bootScript: 'throw new Error("BOOT_FIXTURE_FAILED")',
    },
  });
  const state = await until(async () => {
    const s = await t.call("runner_status", { runtimeId: failed.runtimeId });
    return s.state === "failed" && s;
  });
  assert.equal(state.serviceReady, false);
  assert.equal(state.logicFailure.diagnostic.code, "LOGIC_BOOT_FAILED");
  assert.equal(state.logicFailure.error.message, "BOOT_FIXTURE_FAILED");
  assert.match(state.logicFailure.error.stack, /wxapp-analysis-boot/);
  const errors = [];
  let after = 0;
  for (;;) {
    const logs = await t.call("runner_logs", {
      runtimeId: failed.runtimeId,
      level: "error",
      limit: 200,
      after,
    });
    errors.push(...logs.entries);
    after = logs.nextCursor;
    if (!logs.hasMore) break;
  }
  assert.ok(JSON.stringify(errors).includes("BOOT_FIXTURE_FAILED"));
  assert.equal(
    (await t.call("runner_status", { runtimeId: original.runtimeId })).state,
    "running",
  );
  await t.call("runner_debugger", {
    runtimeId: failed.runtimeId,
    action: "open",
  });
  await t.call("runner_runtime", {
    runtimeId: failed.runtimeId,
    action: "restart",
    analysis: { enabled: false },
  });
  const restarted = await until(async () => {
    const s = await t.call("runner_status", { runtimeId: failed.runtimeId });
    return s.state === "running" && s.serviceReady && s;
  });
  assert.notEqual(restarted.sessionId, failed.sessionId);
  assert.ok(!restarted.logicFailure);
  await t.call("runner_runtime", {
    runtimeId: failed.runtimeId,
    action: "stop",
  });
  assert.equal(
    (await t.call("runner_status", { runtimeId: failed.runtimeId })).state,
    "exited",
  );
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    standardMcp: true,
    failedState: true,
    structuredErrorLevelLog: true,
    inspectorAvailable: true,
    restartFromFailed: true,
    stopAndProfileLock: true,
    otherRuntimePreserved: true,
  };
  fs.writeFileSync(
    "docs/boot-failure-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await t.close();
}
