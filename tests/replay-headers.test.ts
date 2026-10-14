import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { replayHeaders } from "../src/controller/replay-headers";

test("HTTP/2 captures can be replayed once with regenerated transport headers", async () => {
  const received: any[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: "中文😀" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/catalog?page=2`;
  const captured = {
    ":authority": "old.example",
    ":method": "POST",
    ":path": "/old",
    ":scheme": "https",
    Host: "old.example",
    "Content-Length": "9999",
    "Content-Type": "application/json",
    Authorization: "Bearer local-fixture",
    Connection: "keep-alive, X-Hop-Only",
    "X-Hop-Only": "drop",
    "Transfer-Encoding": "chunked",
    "X-App-Field": "keep",
  };
  const original = { ...captured };
  try {
    const headers = replayHeaders(captured, url, url);
    assert.deepEqual(captured, original);
    assert.ok(Object.keys(headers).every((name) => !name.startsWith(":")));
    assert.equal(headers["x-hop-only"], undefined);
    const body = JSON.stringify({ page: 2, keyword: "中文" });
    const result = await fetch(url, { method: "POST", headers, body });
    assert.deepEqual(await result.json(), { value: "中文😀" });
    assert.equal(received.length, 1);
    assert.equal(received[0].url, "/catalog?page=2");
    assert.equal(received[0].body, body);
    assert.equal(received[0].headers.authorization, "Bearer local-fixture");
    assert.equal(received[0].headers["x-app-field"], "keep");
    assert.equal(
      received[0].headers["content-length"],
      String(Buffer.byteLength(body)),
    );
    assert.notEqual(received[0].headers.host, "old.example");
    assert.equal(received[0].headers["x-hop-only"], undefined);
    assert.equal(received[0].headers["transfer-encoding"], undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("replay retains same-origin credentials and requires explicit cross-origin replacement", () => {
  const captured = {
    Authorization: "private-fixture",
    Cookie: "session=fixture",
  };
  assert.deepEqual(
    replayHeaders(captured, "https://a.test/x", "https://a.test/y"),
    {
      authorization: "private-fixture",
      cookie: "session=fixture",
    },
  );
  assert.deepEqual(
    replayHeaders(captured, "https://a.test", "https://b.test"),
    {},
  );
  assert.deepEqual(
    replayHeaders(captured, "https://a.test", "https://b.test", {
      Authorization: "explicit-fixture",
    }),
    { authorization: "explicit-fixture" },
  );
  assert.throws(() =>
    replayHeaders({}, "https://a.test", "https://a.test", {
      ":authority": "explicit-invalid",
    }),
  );
  assert.throws(() =>
    replayHeaders({}, "https://a.test", "https://a.test", {
      "x-test": "bad\r\nInjected: value",
    }),
  );
});
