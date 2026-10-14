import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/controller/artifacts";
import { exportNetworkSession } from "../src/controller/network-export";
test("portable session exports include reusable redacted body files and explicit binary/truncation omissions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-session-export-"));
  const store = new ArtifactStore(path.join(root, "cache"), 128, 1024);
  const identity = { runtimeId: "r", sessionId: "s" };
  try {
    const responseArtifactId = store.put(
      { ...identity, kind: "body", mimeType: "application/json" },
      Buffer.from('{"token":"secret-value","message":"中文"}'),
    );
    const rawResponseArtifactId = store.put(
      { ...identity, kind: "body", mimeType: "application/octet-stream" },
      Buffer.from([0, 128, 255]),
    );
    const records = [
      {
        id: "1",
        requestHeaderEntries: [
          { name: "Authorization", value: "Bearer secret-value" },
        ],
        responseArtifactId,
        rawResponseArtifactId,
      },
    ];
    const destination = path.join(root, "export");
    const result = await exportNetworkSession(
      store,
      records,
      identity,
      destination,
    );
    assert.equal(result.bodyCount, 1);
    assert.equal(result.incompleteBodies, 1);
    const manifest = fs.readFileSync(result.manifest, "utf8");
    assert.ok(!manifest.includes("secret-value"));
    const body = fs.readFileSync(
      path.join(destination, responseArtifactId + ".body"),
      "utf8",
    );
    assert.equal(JSON.parse(body).token, "[REDACTED]");
    assert.equal(JSON.parse(body).message, "中文");
    const raw = await exportNetworkSession(
      store,
      records,
      identity,
      path.join(root, "raw"),
      true,
    );
    assert.equal(raw.bodyCount, 2);
    assert.deepEqual(
      fs.readFileSync(path.join(root, "raw", rawResponseArtifactId + ".body")),
      Buffer.from([0, 128, 255]),
    );
    await assert.rejects(
      exportNetworkSession(store, records, identity, destination),
      /EEXIST/,
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
