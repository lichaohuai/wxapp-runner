import { managedFixture, until } from "./managed-test-runtime.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
const content = "文件正文中文🙂\n";
const requests = [];
const server = http.createServer(async (req, res) => {
  const entry = { path: req.url, method: req.method, bytes: 0 };
  requests.push(entry);
  if (req.url === "/slow") {
    res.writeHead(200, { "content-length": 99999 });
    res.write("partial");
    return;
  }
  const chunks = [];
  for await (const b of req) chunks.push(b);
  const body = Buffer.concat(chunks);
  entry.bytes = body.length;
  if (req.url === "/upload-timeout") return;
  if (req.url === "/upload") {
    assert.match(req.headers["content-type"], /multipart\/form-data/);
    assert.ok(body.includes(Buffer.from(content)));
    assert.ok(body.includes(Buffer.from("输入中文🙂")));
    res.writeHead(201, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
    });
    res.end(gzipSync(JSON.stringify({ message: "下载上传完成🙂" })));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-encoding": "gzip",
  });
  res.end(gzipSync(content));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
let t;
try {
  t = await managedFixture({
    url: url + "/unused",
    beforeStart({ packageDir }) {
      const file = path.join(packageDir, "app-service.js"),
        source = fs.readFileSync(file, "utf8");
      const start = source.indexOf(" submit(){"),
        end = source.indexOf("\n modal(){", start);
      assert.ok(start > 0 && end > start);
      // Only this disposable compiled fixture is changed, never a supplied app.
      const handler = ` submit(){
        const sdk=internals.__appServiceSDK__.wx;
        globalThis.__transferEvents=[];
        const observe=(task,kind)=>{task.onProgressUpdate(e=>__transferEvents.push({kind,state:'progress',...e}));task.onHeadersReceived(e=>__transferEvents.push({kind,state:'headers',statusCode:e.statusCode}));};
        const download=sdk.downloadFile({url:${JSON.stringify(url + "/download")},filePath:'wxfile://usr/transfer.txt',
          success:r=>{__transferEvents.push({kind:'download',state:'success',filePath:r.filePath});
            const upload=sdk.uploadFile({url:${JSON.stringify(url + "/upload")},filePath:r.filePath,name:'document',formData:{title:this.data.input},
              success:r=>this.setData({result:JSON.parse(r.data).message}),fail:r=>this.setData({result:r.errMsg})});observe(upload,'upload');},
          fail:r=>this.setData({result:r.errMsg})});observe(download,'download');},`;
      fs.writeFileSync(
        file,
        source.slice(0, start) + handler + source.slice(end),
      );
    },
  });
  const call = t.call;
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await call("runner_evaluate", { expression, awaitPromise });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  assert.equal(
    await evaluate(
      "internals.__appServiceSDK__.wx.downloadFile===wx.downloadFile",
    ),
    false,
  );
  assert.equal(
    await evaluate("internals.__appServiceSDK__.wx.uploadFile===wx.uploadFile"),
    false,
  );
  await call("runner_input", { selector: "textarea", text: "输入中文🙂" });
  await call("runner_click", { text: "提交", exact: true });
  assert.equal(
    (await call("runner_wait", { kind: "text", text: "下载上传完成🙂" }))
      .status,
    "matched",
  );
  const events = await evaluate("__transferEvents");
  assert.equal(events.filter((e) => e.state === "headers").length, 2);
  assert.ok(
    events.some(
      (e) =>
        e.kind === "upload" && e.state === "progress" && e.totalBytesSent > 0,
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.kind === "download" &&
        e.state === "success" &&
        e.filePath === "wxfile://usr/transfer.txt",
    ),
  );
  assert.equal(
    await evaluate(
      `wx.getFileSystemManager().readFileSync('wxfile://usr/transfer.txt','utf8')`,
    ),
    content,
  );
  const records = await until(async () => {
    const r = (
      await call("runner_network", {
        filter: { urlIncludes: url },
        summary: true,
      })
    ).entries;
    return r.filter((e) => e.state === "complete").length === 2 ? r : false;
  });
  const saved = {};
  for (const p of ["/download", "/upload"]) {
    const record = records.find((r) => r.url.endsWith(p));
    assert.ok(record);
    const body = await call("runner_network", { id: record.id });
    assert.equal(body.context.handler, "submit");
    assert.match(
      body.context.nativeApi,
      p === "/download" ? /^createDownloadTask/ : /^createUploadTask/,
    );
    assert.deepEqual(await call("runner_network", { id: record.id }), body);
    saved[p] = { id: record.id, body };
  }
  assert.equal(saved["/download"].body.responseBody, content);
  assert.equal(
    JSON.parse(saved["/upload"].body.responseBody).message,
    "下载上传完成🙂",
  );
  assert.ok(
    saved["/upload"].body.multipart.some(
      (p) =>
        p.fileName === "transfer.txt" && p.size === Buffer.byteLength(content),
    ),
  );
  await call("runner_debugger", { action: "open" });
  const debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Network", exact: true }).click();
  await debug.getByRole("cell", { name: "Fetch upload", exact: true }).click();
  await debug.getByRole("tab", { name: "Response", exact: true }).click();
  await debug
    .getByText(/下载上传完成🙂/)
    .first()
    .waitFor();
  const evidence = "docs/evidence/native-transfers-2026-09-12";
  fs.mkdirSync(evidence, { recursive: true });
  await debug.screenshot({ path: path.join(evidence, "f12-upload.png") });
  await debug.getByRole("cell").filter({ hasText: "download" }).first().click();
  await debug.getByRole("tab", { name: "Response", exact: true }).click();
  await debug
    .getByText(/文件正文中文🙂/)
    .first()
    .waitFor();
  await debug.screenshot({ path: path.join(evidence, "f12-download.png") });
  for (const { id, body } of Object.values(saved))
    assert.equal(
      (await call("runner_network", { id })).responseBody,
      body.responseBody,
    );
  console.log("native F12 upload/download and MCP repeated bodies passed");
  const temp = await evaluate(
    `new Promise(resolve=>internals.__appServiceSDK__.wx.downloadFile({url:${JSON.stringify(url + "/temp")},success:r=>resolve(r),fail:r=>resolve(r)}))`,
    true,
  );
  assert.match(temp.errMsg, /downloadFile:ok/);
  assert.match(temp.tempFilePath, /^wxfile:\/\/tmp\//);
  // Abort in flight when the first progress callback arrives. This exercises
  // the partial-stream path, not merely cancellation before any I/O.
  const abort = await evaluate(
    `new Promise(resolve=>{const calls=[];const task=internals.__appServiceSDK__.wx.downloadFile({url:${JSON.stringify(url + "/slow")},filePath:'wxfile://usr/transfer.txt',success:r=>calls.push('success'),fail:r=>calls.push(r.errMsg),complete:()=>resolve(calls)});task.onProgressUpdate(()=>task.abort())})`,
    true,
  );
  assert.equal(abort.length, 1);
  assert.match(abort[0], /abort/);
  const timeout = await evaluate(
    `new Promise(resolve=>{const calls=[];internals.__appServiceSDK__.wx.uploadFile({url:${JSON.stringify(url + "/upload-timeout")},filePath:'wxfile://usr/transfer.txt',name:'file',timeout:150,success:()=>calls.push('success'),fail:r=>calls.push(r.errMsg),complete:()=>resolve(calls)})})`,
    true,
  );
  assert.equal(timeout.length, 1);
  assert.match(timeout[0], /timeout/);
  assert.equal(
    await evaluate(
      `wx.getFileSystemManager().readFileSync('wxfile://usr/transfer.txt','utf8')`,
    ),
    content,
  );
  const result = {
    passed: true,
    platform: process.platform,
    genuineBaseTransferTasks: true,
    handlerDownloadUploadSetData: true,
    progressAndHeaders: true,
    explicitAndTemporaryPaths: true,
    unicodeMultipartGzip: true,
    abortInFlightExactlyOnce: true,
    uploadTimeoutExactlyOnce: true,
    existingDestinationPreserved: true,
    mcpRepeatableBody: true,
    lateNativeF12UploadAndDownload: true,
    verifyPlugin: "External authorization not fabricated or claimed verified",
    requests,
  };
  fs.writeFileSync(
    "docs/native-transfers-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  if (t)
    fs.writeFileSync(
      ".local/native-transfers-smoke-failure.log",
      t.logs.join(""),
    );
  throw error;
} finally {
  if (t) await t.close();
  server.closeAllConnections();
  server.close();
}
