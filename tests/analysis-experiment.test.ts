import test from "node:test";
import assert from "node:assert/strict";
import { NetworkRules } from "../src/controller/rules";
import { analysisConfig } from "../src/analysis/boot";
import {
  requiresReviewProtocol,
  requiredAnalysisProtocol,
} from "../src/analysis/protocol";
test("analysis version negotiation preserves P0 protocol 4 and gates P1 options at 5", () => {
  assert.equal(
    requiredAnalysisProtocol("runner_crypto_watch", { action: "arm" }),
    4,
  );
  assert.equal(
    requiredAnalysisProtocol("runner_crypto_watch", {
      action: "read",
      summary: true,
    }),
    5,
  );
  assert.equal(
    requiredAnalysisProtocol("runner_autopsy", { action: "preflight" }),
    5,
  );
  assert.equal(
    requiredAnalysisProtocol("runner_autopsy", {
      action: "start",
      resultCondition: { kind: "text", text: "done" },
    }),
    5,
  );
  assert.equal(
    requiredAnalysisProtocol("runner_autopsy", { action: "get" }),
    0,
  );
});
test("old controllers cannot silently strip scoped probes, factory identity or outbound constraints", () => {
  assert.ok(
    requiresReviewProtocol("runner_runtime", {
      analysis: { taps: [{ scope: "armed" }] },
    }),
  );
  assert.ok(
    requiresReviewProtocol("runner_runtime", {
      analysis: { networkMode: "local-only" },
    }),
  );
  assert.ok(
    requiresReviewProtocol("runner_source", { factoryId: "file:offset:hash" }),
  );
  assert.ok(requiresReviewProtocol("runner_crypto_watch", { action: "arm" }));
  assert.ok(
    !requiresReviewProtocol("runner_runtime", {
      analysis: { enabled: true, taps: [{ scope: "all" }] },
    }),
  );
  assert.ok(!requiresReviewProtocol("runner_source", { action: "list" }));
});
test("analysis local-only checks the final destination after modifications, including pause decisions", () => {
  const rules = new NetworkRules();
  const req = (url: string) => ({
    url,
    method: "POST",
    source: "logic",
    headers: {},
  });
  assert.equal(
    rules.evaluate(req("https://example.invalid")).action,
    "continue",
  );
  rules.experimentMode = analysisConfig({
    enabled: true,
    networkMode: "local-only",
  }).networkMode;
  for (const url of [
    "https://example.invalid",
    "http://127.0.0.1.example.invalid/",
    "http://localhost/",
    "http://example.invalid/http://127.0.0.1/",
  ]) {
    const p = rules.evaluate(req(url));
    assert.equal(p.action, "block");
    assert.equal(p.hits.at(-1).id, "analysis:local-only");
  }
  assert.equal(rules.evaluate(req("http://[::1]:8080/")).action, "continue");
  rules.set(
    {
      enabled: true,
      match: { urlIncludes: "/probe" },
      action: "modify",
      change: { url: "http://127.0.0.1:12345/probe" },
    },
    "test",
  );
  assert.equal(
    rules.evaluate(req("https://example.invalid/prefix/probe")).action,
    "continue",
  );
  const paused = rules.enforceExperiment({
    request: req("https://example.invalid"),
    action: "continue",
    hits: [],
  });
  assert.equal(paused.action, "block");
  assert.equal(
    rules.enforceExperiment({
      request: req("https://example.invalid"),
      action: "mock",
      hits: [],
    }).action,
    "mock",
  );
});
