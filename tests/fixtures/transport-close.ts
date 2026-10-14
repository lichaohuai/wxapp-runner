import net from "node:net";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { installTransport } from "../../src/debug/transport";
import { NetworkRules } from "../../src/controller/rules";

const content = Buffer.from("结束响应中文😀".repeat(4096));
const sockets = new Set<net.Socket>();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.once("data", (request) => {
    const route = request.toString().split(" ")[1];
    let body = content,
      headers = "Content-Type: text/plain; charset=utf-8\r\n";
    if (route === "/gzip") {
      body = gzipSync(body);
      headers += "Content-Encoding: gzip\r\n";
    }
    if (route === "/chunked" || route === "/broken-chunk") {
      headers += "Transfer-Encoding: chunked\r\n";
      body = Buffer.concat([
        Buffer.from(body.length.toString(16) + "\r\n"),
        body,
        Buffer.from(route === "/chunked" ? "\r\n0\r\n\r\n" : "\r\n"),
      ]);
    } else if (route !== "/eof")
      headers += `Content-Length: ${body.length + (route === "/short" ? 20 : 0)}\r\n`;
    socket.end(
      Buffer.concat([
        Buffer.from(
          "HTTP/1.1 200 OK\r\nConnection: close\r\n" + headers + "\r\n",
        ),
        body,
      ]),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + (server.address() as net.AddressInfo).port;
let seq = 0;
const artifacts = new Map<string, Buffer[]>(),
  records = new Map<string, any>();
const rules = new NetworkRules();
const close = installTransport(
  async (action, a) => {
    if (action === "plan") return rules.evaluate(a.request);
    if (action === "cancel") return {};
    if (action === "artifact-create") {
      const id = String(++seq);
      artifacts.set(id, []);
      return { id };
    }
    if (action === "artifact-append") {
      await new Promise((r) => setTimeout(r, 10));
      artifacts.get(a.id)!.push(Buffer.from(a.data));
    }
    return {};
  },
  (r) => records.set(r.id, r),
);
try {
  let passed = 0;
  for (const route of [
    "length",
    "eof",
    "chunked",
    "gzip",
    "short",
    "broken-chunk",
    "rate",
  ]) {
    if (route === "rate")
      rules.conditions.downloadBytesPerSecond = content.length;
    const start = performance.now();
    const promise = fetch(base + "/" + route).then((r) => r.arrayBuffer());
    if (["short", "broken-chunk"].includes(route))
      await assert.rejects(promise);
    else assert.deepEqual(Buffer.from(await promise), content);
    if (route === "rate")
      assert.ok(
        performance.now() - start > 900,
        "download throttle must remain active",
      );
    const id = String(++passed),
      deadline = Date.now() + 3000;
    while (
      !["complete", "failed", "capture-error"].includes(records.get(id)?.state)
    ) {
      assert.ok(Date.now() < deadline, "capture completion deadline");
      await new Promise((r) => setTimeout(r, 5));
    }
    const record = records.get(id);
    if (["short", "broken-chunk"].includes(route))
      assert.notEqual(record.state, "complete");
    else {
      assert.equal(record.state, "complete");
      assert.deepEqual(
        Buffer.concat(artifacts.get(record.responseArtifactId)!),
        content,
      );
      assert.deepEqual(
        Buffer.concat(artifacts.get(record.rawResponseArtifactId)!),
        route === "gzip" ? gzipSync(content) : content,
      );
    }
  }
  console.log(JSON.stringify({ passed }));
} finally {
  await close();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
}
