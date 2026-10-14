import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loader-analysis-"));
let t;
const report = { date: new Date().toISOString(), platform: process.platform };
try {
  const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
  fs.appendFileSync(
    path.join(pkg, "app-service.js"),
    `\ndefine('analysis-fixture.js',function(require,module,exports){var initial=41;exports.run=function(x){if(x>0){return initial+x;}return initial;};});getApp().analysisFixture=require('analysis-fixture.js');`,
  );
  t = await managedFixture({
    packageDir: pkg,
    config: {
      analysis: {
        enabled: true,
        networkMode: "local-only",
        randomSeed: 1234,
        now: 1700000000000,
        execution: {
          enabled: true,
          files: ["app-service.js"],
          modules: ["analysis-fixture.js"],
          capacity: 10000,
          initialization: { enabled: true },
        },
      },
    },
  });
  const boot = await t.call("runner_execution", { action: "status" });
  assert.ok(boot.initialization.count > 0);
  const route = (await t.call("runner_status")).current.route;
  const runs = [],
    outputs = [];
  for (const x of [1, 1, 2]) {
    const job = await t.call("runner_suite", {
      action: "start",
      mode: "analysis",
      steps: [
        {
          tool: "runner_source",
          arguments: {
            action: "locate",
            target: "getApp().analysisFixture.run",
          },
        },
        {
          tool: "runner_oracle",
          arguments: {
            action: "export",
            target: "getApp().analysisFixture.run",
          },
          saveAs: "oracle",
        },
        {
          tool: "runner_execution",
          arguments: { action: "start" },
          saveAs: "capture",
        },
        {
          tool: "runner_oracle",
          arguments: { action: "call", args: [x], revealSensitive: true },
          bind: { oracleId: "oracle.oracleId" },
        },
        {
          tool: "runner_execution",
          arguments: { action: "stop" },
          bind: { runId: "capture.runId" },
        },
        {
          tool: "runner_execution",
          arguments: { action: "read", kinds: ["return"], limit: 1 },
          bind: { runId: "capture.runId" },
          saveAs: "returns",
        },
        {
          tool: "runner_execution",
          arguments: { action: "dependencies" },
          bind: { eventId: "returns.entries.0.id" },
        },
        {
          tool: "runner_execution",
          arguments: { action: "explain", paged: true, maxNodes: 100 },
          bind: { eventId: "returns.entries.0.id" },
        },
      ],
    });
    const done = await until(async () => {
      const r = await t.call("runner_suite", { action: "get", jobId: job.id });
      return r.state !== "running" && r;
    });
    assert.equal(done.results[0].status, "验收通过", JSON.stringify(done));
    const evidence = done.results[0].evidence;
    runs.push(
      evidence.find((e) => e.tool === "runner_execution" && e.result.runId)
        ?.result.runId,
    );
    outputs.push(
      evidence.find((e) => e.tool === "runner_oracle" && e.result.result)
        ?.result.result,
    );
    const dep = evidence.find((e) => e.result?.controlCoverage)?.result;
    assert.ok(dep.control.length);
    const slice = evidence.at(-1).result;
    assert.ok(slice.entries.some((e) => e.runId === boot.initialization.id));
  }
  assert.deepEqual(outputs, [42, 42, 43]);
  assert.equal((await t.call("runner_status")).current.route, route);
  const diff = await t.call("runner_execution", {
    action: "diff",
    runA: runs[1],
    runB: runs[2],
  });
  assert.ok(diff);
  const exportJob = await t.call("runner_execution", {
    action: "export",
    runId: runs[2],
  });
  const exported = await until(async () => {
    const j = await t.call("runner_execution", {
      action: "getExport",
      jobId: exportJob.id,
    });
    return j.state !== "running" && j;
  });
  assert.equal(exported.state, "complete", JSON.stringify(exported));
  const read = { action: "read", id: exported.artifactId, length: 4096 };
  const a = await t.call("runner_artifact", read),
    b = await t.call("runner_artifact", read);
  assert.deepEqual(a, b);
  await t.call("runner_debugger", { action: "open" });
  const debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Wxapp", exact: true }).click();
  await debug
    .getByRole("combobox", { name: "Wxapp section" })
    .selectOption({ label: "验收目录" });
  await debug
    .getByRole("textbox", { name: "场景步骤 JSON", exact: true })
    .fill(
      JSON.stringify([
        { tool: "runner_execution", arguments: { action: "status" } },
      ]),
    );
  await debug
    .getByRole("button", { name: "运行分析场景（保持当前页）", exact: true })
    .click();
  await debug
    .getByRole("button", { name: "查询任务结果", exact: true })
    .click();
  await debug
    .getByText('"analysis-scenario"', { exact: false })
    .first()
    .waitFor();
  Object.assign(report, {
    status: "验收通过",
    scenarios: 3,
    inputs: [1, 1, 2],
    bootOrigins: true,
    branchDependencies: true,
    sourceLocate: true,
    oracle: true,
    diff: true,
    exportRecords: exported.records,
    repeatRead: true,
    nativeWxappPanel: true,
    routeUnchanged: true,
  });
} catch (e) {
  report.status = "失败";
  report.error = e.message;
  console.error(t?.logs.join("").slice(-4000));
  throw e;
} finally {
  fs.writeFileSync(
    "docs/loader-analysis-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(report);
