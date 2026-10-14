// Real, unmodified compiled official demo; no wxbot credentials or API mocks.
import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const packageDir = path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
  throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
})()));
function fingerprint() {
  const hash = createHash("sha256");
  let files = 0;
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) visit(file);else {
        hash.update(path.relative(packageDir, file));
        hash.update(fs.readFileSync(file));
        files++;
      }
    }
  }
  visit(packageDir);
  return {
    sha256: hash.digest("hex"),
    files
  };
}
const before = fingerprint();
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(),
  passed: false,
  package: before,
  routes: [],
  checks: {},
  accountConfigurationUsed: false
};
const t = await managedFixture({
  packageDir,
  appid: report.appid
});
const {
  call
} = t;
async function screenshot(name) {
  const result = await t.client.callTool({
    name: "runner_screenshot",
    arguments: {}
  });
  assert.ok(!result.isError);
  const img = result.content.find(c => c.type === "image");
  assert.ok(img);
  fs.writeFileSync(".local/official-demo-" + name + ".png", Buffer.from(img.data, "base64"));
}
async function recordRoute(route) {
  await call("runner_wait", {
    kind: "route",
    route
  });
  await until(async () => (await call("runner_state")).pages.some(p => p.route === route));
  report.routes.push((await call("runner_status")).current);
}
try {
  await call("runner_wait", {
    kind: "element",
    selector: "#view"
  });
  await recordRoute("page/component/index");
  const info = (await call("runner_evaluate", {
    expression: `({renderer:getCurrentPages()[0].renderer,declared:__wxConfig.page['page/component/index.html'].window.renderer,noDOM:typeof document==='undefined',skyline:wx.getSkylineInfoSync()})`
  })).result.value;
  assert.equal(info.renderer, "webview");
  assert.equal(info.declared, "skyline");
  assert.equal(info.noDOM, true);
  assert.equal(info.skyline.isSupported, false);
  report.checks.runtimeRenderer = info;
  await screenshot("home");
  const beforeClick = (await call("runner_events", {
    limit: 1
  })).latestId;
  const click = await call("runner_click", {
    selector: "#view"
  });
  await call("runner_wait", {
    kind: "element",
    selector: ".navigator-box-show wx-navigator",
    stableMs: 300
  });
  assert.equal((await call("runner_evaluate", {
    expression: "getCurrentPages()[0].data.list[0].open"
  })).result.value, true);
  report.checks.originalHandlerAndSetData = true;
  const trace = [];
  let cursor = beforeClick;
  // Filtered pages still advance across other events: empty is not EOF.
  for (let page = 0; page < 100; page++) {
    const result = await call("runner_trace", {
      operationId: click.operationId,
      after: cursor,
      limit: 200
    });
    trace.push(...result.entries);
    cursor = result.nextCursor;
    if (!result.hasMore) break;
  }
  report.checks.traceAvailable = JSON.stringify(trace).includes("kindToggle");
  assert.ok(report.checks.traceAvailable);
  await call("runner_click", {
    text: "view"
  });
  await recordRoute("packageComponent/pages/view/view/view");
  await call("runner_wait", {
    kind: "text",
    text: "flex-direction"
  });
  await screenshot("view");
  report.checks.realNavigatorToSubpackage = true;
  await call("runner_navigate", {
    method: "navigateBack"
  });
  await recordRoute("page/component/index");
  assert.equal((await call("runner_evaluate", {
    expression: "getCurrentPages()[0].data.list[0].open"
  })).result.value, true);
  report.checks.backPreservesOriginalPage = true;
  await call("runner_navigate", {
    method: "switchTab",
    url: "/page/API/index"
  });
  await recordRoute("page/API/index");
  await call("runner_wait", {
    kind: "text",
    text: "接口"
  });
  await call("runner_navigate", {
    method: "switchTab",
    url: "/page/component/index"
  });
  await recordRoute("page/component/index");
  await call("runner_debugger", {
    action: "open"
  });
  const debug = await until(() => t.app.windows().find(p => p.url().includes("js_app.html")));
  await debug.getByRole("tab", {
    name: "Wxapp",
    exact: true
  }).click();
  await debug.getByText('"effectiveRenderer": "webview"', {
    exact: false
  }).first().waitFor();
  await debug.getByText('"declaredRenderer": "skyline"', {
    exact: false
  }).first().waitFor();
  report.checks.nativeWxappPanelWithRenderer = true;
  // Observation remains connected after a human DevTools window opens.
  assert.equal((await call("runner_status")).current.ready, true);
  assert.ok((await call("runner_snapshot")).text.includes("视图容器"));
  report.checks.f12AndStandardMcpCoexist = true;
  assert.ok(!t.logs.join("").includes("UNIMPLEMENTED: native.createLoadSubPackageTask"));
  assert.ok(!t.logs.join("").includes('"code":"DYNAMIC_SCRIPT_MISSING"'));
  report.checks.localAsyncSubpackageAndViewAliases = true;
  assert.equal((await call("runner_evaluate", {
    expression: "typeof wx.worklet"
  })).result.value, "undefined");
  report.checks.workletCapabilityAbsent = true;
  report.inputsUnchanged = fingerprint().sha256 === before.sha256;
  assert.ok(report.inputsUnchanged);
  report.passed = true;
} catch (e) {
  report.error = e.message;
  report.diagnostics = [];
  for (let after = 0, page = 0; page < 100; page++) {
    const recent = await call("runner_logs", {
      source: "bridge",
      after,
      limit: 200
    });
    report.diagnostics.push(...recent.entries);
    after = recent.nextCursor;
    if (!recent.hasMore) break;
  }
  await screenshot("failure").catch(() => {});
  throw e;
} finally {
  fs.writeFileSync("docs/official-demo-runtime-result.json", JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(".local/official-demo-runtime.log", t.logs.join(""), {
    mode: 0o600
  });
  console.log(JSON.stringify(report));
  await t.close();
}
