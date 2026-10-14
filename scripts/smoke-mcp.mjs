import { _electron as electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedRuntime } from "./test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
const isolated = isolatedRuntime();
const connection = path.join(isolated.directory, "mcp.json");
let requests = 0,
  received;
const server = http.createServer(async (req, res) => {
  requests++;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  received = Buffer.concat(chunks).toString();
  res.setHeader("content-type", "application/json");
  res.setHeader("content-encoding", "gzip");
  res.end(gzipSync(Buffer.from(JSON.stringify({
    message: "MCP中文响应😀",
    token: "private-test-token"
  }))));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const app = await electron.launch({
  cwd: process.cwd(),
  env: {
    ...isolated.env,
    WXAPP_STANDALONE: ""
  },
  args: [".", "--package", "../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()), "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--mcp", "--mcp-file", connection, "--devtools", ...isolated.args]
});
const client = new Client({
  name: "wxapp-mcp-smoke",
  version: "1.0.0"
});
const logs = [];
app.process().stdout.on("data", b => logs.push(String(b)));
app.process().stderr.on("data", b => logs.push(String(b)));
async function wait(fn) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error("MCP test wait timed out");
}
async function call(name, args = {}) {
  const r = await client.callTool({
    name,
    arguments: args
  });
  assert.ok(!r.isError, JSON.stringify(r));
  return r.content[0].type === "image" ? r : JSON.parse(r.content[0].text);
}
try {
  await wait(() => fs.existsSync(connection));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
    stderr: "pipe"
  }));
  assert.equal(fs.statSync(connection).mode & 0o777, 0o600);
  const info = JSON.parse(fs.readFileSync(connection, "utf8"));
  assert.equal((await fetch(info.endpoint + "/call", {
    method: "POST",
    body: "{}"
  })).status, 403);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 36);
  await wait(async () => {
    const s = await call("runner_status");
    return s.serviceReady && s.current?.ready;
  });
  let snap;
  await wait(async () => {
    snap = await call("runner_snapshot");
    return snap.text.includes("常用工具") && !snap.text.includes("正在加载");
  });
  assert.ok(snap.elements.length > 0);
  const oldNode = snap.elements[0].nodeId;
  await call("runner_snapshot");
  assert.equal((await client.callTool({
    name: "runner_click",
    arguments: {
      nodeId: oldNode
    }
  })).isError, true);
  assert.ok(!tools.tools.find(t => t.name === "runner_snapshot").inputSchema.required?.includes("target"));
  const image = await call("runner_screenshot");
  assert.equal(image.content[0].mimeType, "image/png");
  assert.equal(Buffer.from(image.content[0].data, "base64").subarray(1, 4).toString(), "PNG");
  await call("runner_input", {
    selector: "textarea",
    text: "MCP输入😀"
  });
  await wait(async () => (await call("runner_snapshot")).elements.some(e => e.value === "MCP输入😀"));
  const clearNode = (await call("runner_snapshot")).elements.find(e => e.text === "清空");
  assert.ok(clearNode);
  await call("runner_wait", {
    kind: "element",
    nodeId: clearNode.nodeId,
    stableMs: 300
  });
  await call("runner_click", {
    text: "清空"
  });
  await wait(async () => (await call("runner_snapshot")).elements.some(e => e.tag === "textarea" && e.value === ""));
  const rewriteNode = (await call("runner_snapshot")).elements.find(e => e.text === "文案改写");
  assert.ok(rewriteNode);
  await call("runner_wait", {
    kind: "element",
    nodeId: rewriteNode.nodeId,
    stableMs: 300
  });
  await call("runner_click", {
    text: "文案改写"
  });
  await wait(async () => (await call("runner_status")).stack.length === 2);
  await call("runner_navigate", {
    method: "navigateBack"
  });
  await wait(async () => (await call("runner_status")).stack.length === 1);
  const debug = app.windows().find(p => p.url().includes("/js_app.html"));
  await debug.getByRole("tab", {
    name: "Wxapp",
    exact: true
  }).click();
  await debug.getByRole("combobox", {
    name: "Wxapp section"
  }).waitFor();
  await debug.getByRole("button", {
    name: "刷新",
    exact: true
  }).click();
  await debug.getByRole("button", {
    name: "选择此实例",
    exact: true
  }).first().waitFor();
  await debug.screenshot({
    path: "docs/native-wxapp-panel.png"
  });
  const observed = await call("runner_state");
  assert.ok(observed.pages.length === 1);
  const instanceId = observed.pages[0].instanceId;
  assert.equal((await call("runner_state", {
    action: "get",
    instanceId
  })).instances[0].route, "pages/index/index");
  const changes = await call("runner_state", {
    action: "events",
    limit: 200
  });
  assert.ok(changes.entries.some(e => e.type === "handler" && e.name === "clearUrl"));
  assert.ok(changes.entries.some(e => e.type === "setData" && e.context?.handler === "clearUrl"));
  assert.ok((await call("runner_dom", {
    selector: "textarea"
  })).tag === "textarea");
  await call("runner_storage", {
    action: "set",
    key: "debug-test",
    value: {
      message: "中文😀"
    }
  });
  assert.deepEqual((await call("runner_storage", {
    action: "get",
    key: "debug-test"
  })).entries["debug-test"], {
    message: "中文😀"
  });
  await call("runner_storage", {
    action: "set",
    key: "debug-null",
    value: null
  });
  assert.equal((await call("runner_storage", {
    action: "get",
    key: "debug-null"
  })).entries["debug-null"], null);
  await call("runner_storage", {
    action: "remove",
    key: "debug-test"
  });
  await call("runner_storage", {
    action: "remove",
    key: "debug-null"
  });
  await debug.getByRole("tab", {
    name: "Network",
    exact: true
  }).click();
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp-probe`;
  const expression = `new Promise(resolve=>wx.request({url:${JSON.stringify(endpoint)},method:'POST',data:{message:'MCP中文请求😀',token:'private-request-token'},success:r=>resolve(r.data)}))`;
  const value = await call("runner_evaluate", {
    expression,
    awaitPromise: true
  });
  assert.equal(value.result.value.message, "MCP中文响应😀");
  let record;
  await wait(async () => {
    record = (await call("runner_network")).find(r => r.url === endpoint);
    return record?.state === "complete";
  });
  const body = await call("runner_network", {
    id: record.id
  });
  assert.equal(JSON.parse(body.responseBody).message, "MCP中文响应😀");
  assert.equal(JSON.parse(body.responseBody).token, "[REDACTED]");
  assert.equal(JSON.parse(body.requestBody).token, "[REDACTED]");
  assert.deepEqual(await call("runner_network", {
    id: record.id
  }), body, "MCP body reads are repeatable");
  const raw = await call("runner_network", {
    id: record.id,
    revealSensitive: true
  });
  assert.equal(JSON.parse(raw.responseBody).token, "private-test-token");
  // AI reading a response must not consume the native F12 response cache.
  await debug.getByRole("cell", {
    name: "Fetch mcp-probe",
    exact: true
  }).click();
  await debug.getByRole("tab", {
    name: "Payload",
    exact: true
  }).click();
  await debug.getByText(/MCP中文请求😀/).first().waitFor();
  await debug.getByRole("tab", {
    name: "Response",
    exact: true
  }).click();
  await debug.getByText(/MCP中文响应😀/).first().waitFor();
  assert.equal(requests, 1);
  assert.equal(JSON.parse(received).message, "MCP中文请求😀");
  await call("runner_evaluate", {
    expression: "globalThis.mcpBreakpointProbe = function() {\n globalThis.mcpProbeFinished = true;\n};\n//# sourceURL=mcp-probe-script.js"
  });
  const bp = await call("runner_debugger", {
    action: "setBreakpoint",
    url: "mcp-probe-script.js",
    line: 2
  });
  await call("runner_evaluate", {
    expression: 'setTimeout(mcpBreakpointProbe, 20); "scheduled"'
  });
  let state;
  await wait(async () => {
    state = await call("runner_debugger", {
      action: "state"
    });
    return state.paused;
  });
  const frame = state.paused.callFrames[0].callFrameId;
  const frameValue = await call("runner_evaluate", {
    expression: "1+2",
    callFrameId: frame
  });
  assert.equal(frameValue.result.value, 3);
  await call("runner_debugger", {
    action: "resume"
  });
  await call("runner_debugger", {
    action: "removeBreakpoint",
    breakpointId: bp.breakpointId
  });
  assert.equal((await call("runner_evaluate", {
    expression: "mcpProbeFinished"
  })).result.value, true);
  assert.ok((await call("runner_logs")).entries.length > 0);
  const invalid = await client.callTool({
    name: "runner_click",
    arguments: {}
  });
  assert.equal(invalid.isError, true);
  const result = {
    date: new Date().toISOString(),
    tools: tools.tools.map(t => t.name),
    passed: ["standard MCP initialize/listTools/callTool over stdio", "loopback bridge authentication + 0600 descriptor", "real app snapshot, PNG, native input/clear click and route stack", "business VM eval + actual HTTP Unicode/gzip request and response", "redacted repeatable body reads, explicit sensitive opt-in", "same body still visible in native F12; exactly one HTTP request", "native V8 breakpoint, paused frame evaluation and resume", "recent logs and invalid argument errors", "native Wxapp panel, real instance/data/handler changes, DOM and wx storage"],
    requests
  };
  fs.writeFileSync("docs/mcp-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const diagnostics = {
    error: String(error)
  };
  for (const name of ["runner_snapshot", "runner_state", "runner_logs"]) {
    try {
      diagnostics[name] = await call(name, {
        after: 0,
        limit: 100
      });
    } catch {}
  }
  fs.writeFileSync(".local/smoke-mcp-failure.json", JSON.stringify(diagnostics, null, 2));
  throw error;
} finally {
  for (const p of app.windows()) if (p.url().includes("/page/")) await p.screenshot({
    path: ".local/mcp-last-page.png"
  }).catch(() => {});
  await client.close();
  await app.close();
  fs.writeFileSync(".local/mcp-smoke.log", logs.join(""));
  isolated.cleanup();
  await new Promise(r => server.close(r));
}
