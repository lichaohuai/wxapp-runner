import { managedFixture, until } from "./managed-test-runtime.mjs";
import { PNG } from "pngjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const data = JSON.parse(Buffer.concat(chunks));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: "workflow:" + data.message }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const t = await managedFixture({
  url: `http://127.0.0.1:${server.address().port}/submit`,
});
const { call, client } = t;
try {
  await call("runner_wait", { kind: "element", selector: "textarea" });
  const focus = await call("runner_gesture", {
    action: "focus",
    selector: "textarea",
  });
  assert.equal(focus.status, "focus-sent");
  const targetId = (await call("runner_status")).targets.find(
    (t) => t.kind === "view",
  ).targetId;
  assert.equal(
    (
      await call("runner_evaluate", {
        targetId,
        expression: "document.activeElement.tagName",
      })
    ).result.value,
    "TEXTAREA",
  );
  const before = (await call("runner_status")).networkCursor;
  await call("runner_input", { selector: "textarea", text: "中文😀" });
  const op = await call("runner_click", { selector: "#submit" });
  const done = await call("runner_wait", {
    kind: "operation",
    operationId: op.operationId,
    result: { kind: "text", text: "workflow:中文😀" },
  });
  assert.equal(done.businessCompleted, true);
  assert.equal(
    (
      await call("runner_wait", {
        kind: "network",
        after: before,
        urlIncludes: "/submit",
      })
    ).status,
    "matched",
  );
  const full = await client.callTool({
    name: "runner_screenshot",
    arguments: { fullPage: true },
  });
  assert.ok(!full.isError);
  const image = PNG.sync.read(
    Buffer.from(full.content.find((c) => c.type === "image").data, "base64"),
  );
  assert.ok(image.height > 1400);
  // A fixture-owned scroll region exercises real scrolling and pixel stitching.
  await call("runner_evaluate", {
    targetId,
    expression: `(()=>{const e=document.createElement('div');e.id='capture-test';e.style='position:fixed;left:0;top:0;width:160px;height:120px;overflow:scroll;z-index:20000';e.innerHTML='<div style="width:160px;height:180px;background:rgb(255,0,0)"></div><div style="width:160px;height:180px;background:rgb(0,0,255)"></div>';document.body.append(e);e.scrollTop=40})()`,
  });
  const capture = await client.callTool({
    name: "runner_screenshot",
    arguments: { container: "#capture-test" },
  });
  assert.ok(!capture.isError, JSON.stringify(capture));
  const strip = PNG.sync.read(
    Buffer.from(capture.content.find((c) => c.type === "image").data, "base64"),
  );
  assert.equal(strip.height, 360);
  assert.equal(strip.width, 160);
  assert.ok(
    strip.data[(30 * strip.width + 30) * 4] > 200 &&
      strip.data[(30 * strip.width + 30) * 4 + 2] < 100,
  );
  assert.ok(
    strip.data[(300 * strip.width + 30) * 4 + 2] > 200 &&
      strip.data[(300 * strip.width + 30) * 4] < 100,
  );
  assert.equal(
    (
      await call("runner_evaluate", {
        targetId,
        expression: 'document.querySelector("#capture-test").scrollTop',
      })
    ).result.value,
    40,
  );
  await call("runner_evaluate", {
    targetId,
    expression: 'document.querySelector("#capture-test").remove()',
  });
  const wait = call("runner_wait", {
    kind: "text",
    text: "never appears",
    waitId: "cancel-owned",
  });
  await until(async () =>
    (await call("runner_wait", { action: "list" })).some(
      (w) => w.waitId === "cancel-owned",
    ),
  );
  const second = await t.newClient();
  assert.equal(
    (
      await second.callTool({
        name: "runner_wait",
        arguments: { action: "cancel", waitId: "cancel-owned" },
      })
    ).isError,
    true,
  );
  await call("runner_wait", { action: "cancel", waitId: "cancel-owned" });
  assert.equal((await wait).status, "cancelled");
  await call("runner_click", { selector: "#modal" });
  const dialogs = await call("runner_wait", {
    kind: "dialog",
    dialogType: "showModal",
  });
  assert.equal(dialogs.status, "matched");
  const d = (await call("runner_dialog"))[0];
  await call("runner_dialog", {
    action: "respond",
    id: d.id,
    confirm: true,
    content: "once",
  });
  assert.equal(
    (await call("runner_wait", { kind: "text", text: "modal:once" })).status,
    "matched",
  );
  const result = {
    passed: true,
    platform: process.platform,
    focus: true,
    explicitOperationResult: true,
    requestCursor: true,
    fullPageScreenshot: true,
    scrollContainerPixels: true,
    scrollRestored: true,
    waitOwnership: true,
    waitCancellation: true,
    dialog: true,
  };
  fs.writeFileSync(
    "docs/debug-workflow-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(t.logs.join("").slice(-4000));
  throw e;
} finally {
  await t.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
