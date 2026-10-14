import { _electron as electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedRuntime } from "./test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const isolated = isolatedRuntime();
const env = {
  ...isolated.env
};
delete env.WXAPP_STANDALONE;
const responses = [];
let first;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const {
    message
  } = JSON.parse(Buffer.concat(chunks));
  const finish = () => {
    responses.push(message);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      message: "result:" + message
    }));
  };
  if (message === "slow") first = finish;else {
    finish();
    if (first) first();
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const pkg = interactionFixture(isolated.directory, `http://127.0.0.1:${server.address().port}/probe`);
const fixtureLogic = path.join(pkg, "app-service.js");
fs.writeFileSync(fixtureLogic, fs.readFileSync(fixtureLogic, "utf8").replace("success:r=>this.setData({result:r.data.message})", "success:r=>{this.setData({result:r.data.message});Promise.reject(new Error('operation-error:'+r.data.message));}"));
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
  name: "trace",
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
try {
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(connection)) {
    if (Date.now() > deadline) throw Error("startup timeout");
    await new Promise(r => setTimeout(r, 50));
  }
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
    stderr: "pipe"
  }));
  // Startup probes may report no active view until the child creates it.
  for (;;) {
    const s = await call("runner_status");
    if (s.current?.ready) break;
    if (Date.now() > deadline) throw Error("view timeout");
    await new Promise(r => setTimeout(r, 50));
  }
  await call("runner_wait", {
    kind: "element",
    selector: "textarea"
  });
  const instanceId = (await call("runner_state")).pages[0].instanceId;
  const before = (await call("runner_status")).networkCursor;
  await call("runner_input", {
    selector: "textarea",
    text: "slow"
  });
  await call("runner_wait", {
    kind: "state",
    instanceId,
    path: ["input"],
    equals: "slow"
  });
  const slow = await call("runner_click", {
    selector: "#submit"
  });
  await call("runner_input", {
    selector: "textarea",
    text: "fast"
  });
  await call("runner_wait", {
    kind: "state",
    instanceId,
    path: ["input"],
    equals: "fast"
  });
  const fast = await call("runner_click", {
    selector: "#submit"
  });
  await call("runner_wait", {
    kind: "text",
    text: "result:slow"
  });
  assert.deepEqual(responses, ["fast", "slow"]);
  const errorWait = await call("runner_wait", {
    kind: "log",
    after: 0,
    source: "logic",
    level: "error",
    text: "operation-error:result:slow"
  });
  assert.equal(errorWait.status, "matched");
  const requests = (await call("runner_network", {
    after: before,
    limit: 100,
    fields: ["id", "context"]
  })).entries;
  assert.equal(requests.length, 2);
  for (const [operation, value] of [[slow, "slow"], [fast, "fast"]]) {
    const request = requests.find(r => r.context?.rootOperationId === operation.operationId);
    assert.ok(request, JSON.stringify({
      operation,
      requests
    }));
    assert.equal(request.context.rootHandler, "submit");
    assert.equal(JSON.parse((await call("runner_network", {
      id: request.id
    })).requestBody).message, value);
    const trace = [];
    let after = 0;
    for (;;) {
      const page = await call("runner_trace", {
        operationId: operation.operationId,
        after,
        limit: 200
      });
      trace.push(...page.entries);
      after = page.nextCursor;
      if (!page.hasMore) break;
    }
    assert.ok(trace.some(e => e.source === "network"));
    assert.ok(trace.some(e => e.args?.some(a => a?.message === "operation-error:result:" + value)));
    assert.ok(!trace.some(e => e.args?.some(a => a?.message === "operation-error:result:" + (value === "slow" ? "fast" : "slow"))));
    assert.ok(trace.some(e => e.args?.some(a => a.type === "handler" && a.name === "submit")));
    assert.ok(trace.some(e => e.args?.some(a => a.type === "setData" && a.patch?.result === "result:" + value)));
    assert.ok(!trace.some(e => e.args?.some(a => a.type === "setData" && a.patch?.result === "result:" + (value === "slow" ? "fast" : "slow"))));
  }
  const result = {
    passed: true,
    platform: process.platform,
    responsesOutOfOrder: true,
    distinctOperations: true,
    requestsAndDataCorrectlyLinked: true,
    concurrentExceptionsCorrectlyLinked: true
  };
  fs.writeFileSync("docs/trace-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(logs.join("").slice(-6000));
  throw e;
} finally {
  await client.close();
  await app.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  isolated.cleanup();
}
