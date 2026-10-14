import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { socketApis } from "../src/wx-shim/socket";
import { createRequest } from "../src/wx-shim/network";
import { fileApis } from "../src/wx-shim/files";
import { installTransport } from "../src/debug/transport";
import { ArtifactStore } from "../src/controller/artifacts";
import { NetworkRules } from "../src/controller/rules";
test("SocketTask supports text/binary frames, listeners, callback completion and close codes", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", r));
  server.on("connection", (ws) =>
    ws.on("message", (data, binary) => ws.send(data, { binary })),
  );
  const records: any[] = [];
  const sockets = socketApis((r) => records.push(r));
  let connects = 0,
    sends = 0,
    closes = 0;
  try {
    const task = sockets.api.connectSocket({
      url: "ws://127.0.0.1:" + (server.address() as any).port,
      complete: () => connects++,
    });
    await new Promise<void>((resolve, reject) => {
      task.onOpen(resolve);
      task.onError(reject);
    });
    const responses: any[] = [];
    const received = new Promise<void>((resolve) =>
      task.onMessage((r: any) => {
        responses.push(r.data);
        if (responses.length === 2) resolve();
      }),
    );
    task.send({ data: "中文😀", complete: () => sends++ });
    task.send({
      data: new Uint8Array([0, 255, 128]).buffer,
      complete: () => sends++,
    });
    await received;
    assert.equal(responses[0], "中文😀");
    assert.deepEqual([...new Uint8Array(responses[1])], [0, 255, 128]);
    const closed = new Promise<any>((resolve) => task.onClose(resolve));
    task.close({ code: 1000, reason: "finished", complete: () => closes++ });
    assert.equal((await closed).code, 1000);
    assert.equal(connects, 1);
    assert.equal(sends, 2);
    assert.equal(closes, 1);
    const last = records.at(-1);
    assert.equal(last.frameCount, 4);
    assert.equal(last.state, "complete");
    assert.equal(
      last.frames.find((f: any) => f.direction === "received" && f.opcode === 2)
        .payload,
      "AP+A",
    );
  } finally {
    sockets.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("wx request distinguishes timeout/abort and emits chunks; file transfer streams progress and multipart metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-media-"));
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const rules = new NetworkRules();
  const records: any[] = [];
  let upload: Buffer | undefined;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/slow") {
      const timer = setTimeout(() => res.end("late"), 200);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (req.url === "/gbk") {
      res.writeHead(200, { "content-type": "text/plain; charset=gbk" });
      res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
      return;
    }
    if (req.url === "/upload") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      upload = Buffer.concat(chunks);
      res.writeHead(201, { "content-type": "text/plain" }).end("uploaded");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.alloc(16384, 65));
    setTimeout(() => res.end(Buffer.alloc(16384, 66)), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const close = installTransport(
    async (action, a) => {
      if (action === "plan") return rules.evaluate(a.request);
      if (action === "cancel") return {};
      if (action === "artifact-create")
        return {
          id: artifacts.create({ ...a, runtimeId: "r", sessionId: "s" }),
        };
      if (action === "artifact-append") return artifacts.append(a.id, a.data);
      return artifacts.finish(a.id, a);
    },
    (r) => records.push(r),
  );
  const request = createRequest(() => {});
  const files = fileApis(
    { dataDir: path.join(root, "data"), packageDir: root },
    () => {},
  );
  try {
    const gbk: any = await new Promise((resolve, reject) =>
      request({
        url: base + "/gbk",
        dataType: "text",
        success: resolve,
        fail: reject,
      }),
    );
    assert.equal(gbk.data, "中文");
    const timeout: any = await new Promise((resolve) =>
      request({ url: base + "/slow", timeout: 10, fail: resolve }),
    );
    assert.match(timeout.errMsg, /timeout/);
    let complete = 0;
    const abort: any = await new Promise((resolve) => {
      const task = request({
        url: base + "/slow",
        fail: resolve,
        complete: () => complete++,
      });
      task.abort();
    });
    assert.match(abort.errMsg, /abort/);
    assert.equal(complete, 1);
    const chunks: ArrayBuffer[] = [];
    const streamed: any = await new Promise((resolve, reject) => {
      const task = request({
        url: base + "/chunks",
        responseType: "arraybuffer",
        enableChunked: true,
        success: resolve,
        fail: reject,
      });
      task.onChunkReceived!((r: any) => chunks.push(r.data));
    });
    assert.equal(streamed.data.byteLength, 32768);
    assert.ok(chunks.length >= 2);
    const progress: any[] = [];
    const downloaded: any = await new Promise((resolve, reject) => {
      const task = files.api.downloadFile({
        url: base + "/download",
        success: resolve,
        fail: reject,
      });
      task.onProgressUpdate((r: any) => progress.push(r));
    });
    assert.equal(
      fs.statSync(files.resolve(downloaded.tempFilePath)).size,
      32768,
    );
    assert.ok(progress.length >= 2);
    assert.equal(progress.at(-1).progress, 100);
    fs.writeFileSync(
      path.join(root, "data", "upload.bin"),
      Buffer.alloc(131072, 90),
    );
    rules.conditions.uploadBytesPerSecond = 131072;
    const uploads: any[] = [];
    const uploaded: any = await new Promise((resolve, reject) => {
      const task = files.api.uploadFile({
        url: base + "/upload",
        filePath: "wxfile://usr/upload.bin",
        name: "file",
        formData: { message: "表单中文" },
        success: resolve,
        fail: reject,
      });
      task.onProgressUpdate((r: any) => uploads.push(r));
    });
    assert.equal(uploaded.statusCode, 201);
    assert.ok(upload!.includes(Buffer.from("表单中文")));
    assert.ok(upload!.length > 131072);
    assert.ok(uploads.length > 1);
    assert.ok(uploads.at(-1).totalBytesSent >= 131072);
    assert.ok(
      records.some((r) =>
        r.multipart?.some((f: any) => f.name === "file" && f.size === 131072),
      ),
    );
  } finally {
    await close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    artifacts.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
