import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { managedFixture } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-toast-hit-"));
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const frame = path.join(pkg, "page-frame.html");
fs.writeFileSync(frame, fs.readFileSync(frame, "utf8").replace(
  "n('textarea',{id:'entry'",
  "n('button',{id:'toast-target',bindtap:'held',style:'position:fixed;top:45%;left:50%;transform:translate(-50%,-50%);width:220px;height:90px;z-index:100'},['触摸测试']),n('textarea',{id:'entry'",
));
let t;
try {
  t = await managedFixture({ packageDir: pkg });
  const evaluate = async expression => {
    const r = await t.call("runner_evaluate", { expression });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result?.value;
  };
  let taps = 0;
  for (const api of ["showToast", "showLoading"]) {
    for (const mask of [false, true]) {
      await evaluate(`wx.${api}({title:'正在提示',mask:${mask},duration:60000});true`);
      assert.equal((await t.call("runner_wait", { kind: "element", selector: '[role="status"]' })).status, "matched");
      const clicked = await t.client.callTool({ name: "runner_click", arguments: { selector: "#toast-target" } });
      if (mask) {
        assert.equal(clicked.isError, true, "A masked overlay must block input");
        assert.match(JSON.stringify(clicked), /covered/);
      } else {
        assert.ok(!clicked.isError, `${api} mask:false must not intercept the page: ${JSON.stringify(clicked)}`);
        taps++;
      }
      assert.equal(await evaluate("getCurrentPages()[0].data.held"), taps, "Only delivered input may invoke the original handler");
      await evaluate(`wx.${api === "showToast" ? "hideToast" : "hideLoading"}();true`);
      assert.equal((await t.call("runner_wait", { kind: "hidden", selector: '[role="status"]' })).status, "matched");
    }
  }
  await t.call("runner_click", { selector: "#toast-target" });
  assert.equal(await evaluate("getCurrentPages()[0].data.held"), taps + 1);
  console.log(JSON.stringify({ passed: true, originalSdk: true, platform: process.platform, unmaskedClicks: 2, maskedClicksBlocked: 2, afterHideClick: true }));
} finally {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
