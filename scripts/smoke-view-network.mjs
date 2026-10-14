import { managedFixture, until } from "./managed-test-runtime.mjs";
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
const requests = [];
const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  const start = performance.now(),
    parts = [];
  for await (const chunk of req) parts.push(chunk);
  requests.push({
    url: req.url,
    body: Buffer.concat(parts),
    headers: req.headers,
    durationMs: performance.now() - start,
  });
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/echo" }).end();
    return;
  }
  if (req.url === "/bytes") {
    res.setHeader("content-type", "application/octet-stream");
    res.end(Buffer.alloc(32768, 65));
    return;
  }
  if (req.url === "/slow") {
    const timer = setTimeout(() => res.end("late"), 500);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  if (req.url === "/chunks") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.write("first中文");
    setTimeout(() => res.end("second😀"), 100);
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-encoding": "gzip",
  });
  res.end(
    gzipSync(
      JSON.stringify({
        message: "view中文😀",
        body: Buffer.concat(parts).toString(),
      }),
    ),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const t = await managedFixture();
const { call } = t;
try {
  const targetId = (await call("runner_status")).targets.find(
    (t) => t.kind === "view",
  ).targetId;
  async function fetchView(route, options = {}) {
    const after = (await call("runner_status")).networkCursor;
    const value = await call("runner_evaluate", {
      targetId,
      awaitPromise: true,
      expression: `fetch(${JSON.stringify(base + route)},${JSON.stringify(options)}).then(async r=>({status:r.status,body:await r.text()})).catch(e=>({error:e.message}))`,
    });
    return { value: value.result.value, after };
  }
  const original = await fetchView("/echo", {
    method: "POST",
    body: "原始中文😀",
  });
  assert.equal(JSON.parse(original.value.body).body, "原始中文😀");
  const waited = await call("runner_wait", {
    kind: "network",
    after: original.after,
    urlIncludes: "/echo",
  });
  assert.equal(waited.status, "matched");
  const captured = await call("runner_network", { id: waited.result.id });
  assert.equal(captured.source, "view");
  assert.equal(JSON.parse(captured.responseBody).message, "view中文😀");
  assert.match(captured.rawResponseUnavailable, /decoded/);
  const rule = await call("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      action: "modify",
      match: { source: "view", urlIncludes: "/modify" },
      change: {
        url: base + "/echo",
        headers: { "x-view-rule": "yes" },
        body: "modified视图😀",
      },
    },
  });
  await fetchView("/modify", { method: "POST", body: "before" });
  assert.equal(requests.at(-1).url, "/echo");
  assert.equal(requests.at(-1).body.toString(), "modified视图😀");
  assert.equal(requests.at(-1).headers["x-view-rule"], "yes");
  await call("runner_network_rules", { action: "remove", id: rule.id });
  const mock = await call("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      action: "mock",
      match: { source: "view", urlIncludes: "/mock" },
      response: {
        status: 201,
        headers: {
          "content-type": "text/plain",
          "access-control-allow-origin": "*",
        },
        body: "mock视图",
      },
    },
  });
  const count = requests.length;
  assert.equal((await fetchView("/mock")).value.body, "mock视图");
  assert.equal(requests.length, count);
  await call("runner_network_rules", { action: "remove", id: mock.id });
  const block = await call("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      action: "block",
      match: { source: "view", urlIncludes: "/block" },
    },
  });
  const blocked = await fetchView("/block");
  assert.ok(blocked.value.error);
  assert.equal(requests.length, count);
  assert.equal(
    (
      await call("runner_wait", {
        kind: "network",
        after: blocked.after,
        urlIncludes: "/block",
        networkState: "failed",
      })
    ).status,
    "matched",
  );
  await call("runner_network_rules", { action: "remove", id: block.id });
  const pausedRule = await call("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      action: "pause",
      match: { source: "view", urlIncludes: "/paused" },
    },
  });
  const pausedRun = fetchView("/paused");
  await until(
    async () =>
      (await call("runner_network_rules", { action: "paused" })).requests
        .length === 1,
  );
  const pending = (await call("runner_network_rules", { action: "paused" }))
    .requests[0];
  assert.equal(requests.length, count);
  await call("runner_network_rules", {
    action: "resolve",
    id: pending.id,
    decision: { action: "continue" },
  });
  assert.equal((await pausedRun).value.status, 200);
  await call("runner_network_rules", { action: "remove", id: pausedRule.id });
  const redirected = await fetchView("/redirect");
  assert.equal(redirected.value.status, 200);
  assert.ok(
    (await call("runner_network", { limit: 100, summary: false })).some(
      (r) => r.source === "view" && r.redirectFrom,
    ),
  );
  const stream = await fetchView("/chunks");
  assert.equal(stream.value.body, "first中文second😀");
  await call("runner_network_rules", {
    action: "conditions",
    conditions: { uploadBytesPerSecond: 32768, downloadBytesPerSecond: 0 },
  });
  await fetchView("/upload", { method: "POST", body: "a".repeat(32768) });
  assert.ok(
    requests.at(-1).durationMs > 600,
    String(requests.at(-1).durationMs),
  );
  await call("runner_network_rules", {
    action: "conditions",
    conditions: { uploadBytesPerSecond: 0, downloadBytesPerSecond: 32768 },
  });
  const start = performance.now();
  assert.equal((await fetchView("/bytes")).value.body.length, 32768);
  assert.ok(performance.now() - start > 750);
  await call("runner_network_rules", {
    action: "conditions",
    conditions: { offline: true, downloadBytesPerSecond: 0 },
  });
  const beforeOffline = requests.length;
  assert.ok((await fetchView("/offline")).value.error);
  assert.equal(requests.length, beforeOffline);
  await call("runner_network_rules", {
    action: "conditions",
    conditions: { offline: false, cacheDisabled: true },
  });
  const abort = await call("runner_evaluate", {
    targetId,
    awaitPromise: true,
    expression: `fetch(${JSON.stringify(base + "/slow")},{signal:AbortSignal.timeout(20)}).then(()=>false).catch(e=>e.name)`,
  });
  assert.equal(abort.result.value, "TimeoutError");
  const result = {
    passed: true,
    platform: process.platform,
    chromiumDecodedUnicode: true,
    actualModification: true,
    mockNoOutbound: true,
    blockNoOutbound: true,
    pauseContinue: true,
    redirectChain: true,
    streamingResponse: true,
    realUploadThrottle: true,
    realDownloadThrottle: true,
    offline: true,
    cancel: true,
  };
  fs.writeFileSync(
    "docs/view-network-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(t.logs.join("").slice(-4000));
  throw e;
} finally {
  await t.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
