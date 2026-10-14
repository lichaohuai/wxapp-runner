import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const output = path.resolve("docs/evidence/realtime-data-2026-09-12");
fs.mkdirSync(output, { recursive: true });
let t, debug;
try {
  t = await managedFixture({
    beforeStart({ packageDir }) {
      const file = path.join(packageDir, "app-service.js");
      // Only the synthetic fixture is edited. Exercise the original SDK's
      // rate limiter, id allocator and native response subscription.
      const source = fs.readFileSync(file, "utf8").replace(
        "submit(){wx.request(",
        `submit(){this.reportId=internals.__appServiceSDK__.operateRealtimeData(1005,
          JSON.stringify({interface:'local-realtime-fixture',message:'实时中文🙂',token:'private-fixture-value'}),'immediate');
          return;wx.request(`,
      );
      fs.writeFileSync(
        file,
        `globalThis.fixtureRealtimeReceipts=[];
        internals.__appServiceSDK__.onRealtimeDataResponse(function(r){
          fixtureRealtimeReceipts.push(r);
          const p=getCurrentPages().slice(-1)[0];
          if(p && r.idList?.includes(p.reportId)) p.setData({result:'实时日志已记录'});
        });\n` + source,
      );
    },
  });
  const { call } = t;
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await call("runner_evaluate", { expression, awaitPromise });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  const read = async (after = 0) => {
    const entries = [];
    for (;;) {
      const page = await call("runner_logs", {
        source: "realtime",
        after,
        limit: 200,
      });
      entries.push(...page.entries);
      if (!page.hasMore) return entries;
      after = page.nextCursor;
    }
  };
  const before = (await call("runner_logs", { limit: 1 })).latestId;
  await call("runner_click", { selector: "#submit" });
  await call("runner_wait", { kind: "text", text: "实时日志已记录" });
  const row = (await read(before)).find((r) =>
    r.content?.includes("local-realtime-fixture"),
  );
  assert.ok(row, "original SDK native record must reach the controller");
  assert.equal(row.realtimeType, 1005);
  assert.equal(row.priority, "immediate");
  assert.equal(row.context.handler, "submit");
  assert.equal(row.uploaded, false);
  assert.equal(JSON.parse(row.content).token, "[REDACTED]");
  assert.equal(
    (
      await evaluate(
        `fixtureRealtimeReceipts.filter(r=>r.idList?.includes(${row.realtimeId})).map(r=>({errcode:r.errcode,uploaded:r.uploaded,runnerEventId:r.runnerEventId}))`,
      )
    ).length,
    1,
  );
  assert.deepEqual(
    (await read(before)).find((r) => r.id === row.id),
    row,
  );
  const trace = await call("runner_trace", {
    operationId: row.context.operationId,
    after: before,
    limit: 200,
  });
  assert.ok(trace.entries.some((r) => r.id === row.id));

  const invalid = await evaluate(
    `new Promise(resolve=>internals.WeixinJSBridge.invoke('operateRealtimeData',
    {id:901,type:1001,priority:'low',content:{}},resolve))`,
    true,
  );
  assert.equal(invalid.runnerCode, "REALTIME_INVALID_ARGUMENT");
  assert.ok(!(await read()).some((r) => r.realtimeId === 901));
  const large = await evaluate(
    `new Promise(resolve=>internals.WeixinJSBridge.invoke('operateRealtimeData',
    {id:902,type:1001,priority:'high',content:JSON.stringify({message:'较大中文🙂'.repeat(3000),token:'private-fixture-value'})},resolve))`,
    true,
  );
  assert.equal(large.errMsg, "operateRealtimeData:ok");
  const bodyRow = (await read()).find((r) => r.realtimeId === 902);
  assert.ok(bodyRow.contentArtifactId);
  assert.equal(bodyRow.contentOmitted, true);
  const body = await call("runner_artifact", {
    action: "read",
    id: bodyRow.contentArtifactId,
  });
  assert.equal(
    JSON.parse(Buffer.from(body.data, "base64").toString()).message,
    "较大中文🙂".repeat(3000),
  );
  assert.equal(
    JSON.parse(Buffer.from(body.data, "base64").toString()).token,
    "[REDACTED]",
  );
  assert.deepEqual(
    await call("runner_artifact", {
      action: "read",
      id: bodyRow.contentArtifactId,
    }),
    body,
  );

  const status = await call("runner_status");
  assert.ok(
    !status.loader.nativeBoundary.entries.some(
      (r) => r.api === "operateRealtimeData",
    ),
  );
  await call("runner_debugger", { action: "open" });
  debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Wxapp", exact: true }).click();
  await debug
    .getByRole("combobox", { name: "Wxapp section" })
    .selectOption({ label: "实时日志" });
  await debug
    .getByText("local-realtime-fixture", { exact: false })
    .first()
    .waitFor({ state: "attached" });
  // Records default to collapsed <details>; inspect DOM text without revealing raw values.
  assert.ok(
    !(await debug.locator("body").textContent()).includes(
      "private-fixture-value",
    ),
  );
  const details = debug
    .locator("details")
    .filter({ hasText: "local-realtime-fixture" })
    .first();
  await details.locator("summary").click();
  await debug.screenshot({ path: path.join(output, "f12-realtime-data.png") });
  assert.deepEqual(
    (await read(before)).find((r) => r.id === row.id),
    row,
  );
  const result = {
    date: new Date().toISOString(),
    platform: process.platform,
    passed: true,
    originalSdkType1005ToNative: true,
    originalResponseSubscription: true,
    clickHandlerAndSetData: true,
    controllerReceiptBeforeSuccess: true,
    nativeF12AndMcpShareRecord: true,
    unicodeAndRedaction: true,
    repeatedReadsAndLargeArtifact: true,
    invalidArgumentsNoRecords: true,
    noExternalTelemetryUpload: true,
    policy: "local-only telemetry; not a WeChat server acknowledgement",
  };
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  fs.mkdirSync(".local/realtime-data", { recursive: true });
  fs.writeFileSync(".local/realtime-data/failed.log", t?.logs.join("") || "");
  if (debug)
    fs.writeFileSync(
      ".local/realtime-data/ui.txt",
      await debug.locator("body").ariaSnapshot(),
    );
  throw error;
} finally {
  await t?.close();
}
