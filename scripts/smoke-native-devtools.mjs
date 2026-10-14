import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { isolatedRuntime } from "./test-runtime.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const isolated = isolatedRuntime();
delete isolated.env.WXAPP_STANDALONE;
const connection = path.join(isolated.directory, "mcp.json");
let count = 0;
const received = new Map();
const cases = [{
  name: "echo",
  compression: "gzip",
  contentType: "application/json"
}, {
  name: "plain",
  compression: "",
  contentType: "application/json"
}, {
  name: "br",
  compression: "br",
  contentType: "application/json; charset=UTF8"
}, {
  name: "form",
  compression: "deflate",
  contentType: "application/json; charset=UTF-8"
}];
const server = http.createServer(async (req, res) => {
  count++;
  const name = req.url.slice(1);
  const spec = cases.find(c => c.name === name);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  received.set(name, {
    method: req.method,
    body: Buffer.concat(chunks).toString("utf8"),
    contentType: req.headers["content-type"],
    referer: req.headers.referer
  });
  res.setHeader("content-type", spec.contentType);
  let body = Buffer.from(JSON.stringify({
    answer: "native-response 中文响应😀 " + name
  }));
  if (spec.compression) {
    res.setHeader("content-encoding", spec.compression);
    body = {
      gzip: gzipSync,
      deflate: deflateSync,
      br: brotliCompressSync
    }[spec.compression](body);
  }
  // Force multiple wire chunks, including boundaries within UTF-8 characters.
  for (let offset = 0; offset < body.length; offset += 3) {
    res.write(body.subarray(offset, offset + 3));
    await new Promise(r => setTimeout(r, 1));
  }
  res.end();
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + server.address().port + "/echo";
const pkg = path.join(isolated.directory, "package");
fs.mkdirSync(pkg);
fs.writeFileSync(path.join(pkg, "app-config.json"), JSON.stringify({
  pages: ["home"],
  entryPagePath: "home.html",
  renderer: {
    default: "webview"
  },
  componentFramework: {
    default: "exparser"
  }
}));
fs.writeFileSync(path.join(pkg, "app-service.js"), ["App({});", "globalThis.nativeProbe = function nativeProbe() {", '  const body = {message:"native-payload 中文请求😀"};', `  wx.request({url:${JSON.stringify(url)},method:'POST',data:body,success:function(r){console.log('native-log-marker',r.data.answer);}});`, "};", 'console.log("native-logic-ready");'].join("\n"));
fs.writeFileSync(path.join(pkg, "page-frame.html"), "<script></script>");
fs.writeFileSync(path.join(pkg, "home.html"), "");
const app = await electron.launch({
  args: [".", "--package", pkg, "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--app-version", "23", "--devtools", "--mcp", "--mcp-file", connection, ...isolated.args],
  cwd: process.cwd(),
  env: isolated.env
});
const logs = [];
app.process().stdout.on("data", b => logs.push(String(b)));
app.process().stderr.on("data", b => logs.push(String(b)));
async function wait(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error("Timed out");
}
let socket;
let mcp;
try {
  await wait(() => fs.existsSync(connection));
  mcp = new Client({
    name: "native-regression",
    version: "1"
  });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
    stderr: "pipe"
  }));
  await wait(() => app.windows().some(p => p.url().includes("/js_app.html")));
  const debug = app.windows().find(p => p.url().includes("/js_app.html"));
  await debug.getByRole("tab", {
    name: "Network",
    exact: true
  }).click();
  const endpoint = "ws://" + new URL(debug.url()).searchParams.get("ws");
  socket = new WebSocket(endpoint);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = j;
  });
  let seq = 0;
  const pending = new Map(),
    events = [];
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(Error(JSON.stringify(m.error))) : p?.resolve(m.result);
    } else events.push(m);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {
      resolve,
      reject
    });
    socket.send(JSON.stringify({
      id,
      method,
      params
    }));
  });
  await send("Runtime.enable");
  await send("Debugger.enable");
  await wait(() => events.some(e => e.method === "Runtime.executionContextCreated" && e.params.context.name.startsWith("Mini-program business")));
  const contextId = events.find(e => e.method === "Runtime.executionContextCreated" && e.params.context.name.startsWith("Mini-program business")).params.context.id;
  await wait(() => events.some(e => e.method === "Debugger.scriptParsed" && e.params.url.endsWith("/app-service.js")));
  const script = events.find(e => e.method === "Debugger.scriptParsed" && e.params.url.endsWith("/app-service.js")).params;
  await wait(async () => (await send("Runtime.evaluate", {
    expression: "typeof nativeProbe",
    contextId,
    returnByValue: true
  })).result.value === "function");
  const breakpoint = await send("Debugger.setBreakpoint", {
    location: {
      scriptId: script.scriptId,
      lineNumber: 2
    }
  });
  const evaluation = send("Runtime.evaluate", {
    expression: "nativeProbe()",
    contextId
  });
  await wait(() => events.some(e => e.method === "Debugger.paused" && e.params.hitBreakpoints?.includes(breakpoint.breakpointId)));
  assert.equal(count, 0, "Breakpoint must pause the real business function before any request");
  await debug.getByRole("button", {
    name: /Resume script execution/
  }).click();
  await evaluation;
  await send("Debugger.removeBreakpoint", {
    breakpointId: breakpoint.breakpointId
  });
  await wait(() => count === 1);
  await debug.getByRole("tab", {
    name: "Network",
    exact: true
  }).click();
  await debug.getByRole("cell", {
    name: "Fetch echo",
    exact: true
  }).click();
  const hostReferer = "https://servicewechat.com/" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()) + "/23/page-frame.html";
  await debug.getByRole("tab", {
    name: "Headers",
    exact: true
  }).click();
  await debug.getByText(hostReferer, {
    exact: false
  }).first().waitFor();
  assert.equal(received.get("echo").referer, hostReferer);
  const networkResult = await mcp.callTool({
    name: "runner_network",
    arguments: {
      filter: {
        urlIncludes: url
      },
      fields: ["id", "requestHeaders"],
      limit: 10
    }
  });
  assert.ok(!networkResult.isError);
  const network = JSON.parse(networkResult.content.find(x => x.type === "text").text);
  assert.equal(network.entries.find(x => x.requestHeaders?.referer)?.requestHeaders.referer, hostReferer);
  await debug.getByRole("tab", {
    name: "Payload",
    exact: true
  }).click();
  await debug.getByText(/native-payload 中文请求😀/).first().waitFor();
  await debug.getByRole("tab", {
    name: "Response",
    exact: true
  }).click();
  await debug.getByText(/native-response 中文响应😀/).first().waitFor();
  await debug.screenshot({
    path: "docs/native-devtools-network.png"
  });
  await debug.getByRole("tab", {
    name: "Console",
    exact: true
  }).click();
  await debug.getByText(/native-log-marker/).first().waitFor();
  assert.equal(count, 1);
  assert.equal(received.get("echo").method, "POST");
  assert.deepEqual(JSON.parse(received.get("echo").body), {
    message: "native-payload 中文请求😀"
  });
  // Read bodies through the real native UI, never through another Network client.
  for (const spec of cases.slice(1)) {
    const form = spec.name === "form";
    const options = {
      url: url.replace("/echo", "/" + spec.name),
      method: "POST",
      header: {
        "content-type": form ? "application/x-www-form-urlencoded" : spec.contentType
      },
      data: {
        message: "native-payload 中文请求😀"
      }
    };
    const result = await send("Runtime.evaluate", {
      contextId,
      returnByValue: true,
      awaitPromise: true,
      expression: `new Promise(resolve => wx.request({...${JSON.stringify(options)},success:r=>resolve(r.data),fail:e=>resolve(e)}))`
    });
    assert.equal(result.result.value.answer, "native-response 中文响应😀 " + spec.name, "business receives decoded original data");
    await debug.getByRole("tab", {
      name: "Network",
      exact: true
    }).click();
    await debug.getByRole("cell", {
      name: "Fetch " + spec.name,
      exact: true
    }).click();
    await debug.getByRole("tab", {
      name: "Payload",
      exact: true
    }).click();
    await debug.getByText(/native-payload 中文请求😀/).first().waitFor();
    await debug.getByRole("tab", {
      name: "Response",
      exact: true
    }).click();
    await debug.getByText("native-response 中文响应😀 " + spec.name, {
      exact: false
    }).first().waitFor();
    const request = received.get(spec.name);
    assert.equal(request.method, "POST");
    assert.equal(request.contentType, options.header["content-type"]);
    if (form) assert.equal(new URLSearchParams(request.body).get("message"), options.data.message);else assert.deepEqual(JSON.parse(request.body), options.data);
  }
  assert.equal(count, cases.length, "exactly one request per case, no replay");
  // Browser CDP keyboard injection does not emit Electron before-input-event.
  // Exercise the native keyboard path used by the window shortcut.
  await app.evaluate(({
    BrowserWindow
  }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("/js_app.html"));
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "F12"
    });
    window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "F12"
    });
  });
  await wait(() => app.evaluate(({
    BrowserWindow
  }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("/js_app.html"))?.isVisible() === false));
  const reopen = await mcp.callTool({
    name: "runner_gesture",
    arguments: {
      target: "shell",
      action: "keys",
      keys: ["F12"]
    }
  });
  assert.ok(!reopen.isError, JSON.stringify(reopen));
  await wait(() => app.evaluate(({
    BrowserWindow
  }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("/js_app.html"))?.isVisible() === true));
  const result = {
    date: new Date().toISOString(),
    passed: ["Native bundled js_app DevTools connected to the logic worker", "Business source breakpoint pauses before wx.request", "Native DevTools Resume continues the actual handler", "Native Network shows Chinese and emoji in JSON/form Payload and chunked identity/gzip/deflate/br Response", "Actual HTTP, native Network Headers and MCP show the same package-derived host Referer", "Native Console shows original business logs", "F12 hides and reopens the same native logic inspector", "Exactly one real HTTP request per case; original headers and body unchanged; no replay or custom network UI"],
    requests: count
  };
  fs.writeFileSync("docs/native-devtools-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close();
  await mcp?.close();
  fs.writeFileSync(".local/native-devtools-smoke.log", logs.join(""));
  await app.close();
  isolated.cleanup();
  await new Promise(r => server.close(r));
}
