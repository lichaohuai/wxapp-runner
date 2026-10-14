import test from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { gzipSync, gunzipSync } from "node:zlib";
import { installTransport } from "../src/debug/transport";
import { ArtifactStore } from "../src/controller/artifacts";
import { NetworkRules } from "../src/controller/rules";

test("HTTP/2 preserves headers, gzip decoding, redirects, cookies and repeatable raw/decoded bodies", async () => {
  const forge = createRequire(import.meta.url)("node-forge");
  const pair = forge.pki.rsa.generateKeyPair(2048),
    cert = forge.pki.createCertificate();
  cert.publicKey = pair.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: "localhost" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(pair.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const server = http2.createSecureServer({
    key: forge.pki.privateKeyToPem(pair.privateKey),
    cert: pem,
    allowHTTP1: false,
  });
  const payload = JSON.stringify({ text: "HTTP/2 中文🙂", ok: true }),
    compressed = gzipSync(payload),
    requests: any[] = [];
  server.on("stream", (stream, headers) => {
    requests.push(headers);
    if (headers[":path"] === "/redirect") {
      stream.respond({ ":status": 302, location: "/json" });
      stream.end();
      return;
    }
    stream.respond({
      ":status": 200,
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
    });
    stream.end(compressed);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-h2-")),
    artifacts = new ArtifactStore(root),
    rules = new NetworkRules(),
    records = new Map<string, any>();
  const close = installTransport(
    async (action, a) => {
      if (action === "plan") return rules.evaluate(a.request);
      if (action === "artifact-create")
        return {
          id: artifacts.create({ ...a, runtimeId: "h2", sessionId: "s" }),
        };
      if (action === "artifact-append") return artifacts.append(a.id, a.data);
      if (action === "artifact-finish") return artifacts.finish(a.id, a);
      throw Error(action);
    },
    (r) => records.set(r.id, r),
    undefined,
    undefined,
    { connect: { ca: pem }, allowH2: true },
  );
  try {
    const res = await fetch(
      `https://127.0.0.1:${(server.address() as any).port}/redirect`,
      { headers: { accept: "application/json" } },
    );
    assert.equal(res.headers.get("content-encoding"), "gzip");
    assert.equal(
      res.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(res.headers.getSetCookie().length, 2);
    assert.deepEqual(await res.json(), JSON.parse(payload));
    const end = Date.now() + 5000;
    while (records.get("1")?.state !== "complete" && Date.now() < end)
      await new Promise((r) => setTimeout(r, 5));
    const record = records.get("1");
    assert.equal(record.state, "complete");
    assert.equal(record.hops.length, 2);
    assert.equal(record.protocol, "h2");
    assert.equal(record.requestHeaders.accept, "application/json");
    assert.equal(record.requestHeaders[":method"], "GET");
    assert.equal(record.requestHeaders[""], undefined);
    assert.equal(record.responseBody, payload);
    assert.equal(record.encodedBytes, compressed.length);
    assert.equal(record.decodedBytes, Buffer.byteLength(payload));
    assert.equal(
      gunzipSync(artifacts.bytes(record.rawResponseArtifactId)).toString(),
      payload,
    );
    assert.equal(
      artifacts.bytes(record.responseArtifactId).toString(),
      payload,
    );
    assert.deepEqual(
      artifacts.read(record.responseArtifactId),
      artifacts.read(record.responseArtifactId),
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1][":path"], "/json");
  } finally {
    await close();
    await new Promise<void>((r) => server.close(() => r()));
    artifacts.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
