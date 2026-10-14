import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-h5-"));
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/one" });
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  res.end(
    `<html><script>setTimeout(()=>{throw new Error('h5-regression-sentinel')},0);window.initialWxType=typeof wx;window.wx={miniProgram:{postMessage(options){WeixinJSBridge.invoke('invokeMiniProgramAPI',{name:'postMessage',arg:options.data},()=>{})}}};</script><body><h1 id="title">H5 ${req.url} 中文</h1><a id="next" href="/two">Next</a><button id="send" onclick="wx.miniProgram.postMessage({data:{message:'from-h5'}})">Send</button><input id="edit" /></body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const pkg = interactionFixture(dir, origin);
let frame = fs.readFileSync(path.join(pkg, "page-frame.html"), "utf8");
frame = frame.replace(
  "return {tag:'wx-page',children:[n('view'",
  `return {tag:'wx-page',children:[n('web-view',{src:${JSON.stringify(origin + "/redirect")},bindload:'loaded',binderror:'failed',bindmessage:'message'}),n('view'`,
);
fs.writeFileSync(path.join(pkg, "page-frame.html"), frame);
let logic = fs.readFileSync(path.join(pkg, "app-service.js"), "utf8");
logic = logic.replace(
  "onInput(e)",
  "loaded(e){this.setData({h5Loaded:e.detail.src})},failed(e){this.setData({h5Error:e.detail})},message(e){getApp().h5Messages=e.detail.data;},onInput(e)",
);
fs.writeFileSync(path.join(pkg, "app-service.js"), logic);
let t;
const result = { date: new Date().toISOString(), platform: process.platform };
try {
  t = await managedFixture({ packageDir: pkg });
  const h5 = await until(async () =>
    (await t.call("runner_status")).h5?.find((i) => i.state === "loaded"),
  );
  console.log("H5", h5);
  const id = h5.targetId;
  result.target = id;
  const text = await t.call("runner_wait", {
    kind: "text",
    text: "H5 /one 中文",
    targetId: id,
    stableMs: 0,
  });
  assert.equal(text.status, "matched");
  const isolation = await t.call("runner_evaluate", {
    targetId: id,
    expression:
      "({node:typeof require,process:typeof process,env:__wxjs_environment,initialWxType,ownSDK:typeof wx.miniProgram.postMessage})",
  });
  assert.equal(isolation.result.value.node, "undefined");
  assert.equal(isolation.result.value.process, "undefined");
  assert.equal(isolation.result.value.initialWxType, "undefined");
  assert.equal(isolation.result.value.ownSDK, "function");
  await t.call("runner_click", { selector: "#next", targetId: id });
  await t.call("runner_wait", {
    kind: "text",
    text: "H5 /two 中文",
    targetId: id,
    stableMs: 0,
  });
  await t.call("runner_navigate", { method: "navigateBack" });
  await t.call("runner_wait", {
    kind: "text",
    text: "H5 /one 中文",
    targetId: id,
    stableMs: 0,
  });
  const shot = await t.client.callTool({
    name: "runner_screenshot",
    arguments: { targetId: id },
  });
  assert.ok(shot.content.some((i) => i.type === "image"));
  await t.call("runner_input", {
    selector: "#edit",
    text: "中文输入",
    targetId: id,
  });
  assert.equal(
    (
      await t.call("runner_evaluate", {
        targetId: id,
        expression: 'document.querySelector("#edit").value',
      })
    ).result.value,
    "中文输入",
  );
  await t.call("runner_debugger", { action: "open", targetId: id });
  const devtools = await until(() =>
    t.app.windows().find((p) => p.url().includes("inspector.html")),
  );
  await devtools.getByRole("tab", { name: "Wxapp", exact: true }).waitFor();
  await t.call("runner_click", { selector: "#send", targetId: id });
  await t.call("runner_navigate", { method: "navigateTo", url: "/next" });
  const hidden = (await t.call("runner_status")).h5.find(
    (i) => i.targetId === id,
  );
  assert.equal(hidden.visible, false);
  await t.call("runner_navigate", { method: "navigateBack" });
  assert.equal(
    (await t.call("runner_status")).h5.find((i) => i.targetId === id).visible,
    true,
  );
  await t.call("runner_navigate", { method: "redirectTo", url: "/next" });
  assert.equal((await t.call("runner_status")).h5.length, 0);
  const events = await until(
    async () =>
      (await t.call("runner_evaluate", { expression: "getApp().h5Messages" }))
        .result?.value,
    3000,
  );
  assert.equal(events[0].message, "from-h5");
  assert.equal(events.length, 1);
  await t.call("runner_navigate", { method: "reLaunch", url: "/home" });
  const retry = await until(async () =>
    (await t.call("runner_status")).h5?.find((i) => i.state === "loaded"),
  );
  await t.call("runner_evaluate", {
    targetId: retry.targetId,
    expression: 'location.href="http://127.0.0.1:1/unreachable";void 0',
  });
  let errorRows = [],
    after = 0;
  for (let i = 0; i < 60; i++) {
    const page = await t.call("runner_logs", {
      source: "view",
      level: "error",
      after,
      limit: 200,
    });
    errorRows.push(...page.entries);
    after = page.nextCursor;
    if (!page.hasMore) break;
  }
  const diagnostic = errorRows.find(
    (e) => e.targetId === id && e.message?.includes("h5-regression-sentinel"),
  );
  assert.ok(
    diagnostic?.stackTrace?.callFrames?.length,
    "H5 exception missing from level:error results",
  );
  const failed = await until(async () =>
    (await t.call("runner_status")).h5?.find((i) => i.state === "failed"),
  );
  assert.ok(failed.error);
  await until(
    async () =>
      (
        await t.call("runner_evaluate", {
          expression: "getCurrentPages().at(-1).data.h5Error",
        })
      ).result?.value,
  );

  Object.assign(result, {
    status: "验收通过",
    redirect: true,
    loadEvent: true,
    bridgePostMessage: true,
    history: true,
    hideRestore: true,
    closed: true,
    isolated: true,
    mcpScreenshot: true,
    requests,
    input: true,
    nativeDevtools: true,
    loadError: true,
    messageExactlyOnce: true,
    pageOwnsWxNamespace: true,
    errorLevelQuery: true,
  });
} catch (e) {
  result.status = "失败";
  result.error = e.message;
  fs.writeFileSync(
    ".local/loader-alignment/h5-full.log",
    t?.logs.join("") || "",
  );
  console.error(t?.logs.join("").slice(-4000));
  throw e;
} finally {
  fs.writeFileSync(
    "docs/html-webview-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  await t?.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(result);
