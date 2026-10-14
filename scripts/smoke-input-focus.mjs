import { managedFixture, until } from "./managed-test-runtime.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
const t = await managedFixture({
  packageDir: "../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()),
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()
});
try {
  await t.call("runner_debugger", {
    action: "open"
  });
  const debug = await until(() => t.app.windows().find(w => w.url().includes("js_app.html")));
  for (let i = 0; i < 20; i++) {
    // A different process owns native DevTools. Reproduce that foreground
    // condition before every input; native DOM edits alone are insufficient.
    await debug.bringToFront();
    await until(async () => (await t.call("runner_state")).instances.some(x => x.kind === "Page" && x.data?.showTips === false));
    await t.call("runner_wait", {
      kind: "element",
      selector: "textarea",
      stableMs: 300
    });
    await t.call("runner_wait", {
      kind: "hidden",
      selector: ".loading-mask",
      timeoutMs: 30000
    });
    const text = "focus-fixture-" + i;
    try {
      await t.call("runner_input", {
        selector: "textarea",
        text
      });
    } catch (error) {
      const status = await t.call("runner_status");
      const d = await t.call("runner_evaluate", {
        targetId: "page:" + status.current.id,
        expression: `JSON.stringify(Array.from(document.querySelectorAll('textarea')).map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {field:e.outerHTML,hit:hit?.outerHTML.slice(0,1200),viewport:[innerWidth,innerHeight],box:[r.x,r.y,r.width,r.height]}}))`
      });
      console.log("input-diagnostic", i, JSON.stringify(d));
      throw error;
    }
    await until(async () => (await t.call("runner_state")).instances.some(x => x.kind === "Page" && x.data?.url === text));
    const clear = (await t.call("runner_snapshot")).elements.find(e => e.text === "清空");
    assert.ok(clear);
    await t.call("runner_wait", {
      kind: "element",
      nodeId: clear.nodeId,
      stableMs: 100
    });
    await t.call("runner_click", {
      text: "清空"
    });
    await until(async () => (await t.call("runner_snapshot")).elements.some(e => e.tag === "textarea" && e.value === ""));
    console.log("input/handler/clear", i + 1);
  }
  const report = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    iterations: 20,
    realBaselib: true,
    originalHandlerUpdatedData: true,
    clearUpdatedNativeField: true,
    nativeDevToolsCoexistence: true
  };
  fs.writeFileSync("docs/input-focus-result.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await t.close();
}
