import { managedFixture, until } from "./managed-test-runtime.mjs";
import { transform } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const t = await managedFixture();
const { call, app } = t;
let debug;
const frontendErrors = [];
try {
  const status = await call("runner_status");
  const sourceFile = path.join(status.packageDir, "native-original.ts");
  const scriptFile = path.join(status.packageDir, "native-compiled.js");
  const source = [
    "globalThis.nativeHelper = function nativeHelper(n: number) {",
    "  return n * 2;",
    "};",
    "globalThis.nativeFixture = function nativeFixture(n: number) {",
    "  debugger;",
    "  let value = n;",
    "  value = nativeHelper(value);",
    "  return value + 1;",
    "};",
  ].join("\n");
  const built = await transform(source, {
    loader: "ts",
    sourcemap: "external",
    sourcefile: sourceFile,
  });
  fs.writeFileSync(sourceFile, source);
  fs.writeFileSync(scriptFile + ".map", built.map);
  const code =
    built.code +
    "\n//# sourceURL=" +
    pathToFileURL(scriptFile).href +
    "\n//# sourceMappingURL=native-compiled.js.map";
  await call("runner_evaluate", { expression: code });
  await call("runner_debugger", { action: "open" });
  debug = await until(() =>
    app.windows().find((p) => p.url().includes("js_app.html")),
  );
  debug.on("pageerror", (error) => {
    frontendErrors.push(error.stack);
    console.error("Native frontend error:", error.stack);
  });
  await debug.getByRole("tab", { name: "Sources", exact: true }).click();
  const evaluation = call("runner_evaluate", {
    expression: "nativeFixture(2)",
  });
  evaluation.catch(() => {});
  await until(
    async () => (await call("runner_debugger", { action: "state" })).paused,
  );
  await debug
    .getByRole("button", { name: /Resume script execution/ })
    .waitFor({ timeout: 15000 });
  // The native source editor must resolve the existing map and show the original TS file.
  await debug
    .getByRole("tab", { name: /native-original.ts/ })
    .waitFor({ state: "visible", timeout: 15000 });
  // Sources buttons do not animate. Validate their native state explicitly;
  // a paused debug target can stall Playwright's animation-frame stability wait.
  async function toolbarClick(name) {
    const button = debug.getByRole("button", { name });
    await until(
      async () => (await button.isVisible()) && (await button.isEnabled()),
    );
    await button.click({ force: true });
  }
  const actions = [
    /Step over next function call/,
    /Step over next function call/,
    /Step into next function call/,
    /Step out of current function/,
  ];
  for (const name of actions) {
    const after = (await call("runner_events", { limit: 1 })).latestId;
    await toolbarClick(name);
    await until(async () =>
      (
        await call("runner_events", {
          after,
          source: "native-devtools",
          limit: 200,
        })
      ).entries.some((e) => e.type === "Debugger.paused"),
    );
  }
  await toolbarClick(/Resume script execution/);
  assert.equal((await evaluation).result.value, 5);
  await debug.getByRole("tab", { name: /native-original.ts/ }).click();
  const gutter = debug
    .locator(".cm-lineNumbers .cm-gutterElement")
    .filter({ hasText: /^2$/ })
    .first();
  const cursor = (await call("runner_events", { limit: 1 })).latestId;
  await gutter.click();
  const installed = await until(async () => {
    const page = await call("runner_events", {
      after: cursor,
      source: "native-devtools",
      limit: 200,
    });
    return page.entries.find((e) => e.type === "Debugger.setBreakpointByUrl");
  });
  assert.ok(installed.result?.locations?.length, JSON.stringify(installed));
  await call("runner_evaluate", {
    expression:
      "void setTimeout(()=>{globalThis.nativeResult=nativeHelper(3)},0)",
  });
  const nativeHit = await until(async () => {
    const p = (await call("runner_debugger", { action: "state" })).paused;
    return (
      p?.callFrames?.[0]?.location?.scriptId ===
        installed.result.locations[0].scriptId && p
    );
  });
  assert.match(nativeHit.callFrames[0].functionName, /nativeHelper/);
  assert.equal(
    (
      await call("runner_evaluate", {
        callFrameId: nativeHit.callFrames[0].callFrameId,
        expression: "n",
      })
    ).result.value,
    3,
  );
  await toolbarClick(/Resume script execution/);
  assert.equal(
    (await call("runner_evaluate", { expression: "nativeResult" })).result
      .value,
    6,
  );
  const nativeBreakpoint = (
    await call("runner_debugger", { action: "breakpoints" })
  ).breakpoints.find((b) => b.scope === "native-devtools");
  assert.ok(nativeBreakpoint);
  await call("runner_debugger", {
    action: "removeBreakpoint",
    breakpointId: nativeBreakpoint.breakpointId,
  });
  await debug
    .getByRole("checkbox", { name: "2", exact: true })
    .waitFor({ state: "hidden" });
  // Exception pause is independent of page operation queues.
  await call("runner_debugger", { action: "exceptions", state: "all" });
  const throwing = call("runner_evaluate", {
    expression:
      'try { throw new Error("native-exception-fixture") } catch(e) {}',
  });
  throwing.catch(() => {});
  const paused = await until(
    async () => (await call("runner_debugger", { action: "state" })).paused,
  );
  assert.equal(paused.reason, "exception");
  await toolbarClick(/Resume script execution/);
  await throwing;
  await call("runner_debugger", { action: "exceptions", state: "none" });
  await debug
    .getByRole("tab", { name: "Workspace", exact: true })
    .click({ force: true });
  assert.equal(frontendErrors.length, 0, frontendErrors.join("\n"));
  const result = {
    passed: true,
    platform: process.platform,
    nativeSourcesPause: true,
    nativeSourceMapBreakpoint: true,
    nativePauseMcpFrameEvaluation: true,
    mcpRemovesNativeBreakpoint: true,
    nativeStepOverIntoOut: true,
    nativeResume: true,
    existingSourceMapOriginalTS: true,
    exceptionPause: true,
    nativeSourcesEntryWithoutErrors: true,
  };
  fs.writeFileSync(
    "docs/native-debugger-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (e) {
  console.error("Native debugger failure:", e);
  const entries = [];
  let after = 0;
  for (let pageNo = 0; pageNo < 50; pageNo++) {
    const page = await call("runner_events", {
      after,
      source: "native-devtools",
      limit: 200,
    });
    entries.push(...page.entries);
    if (!page.hasMore) break;
    after = page.nextCursor;
  }
  console.error("Native debugger events:", JSON.stringify(entries));
  if (debug)
    fs.writeFileSync(
      "/tmp/wxapp-native-debugger-ui.txt",
      await debug.locator("body").ariaSnapshot(),
    );
  console.error(t.logs.join("").slice(-2500));
  throw e;
} finally {
  await t.close();
}
