import { managedFixture, until } from "./managed-test-runtime.mjs";
import { componentFixture } from "./component-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const result = { passed: true, platform: process.platform, frameworks: [] };
for (const framework of ["exparser", "glass-easel"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-components-"));
  let t;
  try {
    t = await managedFixture({ packageDir: componentFixture(dir, framework) });
    const { call } = t;
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:1" }))
        .status,
      "matched",
    );
    const state = await call("runner_state");
    const leaf = state.instances.find((x) => x.is === "leaf"),
      outer = state.instances.find((x) => x.is === "outer");
    assert.equal(leaf.ownerId, outer.id);
    assert.deepEqual(leaf.domIdentity.componentPath, ["outer-one", "leaf-one"]);
    const dom = await call("runner_dom", {
      selector: '[id="leaf-button"],[id$="--leaf-button"]',
    });
    assert.equal(dom.mapping.framework, framework);
    assert.equal(dom.mapping.status, "mapped", JSON.stringify(dom.mapping));
    assert.equal(dom.mapping.instanceId, leaf.id);
    const location = await call("runner_state", {
      action: "locate",
      instanceId: leaf.id,
      selector: "#leaf-button",
    });
    assert.equal(location.dom.status, "mapped", JSON.stringify(location));
    assert.ok(location.dom.nodeId);
    assert.equal(
      (await call("runner_dom", { nodeId: location.dom.nodeId })).mapping
        .instanceId,
      leaf.id,
    );
    await call("runner_state", {
      action: "setData",
      instanceId: leaf.id,
      patch: { count: 42 },
    });
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:42" }))
        .status,
      "matched",
    );
    const ignoredCallbacks = await call("runner_evaluate", {
      expression: `(()=>{const leaf=getCurrentPages()[0].selectComponent('#outer-one').selectComponent('#leaf-one');leaf.setData({count:43},false);leaf.setData({count:44},{complete:true});return true})()`,
    });
    assert.ok(
      !ignoredCallbacks.exceptionDetails,
      JSON.stringify(ignoredCallbacks),
    );
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:44" }))
        .status,
      "matched",
    );
    const errors = (await call("runner_logs", { level: "error", limit: 200 }))
      .entries;
    assert.ok(
      !JSON.stringify(errors).includes("callback?.apply is not a function"),
    );
    await call("runner_click", { text: "toggle" });
    assert.equal(
      (
        await call("runner_wait", {
          kind: "hidden",
          selector: '[id="leaf-button"],[id$="--leaf-button"]',
        })
      ).status,
      "matched",
    );
    assert.ok(
      !(await call("runner_state")).instances.some((x) => x.id === leaf.id),
    );
    assert.equal(
      (
        await t.client.callTool({
          name: "runner_dom",
          arguments: { nodeId: location.dom.nodeId },
        })
      ).isError,
      true,
    );
    await call("runner_click", { text: "toggle" });
    assert.equal(
      (await call("runner_wait", { kind: "text", text: "nested:child:1" }))
        .status,
      "matched",
    );
    assert.notEqual(
      (await call("runner_state")).instances.find((x) => x.is === "leaf").id,
      leaf.id,
    );
    result.frameworks.push({
      framework,
      nestedOwners: true,
      bidirectionalDOM: true,
      setDataRendered: true,
      nonFunctionSetDataCallbacksPreserved: true,
      dynamicDestroyCreate: true,
      staleNodeRejected: true,
    });
  } catch (e) {
    console.error(t?.logs.join("").slice(-4000));
    throw e;
  } finally {
    await t?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
fs.writeFileSync(
  "docs/components-result.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
