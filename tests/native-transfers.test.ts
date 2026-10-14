import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { NativeTransfers } from "../src/native-components/transfers";
import { createHostApis } from "../src/wx-shim/host";
import { debugContext } from "../src/debug/context";
import { installTransport } from "../src/debug/transport";
import { ArtifactStore } from "../src/controller/artifacts";
import { NetworkRules } from "../src/controller/rules";
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-native-transfer-"));
  const config = {
    dataDir: path.join(dir, "data"),
    packageDir: path.join(dir, "package"),
    storageFile: path.join(dir, "storage.json"),
    appid: "wx" + "0000000000000001",
    appVersion: 2
  };
  fs.mkdirSync(config.packageDir);
  const host = createHostApis(config, () => {});
  const events: any[] = [],
    requests: any[] = [];
  const artifacts = new ArtifactStore(path.join(dir, "artifacts")),
    rules = new NetworkRules(),
    records = new Map<string, any>();
  const restore = installTransport(async (action, a) => {
    if (action === "plan") return rules.evaluate(a.request);
    if (action === "artifact-create") return {
      id: artifacts.create({
        ...a,
        runtimeId: "r",
        sessionId: "s"
      })
    };
    if (action === "artifact-append") return artifacts.append(a.id, a.data);
    if (action === "artifact-finish") return artifacts.finish(a.id, a);
    throw Error(action);
  }, r => records.set(r.id, r));
  let onEvent = (_e: any) => {};
  const native = new NativeTransfers(host, () => {}, (name, e) => {
    events.push({
      name,
      ...e,
      context: debugContext.getStore()
    });
    onEvent(e);
  });
  const server = http.createServer(async (req, res) => {
    requests.push({
      url: req.url,
      headers: req.headers
    });
    if (req.url === "/slow") {
      res.writeHead(200, {
        "content-length": 200000
      });
      res.write("first");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: "/gzip"
      }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    requests.at(-1).body = Buffer.concat(chunks);
    if (req.url === "/upload") {
      res.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip"
      });
      res.end(gzipSync('{"text":"上传中文🙂"}'));
      return;
    }
    res.writeHead(req.url === "/404" ? 404 : 200, {
      "content-type": "text/plain; charset=utf-8",
      "content-encoding": "gzip"
    });
    res.end(gzipSync("下载内容🙂"));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const invoke = (name: string, args: any) => JSON.parse(native.invoke(name, args, () => {
    throw Error("unexpected async");
  })!);
  async function wait(id: number, kind: "Upload" | "Download") {
    const key = kind.toLowerCase() + "TaskId",
      deadline = Date.now() + 6000;
    while (!events.some(e => e[key] === id && ["success", "fail"].includes(e.state))) {
      if (Date.now() > deadline) throw Error("terminal event timeout");
      await new Promise(r => setTimeout(r, 15));
    }
    return events.filter(e => e[key] === id);
  }
  return {
    host,
    native,
    url,
    events,
    requests,
    records,
    artifacts,
    rules,
    invoke,
    wait,
    dir,
    onEvent: (fn: typeof onEvent) => onEvent = fn,
    async close() {
      await restore();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dir, {
        recursive: true,
        force: true
      });
    }
  };
}
test("native download: async ID first, headers/progress, decoded bytes, redirects and explicit destination", async () => {
  const t = await fixture();
  try {
    let id = 0;
    debugContext.run({
      operationId: "download-op",
      handler: "downloadButton"
    }, () => {
      assert.equal(t.native.invoke("createDownloadTaskAsync", {
        url: t.url + "/redirect",
        filePath: "wxfile://usr/file.txt"
      }, r => {
        assert.equal(t.events.length, 0);
        id = r.downloadTaskId;
        t.invoke("listenDownloadTaskStateChange", {
          taskId: id,
          states: ["headersReceived", "progressUpdate"]
        });
      }), "");
    });
    await new Promise<void>(queueMicrotask);
    const events = await t.wait(id, "Download"),
      end = events.at(-1);
    assert.equal(events[0].state, "headersReceived");
    assert.equal(end.state, "success");
    assert.equal(end.filePath, "wxfile://usr/file.txt");
    assert.equal(end.tempFilePath, undefined);
    assert.equal(end.dataLength, Buffer.byteLength("下载内容🙂"));
    assert.equal(end.context.handler, "downloadButton");
    assert.equal(end.context.operationId, "download-op");
    assert.equal(t.host.files.api.getFileSystemManager().readFileSync(end.filePath, "utf8"), "下载内容🙂");
    const progress = events.filter(e => e.state === "progressUpdate");
    assert.equal(progress[0].totalBytesExpectedToWrite, 0);
    assert.equal(progress.at(-1).progress, 100);
    assert.equal(progress.at(-1).totalBytesWritten, end.dataLength);
    assert.deepEqual(t.requests.map(r => r.url), ["/redirect", "/gzip"]);
    const next = t.invoke("createDownloadTask", {
      url: t.url + "/404"
    });
    const other = (await t.wait(next.downloadTaskId, "Download")).at(-1);
    assert.equal(other.state, "success");
    assert.equal(other.statusCode, 404);
    assert.match(other.tempFilePath, /^wxfile:\/\/tmp\//);
    assert.equal(t.native.pendingCount, 0);
  } finally {
    await t.close();
  }
});
test("native upload uses real multipart bytes, MIME, transport progress and repeatable cached bodies", async () => {
  const t = await fixture();
  try {
    const bytes = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.alloc(65536, 65)]);
    const file = "wxfile://sdk/plugin/source.png";
    const physical = t.host.nativeFiles.resolve(file, true);
    fs.mkdirSync(path.dirname(physical), {
      recursive: true
    });
    fs.writeFileSync(physical, bytes);
    assert.throws(() => t.host.files.resolve(file), /internal file space/);
    const r = debugContext.run({
      handler: "uploadButton",
      operationId: "upload-op"
    }, () => t.invoke("createUploadTask", {
      url: t.url + "/upload",
      filePath: file,
      name: "asset",
      formData: {
        title: "中文🙂"
      },
      header: {
        "content-type": "bad/boundary"
      }
    }));
    t.invoke("listenUploadTaskStateChange", {
      taskId: r.uploadTaskId,
      states: ["progressUpdate", "headersReceived"]
    });
    const events = await t.wait(r.uploadTaskId, "Upload"),
      end = events.at(-1);
    assert.equal(end.state, "success");
    assert.equal(end.statusCode, 201);
    assert.equal(JSON.parse(end.data).text, "上传中文🙂");
    assert.equal(events.filter(e => e.state === "headersReceived").length, 1);
    const sent = events.filter(e => e.state === "progressUpdate");
    assert.ok(sent.length > 0);
    const request = t.requests[0];
    assert.match(request.headers["content-type"], /multipart\/form-data; boundary=/);
    assert.ok(request.body.includes(bytes));
    assert.ok(request.body.includes(Buffer.from("中文🙂")));
    assert.match(request.body.toString(), /filename="source.png"\r\nContent-Type: image\/png/);
    assert.equal(sent.at(-1).totalBytesSent, request.body.length);
    assert.equal(sent.at(-1).progress, 100);
    assert.equal(end.context.nativeApi, "createUploadTask");
    const record = [...t.records.values()].find(r => r.url.endsWith("/upload"));
    assert.equal(record.context.handler, "uploadButton");
    assert.equal(record.context.nativeTaskType, "Upload");
    assert.equal(record.multipart.find((p: any) => p.name === "asset").size, bytes.length);
    assert.equal(record.responseBody, end.data);
    assert.deepEqual(t.artifacts.read(record.responseArtifactId), t.artifacts.read(record.responseArtifactId));
    assert.deepEqual(fs.readFileSync(physical), bytes);
  } finally {
    await t.close();
  }
});
test("native transfers reject invalid paths/operations without traffic; cancellation and timeout preserve destination", async () => {
  const t = await fixture();
  try {
    const file = "wxfile://usr/result.txt",
      destination = t.host.files.resolve(file, true);
    fs.writeFileSync(destination, "existing");
    for (const args of [{
      filePath: "/app-service.js"
    }, {
      filePath: "wxfile://usr/../../outside"
    }, {
      timeout: -1
    }, {
      filePath: "wxfile://usr"
    }]) assert.match(t.invoke("createDownloadTask", {
      url: t.url,
      ...args
    }).errMsg, /:fail /);
    for (const args of [{
      filePath: "wxfile://usr/missing",
      name: "file"
    }, {
      filePath: file
    }, {
      filePath: "wxfile://usr",
      name: "file"
    }]) assert.match(t.invoke("createUploadTask", {
      url: t.url,
      ...args
    }).errMsg, /:fail /);
    assert.equal(t.native.pendingCount, 0);
    assert.equal(t.requests.length, 0);
    const first = t.invoke("createDownloadTask", {
      url: t.url,
      filePath: file
    });
    assert.match(t.invoke("operateUploadTask", {
      uploadTaskId: first.downloadTaskId,
      operationType: "abort"
    }).errMsg, /invalid uploadTaskId/);
    assert.match(t.invoke("operateDownloadTask", {
      downloadTaskId: first.downloadTaskId,
      operationType: "retry"
    }).errMsg, /invalid operationType/);
    t.invoke("operateDownloadTask", {
      downloadTaskId: first.downloadTaskId,
      operationType: "abort"
    });
    assert.equal((await t.wait(first.downloadTaskId, "Download")).at(-1).errMsg, "abort");
    assert.equal(t.requests.length, 0);
    const r = t.invoke("createDownloadTask", {
      url: t.url + "/slow",
      filePath: file
    });
    t.invoke("listenDownloadTaskStateChange", {
      taskId: r.downloadTaskId,
      states: ["progressUpdate"]
    });
    t.onEvent(e => {
      if (e.downloadTaskId === r.downloadTaskId && e.state === "progressUpdate") t.invoke("operateDownloadTask", {
        downloadTaskId: r.downloadTaskId,
        operationType: "abort"
      });
    });
    const cancelled = await t.wait(r.downloadTaskId, "Download");
    assert.equal(cancelled.at(-1).state, "fail");
    assert.equal(cancelled.at(-1).errMsg, "abort");
    assert.equal(cancelled.filter(e => ["success", "fail"].includes(e.state)).length, 1);
    const timed = t.invoke("createDownloadTask", {
      url: t.url + "/slow",
      filePath: file,
      timeout: 100
    });
    assert.match((await t.wait(timed.downloadTaskId, "Download")).at(-1).errMsg, /timeout/);
    assert.equal(fs.readFileSync(destination, "utf8"), "existing");
    assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["result.txt"]);
    assert.equal(t.native.pendingCount, 0);
  } finally {
    await t.close();
  }
});
test("public and native transfers share read-only grants; callback exceptions never trigger a second failure", async () => {
  const t = await fixture();
  try {
    const external = path.join(t.dir, "external.txt");
    fs.writeFileSync(external, "granted");
    t.host.files.grant(external);
    let success = 0,
      fail = 0,
      complete = 0;
    await new Promise<void>(resolve => t.host.files.api.uploadFile({
      url: t.url + "/upload",
      name: "file",
      filePath: external,
      success() {
        success++;
        throw Error("business callback");
      },
      fail() {
        fail++;
      },
      complete() {
        complete++;
        resolve();
      }
    }));
    assert.deepEqual({
      success,
      fail,
      complete
    }, {
      success: 1,
      fail: 0,
      complete: 1
    });
    const r = t.invoke("createUploadTask", {
      url: t.url + "/upload",
      name: "file",
      filePath: external
    });
    assert.equal((await t.wait(r.uploadTaskId, "Upload")).at(-1).state, "success");
    assert.equal(fs.readFileSync(external, "utf8"), "granted");
    assert.match(t.invoke("createDownloadTask", {
      url: t.url,
      filePath: external
    }).errMsg, /read-only/);
    assert.equal(t.requests.length, 2);
  } finally {
    await t.close();
  }
});
