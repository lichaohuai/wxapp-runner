import { managedFixture, until } from "./managed-test-runtime.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
let outbound = 0;
const server = http.createServer((req, res) => {
  outbound++;
  res.setHeader("content-type", "application/json");
  res.end('{"message":"retained诊断"}');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const t = await managedFixture({ url: base + "/submit" });
const { call, client } = t;
const error = async (c, name, args) => {
  const result = await c.callTool({ name, arguments: args });
  assert.equal(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
try {
  const initial = await call("runner_status");
  const b = await t.newClient();
  const lease = await call("runner_control", { action: "acquire" });
  assert.equal(
    (
      await error(b, "runner_storage", {
        action: "set",
        key: "conflict",
        value: 1,
      })
    ).code,
    "CONTROL_OCCUPIED",
  );
  await call("runner_debugger", { action: "open" });
  const debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Console", exact: true }).waitFor();
  // Native frontend initialization is observation, not evidence of human input.
  assert.equal((await call("runner_control")).lease.id, lease.lease.id);
  await debug.getByRole("tab", { name: "Console", exact: true }).click();
  await until(async () => !(await call("runner_control")).lease);
  await t.callAs(b, "runner_storage", {
    action: "set",
    key: "retained",
    value: "独立数据",
  });
  const before = (await call("runner_status")).networkCursor;
  const pauseRule = await t.callAs(b, "runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      action: "pause",
      match: { urlIncludes: "/pause-disconnect" },
    },
  });
  await call("runner_evaluate", {
    expression: `wx.request({url:${JSON.stringify(base + "/pause-disconnect")}})`,
  });
  await until(
    async () =>
      (await call("runner_network_rules", { action: "paused" })).requests
        .length === 1,
  );
  assert.equal(outbound, 0);
  await b.close();
  const request = await call("runner_wait", {
    kind: "network",
    after: before,
    urlIncludes: "/pause-disconnect",
    timeoutMs: 30000,
  });
  assert.equal(request.status, "matched");
  assert.equal(outbound, 1);
  assert.equal(
    (await call("runner_network_rules")).rules.find(
      (r) => r.id === pauseRule.id,
    ).enabled,
    false,
  );
  const body = await call("runner_network", { id: request.result.id });
  const bytes = await call("runner_artifact", {
    action: "read",
    id: body.responseArtifactId,
  });
  await error(client, "runner_runtime", {
    action: "switch",
    packageDir: path.join(t.isolated.directory, "missing"),
    appid: initial.appid,
  });
  assert.equal((await call("runner_status")).pid, initial.pid);
  await call("runner_runtime", { action: "restart" });
  await until(async () =>
    ((s) => s.serviceReady && s.current?.ready)(await call("runner_status")),
  );
  const next = await call("runner_status");
  assert.notEqual(next.sessionId, initial.sessionId);
  assert.equal(
    (
      await error(client, "runner_runtime", {
        action: "stop",
        sessionId: initial.sessionId,
      })
    ).code,
    "SESSION_CHANGED",
  );
  assert.equal((await call("runner_status")).state, "running");
  assert.deepEqual(
    (
      await call("runner_artifact", {
        action: "read",
        id: body.responseArtifactId,
        sessionId: initial.sessionId,
      })
    ).data,
    bytes.data,
  );
  assert.equal(
    (
      await call("runner_network", {
        id: request.result.id,
        sessionId: initial.sessionId,
      })
    ).responseBody,
    body.responseBody,
  );
  const stored = await call("runner_storage", {
    action: "get",
    key: "retained",
  });
  assert.ok(JSON.stringify(stored).includes("独立数据"));
  const other = await call("runner_runtime", {
    action: "start",
    packageDir: initial.packageDir,
    appid: initial.appid,
    configFile: path.join(t.isolated.directory, "config.json"),
  });
  await until(async () =>
    ((s) => s.serviceReady && s.current?.ready)(
      await call("runner_status", { runtimeId: other.runtimeId }),
    ),
  );
  assert.match(other.profile, /^isolated-/);
  assert.ok(
    !JSON.stringify(
      await call("runner_storage", {
        runtimeId: other.runtimeId,
        action: "get",
        key: "retained",
      }),
    ).includes("独立数据"),
  );
  await call("runner_runtime", { action: "stop", runtimeId: other.runtimeId });
  assert.equal((await call("runner_status")).pid, next.pid);
  await call("runner_runtime", {
    action: "closeSession",
    sessionId: initial.sessionId,
  });
  await error(client, "runner_artifact", {
    action: "read",
    id: body.responseArtifactId,
  });
  process.kill(next.pid, "SIGKILL");
  await until(async () => (await call("runner_status")).state === "exited");
  assert.equal((await call("runner_status")).exit.signal, "SIGKILL");
  assert.equal(outbound, 1);
  await call("runner_runtime", { action: "restart" });
  await until(async () =>
    ((s) => s.serviceReady && s.current?.ready)(await call("runner_status")),
  );
  assert.equal(outbound, 1);
  const result = {
    passed: true,
    platform: process.platform,
    nativeOpenPreservesLease: true,
    nativeInputTakeover: true,
    disconnectedOwnerReleasesPause: true,
    failedSwitchPreservesRuntime: true,
    staleSessionMutationRejected: true,
    retainedSessionBody: true,
    restartPreservesStorage: true,
    isolatedConcurrentProfile: true,
    closeArchivedSession: true,
    crashDiagnosticAndExplicitRestart: true,
    noReplay: true,
  };
  fs.writeFileSync(
    "docs/collaboration-result.json",
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
