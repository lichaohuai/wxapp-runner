import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { managedFixture } from "./managed-test-runtime.mjs";
const samples = [{
  packageDir: "../package",
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()
}, {
  packageDir: "../package-" + (process.env.WXAPP_TEST_APPID_2 || (() => {
    throw new Error("Set WXAPP_TEST_APPID_2 to the AppID for your authorized test package");
  })()),
  appid: process.env.WXAPP_TEST_APPID_2 || (() => {
    throw new Error("Set WXAPP_TEST_APPID_2 to the AppID for your authorized test package");
  })()
}, {
  packageDir: "../package-" + (process.env.WXAPP_TEST_APPID_3 || (() => {
    throw new Error("Set WXAPP_TEST_APPID_3 to the AppID for your authorized test package");
  })()),
  appid: process.env.WXAPP_TEST_APPID_3 || (() => {
    throw new Error("Set WXAPP_TEST_APPID_3 to the AppID for your authorized test package");
  })()
}];
const rows = [];
for (const sample of samples) {
  const t = await managedFixture({
    ...sample,
    config: {
      loaderAdapter: "official"
    }
  });
  try {
    const s = await t.call("runner_status");
    assert.equal(s.loaderAdapter, "official");
    assert.ok(s.loaderProvenance.sha256);
    const visible = await t.call("runner_wait", {
      kind: "element",
      selector: "wx-view,wx-text,wx-button,wx-scroll-view",
      stableMs: 0
    });
    assert.equal(visible.status, "matched");
    const screenshot = await t.client.callTool({
      name: "runner_screenshot",
      arguments: {}
    });
    assert.ok(screenshot.content.some(c => c.type === "image"));
    rows.push({
      appid: sample.appid,
      route: s.current.route,
      serviceReady: s.serviceReady,
      framework: JSON.parse(fs.readFileSync(path.join(sample.packageDir, "app-config.json"))).componentFramework,
      bootstrapAndVisiblePage: true,
      businessFlowTested: false
    });
    console.log(rows.at(-1));
  } finally {
    await t.close();
  }
}
fs.writeFileSync("docs/official-adapter-result.json", JSON.stringify({
  date: new Date().toISOString(),
  platform: process.platform,
  status: "验收通过",
  rows
}, null, 2) + "\n");
