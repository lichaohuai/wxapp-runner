import { managedFixture, until } from "./managed-test-runtime.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const t = await managedFixture();
const { call, app } = t;
const passed = {};
try {
  const status = await call("runner_status");
  const view = status.targets.find(
    (t) => t.kind === "view" && t.connected,
  ).targetId;
  for (const targetId of ["logic", view]) {
    console.log("debugger-target", targetId);
    const code = [
      "globalThis.debugHelper = function debugHelper(n) { return n * 2; };",
      "globalThis.debugFixture = function debugFixture(n) {",
      "  let value = n;",
      "  value = debugHelper(value);",
      "  return value + 1;",
      "};",
      "//# sourceURL=wxapp-debug-fixture.js",
    ].join("\n");
    await call("runner_evaluate", { targetId, expression: code });
    const bp = await call("runner_debugger", {
      targetId,
      action: "setBreakpoint",
      url: "wxapp-debug-fixture.js",
      line: 3,
      column: 3,
      condition: "n === 2",
    });
    assert.ok(bp.locations.length);
    assert.ok(
      (
        await call("runner_debugger", { targetId, action: "breakpoints" })
      ).breakpoints.some((b) => b.breakpointId === bp.breakpointId),
    );
    assert.equal(
      (
        await call("runner_evaluate", {
          targetId,
          expression: "debugFixture(1)",
        })
      ).result.value,
      3,
    );
    const evaluation = call("runner_evaluate", {
      targetId,
      expression: "debugFixture(2)",
    });
    evaluation.catch(() => {});
    const paused = await until(
      async () =>
        (await call("runner_debugger", { targetId, action: "state" })).paused,
    );
    assert.ok(paused.hitBreakpoints.includes(bp.breakpointId));
    const frame = await call("runner_evaluate", {
      targetId,
      expression: "n",
      callFrameId: paused.callFrames[0].callFrameId,
    });
    assert.equal(frame.result.value, 2);
    for (const action of ["stepOver", "stepInto", "stepOut"]) {
      await call("runner_debugger", { targetId, action });
      await until(
        async () =>
          (await call("runner_debugger", { targetId, action: "state" })).paused,
      );
    }
    await call("runner_debugger", {
      targetId,
      action: "removeBreakpoint",
      breakpointId: bp.breakpointId,
    });
    await call("runner_debugger", { targetId, action: "resume" });
    assert.equal((await evaluation).result.value, 5);
    const search = await call("runner_debugger", {
      targetId,
      action: "search",
      urlIncludes: "wxapp-debug-fixture",
      query: "debugHelper",
    });
    assert.equal(search.matches.length, 2);
    const scriptId = search.matches[0].scriptId;
    assert.ok(
      (
        await call("runner_debugger", { targetId, action: "source", scriptId })
      ).scriptSource.includes("debugHelper"),
    );
    const object = await call("runner_evaluate", {
      targetId,
      expression: '({中文:"value", nested:{n:3}})',
      returnByValue: false,
    });
    assert.ok(
      (
        await call("runner_debugger", {
          targetId,
          action: "properties",
          objectId: object.result.objectId,
        })
      ).result.some((p) => p.name === "中文"),
    );
    await call("runner_debugger", { targetId, action: "releaseObjects" });
    passed[targetId === "logic" ? "logicDebugger" : "viewDebugger"] = true;
  }
  const artifacts = [];
  for (const [targetId, kinds] of [
    ["logic", ["cpu", "allocations", "heap"]],
    [view, ["trace", "heap", "allocations"]],
  ]) {
    for (const kind of kinds) {
      console.log("analysis-target", targetId, kind);
      const job = await call("runner_profile", {
        action: "start",
        targetId,
        kind,
      });
      let current = await until(async () => {
        const j = await call("runner_profile", {
          action: "get",
          jobId: job.id,
        });
        assert.notEqual(j.state, "failed", JSON.stringify(j));
        return j.state !== "starting" && j;
      });
      if (kind !== "heap") {
        await call("runner_evaluate", {
          targetId,
          expression:
            'globalThis.profileScratch=[]; function profileWorkload(){const end=Date.now()+120;while(Date.now()<end){for(let i=0;i<2000;i++) profileScratch.push({i,text:"profile中文"+i});if(profileScratch.length>20000)profileScratch.splice(0,10000)}} profileWorkload();',
        });
        await call("runner_profile", { action: "stop", jobId: job.id });
      }
      current = await until(async () => {
        const j = await call("runner_profile", {
          action: "get",
          jobId: job.id,
        });
        assert.notEqual(j.state, "failed", JSON.stringify(j));
        return j.state === "complete" && j;
      }, 60000);
      const ext =
        kind === "cpu"
          ? "cpuprofile"
          : kind === "heap"
            ? "heapsnapshot"
            : kind === "allocations"
              ? "heapprofile"
              : "json";
      const file = path.join(
        t.isolated.directory,
        targetId + "-" + kind + "." + ext,
      );
      await call("runner_artifact", {
        action: "export",
        id: current.artifactId,
        destination: file,
        revealSensitive: true,
      });
      const data = JSON.parse(fs.readFileSync(file));
      if (kind === "cpu") {
        assert.ok(data.samples?.length);
        assert.ok(
          data.nodes.some(
            (n) => n.callFrame.functionName === "profileWorkload",
          ),
        );
      }
      if (kind === "trace") assert.ok(data.traceEvents?.length);
      if (kind === "heap") assert.ok(data.snapshot?.meta && data.nodes?.length);
      if (kind === "allocations") assert.ok(data.head);
      artifacts.push({ targetId, kind, file, bytes: fs.statSync(file).size });
    }
  }
  await call("runner_debugger", { action: "open", targetId: view });
  const debug = await until(() =>
    app.windows().find((p) => p.url().includes("inspector.html")),
  );
  await debug
    .getByRole("tab", { name: "Wxapp", exact: true })
    .waitFor({ state: "attached" });
  const memoryTab = debug.getByRole("tab", { name: "Memory", exact: true });
  if (!(await memoryTab.isVisible())) {
    await debug.getByRole("button", { name: /More tabs/ }).click();
    await debug.getByRole("menuitem", { name: "Memory", exact: true }).click();
  } else await memoryTab.click();
  const heap = artifacts.find((a) => a.targetId === view && a.kind === "heap");
  const chooser = debug.waitForEvent("filechooser");
  await debug.getByRole("button", { name: /Load/ }).first().click();
  await (await chooser).setFiles(heap.file);
  const imported = debug.getByRole("treeitem", { name: /^page:1-heap/ });
  await until(async () => {
    await debug.getByRole("tab", { name: "Memory", exact: true }).click();
    const label = await imported.getAttribute("aria-label");
    return label && !label.includes("…");
  }, 60000);
  await imported.click();
  await debug
    .getByRole("columnheader", { name: /Shallow Size/ })
    .first()
    .waitFor({ timeout: 10000 });
  passed.nativeHeapImport = true;
  const sampling = artifacts.find(
    (a) => a.targetId === view && a.kind === "allocations",
  );
  const allocationChooser = debug.waitForEvent("filechooser");
  await debug.getByRole("button", { name: /Load/ }).first().click();
  await (await allocationChooser).setFiles(sampling.file);
  const sampled = debug.getByRole("treeitem", { name: /page:1-allocations/ });
  await sampled.waitFor({ state: "visible" });
  await sampled.click();
  await debug
    .getByRole("columnheader", { name: /Self size/i })
    .first()
    .waitFor({ timeout: 10000 });
  passed.nativeAllocationImport = true;
  const performanceTab = debug.getByRole("tab", {
    name: "Performance",
    exact: true,
  });
  if (!(await performanceTab.isVisible())) {
    await debug
      .getByRole("button", { name: /More tabs/ })
      .first()
      .click();
    await debug
      .getByRole("menuitem", { name: "Performance", exact: true })
      .click();
  } else await performanceTab.click();
  await until(async () => {
    await performanceTab.click();
    return (await performanceTab.getAttribute("aria-selected")) === "true";
  }, 20000);
  for (const artifact of [
    artifacts.find((a) => a.kind === "cpu"),
    artifacts.find((a) => a.kind === "trace"),
  ]) {
    const choose = debug.waitForEvent("filechooser");
    choose.catch(() => {});
    await debug
      .getByRole("tabpanel", { name: "Performance panel", exact: true })
      .getByRole("button", { name: /Load trace/ })
      .click({ timeout: 5000 });
    await (await choose).setFiles(artifact.file);
    await until(async () => {
      const snapshot = await debug.locator("body").ariaSnapshot();
      if (/Error while loading|Failed to load/.test(snapshot))
        throw Error(snapshot.slice(-4000));
      return (
        /Bottom-up|Call tree/.test(snapshot) &&
        !/Loading profile|Processing profile/.test(snapshot)
      );
    }, 60000);
    passed[artifact.kind === "cpu" ? "nativeCpuImport" : "nativeTraceImport"] =
      true;
  }
  const result = {
    passed: true,
    platform: process.platform,
    ...passed,
    artifacts: artifacts.map(({ file, ...r }) => r),
  };
  fs.writeFileSync(
    "docs/profiles-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (e) {
  try {
    console.error(
      "PROFILE-FAIL-STATE",
      JSON.stringify(await call("runner_status")),
    );
    console.error(
      "PROFILE-FAIL-EVENTS",
      JSON.stringify(
        await call("runner_events", { limit: 200, source: "inspector" }),
      ),
    );
  } catch {}
  const debug = app.windows().find((p) => p.url().includes("inspector.html"));
  if (debug)
    fs.writeFileSync(
      "/tmp/wxapp-analysis-ui.txt",
      await debug.locator("body").ariaSnapshot(),
    );
  console.error(t.logs.join("").slice(-5000));
  throw e;
} finally {
  await t.close();
}
