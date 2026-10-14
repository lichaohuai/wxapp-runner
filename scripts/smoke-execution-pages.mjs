import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-slice-pages-"));
let t;
try {
  const pkg = interactionFixture(root, "http://127.0.0.1:1/unused");
  fs.appendFileSync(
    path.join(pkg, "app-service.js"),
    '\ndefine("slice-fixture.js",function(require,module,exports){exports.run=function(){var total=0;for(var i=0;i<800;i++)total+=i;return total;};});getApp().sliceFixture=require("slice-fixture.js");',
  );
  t = await managedFixture({
    packageDir: pkg,
    config: {
      analysis: {
        enabled: true,
        networkMode: "local-only",
        execution: {
          enabled: true,
          files: ["app-service.js"],
          modules: ["slice-fixture.js"],
          capacity: 30000,
        },
      },
    },
  });
  await t.call("runner_execution", { action: "start", maxEvents: 30000 });
  const r = await t.call("runner_evaluate", {
    expression: "getApp().sliceFixture.run()",
  });
  assert.equal(r.result.value, (799 * 800) / 2);
  await t.call("runner_execution", { action: "stop" });
  const status = await t.call("runner_execution", { action: "status" }),
    sink = status.latestCursor;
  const observer = await t.newClient();
  const first = await t.call("runner_execution", {
    action: "explain",
    eventId: sink,
    paged: true,
    maxNodes: 100,
    fields: ["kind", "deps"],
  });
  const again = await t.callAs(observer, "runner_execution", {
    action: "explain",
    sliceCursor: first.sliceCursor,
    fields: ["kind", "deps"],
  });
  assert.deepEqual(first, again);
  await t.call("runner_debugger", { action: "open" });
  const debug = await until(() =>
    t.app.windows().find((p) => p.url().includes("js_app.html")),
  );
  await debug.getByRole("tab", { name: "Wxapp", exact: true }).click();
  await debug
    .getByRole("combobox", { name: "Wxapp section" })
    .selectOption({ label: "执行反虚拟化" });
  await debug
    .getByRole("textbox", { name: "切片终点事件 ID", exact: true })
    .fill(String(sink));
  await debug
    .getByRole("button", { name: "开始分页切片", exact: true })
    .click();
  await debug.getByText('"pageIndex": 0', { exact: false }).first().waitFor();
  await debug
    .getByRole("button", { name: "读取下一页切片", exact: true })
    .click();
  await debug.getByText('"pageIndex": 1', { exact: false }).first().waitFor();
  const continued = await t.callAs(observer, "runner_execution", {
    action: "explain",
    sliceCursor: first.nextSliceCursor,
    fields: ["kind", "deps"],
  });
  assert.equal(continued.pageIndex, 1);
  assert.equal(
    (await t.call("runner_execution", { action: "status" })).latestCursor,
    sink,
  );
  console.log(
    JSON.stringify({
      passed: true,
      platform: process.platform,
      nativeWxappPanel: true,
      mcpClients: 2,
      sharedPageRepeat: true,
      uiPages: [0, 1],
      businessInvocations: 1,
      readOnlyControls: true,
    }),
  );
} finally {
  await t?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
