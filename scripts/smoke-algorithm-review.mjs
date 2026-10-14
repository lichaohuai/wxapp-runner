// Exercise a real, ordinary library algorithm through public MCP tools. All
// vectors are local; no account, signature endpoint, or business write is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { interactionFixture } from "./interaction-fixture.mjs";
import { managedFixture, until } from "./managed-test-runtime.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-algorithm-review-"));
let t;
try {
  const pkg = interactionFixture(root, "http://127.0.0.1:1/unused");
  const library = fs.readFileSync(
    "node_modules/crypto-js/crypto-js.js",
    "utf8",
  );
  fs.appendFileSync(
    path.join(pkg, "app-service.js"),
    `
define('vendor/crypto-js.js',function(require,module,exports){${library}\n});
define('utils/hashing.js',function(require,module,exports){
  const CryptoJS=require('../vendor/crypto-js.js');
  exports.digest=function digest(input){return CryptoJS.MD5(input).toString();};
  exports.hash=function hash(input){return exports.digest(input);};
});getApp().hashing=require('utils/hashing.js');`,
  );
  t = await managedFixture({
    packageDir: pkg,
    config: {
      loaderAdapter: "official",
      analysis: { enabled: true, networkMode: "local-only", ttlMs: 300000 },
    },
  });
  const call = t.call;
  const source = await call("runner_source", {
    action: "get",
    path: "utils/hashing.js",
    current: true,
  });
  assert.match(source.source, /CryptoJS.MD5/);
  const location = await call("runner_source", {
    action: "locate",
    target: "getApp().hashing.digest",
  });
  assert.equal(location.found, true);
  assert.ok(location.modules.some((m) => m.path === "utils/hashing.js"));
  const hook = await call("runner_hook", {
    target: "getApp().hashing.digest",
    count: 2,
    ttlMs: 120000,
  });
  const watch = await call("runner_crypto_watch", {
    action: "start",
    auto: false,
    ttlMs: 120000,
    taps: [{ target: "getApp().hashing.digest", algo: "MD5" }],
  });
  const runs = [];
  for (const input of ["abc", "中文😀"]) {
    const slice = await call("runner_slice", {
      action: "start",
      target: "getApp().hashing.hash",
      count: 1,
    });
    runs.push(slice.runId);
    const result = await call("runner_evaluate", {
      expression: `getApp().hashing.hash(${JSON.stringify(input)})`,
    });
    assert.equal(
      result.result.value,
      createHash("md5").update(input).digest("hex"),
    );
  }
  const captured = await call("runner_hook", {
    action: "read",
    hookId: hook.hookId,
    revealSensitive: true,
  });
  assert.equal(captured.entries.length, 2);
  assert.equal(captured.restore, "deferred");
  assert.equal(captured.entries[1].args[0], "中文😀");
  const diff = await call("runner_crypto_watch", {
    action: "diff",
    runA: runs[0],
    runB: runs[1],
    revealSensitive: true,
  });
  assert.ok(diff.changes.length);
  const oracle = await call("runner_oracle", {
    action: "export",
    target: "getApp().hashing.hash",
  });
  const vectors = ["", "abc", "中文😀", "a".repeat(10000)];
  const batch = await call("runner_oracle", {
    action: "batch",
    oracleId: oracle.oracleId,
    inputs: vectors.map((s) => [s]),
    revealSensitive: true,
  });
  assert.equal(batch.calls, vectors.length);
  assert.deepEqual(
    batch.results.map((r) => r.result),
    vectors.map((s) => createHash("md5").update(s).digest("hex")),
  );
  await call("runner_debugger", { action: "open" });
  const devtools = await until(() =>
    t.app.windows().find((w) => w.url().includes("js_app.html")),
  );
  await devtools.getByRole("tab", { name: "Wxapp", exact: true }).click();
  const section = devtools.getByRole("combobox", { name: "Wxapp section" });
  await section.selectOption({ label: "模块源码" });
  await devtools
    .getByText("utils/hashing.js", { exact: false })
    .first()
    .waitFor();
  await section.selectOption({ label: "函数 Hook" });
  await devtools.getByText(hook.hookId, { exact: false }).first().waitFor();
  await call("runner_oracle", { action: "remove", oracleId: oracle.oracleId });
  await call("runner_crypto_watch", { action: "stop", watchId: watch.watchId });
  await call("runner_crypto_watch", { action: "stop" });
  assert.equal(
    (await call("runner_hook", { action: "read", hookId: hook.hookId }))
      .restore,
    "restored",
  );
  const result = {
    date: new Date().toISOString(),
    platform: process.platform,
    status: "验收通过",
    algorithm: "CryptoJS MD5",
    libraryVersion: JSON.parse(
      fs.readFileSync("node_modules/crypto-js/package.json"),
    ).version,
    expectedValues: "independent Node crypto implementation",
    vectors: vectors.map((s) => ({
      utf8Bytes: Buffer.byteLength(s),
      digest: createHash("md5").update(s).digest("hex"),
    })),
    originalFactoryAndInspectorLocation: true,
    hookArgumentsAndReturn: true,
    autoRestore: true,
    causallyScopedDiff: true,
    oracleBatch: true,
    nativeWxappPanel: true,
    limitations: [
      "A known library algorithm validates the tool workflow; this is not a claim of generic VM devirtualization.",
      "The fixture contains the unchanged real dependency; no third-party business package was modified.",
    ],
  };
  fs.writeFileSync(
    "docs/algorithm-review-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(result);
} finally {
  await t?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
