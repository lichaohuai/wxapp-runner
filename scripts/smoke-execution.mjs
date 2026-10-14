import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-execution-"));
let count = 0,
  t;
const server = http.createServer((req, res) => {
  count++;
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  const url = `http://127.0.0.1:${server.address().port}/signed`,
    pkg = interactionFixture(root, url);
  fs.appendFileSync(
    path.join(pkg, "app-service.js"),
    `\ndefine('analysis-fixture.js',function(require,module,exports){exports.hash=function(x){return 'digest:'+x;};exports.sign=function(x){var h={};h['X-Sign']=exports.hash(x+'=value');return h;};exports.send=function(x){wx.request({url:${JSON.stringify(url)},header:exports.sign(x),data:{input:x}});return 'sent';};});getApp().analysis=require('analysis-fixture.js');`,
  );
  const before = fs.readFileSync(path.join(pkg, "app-service.js"), "utf8");
  t = await managedFixture({
    packageDir: pkg,
    config: {
      analysis: {
        enabled: true,
        cryptoTap: true,
        execution: { enabled: true, capacity: 20000 },
      },
    },
  });
  const c = t.call;
  const status = await c("runner_execution");
  assert.equal(status.enabled, true);
  assert.ok(status.files.length);
  const o = await c("runner_oracle", {
    action: "export",
    target: "getApp().analysis.send",
  });
  const job = await c("runner_autopsy", {
    action: "start",
    urlIncludes: "/signed",
    field: { in: "header", name: "X-Sign" },
    trigger: {
      tool: "runner_oracle",
      arguments: { action: "call", oracleId: o.oracleId, args: ["fixture"] },
    },
  });
  const done = await until(async () => {
    const r = await c("runner_autopsy", {
      action: "get",
      jobId: job.id,
      revealSensitive: true,
    });
    return r.phase === "finished" && r;
  });
  assert.ok(["complete", "partial"].includes(done.state), JSON.stringify(done));
  assert.equal(count, 1);
  assert.equal(done.triggerCount, 1);
  assert.ok(
    done.report.fields[0].steps.some((e) => e.value === "fixture=value"),
    JSON.stringify(done.report),
  );
  assert.ok(done.report.oracles.length);
  const exported = done.report.oracles.find(
    (x) =>
      x.source.expression.includes("function(x)") ||
      x.source.expression.includes("function (x)"),
  );
  assert.ok(exported);
  const result = await c("runner_oracle", {
    action: "call",
    oracleId: exported.oracleId,
    args: ["other"],
    revealSensitive: true,
  });
  assert.equal(result.calls, 1);
  assert.equal(count, 1);
  const projected = await c("runner_execution", {
    action: "read",
    runId: done.runId,
    limit: 2,
    fields: ["id", "kind"],
  });
  assert.ok(projected.entries.length);
  assert.ok(
    projected.entries.every(
      (e) => Object.keys(e).sort().join(",") === "id,kind",
    ),
  );
  assert.ok(projected.nextCursor > 0);
  const hidden = await c("runner_autopsy", { action: "get", jobId: job.id });
  assert.ok(!JSON.stringify(hidden).includes("fixture=value"));
  const cancel = await c("runner_autopsy", {
    action: "start",
    urlIncludes: "/not-triggered",
    timeoutMs: 5000,
  });
  await c("runner_autopsy", { action: "cancel", jobId: cancel.id });
  const cancelled = await until(async () => {
    const r = await c("runner_autopsy", { action: "get", jobId: cancel.id });
    return r.phase === "finished" && r;
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(count, 1);
  await c("runner_debugger", { action: "open" });
  const dev = await until(() =>
    t.app.windows().find((w) => w.url().includes("js_app.html")),
  );
  await dev.getByRole("tab", { name: "Wxapp", exact: true }).click();
  const section = dev.getByRole("combobox", { name: "Wxapp section" });
  for (const label of ["执行反虚拟化", "字段写监视", "Signer Autopsy"]) {
    await section.selectOption({ label });
    await dev.getByRole("button", { name: "执行所填分析操作" }).waitFor();
  }
  // Exercise native panel actions, not merely the presence of sections.
  const uiResult = dev.getByLabel("Wxapp result");
  const readUI = async () => {
    try {
      return JSON.parse(await uiResult.locator("pre").first().textContent());
    } catch {
      return undefined;
    }
  };
  await dev.getByLabel("显示敏感字段").check();
  await section.selectOption({ label: "Signer Autopsy" });
  await dev.getByLabel("执行分析参数").fill(
    JSON.stringify({
      action: "start",
      urlIncludes: "/signed",
      field: { in: "header", name: "X-Sign" },
      trigger: {
        tool: "runner_oracle",
        arguments: {
          action: "call",
          oracleId: o.oracleId,
          args: ["native-ui"],
        },
      },
    }),
  );
  await dev.getByRole("button", { name: "执行所填分析操作" }).click();
  const uiJob = await until(async () => {
    const r = await readUI();
    return r?.id && r;
  });
  assert.equal(await dev.getByLabel("Autopsy 任务 ID").inputValue(), uiJob.id);
  const uiDone = await until(async () => {
    await dev
      .getByRole("button", { name: "读取分析报告", exact: true })
      .click();
    const r = await readUI();
    return r?.id === uiJob.id && r?.phase === "finished" && r;
  });
  assert.ok(
    ["complete", "partial"].includes(uiDone.state),
    JSON.stringify({
      state: uiDone.state,
      error: uiDone.error,
      phase: uiDone.phase,
    }),
  );
  assert.equal(uiDone.triggerCount, 1);
  assert.equal(count, 2);
  await dev
    .getByRole("button", { name: /^准备复算/ })
    .first()
    .click();
  const candidate = JSON.parse(
    await dev.getByLabel("分析工具参数").inputValue(),
  );
  assert.ok(candidate.oracleId);
  candidate.args = ["native-recompute"];
  await dev.getByLabel("分析工具参数").fill(JSON.stringify(candidate));
  await dev.getByRole("button", { name: "执行分析命令", exact: true }).click();
  await until(async () => {
    const r = await readUI();
    return r?.oracleId === candidate.oracleId && r?.calls === 1;
  });
  assert.equal(count, 2);
  await section.selectOption({ label: "模块源码" });
  await dev.getByRole("button", { name: "检查插件依赖", exact: true }).click();
  await until(async () => {
    const r = await readUI();
    return r?.runtimeVerified === false && Array.isArray(r.plugins);
  });
  await dev.getByLabel("模块路径", { exact: true }).fill("analysis-fixture.js");
  await dev.getByRole("button", { name: "格式化模块", exact: true }).click();
  await until(async () => {
    const r = await readUI();
    return (
      r?.representation === "formatted factory" &&
      r.source.includes("exports.hash")
    );
  });
  await dev
    .getByRole("button", { name: "读取当前运行工厂", exact: true })
    .click();
  const currentFactory = await until(async () => {
    const r = await readUI();
    return r?.factoryId && r.representation === "original define factory" && r;
  });
  assert.equal(
    await dev.getByLabel("工厂 ID（可选）").inputValue(),
    currentFactory.factoryId,
  );
  await dev.getByRole("button", { name: "列出同名工厂", exact: true }).click();
  await until(async () => {
    const r = await readUI();
    return r?.modules?.some((m) => m.factoryId === currentFactory.factoryId);
  });
  await section.selectOption({ label: "执行反虚拟化" });
  await dev
    .getByLabel("执行分析参数")
    .fill(
      JSON.stringify({ action: "diff", runA: done.runId, runB: uiDone.runId }),
    );
  await dev.getByRole("button", { name: "执行所填分析操作" }).click();
  await until(async () => {
    const r = await readUI();
    return r?.changes && r;
  });
  await dev
    .getByLabel("执行分析参数")
    .fill(JSON.stringify({ runId: uiDone.runId }));
  await dev
    .getByRole("button", { name: "按源码汇总执行", exact: true })
    .click();
  const uiSummary = await until(async () => {
    const r = await readUI();
    return r?.groupBy === "source" && r;
  });
  const mcpSummary = await c("runner_execution", {
    action: "summary",
    runId: uiDone.runId,
    beforeEvent: uiSummary.snapshotCursor,
  });
  assert.equal(uiSummary.matchedEvents, mcpSummary.matchedEvents);
  assert.equal(uiSummary.groupCount, mcpSummary.groupCount);
  assert.ok(mcpSummary.matchedEvents > 0);
  await section.selectOption({ label: "分析产物" });
  await dev.getByLabel("artifactId", { exact: true }).fill(uiDone.artifactId);
  await dev.getByRole("button", { name: "读取产物预览", exact: true }).click();
  await until(async () => {
    const r = await readUI();
    return r?.data && r;
  });
  const artifact = await c("runner_artifact", {
    action: "read",
    id: done.artifactId,
  });
  assert.ok(artifact.data);
  const manual = await c("runner_autopsy", {
    action: "start",
    urlIncludes: "/signed",
    field: { in: "header", name: "X-Sign" },
    timeoutMs: 10000,
  });
  await until(
    async () =>
      (await c("runner_autopsy", { action: "get", jobId: manual.id })).phase ===
      "waiting-manual-action",
  );
  await section.selectOption({ label: "函数 Oracle" });
  await dev.getByLabel("分析工具参数").fill(
    JSON.stringify({
      action: "call",
      oracleId: o.oracleId,
      args: ["manual"],
    }),
  );
  await dev.getByRole("button", { name: "执行分析命令", exact: true }).click();
  const manualDone = await until(async () => {
    const r = await c("runner_autopsy", { action: "get", jobId: manual.id });
    return r.phase === "finished" && r;
  });
  assert.ok(
    ["complete", "partial"].includes(manualDone.state),
    JSON.stringify(manualDone.error),
  );
  assert.equal(manualDone.triggerCount, 0);
  assert.equal(count, 3);
  const probe = await c("runner_crypto_watch", {
    action: "start",
    auto: false,
    taps: [{ target: "String.prototype.charCodeAt", scope: "armed", count: 3 }],
  });
  const scopeRun = await c("runner_execution", {
    action: "start",
    ttlMs: 10000,
  });
  await section.selectOption({ label: "Crypto 采集" });
  await dev.getByLabel("探针 ID（逗号分隔）").fill(probe.tapIds.join(","));
  await dev.getByLabel("采集执行 ID").fill(scopeRun.runId);
  await dev
    .getByRole("button", { name: "按指定操作启用探针", exact: true })
    .click();
  await until(async () => {
    const r = await readUI();
    return r?.taps?.some(
      (p) =>
        p.tapId === probe.tapIds[0] && p.armed && p.runId === scopeRun.runId,
    );
  });
  await dev.getByRole("button", { name: "暂停所选探针", exact: true }).click();
  await until(async () => {
    const r = await readUI();
    return r?.taps?.some((p) => p.tapId === probe.tapIds[0] && !p.armed);
  });
  await c("runner_execution", { action: "stop", runId: scopeRun.runId });
  await c("runner_crypto_watch", { action: "stop", tapIds: probe.tapIds });
  assert.equal(
    fs.readFileSync(path.join(pkg, "app-service.js"), "utf8"),
    before,
  );
  const running = await c("runner_status");
  const rejected = await t.client.callTool({
    name: "runner_runtime",
    arguments: {
      action: "restart",
      analysis: {
        enabled: true,
        execution: { enabled: true, modules: ["missing/fixture.js"] },
      },
    },
  });
  assert.equal(rejected.isError, true);
  assert.ok(JSON.stringify(rejected).includes("EXECUTION_MODULE_NOT_FOUND"));
  assert.equal((await c("runner_status")).sessionId, running.sessionId);
  const report = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    standardMcp: true,
    realBaselib: true,
    singleRequest: true,
    executionToNetwork: true,
    autopsyToOracle: true,
    cancelWithoutReplay: true,
    redacted: true,
    nativePanel: true,
    nativeWorkflow: true,
    waitsForManualInput: true,
    invalidModulePreservesSession: true,
    nativeSourceDiffArtifact: true,
    nativeFactorySelection: true,
    nativeProbeArming: true,
    packageUnchanged: true,
    realChaosSample: false,
  };
  fs.writeFileSync(
    "docs/execution-smoke-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await t?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
