import { managedFixture } from "./managed-test-runtime.mjs";
import { componentFixture } from "./component-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// Test actual base-library callbacks, dialogs and MCP with isolated app profiles.
// No OS authorization prompt, fabricated production coordinate or business request.
const report = {
  platform: process.platform,
  date: new Date().toISOString(),
  frameworks: [],
  realCoordinate: "已实现未验收",
};
for (const framework of ["exparser", "glass-easel"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-location-smoke-"));
  let t;
  try {
    const pkg = componentFixture(dir, framework);
    const script = path.join(pkg, "app-service.js");
    const handler = "increase(){this.setData({count:this.data.count+1});}";
    const replacement =
      "increase(){wx.getLocation({type:'gcj02',success:r=>this.setData({locationResult:r,count:this.data.count+1}),fail:r=>this.setData({locationResult:r,count:this.data.count+1}),complete:()=>console.log('location-smoke-complete')});}";
    const source = fs.readFileSync(script, "utf8");
    assert.ok(source.includes(handler));
    fs.writeFileSync(script, source.replaceAll(handler, replacement));
    t = await managedFixture({ packageDir: pkg });
    const { call } = t;
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:1" }))
        .status,
      "matched",
    );
    const click = await call("runner_click", { text: "nested:child:1" });
    const pending = await call("runner_wait", {
      kind: "dialog",
      dialogType: "authorize",
    });
    assert.equal(pending.status, "matched");
    await call("runner_dialog", {
      action: "respond",
      id: pending.result.id,
      cancel: true,
    });
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:2" }))
        .status,
      "matched",
    );
    const leaf = (await call("runner_state")).instances.find(
      (i) => i.is === "leaf",
    );
    assert.equal(leaf.data.locationResult.runnerCode, "LOCATION_APP_DENIED");
    assert.equal(leaf.data.locationResult.errMsg, "getLocation:fail auth deny");
    assert.equal(
      (
        await t.client.callTool({
          name: "runner_dialog",
          arguments: {
            action: "respond",
            id: pending.result.id,
            confirm: true,
          },
        })
      ).isError,
      true,
    );
    await call("runner_click", { text: "nested:child:2" });
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:3" }))
        .status,
      "matched",
    );
    assert.equal((await call("runner_dialog")).length, 0);
    await call("runner_evaluate", {
      expression:
        "void wx.getSetting({success:r=>globalThis.__locationSettings=r})",
    });
    const setting = await call("runner_evaluate", {
      expression: "globalThis.__locationSettings",
      returnByValue: true,
    });
    assert.equal(setting.result.value.authSetting["scope.userLocation"], false);
    await call("runner_evaluate", {
      expression:
        "void wx.openSetting({success:r=>globalThis.__locationSettings=r})",
    });
    const settings = await call("runner_wait", {
      kind: "dialog",
      dialogType: "openSetting",
    });
    assert.equal(settings.status, "matched");
    const invalid = await t.client.callTool({
      name: "runner_dialog",
      arguments: {
        action: "respond",
        id: settings.result.id,
        authSetting: { "scope.camera": true },
      },
    });
    assert.equal(invalid.isError, true);
    assert.equal((await call("runner_dialog"))[0].id, settings.result.id);
    await call("runner_dialog", {
      action: "respond",
      id: settings.result.id,
      authSetting: { "scope.userLocation": true },
    });
    // Await the original callback via the Inspector without a fixed sleep.
    await call("runner_evaluate", {
      expression: "wx.getSetting()",
      awaitPromise: true,
    });
    const allowed = await call("runner_evaluate", {
      expression: "wx.getSetting()",
      awaitPromise: true,
    });
    assert.equal(allowed.result.value.authSetting["scope.userLocation"], true);
    assert.equal(
      (await call("runner_state", { action: "location" })).mode,
      "system",
    );
    await call("runner_state", {
      action: "location",
      location: {
        mode: "simulated",
        latitude: 39.907333,
        longitude: 116.391083,
      },
    });
    await call("runner_click", { text: "nested:child:3" });
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:4" }))
        .status,
      "matched",
    );
    const simulatedResult = (
      await call("runner_state", { action: "get", instanceId: leaf.id })
    ).instances[0].data.locationResult;
    assert.equal(simulatedResult.errMsg, "getLocation:ok");
    assert.ok(Math.abs(simulatedResult.longitude - 116.39732) < 0.0001);
    await call("runner_state", {
      action: "location",
      location: { mode: "system" },
    });
    assert.equal(
      (await call("runner_state", { action: "location" })).simulated,
      false,
    );
    const trace = [];
    let after = 0;
    for (;;) {
      const page = await call("runner_trace", {
        operationId: click.operationId,
        after,
        limit: 200,
      });
      trace.push(...page.entries);
      after = page.nextCursor;
      if (!page.hasMore) break;
    }
    const serialized = JSON.stringify(trace);
    assert.ok(
      serialized.includes("native-api") &&
        serialized.includes("LOCATION_APP_DENIED"),
    );
    report.frameworks.push({
      framework,
      status: "验收通过",
      originalHandler: true,
      deniedCallbackAndSetData: true,
      noAutomaticReprompt: true,
      invalidSettingsNoSideEffects: true,
      explicitSettingsUpdate: true,
      debugOperationLinked: true,
      explicitSimulationSuccessAndGcj02Rendered: true,
      restoreSystemMode: true,
    });
  } catch (e) {
    console.error(t?.logs.join("").slice(-3000));
    throw e;
  } finally {
    await t?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
fs.writeFileSync(
  "docs/location-result.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
