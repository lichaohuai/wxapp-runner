import { managedFixture, until } from "./managed-test-runtime.mjs";
import { componentFixture } from "./component-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-panel-"));
const t = await managedFixture({
  packageDir: componentFixture(directory, "glass-easel"),
});
const { call } = t;
let debug;
try {
  await call("runner_wait", { kind: "text", text: "nested:child:1" });
  const state = await call("runner_state");
  const leaf = state.instances.find((i) => i.is === "leaf");
  await call("runner_debugger", { action: "open" });
  debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Wxapp", exact: true }).click();
  const section = debug.getByRole("combobox", { name: "Wxapp section" });
  await debug
    .getByRole("button", { name: "选择此实例", exact: true })
    .first()
    .waitFor();
  const boundary = await call('runner_evaluate', {expression:"new Promise(resolve=>internals.WeixinJSBridge.invoke('setPanelNativeFixture',{},resolve))",awaitPromise:true});
  assert.equal(boundary.result.value.runnerCode,'NATIVE_API_UNIMPLEMENTED');
  await section.selectOption({label:'加载链路'});
  await debug.getByRole('checkbox',{name:'自动刷新',exact:true}).check();
  await debug.getByText('宿主能力缺口（实际调用）',{exact:true}).waitFor();
  await debug.getByText('"api": "setPanelNativeFixture"',{exact:false}).first().waitFor();
  await debug.getByRole('checkbox',{name:'自动刷新',exact:true}).uncheck();
  const gaps=(await call('runner_status')).loader.nativeBoundary;
  assert.equal(gaps.entries.find(r=>r.api==='setPanelNativeFixture').calls,1);
  fs.mkdirSync('docs/evidence/loader-convergence-2026-09-12',{recursive:true});
  await debug.screenshot({path:'docs/evidence/loader-convergence-2026-09-12/native-boundary-panel.png'});
  await section.selectOption({label:"小程序包"});
  await debug.getByRole("button",{name:"搜索小程序",exact:true}).waitFor();
  await debug.getByText('"scope": "package-library"',{exact:false}).first().waitFor();
  await section.selectOption({label:"状态"});
  await debug.getByRole("button",{name:"选择此实例",exact:true}).first().waitFor();
  await debug.getByRole("textbox", { name: "搜索", exact: true }).fill("leaf");
  await debug
    .getByRole("button", { name: "选择此实例", exact: true })
    .first()
    .waitFor();
  await debug
    .getByRole("textbox", { name: "instanceId", exact: true })
    .fill(leaf.id);
  await debug
    .getByRole("textbox", { name: "setData JSON", exact: true })
    .fill('{"count":77}');
  await debug
    .getByRole("button", { name: "提交 setData", exact: true })
    .click();
  assert.equal(
    (await call("runner_wait", { kind: "text", text: "nested:child:77" }))
      .status,
    "matched",
  );
  await debug.getByRole("textbox", { name: "搜索", exact: true }).fill("");
  await section.selectOption({ label: "存储" });
  await debug
    .getByRole("textbox", { name: "storage key", exact: true })
    .fill("panel-test");
  await debug
    .getByRole("textbox", { name: "storage JSON value", exact: true })
    .fill('"面板写入"');
  await debug.getByRole("button", { name: "写入", exact: true }).click();
  await until(
    async () =>
      (await call("runner_storage", { action: "get", key: "panel-test" }))
        .entries["panel-test"] === "面板写入",
  );
  await section.selectOption({ label: "DOM" });
  await debug
    .getByRole("textbox", { name: "CSS selector", exact: true })
    .fill('[id="leaf-button"],[id$="--leaf-button"]');
  await debug.getByRole("button", { name: "inspect", exact: true }).click();
  await debug
    .getByText('"framework": "glass-easel"', { exact: false })
    .first()
    .waitFor();
  await section.selectOption({ label: "网络规则" });
  await debug
    .getByRole("textbox", { name: "规则 JSON（默认关闭）", exact: true })
    .fill('{"action":"block","match":{"urlIncludes":"/panel-fixture-rule"}}');
  await debug.getByRole("button", { name: "保存规则", exact: true }).click();
  const rule = await until(async () =>
    (await call("runner_network_rules")).rules.find(
      (r) => r.match.urlIncludes === "/panel-fixture-rule",
    ),
  );
  assert.equal(rule.enabled, false);
  await section.selectOption({ label: "分析产物" });
  await debug.getByRole("button", { name: "启动 cpu", exact: true }).click();
  const job = await until(async () =>
    (await call("runner_profile")).jobs.find(
      (j) => j.kind === "cpu" && j.state === "running",
    ),
  );
  await debug.getByRole("textbox", { name: "jobId", exact: true }).fill(job.id);
  await debug.getByRole("button", { name: "停止分析", exact: true }).click();
  await until(
    async () =>
      (await call("runner_profile", { action: "get", jobId: job.id })).state ===
      "complete",
  );
  const old = (await call("runner_status")).sessionId;
  await section.selectOption({ label: "运行实例" });
  await debug.getByRole("button", { name: "restart", exact: true }).click();
  await until(async () => {
    const s = await call("runner_status");
    return s.sessionId !== old && s.serviceReady && s.current?.ready;
  });
  await debug
    .getByRole("tab", { name: "Wxapp", exact: true })
    .waitFor({ state: "visible" });
  await debug.getByRole("tab", { name: "Wxapp", exact: true }).click();
  await debug
    .getByRole("button", { name: "选择此实例", exact: true })
    .first()
    .waitFor();
  await debug.screenshot({ path: "docs/native-wxapp-panel.png" });
  const result = {
    passed: true,
    platform: process.platform,
    nativePanel: true,
    nativeBoundarySharedWithMcp: true,
    packageLibrarySharedService: true,
    searchableRealInstances: true,
    setDataRendered: true,
    storageSharedWithMcp: true,
    domInspection: true,
    disabledRulesEditor: true,
    profileControls: true,
    runtimeRestartAndFrontendRebind: true,
  };
  fs.writeFileSync(
    "docs/wxapp-panel-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (e) {
  if (debug)
    fs.writeFileSync(
      "/tmp/wxapp-panel-ui.txt",
      await debug.locator("body").ariaSnapshot(),
    );
  console.error(t.logs.join("").slice(-4000));
  throw e;
} finally {
  await t.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
