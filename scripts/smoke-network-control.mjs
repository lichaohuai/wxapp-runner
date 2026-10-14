import { _electron as electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedRuntime } from "./test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
const isolated = isolatedRuntime(),
  env = {
    ...isolated.env
  };
delete env.WXAPP_STANDALONE;
const sent = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  sent.push({
    url: req.url,
    body: Buffer.concat(chunks).toString(),
    headers: req.headers
  });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-encoding": "gzip"
  });
  res.end(gzipSync(Buffer.from(JSON.stringify({
    message: "真实中文响应😀",
    token: "private-value"
  }))));
});
const sockets = new WebSocketServer({
  server
});
sockets.on("connection", ws => ws.on("message", (data, binary) => ws.send(data, {
  binary
})));
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;
const pkg = interactionFixture(isolated.directory, base + "/probe");
const connection = path.join(isolated.directory, "mcp.json");
const app = await electron.launch({
  cwd: process.cwd(),
  env,
  args: [".", "--package", pkg, "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--mcp", "--mcp-file", connection, ...isolated.args]
});
const logs = [];
app.process().stdout.on("data", b => logs.push(String(b)));
app.process().stderr.on("data", b => logs.push(String(b)));
const client = new Client({
  name: "network-control",
  version: "1"
});
async function call(name, args = {}) {
  const r = await client.callTool({
    name,
    arguments: args
  });
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}
async function until(fn) {
  const end = Date.now() + 20000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("setup timeout");
    await new Promise(r => setTimeout(r, 50));
  }
}
async function request(name, data = "中文请求😀") {
  const after = (await call("runner_status")).networkCursor;
  await call("runner_evaluate", {
    expression: "wx.request(" + JSON.stringify({
      url: base + "/" + name,
      method: "POST",
      data: {
        message: data
      }
    }) + ")"
  });
  const result = await call("runner_wait", {
    kind: "network",
    after,
    urlIncludes: "/" + name
  });
  assert.equal(result.status, "matched");
  return result.result;
}
try {
  await until(() => fs.existsSync(connection));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
    stderr: "pipe"
  }));
  await until(async () => (await call("runner_status")).current?.ready);
  await call("runner_wait", {
    kind: "element",
    selector: "#submit"
  });
  const original = await request("probe");
  assert.equal(sent.length, 1);
  const first = await call("runner_network", {
    id: original.id
  });
  assert.equal(JSON.parse(first.responseBody).message, "真实中文响应😀");
  assert.equal(JSON.parse(first.responseBody).token, "[REDACTED]");
  const bodyA = await call("runner_artifact", {
    action: "read",
    id: first.responseArtifactId
  });
  const bodyB = await call("runner_artifact", {
    action: "read",
    id: first.responseArtifactId
  });
  assert.equal(bodyA.data, bodyB.data);
  const all = await call("runner_network", {
    limit: 100
  });
  assert.ok(all.some(r => r.source === "view" && /WAWebview/.test(r.url)));
  await call("runner_gesture", {
    action: "keys",
    keys: ["F12"]
  });
  await until(() => app.windows().some(p => p.url().includes("js_app.html")));
  const debug = app.windows().find(p => p.url().includes("js_app.html"));
  await debug.getByRole("tab", {
    name: "Network",
    exact: true
  }).click();
  await debug.getByRole("cell", {
    name: "Fetch probe",
    exact: true
  }).click();
  await debug.getByRole("tab", {
    name: "Response",
    exact: true
  }).click();
  await debug.getByText("真实中文响应😀", {
    exact: false
  }).first().waitFor();
  assert.equal((await call("runner_artifact", {
    action: "read",
    id: first.responseArtifactId
  })).data, bodyA.data);
  const rule = await call("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      match: {
        urlIncludes: "/modify"
      },
      action: "modify",
      change: {
        headers: {
          "x-debug": "modified"
        },
        body: "修改正文😀"
      }
    }
  });
  await request("modify");
  assert.equal(sent.at(-1).headers["x-debug"], "modified");
  assert.equal(sent.at(-1).body, "修改正文😀");
  await call("runner_network_rules", {
    action: "remove",
    id: rule.id
  });
  const mock = await call("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      match: {
        urlIncludes: "/mock"
      },
      action: "mock",
      response: {
        status: 201,
        headers: {
          "content-type": "application/json"
        },
        body: '{"message":"模拟😀"}'
      }
    }
  });
  const count = sent.length;
  const mocked = await request("mock");
  assert.equal(mocked.status, 201);
  assert.equal(sent.length, count);
  await call("runner_network_rules", {
    action: "remove",
    id: mock.id
  });
  const pauseRule = await call("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      action: "pause",
      match: {
        urlIncludes: "/paused"
      }
    }
  });
  const after = (await call("runner_status")).networkCursor;
  await call("runner_evaluate", {
    expression: "wx.request({url:" + JSON.stringify(base + "/paused") + "})"
  });
  await until(async () => (await call("runner_network_rules", {
    action: "paused"
  })).requests.length === 1);
  assert.equal(sent.length, count);
  const paused = (await call("runner_network_rules", {
    action: "paused"
  })).requests[0];
  await call("runner_network_rules", {
    action: "resolve",
    id: paused.id,
    decision: {
      action: "continue"
    }
  });
  assert.equal((await call("runner_wait", {
    kind: "network",
    after,
    urlIncludes: "/paused"
  })).status, "matched");
  await call("runner_network_rules", {
    action: "remove",
    id: pauseRule.id
  });
  const beforeReplay = sent.length,
    cursor = (await call("runner_status")).networkCursor;
  const replay = await call("runner_replay", {
    id: original.id
  });
  assert.equal(replay.status, "request-sent");
  assert.notEqual(replay.requestId, original.id);
  assert.equal((await call("runner_wait", {
    kind: "network",
    after: cursor,
    requestId: replay.requestId
  })).status, "matched");
  assert.equal(sent.length, beforeReplay + 1);
  assert.equal(sent.at(-1).body, sent[0].body);
  const replayed = await call("runner_network", {
    id: replay.requestId
  });
  assert.equal(replayed.context.replayOf, original.id);
  const socketCursor = (await call("runner_status")).networkCursor;
  await call("runner_evaluate", {
    expression: "globalThis.testSocket=wx.connectSocket({url:" + JSON.stringify(base.replace("http:", "ws:") + "/socket") + "}); testSocket.onOpen(()=>testSocket.send({data:'socket-echo中文'})); testSocket.onMessage(()=>testSocket.close({code:1000}));"
  });
  const socketRecord = await call("runner_wait", {
    kind: "network",
    after: socketCursor,
    urlIncludes: "/socket"
  });
  assert.equal(socketRecord.status, "matched");
  assert.equal(socketRecord.result.resourceType, "WebSocket");
  assert.equal(socketRecord.result.frameCount, 2);
  await debug.getByRole("cell", {
    name: /socket/
  }).first().click({
    timeout: 5000
  });
  await debug.getByRole("tab", {
    name: "Messages",
    exact: true
  }).click();
  await debug.getByText("socket-echo中文", {
    exact: true
  }).first().waitFor();
  const har = await call("runner_artifact", {
    action: "har"
  });
  const exportFile = path.join(isolated.directory, "network.har");
  await call("runner_artifact", {
    action: "export",
    id: har.id,
    destination: exportFile
  });
  const exported = JSON.parse(fs.readFileSync(exportFile, "utf8"));
  assert.ok(exported.log.entries.length >= 5);
  assert.ok(!fs.readFileSync(exportFile, "utf8").includes("private-value"));
  const sessionDir = path.join(isolated.directory, "network-session");
  await call("runner_artifact", {
    action: "session",
    destination: sessionDir
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8"));
  assert.ok(!JSON.stringify(manifest).includes("private-value"));
  assert.ok(fs.readdirSync(sessionDir).length > 1);
  const result = {
    networkSessionExport: true,
    passed: true,
    platform: process.platform,
    nativeHistoricalNetwork: true,
    viewResources: true,
    repeatableBodies: true,
    actualModification: true,
    mockNoOutbound: true,
    pauseContinue: true,
    singleReplay: true,
    nativeWebSocketFrames: true,
    harExport: true
  };
  fs.writeFileSync("docs/network-control-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(logs.join("").slice(-4000));
  throw e;
} finally {
  await client.close();
  await app.close();
  sockets.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  isolated.cleanup();
}
