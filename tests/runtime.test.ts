import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { safePath, chunkMap, viewFiles } from "../src/loader";
import { storageApi } from "../src/wx-shim/storage";
import { createRequest } from "../src/wx-shim/network";
import { WxbotClient } from "../src/wxbot";
import { fileApis } from "../src/wx-shim/files";
function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-test-"));
}
async function server(handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + (s.address() as any).port,
    close: () => new Promise<void>(r => s.close(() => r()))
  };
}
test("loader resolves the supplied package and discovers chunk routes without app constants", () => {
  const root = path.resolve("../package");
  const c = {
    packageDir: root,
    app: JSON.parse(fs.readFileSync(root + "/app-config.json", "utf8"))
  };
  const route = c.app.entryPagePath.replace(/\.html$/, "");
  const map = chunkMap(root);
  assert.equal(Object.keys(map).length, 62);
  assert.ok(viewFiles(c, route).includes(map[route] + ".webview.js"));
  assert.throws(() => safePath(root, "../../CLAUDE.md"));
});
test("loader rejects symlink escapes", () => {
  const dir = temp();
  try {
    fs.symlinkSync(os.tmpdir(), dir + "/outside");
    assert.throws(() => safePath(dir, "outside"));
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test("storage persists structured values and handles prototype-like keys", () => {
  const dir = temp();
  try {
    const a = storageApi(dir + "/store.json");
    a.setStorageSync("auth_token", "unit-test-token");
    a.setStorageSync("__proto__", {
      nested: [1, true, "x"]
    });
    const b = storageApi(dir + "/store.json");
    assert.equal(b.getStorageSync("auth_token"), "unit-test-token");
    assert.deepEqual(b.getStorageSync("__proto__"), {
      nested: [1, true, "x"]
    });
    const x = b.getStorageSync("__proto__");
    x.nested.push(2);
    assert.equal(b.getStorageSync("__proto__").nested.length, 3);
    b.clearStorageSync();
    assert.deepEqual(storageApi(dir + "/store.json").getStorageInfoSync().keys, []);
  } finally {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test("request sends actual HTTP JSON, reports non-2xx through success, complete once", async () => {
  let received: any;
  const s = await server(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    received = {
      body,
      method: req.method,
      header: req.headers["content-type"]
    };
    res.writeHead(403, {
      "content-type": "application/json"
    });
    res.end('{"blocked":true}');
  });
  try {
    let completed = 0;
    const r: any = await new Promise((resolve, reject) => createRequest(() => {})({
      url: s.url + "/anything",
      method: "POST",
      data: {
        hello: 1
      },
      success: r => resolve(r),
      fail: reject,
      complete: () => completed++
    }));
    assert.equal(r.statusCode, 403);
    assert.deepEqual(r.data, {
      blocked: true
    });
    assert.equal(completed, 1);
    assert.deepEqual(JSON.parse(received.body), {
      hello: 1
    });
    assert.equal(received.method, "POST");
  } finally {
    await s.close();
  }
});
test("wxbot sends account headers and documented body; unwraps response and rejects missing code", async () => {
  let request: any;
  let mode = 0;
  const s = await server(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    request = {
      url: req.url,
      headers: req.headers,
      body: JSON.parse(body)
    };
    res.setHeader("content-type", "application/json");
    res.end(mode === 0 ? '{"data":{"code":"test-code-not-a-real-code"}}' : '{"data":{}}');
  });
  try {
    const client = new WxbotClient({
      wxbot: s.url,
      appid: "test-app",
      deviceId: "test-device",
      appKey: "key",
      appSecret: "secret"
    });
    assert.equal((await client.call("jslogin")).code, "test-code-not-a-real-code");
    assert.equal(request.url, "/miniprogram/jslogin");
    assert.equal(request.headers["x-app-secret"], "secret");
    assert.deepEqual(request.body, {
      device_id: "test-device",
      appid: "test-app"
    });
    mode = 1;
    await assert.rejects(() => client.call("jslogin"), /did not return/);
  } finally {
    await s.close();
  }
});
test("filesystem uses virtual user root and denies traversal", () => {
  const root = temp();
  const pkg = temp();
  try {
    const {
      api
    } = fileApis({
      dataDir: root,
      packageDir: pkg
    }, () => {});
    const fm = api.getFileSystemManager();
    fm.mkdirSync("wxfile://usr/nested");
    fm.writeFileSync("wxfile://usr/nested/a.txt", "hello");
    assert.equal(fm.readFileSync("wxfile://usr/nested/a.txt", "utf8"), "hello");
    assert.throws(() => fm.readFileSync("wxfile://usr/../../etc/passwd"));
    assert.throws(() => fm.writeFileSync("/package.js", "bad"));
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
    fs.rmSync(pkg, {
      recursive: true,
      force: true
    });
  }
});
test("legacy exparser package loads page-frame.html before the page HTML", () => {
  const root = path.resolve("../package-" + ("wx" + "0000000000000010"));
  const app = JSON.parse(fs.readFileSync(path.join(root, "app-config.json"), "utf8"));
  assert.equal(app.componentFramework.default, "exparser");
  assert.deepEqual(viewFiles({
    packageDir: root,
    app
  }, app.entryPagePath.replace(/\.html$/, "")), ["page-frame.html"]);
});
