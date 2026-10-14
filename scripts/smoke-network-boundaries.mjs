import { managedFixture, until } from "./managed-test-runtime.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
let outbound = 0;
const server = http.createServer((req, res) => {
  outbound++;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  if (req.url === "/hang") {
    res.write("partial中文");
    return;
  }
  res.end("大".repeat(400000));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const t = await managedFixture({
  debug: { bodyLimit: 131072, totalBodyLimit: 1048576 },
});
const { call, client } = t;
const fail = async (name, arguments_) => {
  const r = await client.callTool({ name, arguments: arguments_ });
  assert.equal(r.isError, true, JSON.stringify(r));
  return r;
};
try {
  let after = (await call("runner_status")).networkCursor;
  await call("runner_evaluate", {
    expression: `wx.request({url:${JSON.stringify(base + "/large")},dataType:'text',success:r=>globalThis.largeLength=r.data.length})`,
  });
  const large = (
    await call("runner_wait", { kind: "network", after, urlIncludes: "/large" })
  ).result;
  await until(
    async () =>
      (await call("runner_evaluate", { expression: "globalThis.largeLength" }))
        .result.value === 400000,
  );
  const row = await call("runner_network", { id: large.id });
  const artifact = await call("runner_artifact", {
    action: "read",
    id: row.responseArtifactId,
  });
  assert.equal(artifact.truncated, true);
  assert.equal(artifact.bytes, 131072);
  assert.ok(artifact.observedBytes > artifact.bytes);
  assert.equal(row.encodedBytes, 1200000);
  assert.equal(row.decodedBytes, null);
  assert.equal(
    (await call("runner_artifact", { action: "read", id: artifact.id })).data,
    artifact.data,
  );
  await fail("runner_artifact", {
    action: "export",
    id: artifact.id,
    destination: path.join(t.isolated.directory, "invalid.txt"),
  });
  const rule = await call("runner_network_rules", {
    action: "set",
    rule: { enabled: true, match: { urlIncludes: "/paused" }, action: "pause" },
  });
  after = (await call("runner_status")).networkCursor;
  await call("runner_evaluate", {
    expression: `globalThis.cancelTask=wx.request({url:${JSON.stringify(base + "/paused")}})`,
  });
  await until(
    async () =>
      (await call("runner_network_rules", { action: "paused" })).requests
        .length === 1,
  );
  await call("runner_evaluate", { expression: "cancelTask.abort()" });
  assert.equal(
    (
      await call("runner_wait", {
        kind: "network",
        after,
        urlIncludes: "/paused",
        networkState: "failed",
      })
    ).status,
    "matched",
  );
  await until(
    async () =>
      (await call("runner_network_rules", { action: "paused" })).requests
        .length === 0,
  );
  assert.equal(outbound, 1);
  after = (await call("runner_status")).networkCursor;
  await call("runner_evaluate", {
    expression: `wx.request({url:${JSON.stringify(base + "/paused-mock")}})`,
  });
  const paused = await until(
    async () =>
      (await call("runner_network_rules", { action: "paused" })).requests[0],
  );
  await call("runner_network_rules", {
    action: "resolve",
    id: paused.id,
    decision: { action: "mock", response: { body: "minimal mock" } },
  });
  assert.equal(
    (
      await call("runner_wait", {
        kind: "network",
        after,
        urlIncludes: "/paused-mock",
      })
    ).result.status,
    200,
  );
  assert.equal(outbound, 1);
  await call("runner_network_rules", { action: "remove", id: rule.id });
  after = (await call("runner_status")).networkCursor;
  await call("runner_evaluate", {
    expression: `wx.request({url:${JSON.stringify(base + "/hang")}})`,
  });
  await call("runner_wait", {
    kind: "network",
    after,
    urlIncludes: "/hang",
    networkState: "headers",
  });
  const pending = (await call("runner_network", { after })).entries.find((r) =>
    r.url.endsWith("/hang"),
  );
  const status = await call("runner_status");
  process.kill(status.pid, "SIGKILL");
  await until(async () => (await call("runner_status")).state === "exited");
  const incomplete = await call("runner_network", { id: pending.id });
  assert.equal(incomplete.state, "capture-error");
  assert.equal(incomplete.completionUnknown, true);
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    largeBusinessResponseUnchanged: true,
    explicitCaptureTruncation: true,
    repeatRead: true,
    incompleteExportRejected: true,
    abortPausedNoOutbound: true,
    minimalPausedMock: true,
    crashMarksUnknownCompletion: true,
  };
  fs.writeFileSync(
    "docs/network-boundaries-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (e) {
  console.error(t.logs.join("").slice(-3000));
  throw e;
} finally {
  await t.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
