import test from "node:test";
import assert from "node:assert/strict";
import {
  AutopsyJobs,
  requestSink,
  autopsyPreflight,
} from "../src/analysis/execution/autopsy";
const until = async (f: () => any) => {
  for (let i = 0; i < 100; i++) {
    const x = f();
    if (x) return x;
    await new Promise((r) => setImmediate(r));
  }
  throw Error("job not settled");
};
function host() {
  const jobs = new AutopsyJobs(),
    calls: any[] = [],
    o: any = {
      runtimeId: "r",
      sessionId: "s",
      clientId: "c",
      check() {},
      artifact() {
        return "artifact";
      },
      async call(n: string, a: any) {
        calls.push([n, a]);
        if (n === "runner_status") return { networkCursor: 0 };
        if (n === "runner_crypto_watch")
          return { taps: [], latestCursor: 0, entries: [] };
        if (n === "runner_execution") {
          if (a.action === "status")
            return { enabled: true, files: [{ file: "fixture.js" }] };
          if (a.action === "start") return { runId: "x" };
          if (a.action === "explain")
            return {
              sink: {
                argumentsHeap: [
                  {
                    properties: {
                      header: {
                        object: { properties: { "X-Sign": { ref: 9 } } },
                      },
                    },
                  },
                ],
              },
              semantic: [],
              events: [],
              oracleCandidates: [],
              missing: [],
              opaqueBoundaries: [],
            };
          return {};
        }
        if (n === "runner_network")
          return {
            entries: [
              {
                id: "n",
                cursor: 1,
                url: "http://localhost/fixture",
                context: { executionRunId: "x", executionEventId: 1 },
              },
            ],
            nextCursor: 1,
          };
        return { operationId: undefined };
      },
    };
  return { jobs, calls, o };
}
test("result conditions are validated before capture/trigger and preflight is read-only", async () => {
  const h = host();
  for (const resultCondition of [
    { kind: "state", instanceId: "p", path: ["ok"] },
    { kind: "text" },
    { kind: "route", route: "x", runtimeId: "other" },
  ])
    assert.throws(() =>
      h.jobs.start({ resultCondition, timeoutMs: 1000 }, h.o),
    );
  assert.equal(h.calls.length, 0);
  const result = await autopsyPreflight(
    { timeoutMs: 1000, resultCondition: { kind: "text", text: "done" } },
    h.o,
  );
  assert.equal(result.actionsSubmitted, 0);
  assert.ok(
    h.calls.every(([n, a]) => n === "runner_status" || a.action === "status"),
  );
});
test("business wait precedes the single trigger; matching evidence and transport remain separate", async () => {
  const h = host(),
    original = h.o.call;
  let resolve: any;
  h.o.call = async (n: string, a: any) => {
    if (n === "runner_wait") {
      h.calls.push([n, a]);
      return new Promise((r) => (resolve = r));
    }
    if (n === "runner_oracle") {
      assert.ok(resolve);
      resolve({ status: "matched", result: "done" });
    }
    return original(n, a);
  };
  const j = h.jobs.start(
    {
      field: { in: "header", name: "X-Sign" },
      timeoutMs: 1000,
      resultCondition: { kind: "text", text: "done" },
      trigger: {
        tool: "runner_oracle",
        arguments: { action: "call", oracleId: "o" },
      },
    },
    h.o,
  );
  const done = await until(() => {
    const x = h.jobs.get(j.id, "r", true);
    return x.phase === "finished" && x;
  });
  assert.equal(done.triggerCount, 1);
  assert.equal(done.report.outcome.businessResult, "condition-matched");
  assert.equal(done.report.outcome.transportFinished, null);
  assert.equal(done.businessCheck.basis, "caller-specified-result-condition");
});
test("result timeout or cancellation retains a report without replay and cleans only the owned wait", async () => {
  for (const state of ["timeout", "cancelled"]) {
    const h = host(),
      original = h.o.call;
    h.o.call = async (n: string, a: any, signal: any) => {
      if (n === "runner_wait")
        return new Promise((r) => {
          const settle = () => r({ status: state });
          signal.addEventListener("abort", settle, { once: true });
          if (state === "timeout") setTimeout(settle, 25);
        });
      return original(n, a);
    };
    const j = h.jobs.start(
      {
        field: { in: "header", name: "X-Sign" },
        timeoutMs: 1000,
        resultCondition: { kind: "text", text: "never" },
        trigger: {
          tool: "runner_oracle",
          arguments: { action: "call", oracleId: "o" },
        },
      },
      h.o,
    );
    await until(() => h.jobs.get(j.id, "r").phase === "waiting-result");
    if (state === "cancelled") h.jobs.cancel(j.id, "r", "c");
    if (state === "timeout") await new Promise((r) => setTimeout(r, 30));
    const done = await until(() => {
      const x = h.jobs.get(j.id, "r", true);
      return x.phase === "finished" && x;
    });
    assert.equal(done.state, state === "timeout" ? "timed-out" : "cancelled");
    assert.equal(done.report.outcome.businessResult, state);
    assert.equal(done.artifactId, "artifact");
    assert.equal(done.triggerCount, 1);
    assert.equal(h.calls.filter(([n]) => n === "runner_oracle").length, 1);
  }
});
test("autopsy pages crypto by run and never reports complete on missing evidence", async () => {
  for (const broken of [false, true]) {
    const h = host(),
      original = h.o.call;
    let reads = 0;
    h.o.call = async (name: string, args: any) => {
      if (name === "runner_crypto_watch" && args.action === "read") {
        assert.equal(args.runId, "x");
        reads++;
        return {
          entries: [{ id: reads, executionRunId: "x", kind: "return" }],
          nextCursor: reads,
          hasMore: reads === 1,
          gap: broken && reads === 1,
        };
      }
      return original(name, args);
    };
    const j = h.jobs.start(
      { field: { in: "header", name: "X-Sign" }, timeoutMs: 1000 },
      h.o,
    );
    const done = await until(() => {
      const j2 = h.jobs.get(j.id, "r", true);
      return j2.phase === "finished" && j2;
    });
    assert.equal(reads, 2);
    assert.equal(done.report.cryptoCalls.length, 2);
    assert.equal(done.report.cryptoTruncated, false);
    assert.equal(done.state, broken ? "partial" : "complete");
    assert.equal(done.report.evidence.complete, !broken);
    if (broken)
      assert.ok(done.report.evidence.reasons.includes("CRYPTO_CURSOR_GAP"));
    assert.equal(done.report.outcome.businessResult, "not-evaluated");
  }
});
test("a non-advancing crypto cursor is bounded and reported instead of spinning or succeeding", async () => {
  const h = host(),
    original = h.o.call;
  h.o.call = async (name: string, a: any) =>
    name === "runner_crypto_watch" && a.action === "read"
      ? { entries: [], nextCursor: a.after, hasMore: true }
      : original(name, a);
  const j = h.jobs.start(
    { field: { in: "header", name: "X-Sign" }, timeoutMs: 1000 },
    h.o,
  );
  const done = await until(() => {
    const v = h.jobs.get(j.id, "r", true);
    return v.phase === "finished" && v;
  });
  assert.equal(done.state, "partial");
  assert.ok(done.report.evidence.reasons.includes("CRYPTO_CURSOR_STALLED"));
});
test("autopsy consumes immutable graph artifacts rather than truncated tool previews", async () => {
  const h = host(),
    original = h.o.call;
  const artifacts = new Map();
  let index = 0;
  h.o.call = async (name: string, args: any) => {
    if (name === "runner_artifact") {
      const bytes = artifacts.get(args.id),
        end = Math.min(bytes.length, args.offset + args.length);
      return {
        data: bytes.subarray(args.offset, end).toString("base64"),
        readableBytes: bytes.length,
        hasMore: end < bytes.length,
      };
    }
    const r = await original(name, args);
    if (name === "runner_execution" && args.action === "explain") {
      const id = "graph-" + ++index;
      artifacts.set(
        id,
        Buffer.from(JSON.stringify({ ...r, notes: "fixture".repeat(20000) })),
      );
      return {
        ...r,
        events: [],
        truncated: true,
        outputLimited: true,
        artifactId: id,
      };
    }
    return r;
  };
  const j = h.jobs.start(
    { field: { in: "header", name: "X-Sign" }, timeoutMs: 1000 },
    h.o,
  );
  const done = await until(() => {
    const v = h.jobs.get(j.id, "r", true);
    return v.phase === "finished" && v;
  });
  assert.equal(done.state, "complete");
  assert.equal(done.report.fields[0].truncated, false);
  assert.equal(artifacts.size, 2);
});
test("unfinished crypto calls and clipped captured values cannot produce complete evidence", async () => {
  for (const [entries, reason] of [
    [
      [
        { id: 1, callId: 1, phase: "call", executionRunId: "x" },
        { id: 2, callId: 1, phase: "promise-pending", executionRunId: "x" },
      ],
      "CRYPTO_CALL_INCOMPLETE",
    ],
    [
      [
        {
          id: 1,
          callId: 1,
          phase: "return",
          input: { text: "preview", truncated: true },
          executionRunId: "x",
        },
      ],
      "CRYPTO_VALUE_TRUNCATED",
    ],
  ] as const) {
    const h = host(),
      original = h.o.call;
    h.o.call = async (name: string, a: any) =>
      name === "runner_crypto_watch" && a.action === "read"
        ? { entries, hasMore: false, nextCursor: 2 }
        : original(name, a);
    const j = h.jobs.start(
      { field: { in: "header", name: "X-Sign" }, timeoutMs: 1000 },
      h.o,
    );
    const done = await until(() => {
      const v = h.jobs.get(j.id, "r", true);
      return v.phase === "finished" && v;
    });
    assert.equal(done.state, "partial");
    assert.ok(done.report.evidence.reasons.includes(reason));
  }
});
test("transport progress updates independently of a finished analysis and never implies business success", async () => {
  const h = host();
  let status: any = { state: "pending" };
  h.o.requestStatus = () => status;
  const j = h.jobs.start(
    { field: { in: "header", name: "X-Sign" }, timeoutMs: 1000 },
    h.o,
  );
  const done = await until(() => {
    const v = h.jobs.get(j.id, "r", true);
    return v.phase === "finished" && v;
  });
  assert.equal(done.state, "complete");
  assert.equal(done.outcome.transportFinished, false);
  status = {
    state: "failed",
    status: 503,
    error: "fixture failure",
    durationMs: 23,
  };
  const late = h.jobs.get(j.id, "r", true);
  assert.equal(late.state, "complete");
  assert.equal(late.outcome.transportFinished, true);
  assert.equal(late.outcome.responseStatus, 503);
  assert.equal(late.outcome.businessResult, "not-evaluated");
  assert.equal(h.calls.filter((x) => x[0] === "runner_click").length, 0);
});
test("report artifact samples current transport, not the pending record observed before slicing", async () => {
  const h = host();
  let artifact: any;
  h.o.requestStatus = () => ({ state: "complete", status: 201 });
  h.o.artifact = (report: any) => {
    artifact = report;
    return "artifact";
  };
  const j = h.jobs.start(
    { field: { in: "header", name: "X-Sign" }, timeoutMs: 1000 },
    h.o,
  );
  await until(() => h.jobs.get(j.id, "r").phase === "finished");
  assert.equal(artifact.outcome.transportFinished, true);
  assert.equal(artifact.outcome.responseStatus, 201);
  assert.equal(artifact.outcome.businessResult, "not-evaluated");
});
test("autopsy checks trigger arguments before any action, captures once, cleans only its run", async () => {
  const h = host();
  assert.throws(() =>
    h.jobs.start(
      {
        trigger: { tool: "runner_click", arguments: { x: 1 } },
        timeoutMs: 1000,
      },
      h.o,
    ),
  );
  assert.equal(h.calls.length, 0);
  const j = h.jobs.start(
    {
      trigger: { tool: "runner_click", arguments: { x: 1, y: 1 } },
      field: { in: "header", name: "X-Sign" },
      timeoutMs: 1000,
    },
    h.o,
  );
  const done = await until(() => {
    const r = h.jobs.get(j.id, "r", true);
    return r.phase === "finished" && r;
  });
  assert.equal(done.triggerCount, 1);
  assert.equal(h.calls.filter((x) => x[0] === "runner_click").length, 1);
  assert.equal(
    h.calls.filter((x) => x[0] === "runner_execution" && x[1].action === "stop")
      .length,
    1,
  );
});
test("cancel during arm keeps the returned run ID and stops it without submitting input", async () => {
  const h = host(),
    original = h.o.call;
  let id: string;
  h.o.call = async (n: string, a: any) => {
    const r = await original(n, a);
    if (n === "runner_execution" && a.action === "start")
      h.jobs.cancel(id, "r", "c");
    return r;
  };
  const j = h.jobs.start(
    {
      trigger: { tool: "runner_click", arguments: { x: 1, y: 1 } },
      field: { in: "header", name: "X-Sign" },
      timeoutMs: 1000,
    },
    h.o,
  );
  id = j.id;
  const done = await until(() => {
    const r = h.jobs.get(id, "r");
    return r.phase === "finished" && r;
  });
  assert.equal(done.state, "cancelled");
  assert.equal(h.calls.filter((x) => x[0] === "runner_click").length, 0);
  assert.ok(
    h.calls.some(
      (x) =>
        x[0] === "runner_execution" &&
        x[1].action === "stop" &&
        x[1].runId === "x",
    ),
  );
});
test("request field mapping labels container precision and never matches values by coincidence", () => {
  assert.equal(
    requestSink(
      { argumentsHeap: [{ properties: { data: { ref: 5 } } }] },
      { in: "body", name: "sign" },
    ).precision,
    "whole-container",
  );
  assert.ok(requestSink({}, { in: "header", name: "sign" }).reason);
});

test("large autopsy polls return compact summaries and preserve the complete artifact", async () => {
  const h = host(),
    original = h.o.call;
  let artifact: any;
  h.o.artifact = (report: any) => {
    artifact = report;
    return "large-artifact";
  };
  h.o.call = async (n: string, a: any) => {
    const r = await original(n, a);
    if (n === "runner_execution" && a.action === "explain")
      return {
        ...r,
        semantic: Array.from({ length: 2000 }, (_, id) => ({
          id,
          kind: "binary",
          value: "fixture-only",
          deps: [],
          location: {
            file: "x".repeat(200) + ".js",
            line: 1,
            column: id + 1,
            expression: "x".repeat(200),
          },
        })),
      };
    return r;
  };
  const j = h.jobs.start(
    { field: { in: "header", name: "X-Sign" }, timeoutMs: 2000 },
    h.o,
  );
  const result = await until(() => {
    const r = h.jobs.get(j.id, "r");
    return r.phase === "finished" && r;
  });
  assert.equal(result.artifactId, "large-artifact");
  assert.equal(result.outputLimited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 131072);
  assert.equal(artifact.fields[0].steps.length, 2000);
  assert.ok(!JSON.stringify(artifact).includes("fixture-only"));
});
