// Explicit real-service read-only regression. Never writes code, openid, token or raw bodies to reports.
import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const configFile = process.argv[2];
if (!configFile) throw Error("Pass the private wxbot config file explicitly");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  status: "已实现未验收",
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(),
  realService: true,
  remoteWrites: false,
  checks: {}
};
const t = await managedFixture({
  packageDir: path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })())),
  appid: report.appid,
  config
});
const value = async expression => (await t.call("runner_evaluate", {
  expression
})).result.value;
const wait = async args => {
  const r = await t.call("runner_wait", args);
  assert.equal(r.status, "matched", JSON.stringify(r));
  return r;
};
try {
  report.checks.realSdk = await value(`({cloud:typeof wx.cloud,database:typeof wx.cloud.database,uploadFile:typeof wx.cloud.uploadFile})`);
  assert.equal(report.checks.realSdk.database, "function");
  await value(`globalThis.__accountProbe={};wx.login({success:r=>__accountProbe.login=typeof r.code==='string'&&!!r.code,fail:e=>__accountProbe.login=false});wx.getUserInfo({success:r=>__accountProbe.userInfo=!!r.userInfo&&typeof r.rawData==='string',fail:e=>__accountProbe.userInfo=false});true`);
  const account = await until(async () => {
    const r = await value("__accountProbe");
    return r.login !== undefined && r.userInfo !== undefined && r;
  }, 40000);
  report.checks.account = account;
  assert.equal(account.login, true);
  assert.equal(account.userInfo, true);
  await t.call("runner_navigate", {
    method: "navigateTo",
    url: "/packageCloud/pages/user/user-authentication/user-authentication"
  });
  await wait({
    kind: "text",
    text: "获取 OpenID"
  });
  await t.call("runner_debugger", {
    action: "open"
  });
  const debug = await until(() => t.app.windows().find(p => p.url().includes("js_app.html")));
  await debug.getByRole("tab", {
    name: "Wxapp",
    exact: true
  }).click();
  const start = Date.now();
  const input = await t.call("runner_click", {
    text: "获取 OpenID"
  });
  report.checks.input = {
    durationMs: Date.now() - start,
    receipt: input.receipt,
    status: input.status
  };
  await until(async () => await value(`!!getCurrentPages().at(-1).data.openid && !getCurrentPages().at(-1).data.loading`), 40000);
  // View inspection returns only a boolean; the displayed identifier is never emitted.
  await wait({
    kind: "element",
    selector: ".openid"
  });
  const targetId = "page:" + (await t.call("runner_status")).current.id;
  assert.ok(targetId);
  const rendered = await t.call("runner_evaluate", {
    targetId,
    expression: `!!document.querySelector('.openid')?.textContent.trim()`
  });
  report.checks.originalPageRendered = rendered.result.value;
  assert.equal(rendered.result.value, true);
  const requests = await t.call("runner_network", {
    limit: 100
  });
  const botRequests = requests.filter(r => String(r.url).includes("/miniprogram/operatewxdata"));
  report.checks.operateRequestCount = botRequests.length;
  assert.ok(botRequests.length);
  const last = botRequests.at(-1);
  const first = await t.call("runner_network", {
      id: last.id
    }),
    second = await t.call("runner_network", {
      id: last.id
    });
  report.checks.repeatableBody = JSON.stringify(first.responseBody) === JSON.stringify(second.responseBody);
  assert.ok(report.checks.repeatableBody);
  report.checks.noMock = (await t.call("runner_network_rules")).rules.every(r => !r.enabled);
  assert.ok(report.checks.noMock);
  report.status = "验收通过";
} catch (e) {
  report.status = "失败";
  report.error = String(e.message).replace(/(?:o[a-zA-Z0-9_-]{20,}|[a-f0-9]{32,})/g, "[REDACTED]");
  throw e;
} finally {
  fs.writeFileSync("docs/cloud-readonly-result.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  await t.close();
}
