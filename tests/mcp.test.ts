import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { observeFetch } from "../src/mcp/network";
import { redact } from "../src/mcp/redact";
import { parseTool } from "../src/mcp/tools";
test("evaluate rejects an unsupported target before execution instead of silently selecting logic", () => {
  assert.throws(
    () =>
      parseTool("runner_evaluate", {
        target: "view",
        expression: "sideEffect()",
      }),
    /target/,
  );
  assert.equal(
    (
      parseTool("runner_evaluate", {
        targetId: "page:7",
        expression: "document.title",
      }) as any
    ).targetId,
    "page:7",
  );
  assert.equal(
    (
      parseTool("runner_evaluate", {
        targetId: "logic",
        expression: "typeof document",
      }) as any
    ).targetId,
    "logic",
  );
});

test("MCP validates click locators and debugger arguments; redacts structured credentials", () => {
  assert.throws(() => parseTool("runner_click", {}));
  assert.throws(() =>
    parseTool("runner_click", { text: "delete", x: 1, y: 1 }),
  );
  assert.throws(() =>
    parseTool("runner_debugger", { action: "setBreakpoint" }),
  );
  assert.throws(() => parseTool("runner_network", { limit: 100000 }));
  assert.equal(
    (parseTool("runner_input", { nodeId: "snapshot:1", text: "" }) as any).text,
    "",
  );
  assert.ok(!redact('{"token":"secret","message":"cut').includes("secret"));
  const value = redact({
    authorization: "secret",
    data: { token: "secret", code: "login-code", status: 200 },
    requestBody: '{"app_secret":"secret","message":"中文"}',
    url: "https://test.invalid/?token=secret&value=中文",
  });
  assert.equal(value.authorization, "[REDACTED]");
  assert.equal(value.data.code, "[REDACTED]");
  assert.equal(value.data.status, 200);
  assert.equal(JSON.parse(value.requestBody).message, "中文");
  assert.ok(!JSON.stringify(value).includes('"secret"'));
});
test("MCP fetch observer preserves business data and bounds decoded copies independently of DevTools", async () => {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-encoding", "gzip");
    res.end(
      gzipSync(
        Buffer.from(
          JSON.stringify({ message: "中文😀", large: "x".repeat(300000) }),
        ),
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const events: any[] = [];
  const restore = observeFetch((r) => events.push(structuredClone(r)));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/`,
    );
    const data = await response.json();
    assert.equal(data.message, "中文😀");
    assert.equal(data.large.length, 300000);
    assert.equal(count, 1);
    for (let i = 0; i < 200 && !events.some((e) => e.state === "complete"); i++)
      await new Promise((r) => setTimeout(r, 5));
    const last = events.at(-1);
    assert.equal(last.state, "complete");
    assert.equal(last.responseBodyTruncated, true);
    assert.ok(last.responseBody.length <= 256 * 1024);
  } finally {
    restore();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("MCP rejects partial coordinates and navigation without a URL", () => {
  for (const args of [
    { x: 1 },
    { y: 1 },
    { selector: "textarea", x: 1 },
    { text: "clear", y: 1 },
    { x: 1, y: 1, nodeId: "old" },
  ])
    assert.throws(() => parseTool("runner_click", args));
  assert.throws(() => parseTool("runner_navigate", { method: "navigateTo" }));
  assert.throws(() =>
    parseTool("runner_navigate", { method: "switchTab", url: " " }),
  );
  assert.doesNotThrow(() =>
    parseTool("runner_navigate", { method: "navigateBack" }),
  );
});

test("request observation distinguishes HTTP errors, timeout, explicit abort, and retains caller context", async () => {
  const { createRequest } = await import("../src/wx-shim/network");
  const { debugContext, traceContext } = await import("../src/debug/context");
  const server = http.createServer((req, res) => {
    if (req.url === "/slow") setTimeout(() => res.end("late"), 150);
    else {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end('{"message":"服务错误"}');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const records = new Map<string, any>();
  const restore = observeFetch((r) => records.set(r.id, structuredClone(r)));
  const request = createRequest(() => {});
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    let successes = 0,
      failures = 0,
      completed = 0;
    await debugContext.run(
      traceContext({ handler: "testClick", route: "fixture/home" }),
      () =>
        new Promise<void>((resolve) =>
          request({
            url: base + "/error",
            success: (r: any) => {
              successes++;
              assert.equal(r.statusCode, 503);
              assert.equal(r.data.message, "服务错误");
            },
            complete: () => {
              completed++;
              resolve();
            },
          }),
        ),
    );
    await new Promise<void>((resolve) =>
      request({
        url: base + "/slow",
        timeout: 15,
        fail: () => failures++,
        complete: () => {
          completed++;
          resolve();
        },
      }),
    );
    await new Promise<void>((resolve) => {
      const task = request({
        url: base + "/slow",
        fail: () => failures++,
        complete: () => {
          completed++;
          resolve();
        },
      });
      task.abort();
    });
    assert.equal(successes, 1);
    assert.equal(failures, 2);
    assert.equal(completed, 3);
    for (
      let i = 0;
      i < 100 && [...records.values()].some((r) => r.state === "headers");
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    const values = [...records.values()];
    assert.equal(values.length, 3);
    assert.equal(values[0].context.rootHandler, "testClick");
    assert.equal(values[0].context.route, "fixture/home");
    assert.equal(values.filter((r) => r.state === "failed").length, 2);
    assert.ok(values.every((r) => typeof r.durationMs === "number"));
    assert.match(values[0].callStack, /network/);
  } finally {
    restore();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
