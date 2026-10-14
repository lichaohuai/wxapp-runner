import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const t = await managedFixture({
  packageDir: path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })())),
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()
});
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  status: "已实现未验收",
  simulated: true,
  realAccounts: false,
  checks: {}
};
const value = async e => (await t.call("runner_evaluate", {
  expression: e
})).result.value;
const wait = async args => {
  const r = await t.call("runner_wait", args);
  assert.equal(r.status, "matched", JSON.stringify(r));
  return r;
};
try {
  const catalog = await t.call("runner_suite", {
    action: "catalog",
    limit: 500
  });
  assert.equal(catalog.pageCount, 356);
  assert.equal(catalog.pages.length, 356);
  assert.equal(catalog.scanErrors.length, 0);
  report.checks.catalog356 = true;
  await t.call("runner_device", {
    action: "preset",
    preset: "android"
  });
  await t.call("runner_navigate", {
    method: "navigateTo",
    url: "/packageAPI/pages/device/on-compass-change/on-compass-change"
  });
  await wait({
    kind: "text",
    text: "停止监听"
  });
  await t.call("runner_device", {
    action: "emit",
    event: "compass",
    data: {
      direction: 123,
      accuracy: 5
    }
  });
  const state = await t.call("runner_state"),
    instanceId = state.pages.at(-1).instanceId;
  assert.equal((await wait({
    kind: "state",
    instanceId,
    path: ["direction"],
    equals: 123
  })).status, "matched");
  await wait({
    kind: "text",
    text: "123"
  });
  report.checks.originalCompassCallbackAndView = true;
  await t.call("runner_click", {
    text: "停止监听"
  });
  assert.equal((await wait({
    kind: "state",
    instanceId,
    path: ["enabled"],
    equals: false
  })).status, "matched");
  const stopped = await t.client.callTool({
    name: "runner_device",
    arguments: {
      action: "emit",
      event: "compass",
      data: {
        direction: 234
      }
    }
  });
  assert.equal(stopped.isError, true);
  assert.equal(await value("getCurrentPages().at(-1).data.direction"), 123);
  report.checks.stoppedSensorRejectsInput = true;
  await t.call("runner_click", {
    text: "开始监听"
  });
  await t.call("runner_device", {
    action: "emit",
    event: "compass",
    data: {
      direction: 234
    }
  });
  await wait({
    kind: "text",
    text: "234"
  });
  report.checks.originalRestartCallback = true;
  await t.call("runner_device", {
    action: "set",
    state: {
      battery: {
        level: 63,
        isCharging: false
      }
    }
  });
  await t.call("runner_navigate", {
    method: "navigateTo",
    url: "/packageAPI/pages/device/get-battery-info/get-battery-info"
  });
  await wait({
    kind: "element",
    selector: "wx-button"
  });
  await t.call("runner_click", {
    selector: "wx-button"
  });
  await wait({
    kind: "text",
    text: "63"
  });
  report.checks.originalBatteryCallbackAndView = true;
  await t.call("runner_debugger", {
    action: "open"
  });
  const debug = await until(() => t.app.windows().find(p => p.url().includes("js_app.html")));
  await debug.getByRole("tab", {
    name: "Wxapp",
    exact: true
  }).click();
  await debug.getByRole("combobox", {
    name: "Wxapp section"
  }).selectOption({
    label: "模拟设备"
  });
  await debug.getByText('"level": 63', {
    exact: false
  }).first().waitFor();
  report.checks.nativeF12SharedDevice = true;
  const routes = ["packageComponent/pages/view/view/view", "packageComponent/pages/form/button/button"];
  const job = await t.call("runner_suite", {
    action: "start",
    routes,
    steps: [{
      tool: "runner_screenshot",
      arguments: {}
    }]
  });
  const result = await until(async () => {
    const r = await t.call("runner_suite", {
      action: "get",
      jobId: job.id
    });
    return r.state !== "running" && r;
  }, 40000);
  assert.equal(result.state, "complete");
  assert.ok(result.results.every(r => r.status === "验收通过"), JSON.stringify(result));
  report.checks.suitePageReadiness = {
    jobId: job.id,
    passed: result.completed,
    level: "page-ready only"
  };
  const cancel = await t.call("runner_suite", {
    action: "start",
    routes: [routes[0]],
    steps: [{
      tool: "runner_wait",
      arguments: {
        kind: "text",
        text: "never-exists-suite-test",
        timeoutMs: 60000
      }
    }]
  });
  await t.call("runner_suite", {
    action: "cancel",
    jobId: cancel.id
  });
  const cancelled = await until(async () => {
    const r = await t.call("runner_suite", {
      action: "get",
      jobId: cancel.id
    });
    return r.state === "cancelled" && r;
  });
  assert.equal(cancelled.state, "cancelled");
  report.checks.suiteCancellation = true;
  report.status = "验收通过";
} catch (e) {
  report.status = "失败";
  report.error = e.message;
  throw e;
} finally {
  fs.writeFileSync("docs/device-suite-result.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  await t.close();
}
