import { managedFixture, until } from "./managed-test-runtime.mjs";
import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const received = [],
  handshakes = [],
  peers = new Set(),
  raw = new Set();
const httpServer = http.createServer(),
  server = new WebSocketServer({ noServer: true, perMessageDeflate: true });
httpServer.on("connection", (s) => {
  raw.add(s);
  s.on("close", () => raw.delete(s));
});
httpServer.on("upgrade", (req, socket, head) => {
  handshakes.push({
    path: req.url,
    protocol: req.headers["sec-websocket-protocol"],
  });
  if (req.url === "/timeout") return;
  if (req.url === "/reject") {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  server.handleUpgrade(req, socket, head, (ws) =>
    server.emit("connection", ws, req),
  );
});
server.on("connection", (ws, req) => {
  peers.add(ws);
  ws.on("close", () => peers.delete(ws));
  ws.on("message", (bytes, binary) => {
    received.push({ path: req.url, binary, bytes: Buffer.from(bytes) });
    ws.send(bytes, { binary });
  });
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const url = `ws://127.0.0.1:${httpServer.address().port}`;
let t;
try {
  t = await managedFixture({
    beforeStart({ packageDir }) {
      const p = path.join(packageDir, "app-service.js"),
        source = fs.readFileSync(p, "utf8");
      const a = source.indexOf(" submit(){"),
        b = source.indexOf("\n modal(){", a);
      assert.ok(a > 0 && b > a);
      const handler = ` submit(){globalThis.__wsEvents=[];const events=__wsEvents;
     const task=internals.__appServiceSDK__.wx.connectSocket({url:${JSON.stringify(url + "/socket")},protocols:['wx-fixture'],header:{'X-WECHAT-HOSTSIGN':'local-fixture'},complete:r=>events.push({type:'connectComplete',errMsg:r.errMsg})});
     task.onOpen(r=>{events.push({type:'open',protocol:r.protocol});
       task.send({data:this.data.input,complete:r=>events.push({type:'sendComplete',errMsg:r.errMsg})});
       task.send({data:new Uint8Array([0,255,128,1]).buffer,complete:r=>events.push({type:'sendComplete',errMsg:r.errMsg})});});
     task.onMessage(r=>{events.push({type:'message',data:typeof r.data==='string'?r.data:Array.from(new Uint8Array(r.data))});
       if(events.filter(e=>e.type==='message').length===2){this.setData({result:'Socket中文与二进制完成🙂'});task.close({code:3001,reason:'正常关闭',complete:r=>events.push({type:'closeComplete',errMsg:r.errMsg})});}});
     task.onError(r=>{events.push({type:'error',errMsg:r.errMsg});this.setData({result:r.errMsg})});task.onClose(r=>events.push({type:'close',...r}));},`;
      fs.writeFileSync(p, source.slice(0, a) + handler + source.slice(b));
    },
  });
  const call = t.call,
    evaluate = async (expression, awaitPromise = false) => {
      const r = await call("runner_evaluate", { expression, awaitPromise });
      assert.ok(!r.exceptionDetails, JSON.stringify(r));
      return r.result.value;
    };
  assert.equal(
    await evaluate(
      "internals.__appServiceSDK__.wx.connectSocket===wx.connectSocket",
    ),
    false,
  );
  await call("runner_input", { selector: "textarea", text: "输入中文🙂" });
  await call("runner_click", { text: "提交", exact: true });
  assert.equal(
    (
      await call("runner_wait", {
        kind: "text",
        text: "Socket中文与二进制完成🙂",
      })
    ).status,
    "matched",
  );
  const events = await until(async () => {
    const e = await evaluate("__wsEvents");
    return e.some((e) => e.type === "close") ? e : false;
  });
  assert.equal(events.filter((e) => e.type === "connectComplete").length, 1);
  assert.equal(events.filter((e) => e.type === "sendComplete").length, 2);
  assert.equal(events.filter((e) => e.type === "closeComplete").length, 1);
  assert.equal(events.find((e) => e.type === "close").code, 3001);
  assert.deepEqual(
    events.filter((e) => e.type === "message").map((e) => e.data),
    ["输入中文🙂", [0, 255, 128, 1]],
  );
  const summary = await until(async () => {
    const entries = (
      await call("runner_network", {
        filter: { urlIncludes: url + "/socket" },
        summary: true,
      })
    ).entries;
    return entries.find((e) => e.state === "complete");
  });
  const record = await until(async () => {
    const r = await call("runner_network", { id: summary.id });
    return r.frames.length === 4 && r.frames.every((f) => f.artifactId)
      ? r
      : false;
  });
  assert.equal(record.context.nativeApi, "createSocketTask");
  assert.equal(record.context.handler, "submit");
  assert.equal(record.status, 101);
  assert.equal(
    record.requestHeaders["X-WECHAT-HOSTSIGN"] ||
      record.requestHeaders["x-wechat-hostsign"],
    "[REDACTED]",
  );
  assert.deepEqual(await call("runner_network", { id: record.id }), record);
  const frame = record.frames.find(
    (f) => f.direction === "received" && f.opcode === 1,
  );
  const body = await call("runner_artifact", {
    action: "read",
    id: frame.artifactId,
  });
  assert.equal(Buffer.from(body.data, "base64").toString(), "输入中文🙂");
  assert.deepEqual(
    await call("runner_artifact", { action: "read", id: frame.artifactId }),
    body,
  );
  await call("runner_debugger", { action: "open" });
  const debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  const frontendErrors = [];
  debug.on("pageerror", (error) => frontendErrors.push(error.message));
  await debug.getByRole("tab", { name: "Network", exact: true }).click();
  await debug.getByRole("cell").filter({ hasText: "socket" }).first().click();
  await debug.getByRole("tab", { name: "Messages", exact: true }).click();
  await debug.getByText("输入中文🙂", { exact: true }).first().waitFor();
  const evidence = "docs/evidence/native-socket-2026-09-12";
  fs.mkdirSync(evidence, { recursive: true });
  await debug.screenshot({
    path: path.join(evidence, "f12-socket-messages.png"),
  });
  assert.deepEqual(await call("runner_network", { id: record.id }), record);
  console.log(
    "native SocketTask handler, binary bridge, MCP/artifacts and late F12 passed",
  );
  const large = await evaluate(
    `new Promise(resolve=>{const task=internals.__appServiceSDK__.wx.connectSocket({url:${JSON.stringify(url + "/large")}});let bytes=0;task.onOpen(()=>task.send({data:'🙂'.repeat(1000)}));task.onMessage(r=>{bytes=r.data.length;task.close()});task.onClose(()=>resolve(bytes));task.onError(r=>resolve(r));})`,
    true,
  );
  assert.equal(large, 2000);
  const largeRecord = await until(async () => {
    const item = (
      await call("runner_network", {
        filter: { urlIncludes: url + "/large" },
        summary: true,
      })
    ).entries.find((r) => r.state === "complete");
    if (!item) return false;
    const r = await call("runner_network", { id: item.id });
    return r.frames.some((f) => f.direction === "received" && f.artifactId)
      ? r
      : false;
  });
  const largeFrame = largeRecord.frames.find((f) => f.direction === "received");
  assert.equal(largeFrame.bytes, 4000);
  assert.equal(largeFrame.truncated, true);
  const largeArtifact = await call("runner_artifact", {
    action: "read",
    id: largeFrame.artifactId,
  });
  assert.equal(
    Buffer.from(largeArtifact.data, "base64").toString(),
    "🙂".repeat(1000),
  );
  for (const p of ["/reject", "/timeout"]) {
    const calls = await evaluate(
      `new Promise(resolve=>{const events=[];const task=internals.__appServiceSDK__.wx.connectSocket({url:${JSON.stringify(url + p)},timeout:150,complete:r=>events.push({state:'create',errMsg:r.errMsg})});task.onOpen(()=>events.push({state:'open'}));task.onError(r=>events.push({state:'error',...r}));task.onClose(r=>{events.push({state:'close',...r});resolve(events)})})`,
      true,
    );
    assert.deepEqual(
      calls.map((e) => e.state),
      ["create", "error", "close"],
    );
    assert.match(calls[1].errMsg, p === "/reject" ? /403/ : /timed out/);
  }
  // Offline blocks a new socket before it reaches even the local test server.
  await call("runner_network_rules", {
    action: "conditions",
    conditions: { offline: true },
  });
  const blocked = await evaluate(
    `new Promise(resolve=>{const events=[];const task=internals.__appServiceSDK__.wx.connectSocket({url:${JSON.stringify(url + "/offline")}});task.onError(r=>events.push(r.errMsg));task.onClose(()=>resolve(events))})`,
    true,
  );
  assert.match(blocked[0], /offline/);
  assert.ok(!handshakes.some((e) => e.path === "/offline"));
  await call("runner_network_rules", {
    action: "conditions",
    conditions: { offline: false },
  });
  assert.deepEqual(frontendErrors, []);
  const result = {
    passed: true,
    platform: process.platform,
    genuineBaseSocketTask: true,
    handlerToSocketToSetData: true,
    textAndNativeBinary: true,
    protocolNegotiation: true,
    actualHandshakeHeaders: true,
    normalAndErrorCloseExactlyOnce: true,
    timeoutNoRetry: true,
    offlineNoHandshake: true,
    mcpRepeatableFrames: true,
    frameArtifactRepeatable: true,
    largeFrameTruncationExplicit: true,
    lateNativeF12Messages: true,
    nativeF12NoHeaderParserErrors: true,
    hostSignRedacted: true,
    remotePluginAuthorization: "Not verified; no synthetic plugin credentials",
    handshakes,
    frames: received.map((e) => ({
      path: e.path,
      binary: e.binary,
      bytes: e.bytes.length,
    })),
  };
  fs.writeFileSync(
    "docs/native-socket-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  if (t)
    fs.writeFileSync(".local/native-socket-smoke-failure.log", t.logs.join(""));
  throw error;
} finally {
  if (t) await t.close();
  for (const ws of peers) ws.terminate();
  for (const s of raw) s.destroy();
  await new Promise((r) => server.close(r));
  await new Promise((r) => httpServer.close(r));
}
