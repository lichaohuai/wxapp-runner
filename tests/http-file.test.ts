import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveFile } from "../src/http-file";
test("package media serves bytes, HEAD, seek ranges and invalid ranges without whole-file buffering", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-file-")),
    file = path.join(dir, "clip.mp4");
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const server = http.createServer((q, s) => serveFile(q, s, file));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    const full = await fetch(url);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal((await full.arrayBuffer()).byteLength, 10);
    const range = await fetch(url, { headers: { Range: "bytes=2-5" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
    assert.deepEqual(
      [...new Uint8Array(await range.arrayBuffer())],
      [2, 3, 4, 5],
    );
    const suffix = await fetch(url, { headers: { Range: "bytes=-2" } });
    assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())], [8, 9]);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const value of [
      "bytes=20-",
      "bytes=8-2",
      "bytes=-0",
      "bytes=",
      "bytes=0-1,4-5",
    ]) {
      const r = await fetch(url, { headers: { Range: value } });
      assert.equal(r.status, 416);
      await r.text();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
