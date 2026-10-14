import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { installTransport } from "../src/debug/transport";
import { ArtifactStore } from "../src/controller/artifacts";
import { NetworkRules } from "../src/controller/rules";

test("controlled transport preserves Unicode/gzip and redirects, modifies wire requests, mocks without outbound traffic, and throttles both directions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-transport-"));
  const artifacts = new ArtifactStore(dir);
  const rules = new NetworkRules();
  const records = new Map<string, any>();
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    const time = performance.now();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    requests.push({
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks),
      durationMs: performance.now() - time,
    });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/echo" }).end();
      return;
    }
    if (req.url === "/download") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.alloc(32768, 65));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
    });
    res.end(
      gzipSync(
        Buffer.from(
          JSON.stringify({
            text: "中文😀",
            body: Buffer.concat(chunks).toString(),
            token: "private-value",
          }),
        ),
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const sink = async (action: string, a: any) => {
    if (action === "plan") return rules.evaluate(a.request);
    if (action === "artifact-create")
      return { id: artifacts.create({ ...a, runtimeId: "r", sessionId: "s" }) };
    if (action === "artifact-append") return artifacts.append(a.id, a.data);
    if (action === "artifact-finish") return artifacts.finish(a.id, a);
    throw Error(action);
  };
  const close = installTransport(sink, (r) => records.set(r.id, r));
  const complete = async (id: string) => {
    const deadline = Date.now() + 5000;
    while (
      !["complete", "failed", "capture-error"].includes(records.get(id)?.state)
    ) {
      if (Date.now() > deadline)
        throw Error("capture timeout " + JSON.stringify(records.get(id)));
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(
      records.get(id).state,
      "complete",
      JSON.stringify(records.get(id)),
    );
    return records.get(id);
  };
  try {
    assert.equal(
      (
        await (
          await fetch(base + "/echo", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"x":"中文😀"}',
          })
        ).json()
      ).text,
      "中文😀",
    );
    const record = await complete("1");
    assert.equal(JSON.parse(record.requestBody).x, "中文😀");
    assert.equal(
      JSON.parse(
        gunzipSync(artifacts.bytes(record.rawResponseArtifactId)).toString(),
      ).text,
      "中文😀",
    );
    const one: any = artifacts.read(record.responseArtifactId);
    const two: any = artifacts.read(record.responseArtifactId);
    assert.equal(one.data, two.data);
    assert.ok(
      !Buffer.from(one.data, "base64").toString().includes("private-value"),
    );
    const rule = rules.set(
      {
        enabled: true,
        match: { urlIncludes: "/modify" },
        action: "modify",
        change: {
          url: base + "/echo",
          headers: { "x-modified": "yes" },
          body: "changed中文",
        },
      },
      "a",
    );
    await (
      await fetch(base + "/modify", { method: "POST", body: "original" })
    ).text();
    await complete("2");
    assert.equal(requests.at(-1).url, "/echo");
    assert.equal(requests.at(-1).headers["x-modified"], "yes");
    assert.equal(requests.at(-1).body.toString(), "changed中文");
    rules.update(rule.id, "remove");
    const mock = rules.set(
      {
        enabled: true,
        match: { urlIncludes: "/mock" },
        action: "mock",
        response: {
          status: 201,
          headers: { "content-type": "application/json" },
          body: '{"text":"模拟中文"}',
        },
      },
      "a",
    );
    const before = requests.length;
    const mocked = await fetch(base + "/mock");
    assert.equal(mocked.status, 201);
    assert.equal((await mocked.json()).text, "模拟中文");
    await complete("3");
    assert.equal(requests.length, before);
    rules.update(mock.id, "remove");
    await (await fetch(base + "/redirect")).text();
    const redirected = await complete("4");
    assert.equal(redirected.hops.length, 2);
    assert.equal(redirected.hops[0].status, 302);
    rules.conditions.uploadBytesPerSecond = 32768;
    await (
      await fetch(base + "/echo", { method: "POST", body: Buffer.alloc(32768) })
    ).text();
    await complete("5");
    assert.ok(
      requests.at(-1).durationMs > 350,
      String(requests.at(-1).durationMs),
    );
    rules.conditions.uploadBytesPerSecond = 0;
    rules.conditions.downloadBytesPerSecond = 32768;
    const start = performance.now();
    assert.equal(
      (await (await fetch(base + "/download")).arrayBuffer()).byteLength,
      32768,
    );
    assert.ok(performance.now() - start >= 900);
    await complete("6");
    rules.conditions.offline = true;
    const count = requests.length;
    await assert.rejects(fetch(base + "/offline"));
    assert.equal(requests.length, count);
  } finally {
    await close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    artifacts.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact quotas preserve repeatable reads and expose eviction/truncation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-artifacts-"));
  const store = new ArtifactStore(dir, 8, 12);
  const meta = {
    runtimeId: "r",
    sessionId: "s",
    kind: "body",
    mimeType: "text/plain",
  };
  try {
    const a = store.put(meta, Buffer.from("12345678"));
    const b = store.put(meta, Buffer.from("abcdefghijk"));
    assert.equal(store.info(a).evicted, true);
    assert.throws(() => store.read(a), /evicted/);
    assert.equal(store.info(b).truncated, true);
    assert.equal(store.info(b).bytes, 8);
    assert.equal(store.info(b).observedBytes, 11);
    assert.deepEqual(store.read(b), store.read(b));
    store.closeSession("s");
    assert.throws(() => store.bytes(b), /evicted/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
