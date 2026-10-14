import { managedFixture } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-upload-workflow-"));
let outbound = 0,
  received;
const server = http.createServer(async (req, res) => {
  outbound++;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  received = Buffer.concat(chunks).toString();
  res.setHeader("content-type", "application/json");
  res.end('{"message":"上传成功😀"}');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/upload`;
const pkg = interactionFixture(root, url),
  file = path.join(root, "上传测试.txt"),
  bytes = "原始文件内容😀";
fs.writeFileSync(file, bytes);
const logic = path.join(pkg, "app-service.js");
fs.writeFileSync(
  logic,
  fs
    .readFileSync(logic, "utf8")
    .replace(
      "success:r=>this.setData({result:'file:'+r.tempFiles[0].name})",
      `success:r=>wx.uploadFile({url:${JSON.stringify(url)},filePath:r.tempFiles[0].path,name:'file',formData:{label:'字段中文'},success:r=>this.setData({result:JSON.parse(r.data).message})})`,
    ),
);
const t = await managedFixture({ packageDir: pkg });
const { call } = t;
try {
  await call("runner_wait", { kind: "element", selector: "#files" });
  const before = (await call("runner_status")).networkCursor;
  const click = await call("runner_click", { selector: "#files" });
  const dialog = await call("runner_wait", {
    kind: "dialog",
    dialogType: "chooseMessageFile",
  });
  assert.equal(dialog.status, "matched");
  await call("runner_dialog", {
    action: "respond",
    id: dialog.result.id,
    files: [file],
  });
  const done = await call("runner_wait", {
    kind: "operation",
    operationId: click.operationId,
    result: { kind: "text", text: "上传成功😀" },
  });
  assert.equal(done.businessCompleted, true);
  const request = await call("runner_wait", {
    kind: "network",
    after: before,
    urlIncludes: "/upload",
  });
  assert.equal(request.status, "matched");
  const record = await call("runner_network", { id: request.result.id });
  assert.equal(record.status, 200);
  assert.ok(
    record.multipart.some(
      (f) => f.name === "file" && f.size === Buffer.byteLength(bytes),
    ),
  );
  assert.ok(received.includes(bytes));
  assert.ok(received.includes("字段中文"));
  assert.equal(outbound, 1);
  const repeated = await t.client.callTool({
    name: "runner_dialog",
    arguments: { action: "respond", id: dialog.result.id, files: [file] },
  });
  assert.equal(repeated.isError, true);
  assert.equal(outbound, 1);
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    standardMcpFileSelection: true,
    authorizedFileRealUpload: true,
    multipartChinese: true,
    explicitResultWait: true,
    oneUploadAndOneCallback: true,
  };
  fs.writeFileSync(
    "docs/upload-workflow-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(t.logs.join("").slice(-3500));
  throw e;
} finally {
  await t.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
