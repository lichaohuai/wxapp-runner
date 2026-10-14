import { managedFixture, until } from "./managed-test-runtime.mjs";
import http from "node:http";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const received = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const b of req) chunks.push(b);
  const data = Buffer.concat(chunks);
  received.push({
    url: req.url,
    method: req.method,
    body: data,
    headers: req.headers,
  });
  if (req.url === "/timeout") return;
  if (req.url === "/binary") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(data);
    return;
  }
  if (req.url === "/stream") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("分块中文🙂");
    return;
  }
  res.writeHead(201, {
    "content-type": "application/json; charset=utf-8",
    "content-encoding": "gzip",
    "set-cookie": ["one=1; Path=/", "two=2; Path=/"],
  });
  res.end(
    gzipSync(
      JSON.stringify({
        message: "官方任务中文🙂",
        request: JSON.parse(data.toString() || "{}"),
      }),
    ),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
let t;
try {
  t = await managedFixture({
    url: endpoint + "/native-request",
    beforeStart({ packageDir }) {
      const p = path.join(packageDir, "app-service.js");
      // Test ONLY: choose the retained real SDK API, not the main app's wx shim.
      fs.writeFileSync(
        p,
        fs
          .readFileSync(p, "utf8")
          .replace(
            "submit(){wx.request(",
            "submit(){internals.__appServiceSDK__.wx.request(",
          )
          .replace(
            "method:'POST',data:{message:this.data.input}",
            "method:'POST',header:{'X-WECHAT-HOSTSIGN':'local-fixture-sign'},data:{message:this.data.input}",
          ),
      );
    },
  });
  const { call } = t;
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await call("runner_evaluate", { expression, awaitPromise });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  assert.equal(
    await evaluate("internals.__appServiceSDK__.wx.request === wx.request"),
    false,
  );
  await call("runner_input", { selector: "textarea", text: "原始输入🙂" });
  await call("runner_click", { text: "提交", exact: true });
  assert.equal(
    (await call("runner_wait", { kind: "text", text: "官方任务中文🙂" }))
      .status,
    "matched",
  );
  const record = await until(async () => {
    const r = (
      await call("runner_network", {
        filter: { urlIncludes: "/native-request" },
        summary: true,
      })
    ).entries;
    return r.find((r) => r.state === "complete");
  });
  const body = await call("runner_network", { id: record.id });
  assert.equal(JSON.parse(body.responseBody).message, "官方任务中文🙂");
  assert.equal(JSON.parse(body.requestBody).message, "原始输入🙂");
  assert.match(body.context.nativeApi, /^createRequestTask/);
  assert.equal(body.context.handler, "submit");
  assert.deepEqual(await call("runner_network", { id: record.id }), body);
  assert.equal(body.requestHeaders["x-wechat-hostsign"], "[REDACTED]");
  assert.equal(
    (await call("runner_network", { id: record.id, revealSensitive: true }))
      .requestHeaders["x-wechat-hostsign"],
    "local-fixture-sign",
  );
  // Open native F12 AFTER the request: it must replay history and read the same cache.
  await call("runner_debugger", { action: "open" });
  const debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Network", exact: true }).click();
  await debug
    .getByRole("cell", { name: "Fetch native-request", exact: true })
    .click();
  await debug.getByRole("tab", { name: "Response", exact: true }).click();
  await debug
    .getByText(/官方任务中文🙂/)
    .first()
    .waitFor();
  assert.equal(
    (await call("runner_network", { id: record.id })).responseBody,
    body.responseBody,
  );
  fs.mkdirSync("docs/evidence/native-network-2026-09-12", { recursive: true });
  await debug.screenshot({
    path: "docs/evidence/native-network-2026-09-12/f12-native-request.png",
  });
  const binary = await evaluate(
    `new Promise(resolve=>internals.__appServiceSDK__.wx.request({url:${JSON.stringify(endpoint + "/binary")},method:'POST',responseType:'arraybuffer',data:new Uint8Array([0,255,128,1]).buffer,success:r=>resolve({ok:true,bytes:Array.from(new Uint8Array(r.data))}),fail:r=>resolve(r)}))`,
    true,
  );
  assert.deepEqual(binary, { ok: true, bytes: [0, 255, 128, 1] });
  const streamed = await evaluate(
    `new Promise(resolve=>{const events=[],chunks=[];let headers=0,success=0,complete=0;const task=internals.__appServiceSDK__.wx.request({url:${JSON.stringify(endpoint + "/stream")},enableChunked:true,success(){success++},fail(r){events.push(r.errMsg)},complete(){complete++;resolve({headers,success,complete,events,chunks})}});task.onHeadersReceived(()=>headers++);task.onChunkReceived(r=>chunks.push(Array.from(new Uint8Array(r.data))));})`,
    true,
  );
  assert.equal(streamed.headers, 1);
  assert.equal(streamed.success, 1);
  assert.equal(streamed.complete, 1);
  assert.equal(Buffer.from(streamed.chunks.flat()).toString(), "分块中文🙂");
  const timeout = await evaluate(
    `new Promise(resolve=>{const calls=[];internals.__appServiceSDK__.wx.request({url:${JSON.stringify(endpoint + "/timeout")},timeout:150,success(){calls.push('success')},fail(r){calls.push(r.errMsg)},complete(){calls.push('complete');resolve(calls)}})})`,
    true,
  );
  assert.equal(timeout.length, 2);
  assert.match(timeout[0], /timeout/);
  assert.equal(timeout[1], "complete");
  const aborted = await evaluate(
    `new Promise(resolve=>{const calls=[];const task=internals.__appServiceSDK__.wx.request({url:${JSON.stringify(endpoint + "/abort")},success(){calls.push('success')},fail(r){calls.push(r.errMsg)},complete(){calls.push('complete');resolve(calls)}});task.abort();})`,
    true,
  );
  assert.equal(aborted.length, 2);
  assert.match(aborted[0], /abort/);
  assert.equal(aborted[1], "complete");
  const policy = await evaluate(
    `new Promise(resolve=>internals.WeixinJSBridge.invoke('checkNetworkAPIURL',{api:'request',url:${JSON.stringify(endpoint)}},resolve))`,
    true,
  );
  assert.equal(policy.isLocalHost, true);
  assert.equal(policy.isInLAN, false);
  assert.equal(received.filter((r) => r.url === "/native-request").length, 1);
  const result = {
    passed: true,
    platform: process.platform,
    genuineBaseRequestTask: true,
    handlerToNativeToSetData: true,
    unicodeGzip: true,
    binary: true,
    chunkedCallbacks: true,
    timeoutExactlyOnce: true,
    abortExactlyOnce: true,
    mcpRepeatableBody: true,
    lateNativeF12Body: true,
    pluginHostSignRedaction: true,
    domainCheckPolicy: policy.runnerDomainPolicy,
    pluginAuthorization:
      "External verifyPlugin remains unverified; no synthetic credentials",
    requests: received.map((r) => ({
      path: r.url,
      method: r.method,
      bytes: r.body.length,
    })),
    nativeApi: body.context.nativeApi,
  };
  fs.writeFileSync(
    "docs/native-network-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  if (t)
    fs.writeFileSync(
      ".local/native-network-smoke-failure.log",
      t.logs.join(""),
    );
  throw error;
} finally {
  if (t) await t.close();
  server.closeAllConnections();
  server.close();
}
