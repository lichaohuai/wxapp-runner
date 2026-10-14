import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { summarizeCrypto } from "../src/analysis/crypto-evidence";
import { executionOutput } from "../src/analysis/execution/output";
import { AnalysisTools } from "../src/analysis/tools";
const digest = createHash("md5").update("abc").digest("hex");
const row = {
  id: 2,
  kind: "crypto",
  phase: "return",
  callId: 1,
  algo: "module:md5.min.js",
  input: "abc",
  output: digest,
  executionRunId: "r",
  executionEventId: 10,
};
test("raw Crypto tool reads hide stream chunks, receiver and literal source expressions by default", async () => {
  const secret = "private-vector-fixture";
  const captured = {
    ...row,
    chunks: [secret],
    thisArg: { private: secret },
    verificationVector: { input: secret },
    executionLocation: { location: { expression: secret } },
  };
  const tools = new AnalysisTools(async (n, a) =>
    n === "runner_status"
      ? { runtimeId: "r", sessionId: "s" }
      : {
          result: {
            value: a.expression.startsWith("!!")
              ? true
              : { entries: [captured], nextCursor: 2, hasMore: false },
          },
        },
  );
  const hidden = await tools.dispatch("runner_crypto_watch", {
    action: "read",
  });
  assert.ok(!JSON.stringify(hidden).includes(secret));
  const raw = await tools.dispatch("runner_crypto_watch", {
    action: "read",
    revealSensitive: true,
  });
  assert.ok(JSON.stringify(raw).includes(secret));
});
test("named tap verification is limited to a captured vector, and values never create field associations", () => {
  const fields = [
    {
      field: { in: "header", name: "sign" },
      events: [{ id: 10, runId: "different", value: digest }],
    },
  ];
  let result = summarizeCrypto([row], fields).steps[0];
  assert.equal(result.verification.status, "verified");
  assert.equal(result.metadata.basis, "named-tap-candidate");
  assert.deepEqual(result.fieldLinks, []);
  fields[0].events[0].runId = "r";
  result = summarizeCrypto([row], fields).steps[0];
  assert.equal(result.fieldLinks.length, 1);
  assert.equal(
    summarizeCrypto([{ ...row, output: "00" }]).steps[0].verification.status,
    "mismatch",
  );
  assert.ok(
    !JSON.stringify(executionOutput(summarizeCrypto([row]))).includes(digest),
  );
  assert.ok(
    !JSON.stringify(
      executionOutput({ verificationVector: { input: "secret-fixture" } }),
    ).includes("secret-fixture"),
  );
  assert.ok(
    !JSON.stringify(
      executionOutput({ thisArg: { privateValue: "private-fixture" } }),
    ).includes("private-fixture"),
  );
});
test("a matching request field is a numerical comparison, never an invented origin link", () => {
  const fields = [
    {
      field: { in: "header", name: "sign" },
      selection: { precision: "exact-option-property" },
      sink: { value: digest },
      events: [],
    },
  ];
  const result = summarizeCrypto([row], fields).steps[0];
  assert.equal(result.fieldComparisons[0].matched, true);
  assert.equal(result.fieldComparisons[0].association, "value-comparison-only");
  assert.deepEqual(result.fieldLinks, []);
  fields[0].selection.precision = "whole-container";
  assert.equal(
    summarizeCrypto([row], fields).steps[0].fieldComparisons[0].matched,
    null,
  );
});
test("truncated, unfinished, ambiguous and nonexportable observations are never verified", () => {
  for (const change of [
    { output: { encoding: "hex", data: digest, bytes: 16, truncated: true } },
    { phase: "call" },
    { phase: "throw" },
    { input: { text: "abc", truncated: true } },
    { algo: "unknown" },
    { streamTruncated: true },
    {
      crypto: {
        algorithm: "AES",
        operation: "encrypt",
        inputEncoding: "utf8-or-bytes",
        outputEncoding: "hex",
        keyEncoding: "opaque-handle",
      },
    },
    {
      crypto: {
        algorithm: "AES",
        operation: "encrypt",
        inputEncoding: "utf8-or-bytes",
        outputEncoding: "hex",
        keyEncoding: "passphrase",
      },
    },
  ])
    assert.equal(
      summarizeCrypto([{ ...row, ...change }]).steps[0].verification.status,
      "unavailable",
    );
});
test("WebCrypto real digest bytes verify and independent call identities cannot collapse", async () => {
  const output = Buffer.from(
    await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("中文😀"),
    ),
  );
  const bytes = (b: Buffer) => ({
    encoding: "hex",
    data: b.toString("hex"),
    bytes: b.length,
    truncated: false,
  });
  const r = {
    ...row,
    crypto: {
      adapter: "WebCrypto",
      algorithm: "SHA-256",
      operation: "digest",
      inputEncoding: "bytes",
      outputEncoding: "bytes",
    },
    verificationVector: {
      input: bytes(Buffer.from("中文😀")),
      output: bytes(output),
    },
  };
  const result = summarizeCrypto([
    { ...r, phase: "call" },
    r,
    { ...r, id: 4, executionRunId: "other" },
  ]);
  assert.equal(result.steps.length, 2);
  assert.equal(result.counts.verified, 2);
  assert.equal(result.steps[0].inputFormat.bytes, 10);
});
