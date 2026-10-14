import { _electron as electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedRuntime } from "./test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const isolated = isolatedRuntime();
const env = {
  ...isolated.env
};
delete env.WXAPP_STANDALONE;
const connection = path.join(isolated.directory, "controller.json");
const app = await electron.launch({
  cwd: process.cwd(),
  env,
  args: [".", "--package", "../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()), "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--mcp", "--mcp-file", connection, ...isolated.args]
});
const logs = [];
app.process().stdout.on("data", b => logs.push(String(b)));
app.process().stderr.on("data", b => logs.push(String(b)));
const clients = [];
async function until(probe, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error("Controller startup/exit timeout");
}
async function client(name) {
  const c = new Client({
    name,
    version: "1"
  });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
    stderr: "pipe"
  }));
  clients.push(c);
  return c;
}
async function call(c, name, args = {}) {
  const r = await c.callTool({
    name,
    arguments: args
  });
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}
try {
  await until(() => fs.existsSync(connection));
  const a = await client("controller-a"),
    b = await client("controller-b");
  assert.equal((await a.listTools()).tools.length, 36);
  await until(async () => (await call(a, "runner_status")).current?.ready);
  const initial = await call(a, "runner_status");
  assert.notEqual(initial.pid, app.process().pid);
  await call(a, "runner_wait", {
    kind: "text",
    text: "常用工具"
  });
  const snapshotA = await call(a, "runner_snapshot");
  await call(b, "runner_snapshot");
  assert.ok((await call(a, "runner_dom", {
    nodeId: snapshotA.elements[0].nodeId
  })).tag);
  await call(a, "runner_control", {
    action: "acquire"
  });
  assert.equal((await b.callTool({
    name: "runner_input",
    arguments: {
      selector: "textarea",
      text: "should-not-write"
    }
  })).isError, true);
  await call(a, "runner_control", {
    action: "release"
  });
  await call(a, "runner_runtime", {
    action: "stop"
  });
  assert.equal((await call(b, "runner_status")).state, "exited");
  let after = 0,
    exited = false;
  for (;;) {
    const page = await call(b, "runner_events", {
      after,
      limit: 200
    });
    exited ||= page.entries.some(e => e.type === "exit");
    after = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.ok(exited);
  await call(b, "runner_runtime", {
    action: "restart"
  });
  await until(async () => (await call(a, "runner_status")).current?.ready);
  const restarted = await call(a, "runner_status");
  assert.notEqual(restarted.sessionId, initial.sessionId);
  assert.equal((await a.callTool({
    name: "runner_logs",
    arguments: {
      sessionId: initial.sessionId
    }
  })).isError, true);
  process.kill(restarted.pid, "SIGKILL");
  await until(async () => (await call(a, "runner_status")).state === "exited");
  assert.equal((await call(a, "runner_status")).exit.signal, "SIGKILL");
  await call(a, "runner_runtime", {
    action: "restart"
  });
  await until(async () => (await call(a, "runner_status")).current?.ready);
  const result = {
    passed: true,
    platform: process.platform,
    toolCount: 36,
    processIsolation: true,
    clientSnapshots: true,
    leases: true,
    stopRestart: true,
    crashRestart: true,
    staleSessionRejected: true
  };
  fs.writeFileSync("docs/controller-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(logs.join("").slice(-5000));
  throw e;
} finally {
  for (const c of clients) await c.close();
  await app.close();
  isolated.cleanup();
}
