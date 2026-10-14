import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const require = createRequire(import.meta.url),
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-p1-workflow-"));
let count = 0,
  t;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) {
  }
  count++;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true}');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  const url = `http://127.0.0.1:${server.address().port}/signed`,
    pkg = interactionFixture(root, url);
  const crypto = fs.readFileSync(
    require.resolve("crypto-js/crypto-js.js"),
    "utf8",
  );
  fs.appendFileSync(
    path.join(pkg, "app-service.js"),
    `
define('crypto-js.js',function(require,module,exports){${crypto}\n});
define('analysis-workflow.js',function(require,module,exports){var c=require('crypto-js.js');
exports.sign=function(x){var key=c.enc.Hex.parse('000102030405060708090a0b0c0d0e0f');var cipher=c.AES.encrypt('input:'+x,key,{mode:c.mode.ECB,padding:c.pad.Pkcs7});return {'X-Sign':c.MD5(cipher.ciphertext.toString().toUpperCase()).toString()};};
exports.send=function(x){wx.request({url:${JSON.stringify(url)},header:exports.sign(x),data:{input:x},success:function(){getCurrentPages()[0].setData({result:'done:'+x});console.log('workflow-result:'+x);}});return 'sent';};});getApp().workflow=require('analysis-workflow.js');`,
  );
  const original = fs.readFileSync(path.join(pkg, "app-service.js"), "utf8");
  t = await managedFixture({
    packageDir: pkg,
    config: {
      analysis: {
        enabled: true,
        networkMode: "local-only",
        cryptoTap: true,
        ttlMs: 300000,
        capacity: 2000,
        execution: {
          enabled: true,
          files: ["app-service.js"],
          modules: ["analysis-workflow.js"],
          capacity: 20000,
        },
      },
    },
  });
  const c = t.call,
    send = await c("runner_oracle", {
      action: "export",
      target: "getApp().workflow.send",
    });
  const trigger = (input) => ({
    tool: "runner_oracle",
    arguments: { action: "call", oracleId: send.oracleId, args: [input] },
  });
  const config = {
    urlIncludes: "/signed",
    field: { in: "header", name: "X-Sign" },
    timeoutMs: 10000,
  };
  const ready = await c("runner_autopsy", {
    ...config,
    action: "preflight",
    trigger: trigger("alpha"),
    resultCondition: { kind: "text", text: "done:alpha" },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.actionsSubmitted, 0);
  assert.equal(ready.networkMode, "local-only");
  assert.equal(count, 0);
  const lease = await c("runner_control", { action: "acquire", ttlMs: 30000 });
  const observer = await t.newClient();
  const observerReady = await t.callAs(observer, "runner_autopsy", {
    ...config,
    action: "preflight",
  });
  assert.equal(observerReady.ready, true);
  assert.equal((await c("runner_control")).lease.id, lease.lease.id);
  await c("runner_control", { action: "release" });
  const job = await c("runner_autopsy", {
    ...config,
    action: "start",
    trigger: trigger("alpha"),
    resultCondition: { kind: "text", text: "done:alpha" },
  });
  const settled = async (id) =>
    until(async () => {
      const r = await c("runner_autopsy", { action: "get", jobId: id });
      return r.phase === "finished" && r;
    }, 20000);
  const done = await settled(job.id);
  assert.ok(
    ["complete", "partial"].includes(done.state),
    JSON.stringify(done.error),
  );
  assert.equal(done.report.outcome.businessResult, "condition-matched");
  assert.equal(done.triggerCount, 1);
  assert.equal(count, 1);
  assert.ok(
    done.report.cryptoSummary.counts.verified >= 2,
    JSON.stringify(done.report.cryptoSummary),
  );
  assert.ok(
    done.report.cryptoSummary.steps.some(
      (s) =>
        s.metadata.algorithm === "AES" &&
        s.metadata.mode === "ECB" &&
        s.verification.status === "verified",
    ),
  );
  assert.ok(
    done.report.cryptoSummary.steps.some((s) => s.fieldLinks.length),
    "ID-linked field relation",
  );
  assert.ok(
    done.report.cryptoSummary.steps.some((s) =>
      s.fieldComparisons.some((f) => f.matched === true),
    ),
    "request field independently compared",
  );
  const summary = await c("runner_crypto_watch", {
    action: "read",
    runId: done.runId,
    summary: true,
    limit: 100,
  });
  assert.ok(summary.counts.verified >= 2);
  assert.ok(summary.nextCursor > 0);
  assert.ok(!JSON.stringify(summary).includes("0001020304050607"));
  // Native DevTools workflow uses form fields and the same service, with no eval/HTTP replay.
  await c("runner_debugger", { action: "open" });
  const dev = await until(() =>
    t.app.windows().find((w) => w.url().includes("js_app.html")),
  );
  await dev.getByRole("tab", { name: "Wxapp", exact: true }).click();
  const section = dev.getByRole("combobox", { name: "Wxapp section" }),
    output = dev.getByLabel("Wxapp result");
  const readUI = async () => {
    try {
      return JSON.parse(await output.locator("pre").first().textContent());
    } catch {
      return undefined;
    }
  };
  await section.selectOption({ label: "请求" });
  await output
    .locator("summary")
    .filter({ hasText: "/signed" })
    .first()
    .click();
  await dev
    .getByRole("button", { name: "分析此请求的字段来源", exact: true })
    .click();
  assert.equal(
    await dev.getByLabel("分析请求 ID（可从请求页选择）").inputValue(),
    done.requestId,
  );
  await dev.getByLabel("分析触发方式").selectOption("oracle");
  await dev
    .getByRole("button", { name: "填入已有 Oracle", exact: true })
    .click();
  await dev
    .getByRole("button", {
      name: "选择 Oracle · " + send.oracleId,
      exact: true,
    })
    .click();
  assert.equal(
    await dev.getByLabel("触发选择器或 Oracle ID").inputValue(),
    send.oracleId,
  );
  await dev.getByLabel("Oracle 参数数组").fill('["beta"]');
  const state = await c("runner_state");
  const page = state.instances.find((i) => i.kind === "Page");
  assert.ok(page);
  await dev.getByLabel("业务结果条件").selectOption("state");
  await dev.getByLabel("结果实例 ID").fill(page.id);
  await dev.getByLabel("data 路径（点分隔）").fill("result");
  await dev.getByLabel("预期文字、选择器、路由或 JSON 值").fill('"done:beta"');
  const uiLease = await c("runner_control", {
    action: "acquire",
    ttlMs: 30000,
  });
  await dev
    .getByRole("button", { name: "只读预检分析条件", exact: true })
    .click();
  await until(async () => {
    const r = await readUI();
    return r?.ready;
  });
  assert.equal(count, 1);
  assert.equal(
    (await c("runner_control")).lease.id,
    uiLease.lease.id,
    "F12 preflight did not take over the lease",
  );
  await dev
    .getByRole("button", { name: "启动本次分析（最多触发一次）", exact: true })
    .click();
  const uiJob = await until(async () => {
    const r = await readUI();
    return r?.id && r;
  });
  assert.equal(
    await dev
      .getByRole("button", {
        name: "启动本次分析（最多触发一次）",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  const uiDone = await settled(uiJob.id);
  assert.equal(count, 2);
  assert.equal(uiDone.report.outcome.businessResult, "condition-matched");
  const readReport = async (id) => {
    await dev.getByLabel("Autopsy 任务 ID").fill(id);
    await dev
      .getByRole("button", { name: "读取分析报告", exact: true })
      .click();
    await until(async () => {
      const r = await readUI();
      return r?.id === id && r.phase === "finished";
    });
  };
  await readReport(job.id);
  await dev
    .getByRole("button", { name: "将当前报告设为 A", exact: true })
    .click();
  await readReport(uiJob.id);
  await dev
    .getByRole("button", { name: "将当前报告设为 B", exact: true })
    .click();
  await dev
    .getByRole("button", {
      name: "比较 A/B 的执行、Crypto 和请求",
      exact: true,
    })
    .click();
  const diff = await until(async () => {
    const r = await readUI();
    return r?.results && r;
  });
  assert.equal(diff.actionsSubmitted, 0);
  assert.equal(diff.results.length, 3);
  assert.ok(
    diff.results.every((r) => !r.error),
    JSON.stringify(diff),
  );
  assert.equal(count, 2);
  await readReport(uiJob.id);
  await dev
    .getByRole("button", { name: /^定位 Crypto 调用源码/ })
    .first()
    .click();
  try {
    await until(async () => {
      const r = await readUI();
      return r?.factoryId && r.path === "analysis-workflow.js";
    });
  } catch (e) {
    console.error(
      "source-jump-result",
      JSON.stringify(await readUI())?.slice(0, 1800),
    );
    throw e;
  }
  await section.selectOption({ label: "Signer Autopsy" });
  await readReport(uiJob.id);
  await dev
    .getByRole("button", { name: /^准备复算/ })
    .first()
    .click();
  const candidate = JSON.parse(
    await dev.getByLabel("分析工具参数").inputValue(),
  );
  // The candidate function is explicitly selected, no automatic invocation in source/analysis.
  assert.ok(candidate.oracleId);
  assert.equal(count, 2);
  const sign = await c("runner_oracle", {
    action: "export",
    target: "getApp().workflow.sign",
  });
  await dev.getByLabel("分析工具参数").fill(
    JSON.stringify({
      action: "call",
      oracleId: sign.oracleId,
      args: ["recompute"],
    }),
  );
  await dev.getByRole("button", { name: "执行分析命令", exact: true }).click();
  await until(async () => {
    const r = await readUI();
    return r?.oracleId === sign.oracleId && r.calls === 1;
  });
  assert.equal(count, 2);
  await section.selectOption({ label: "Signer Autopsy" });
  await readReport(uiJob.id);
  await dev
    .getByRole("button", { name: "读取当前分析产物", exact: true })
    .click();
  await until(async () => {
    const r = await readUI();
    return r?.data;
  });
  // Log result starts at the pre-input cursor; a fast callback is not lost.
  const log = await c("runner_autopsy", {
    ...config,
    action: "start",
    trigger: trigger("log"),
    resultCondition: { kind: "log", text: "workflow-result:log" },
  });
  assert.equal((await settled(log.id)).businessResult, "condition-matched");
  assert.equal(count, 3);
  // Missing result times out even though HTTP and evidence finished; it keeps artifacts.
  const timeout = await c("runner_autopsy", {
    ...config,
    action: "start",
    trigger: trigger("timeout"),
    timeoutMs: 900,
    resultCondition: { kind: "text", text: "never-shown" },
  });
  const timed = await settled(timeout.id);
  assert.equal(timed.state, "timed-out");
  assert.equal(timed.businessResult, "timeout");
  assert.ok(timed.artifactId);
  assert.equal(count, 4);
  const cancel = await c("runner_autopsy", {
    ...config,
    action: "start",
    trigger: trigger("cancel"),
    resultCondition: { kind: "text", text: "never-shown" },
  });
  await until(async () => {
    const r = await c("runner_autopsy", { action: "get", jobId: cancel.id });
    return r.phase === "waiting-result";
  });
  await c("runner_autopsy", { action: "cancel", jobId: cancel.id });
  const cancelled = await settled(cancel.id);
  assert.equal(cancelled.state, "cancelled");
  assert.ok(cancelled.artifactId);
  assert.equal(count, 5);
  assert.equal(
    fs.readFileSync(path.join(pkg, "app-service.js"), "utf8"),
    original,
  );
  const report = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    standardMcp: true,
    realBaselib: true,
    nativeGuidedWorkflow: true,
    requestSelection: true,
    preflightReadOnly: true,
    preflightWithAnotherClientLease: true,
    nativePreflightPreservesLease: true,
    numericFieldComparison: true,
    cryptoVectorVerification: true,
    sourceJump: true,
    oracleExplicitRecompute: true,
    threeWayDiff: true,
    artifactRead: true,
    resultCondition: true,
    fastLogCondition: true,
    timeoutRetainsEvidence: true,
    cancelRetainsEvidence: true,
    noDuplicateRequests: true,
    requests: count,
    packageUnchanged: true,
  };
  fs.writeFileSync(
    "docs/analysis-workflow-smoke-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await t?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
