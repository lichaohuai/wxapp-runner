import test from "node:test";
import assert from "node:assert/strict";
import { inspectorFunctionLocation } from "../src/analysis/function-location";

test("function location follows Inspector proxy and bound identities to the real compiled function", async () => {
  const location = { scriptId: "4", lineNumber: 17, columnNumber: 62 };
  const internal = (name: string, value: any) => ({
    internalProperties: [{ name, value }],
  });
  const objects: Record<string, any> = {
    proxy: internal("[[Target]]", { objectId: "bound" }),
    bound: internal("[[TargetFunction]]", { objectId: "bound2" }),
    bound2: internal("[[BoundTargetFunction]]", { objectId: "original" }),
    original: internal("[[FunctionLocation]]", { value: location }),
  };
  const r = await inspectorFunctionLocation("proxy", async (id) => objects[id]);
  assert.deepEqual(r.location, location);
  assert.deepEqual(r.wrappers, [
    "[[Target]]",
    "[[TargetFunction]]",
    "[[BoundTargetFunction]]",
  ]);
});

test("opaque, cyclic and excessively nested Inspector objects have bounded explicit failure", async () => {
  const opaque = await inspectorFunctionLocation("native", async () => ({
    result: [{ name: "toString", value: { description: "fake source" } }],
  }));
  assert.equal(opaque.location, undefined);
  assert.match(opaque.reason!, /did not provide/);
  const cyclic = await inspectorFunctionLocation("cycle", async () => ({
    internalProperties: [{ name: "[[Target]]", value: { objectId: "cycle" } }],
  }));
  assert.match(cyclic.reason!, /cycle/);
  let calls = 0;
  const deep = await inspectorFunctionLocation("0", async () => ({
    internalProperties: [
      { name: "[[TargetFunction]]", value: { objectId: String(++calls) } },
    ],
  }));
  assert.equal(calls, 8);
  assert.match(deep.reason!, /depth limit/);
});
