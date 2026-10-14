import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-protocol-"));
const received = [];
let version = 3;
const server = http.createServer(async (req, res) => {
  let text = "";
  for await (const b of req) text += b;
  const call = JSON.parse(text);
  received.push(call.name);
  res.setHeader("content-type", "application/json");
  res.setHeader("X-Wxapp-Analysis", String(version));
  res.end(JSON.stringify({
    result: {
      runtimeId: "fixture",
      sessionId: "fixture-session",
      tool: call.name
    }
  }));
});
const client = new Client({
  name: "analysis-protocol-regression",
  version: "1"
});
try {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const file = path.join(dir, "connection.json");
  fs.writeFileSync(file, JSON.stringify({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    token: "local-fixture-only"
  }), {
    mode: 0o600
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", file],
    stderr: "pipe"
  }));
  for (const [name, args] of [["runner_crypto_watch", {
    action: "arm",
    tapIds: ["fixture"],
    runId: "fixture-run"
  }], ["runner_source", {
    action: "get",
    path: "same.js",
    current: true
  }], ["runner_source", {
    action: "get",
    path: "same.js",
    factoryId: "fixture"
  }], ["runner_runtime", {
    action: "start",
    appid: process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(),
    packageDir: "/tmp/fixture",
    analysis: {
      enabled: true,
      networkMode: "local-only"
    }
  }], ["runner_runtime", {
    action: "start",
    appid: process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(),
    packageDir: "/tmp/fixture",
    analysis: {
      enabled: true,
      taps: [{
        target: "String.prototype.charCodeAt",
        scope: "armed"
      }]
    }
  }]]) {
    const result = await client.callTool({
      name,
      arguments: args
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /CONTROLLER_UPGRADE_REQUIRED/);
  }
  assert.ok(received.every(n => n === "runner_status"), "no mutation reaches the old controller");
  version = 4;
  for (const [name, args] of [["runner_crypto_watch", {
    action: "read",
    summary: true
  }], ["runner_autopsy", {
    action: "preflight"
  }], ["runner_autopsy", {
    action: "start",
    field: {
      in: "header",
      name: "X-Sign"
    },
    resultCondition: {
      kind: "text",
      text: "done"
    }
  }]]) {
    const result = await client.callTool({
      name,
      arguments: args
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /CONTROLLER_UPGRADE_REQUIRED/);
  }
  assert.ok(received.every(n => n === "runner_status"), "P1 cannot be silently ignored by protocol 4");
  const p0 = await client.callTool({
    name: "runner_crypto_watch",
    arguments: {
      action: "arm",
      tapIds: ["fixture"],
      runId: "fixture-run"
    }
  });
  assert.ok(!p0.isError, "P0 calls still reach protocol 4 controllers");
  const compatible = await client.callTool({
    name: "runner_crypto_watch",
    arguments: {
      action: "status"
    }
  });
  assert.ok(!compatible.isError);
  const report = {
    passed: true,
    date: new Date().toISOString(),
    standardMcp: true,
    oldControllerMutations: 0,
    legacyStatusCompatible: true,
    p0CompatibleWithProtocol4: true,
    p1RequiresProtocol5: true
  };
  fs.writeFileSync("docs/analysis-protocol-result.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  fs.rmSync(dir, {
    recursive: true,
    force: true
  });
}
