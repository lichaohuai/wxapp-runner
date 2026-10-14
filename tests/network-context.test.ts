import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequest } from "../src/wx-shim/network";
import { fileApis } from "../src/wx-shim/files";
import { resolvePackageVersion } from "../src/loader/package-version";
import { readConfig, wxConfig } from "../src/config";
import { parseTool } from "../src/mcp/tools";
test("native network identity reaches actual request/upload/download without changing business data or host fetch", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wx-network-context-"));
  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));
  const received: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString()
    });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const a = {
    appid: "wx" + "0000000000000006",
    appVersion: 83
  };
  const b = {
    appid: "wx" + "000000000000000a",
    appVersion: 9
  };
  const header = {
    ReFeReR: "https://invalid.example/",
    REFERRER: "invalid",
    "X-Sign": "untouched",
    Cookie: "fixture=1"
  };
  const invoke = (fn: Function, o: any) => new Promise<any>((success, fail) => fn({
    ...o,
    success,
    fail
  }));
  const result = await invoke(createRequest(() => {}, 5000, a), {
    url: url + "/request?sign=original",
    method: "POST",
    data: "中文😀",
    header
  });
  assert.equal(result.data.ok, true);
  const files = fileApis({
    ...a,
    packageDir: root,
    dataDir: path.join(root, "data")
  }, () => {});
  const download = await invoke(files.api.downloadFile, {
    url: url + "/download",
    header
  });
  assert.equal(fs.readFileSync(files.resolve(download.tempFilePath), "utf8"), '{"ok":true}');
  await invoke(files.api.uploadFile, {
    url: url + "/upload",
    filePath: download.tempFilePath,
    name: "asset",
    formData: {
      note: "中文"
    },
    header
  });
  await invoke(createRequest(() => {}, 5000, b), {
    url: url + "/other-app"
  });
  await (await fetch(url + "/host-bot-or-package-request")).text();
  for (const req of received.slice(0, 3)) {
    assert.equal(req.headers.referer, `https://servicewechat.com/${a.appid}/83/page-frame.html`);
    assert.equal(req.headers.referrer, undefined);
    assert.equal(req.headers["x-sign"], "untouched");
    assert.equal(req.headers.cookie, "fixture=1");
  }
  assert.equal(received[0].url, "/request?sign=original");
  assert.equal(received[0].body, "中文😀");
  assert.match(received[2].headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(received[2].body, /中文/);
  assert.equal(received[3].headers.referer, `https://servicewechat.com/${b.appid}/9/page-frame.html`);
  assert.equal(received[4].headers.referer, undefined);
  assert.equal(header.ReFeReR, "https://invalid.example/");
});
test("package version comes from matched download metadata, supports explicit configuration, and never borrows another app identity", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wx-version-"));
  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));
  const pkg = path.join(root, "package"),
    appid = "wx" + "0000000000000006";
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "app-config.json"), JSON.stringify({
    pages: ["pages/a"],
    entryPagePath: "pages/a.html"
  }));
  const metadata = {
    format: 1,
    complete: true,
    appid,
    version: 83
  };
  const write = (value: any) => fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(value));
  write(metadata);
  assert.deepEqual(resolvePackageVersion(pkg, appid, {}), {
    appVersion: 83,
    appVersionSource: "download-manifest"
  });
  const args = ["--package", pkg, "--appid", appid, "--config", path.join(root, "missing.json")];
  assert.equal(wxConfig(readConfig(args)).accountInfo.appVersion, 83);
  assert.equal(readConfig([...args, "--app-version", "91"]).appVersion, 91);
  assert.throws(() => readConfig([...args, "--app-version", "bad"]), /PACKAGE_VERSION_INVALID/);
  assert.equal((parseTool("runner_runtime", {
    action: "start",
    appid,
    packageDir: pkg,
    appVersion: 91
  }) as any).appVersion, 91);
  assert.throws(() => parseTool("runner_runtime", {
    action: "start",
    appid,
    packageDir: pkg,
    appVersion: -1
  }));
  write({
    ...metadata,
    appid: "wx" + "000000000000000a"
  });
  assert.deepEqual(resolvePackageVersion(pkg, appid, {}), {
    appVersion: 0,
    appVersionSource: "unknown-native-zero"
  });
  write({
    ...metadata,
    complete: false
  });
  assert.equal(resolvePackageVersion(pkg, appid, {
    accountInfo: {
      appVersion: 7
    }
  }).appVersion, 7);
  assert.equal(resolvePackageVersion(pkg, appid, {}, 0).appVersion, 0);
});
