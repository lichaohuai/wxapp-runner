import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { managedFixture, until } from "./managed-test-runtime.mjs";
const packageDir = path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
  throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
})()));
const fingerprint = () => createHash("sha256").update(fs.readFileSync(path.join(packageDir, "app-service.js"))).digest("hex");
const before = fingerprint();
let t,
  received = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) {}
  received++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    code: 0,
    data: {
      probe: "local-response"
    },
    msg: "ok"
  }));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
try {
  t = await managedFixture({
    packageDir,
    appid: process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(),
    config: {
      analysis: {
        enabled: true,
        networkMode: "local-only",
        defeatAntiHook: true,
        cryptoTap: true,
        ttlMs: 300000,
        capacity: 2000,
        captureBytes: 4096,
        randomSeed: 42,
        now: 1700000000000,
        taps: [{
          target: "String.prototype.charCodeAt",
          scope: "armed",
          count: 5
        }, {
          target: "String.fromCharCode",
          scope: "armed",
          count: 5
        }],
        execution: {
          enabled: true,
          files: ["app-service.js"],
          modules: ["app.js", "utils/util.js"],
          capacity: 100000,
          maxEvents: 100000,
          ttlMs: 60000,
          valueLimit: 4096
        }
      }
    }
  });
  const c = t.call;
  const initial = await c("runner_crypto_watch", {
    action: "status"
  });
  const dormant = initial.taps.filter(p => p.scope === "armed");
  assert.equal(dormant.length, 2);
  assert.ok(dormant.every(p => p.remaining === 5 && p.state === "installed"));
  console.log("boot-ready: dormant aliases retained their full budget");
  const modulePath = "utils/md5.min.js";
  const factories = await c("runner_source", {
    action: "list",
    path: modulePath
  });
  assert.ok(new Set(factories.modules.map(m => m.sha256)).size > 1);
  const ambiguous = await t.client.callTool({
    name: "runner_source",
    arguments: {
      action: "get",
      path: modulePath,
      file: "app-service.js"
    }
  });
  assert.equal(ambiguous.isError, true);
  assert.match(JSON.stringify(ambiguous), /multiple factories/);
  const current = await c("runner_source", {
    action: "get",
    path: modulePath,
    current: true,
    length: 200
  });
  const actual = await c("runner_source", {
    action: "locate",
    target: {
      module: modulePath
    }
  });
  assert.ok(actual.modules.some(m => m.factoryId === current.factoryId));
  assert.notEqual(current.factoryId, factories.modules[0].factoryId);
  console.log("factory: current source agrees with observed function location");
  const h = await c("runner_hook", {
    action: "install",
    target: {
      module: modulePath
    },
    count: 1
  });
  const oracle = await c("runner_oracle", {
    action: "export",
    target: {
      module: modulePath
    }
  });
  await c("runner_oracle", {
    action: "call",
    oracleId: oracle.oracleId,
    args: ["debugger-default-export-fixture"]
  });
  const hit = await c("runner_hook", {
    action: "read",
    hookId: h.hookId
  });
  assert.equal(hit.entries.length, 1);
  const send = await c("runner_oracle", {
    action: "export",
    target: "getApp().utils.request"
  });
  await c("runner_network_rules", {
    action: "set",
    rule: {
      enabled: true,
      priority: 1000,
      match: {
        urlIncludes: "/debugger-review-probe",
        source: "logic"
      },
      action: "modify",
      change: {
        url: `http://127.0.0.1:${server.address().port}/debugger-review-probe`
      }
    }
  });
  const job = await c("runner_autopsy", {
    action: "start",
    urlIncludes: "/debugger-review-probe",
    field: {
      in: "header",
      name: "X-Sign"
    },
    timeoutMs: 60000,
    revealSensitive: true,
    trigger: {
      tool: "runner_oracle",
      arguments: {
        action: "call",
        oracleId: send.oracleId,
        args: [{
          url: "/debugger-review-probe",
          params: {
            fixture: "debugger-regression"
          },
          method: "POST"
        }]
      }
    }
  });
  const done = await until(async () => {
    const r = await c("runner_autopsy", {
      action: "get",
      jobId: job.id,
      revealSensitive: true
    });
    return r.phase === "finished" && r;
  }, 65000);
  assert.ok(["partial", "complete"].includes(done.state), JSON.stringify(done.error));
  assert.equal(done.triggerCount, 1);
  await until(() => received === 1);
  // Read the service-owned artifact, never synthesize missing graph edges in the test.
  const chunks = [];
  let offset = 0;
  for (let n = 0; n < 500; n++) {
    const a = await c("runner_artifact", {
      action: "read",
      id: done.artifactId,
      offset,
      length: 65536,
      revealSensitive: true
    });
    const b = Buffer.from(a.data, "base64");
    chunks.push(b);
    offset += b.length;
    if (!b.length || a.hasMore === false || offset >= a.readableBytes) break;
  }
  const report = JSON.parse(Buffer.concat(chunks));
  const field = report.fields[0];
  const upper = field.events.find(e => e.kind === "call" && e.native === "String.toUpperCase");
  if (!upper) console.log("slice-completeness", JSON.stringify({
    events: field.events.length,
    truncated: field.truncated,
    missing: field.missing,
    opaque: field.opaqueBoundaries.length,
    crypto: report.cryptoCalls.map(e => ({
      algo: e.algo,
      eventId: e.executionEventId,
      phase: e.phase
    })),
    evidence: report.evidence
  }));
  if (!upper) console.log("slice-call-metadata", JSON.stringify(field.events.filter(e => e.kind === "call").map(({
    id,
    callee,
    native,
    receiverDeps,
    argumentDeps,
    opaque,
    receiver
  }) => ({
    id,
    callee,
    native,
    receiverDeps,
    argumentDeps,
    opaque,
    receiverType: typeof receiver
  }))));
  assert.ok(upper, "native uppercase identity retained");
  assert.ok(upper.receiverDeps.length, "receiver has provenance");
  assert.ok(report.cryptoCalls.length > 0);
  assert.ok(report.cryptoSummary.counts.verified >= 4, JSON.stringify(report.cryptoSummary.counts));
  const aesStep = report.cryptoSummary.steps.find(s => s.metadata.algorithm === "AES");
  assert.equal(aesStep?.verification.status, "verified", JSON.stringify(aesStep && {
    metadata: aesStep.metadata,
    verification: aesStep.verification
  }));
  assert.ok(report.cryptoSummary.steps.some(s => s.fieldLinks.length > 0));
  assert.ok(report.cryptoSummary.steps.some(s => s.fieldComparisons.some(f => f.matched === true)));
  assert.equal(report.cryptoTruncated, false);
  assert.ok(report.evidence);
  assert.equal(report.outcome.businessResult, "not-evaluated");
  if (field.opaqueBoundaries.length) assert.equal(done.state, "partial");
  // Demonstrate actual nv_* alias capture in this package during a scoped run.
  const run = await c("runner_execution", {
    action: "start",
    ttlMs: 10000,
    maxEvents: 100000
  });
  await c("runner_crypto_watch", {
    action: "arm",
    tapIds: dormant.map(p => p.tapId),
    runId: run.runId,
    count: 5
  });
  await c("runner_oracle", {
    action: "call",
    oracleId: send.oracleId,
    args: [{
      url: "/debugger-review-probe",
      params: {
        fixture: "scoped-probes"
      },
      method: "POST"
    }]
  });
  await until(() => received === 2);
  const scoped = await c("runner_crypto_watch", {
    action: "read",
    runId: run.runId,
    limit: 100
  });
  const lowLevel = scoped.entries.filter(e => e.kind === "crypto" && ["user-specified"].includes(e.algo));
  assert.ok(lowLevel.length > 0, "captured aliases record in the explicit run");
  await c("runner_crypto_watch", {
    action: "disarm",
    tapIds: dormant.map(p => p.tapId)
  });
  await c("runner_execution", {
    action: "stop",
    runId: run.runId
  });
  assert.equal(fingerprint(), before);
  const result = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    realPackage: true,
    realBaselib: true,
    standardMcp: true,
    packageUnchanged: true,
    noAccountConfig: true,
    networkMode: "local-only",
    localRequests: received,
    autopsyTriggerCount: done.triggerCount,
    currentFactoryLine: current.line,
    duplicateFactories: factories.total,
    defaultExportHook: true,
    bootBudgetsPreserved: true,
    scopedAliasesObserved: true,
    receiverDependency: true,
    sliceEvents: field.events.length,
    opaqueBoundaries: field.opaqueBoundaries.length,
    evidence: report.evidence,
    autopsyState: done.state,
    cryptoCalls: report.cryptoCalls.length,
    cryptoVerification: report.cryptoSummary.counts,
    verifiedCipherMode: aesStep.metadata.mode,
    requestFieldNumericallyMatched: true,
    originalUserRuntimesUntouched: true
  };
  fs.writeFileSync("docs/analysis-review-smoke-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  await t?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
