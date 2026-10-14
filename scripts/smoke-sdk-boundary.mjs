import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const out = path.resolve(".local/loader-convergence-20260912/sdk-boundary");
fs.mkdirSync(out, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-boundary-"));
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
let t;
try {
  t = await managedFixture({ packageDir: pkg });
  const evaluate = async (expression, target = "logic") => {
    const r = await t.call("runner_evaluate", {
      expression,
      targetId:
        target === "logic"
          ? "logic"
          : "page:" + (await t.call("runner_status")).current.id,
      awaitPromise: true,
    });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result?.value;
  };
  const describe = `(w=>{const r=w.getRecorderManager(),l=w.getRealtimeLogManager();return {recorder:typeof r.start,sameRecorder:r===w.getRecorderManager(),recorderOn:typeof r.onError,recorderOff:typeof r.offError,logger:typeof l.info,sameLogger:l===w.getRealtimeLogManager(),memoryListener:typeof w.onMemoryWarning}})`;
  const factories = await evaluate(describe + "(wx)");
  const original = await evaluate(
    describe + "(internals.__appServiceSDK__.wx)",
  );
  assert.deepEqual(factories, original);
  assert.equal(factories.recorder, "function");
  assert.equal(factories.logger, "function");
  assert.deepEqual(
    await evaluate(
      "({available:wx.canIUse('getRecorderManager'),dom:typeof document})",
    ),
    { available: false, dom: "undefined" },
  );
  // Exercise the real manager error event instead of a generic wx.* callback.
  const managerError = await evaluate(
    `new Promise(resolve=>{const r=wx.getRecorderManager();let hits=0;const handler=e=>{hits++;r.offError?.(handler);resolve({hits,message:e.errMsg})};r.onError(handler);r.start({duration:1000});})`,
  );
  assert.equal(managerError.hits, 1);
  assert.match(managerError.message, /fail/);
  for (const target of ["logic", "view"]) {
    const bridge =
      target === "logic" ? "internals.WeixinJSBridge" : "WeixinJSBridge";
    const r = await evaluate(
      `new Promise(resolve=>${bridge}.invoke('setRunnerBoundaryFixture',{},resolve))`,
      target,
    );
    assert.match(r.errMsg, /fail/);
    assert.equal(r.runnerCode, "NATIVE_API_UNIMPLEMENTED");
  }
  const status = await until(async () => {
    const s = await t.call("runner_status");
    return (
      s.loader?.nativeBoundary?.entries.filter(
        (r) => r.api === "setRunnerBoundaryFixture",
      ).length === 2 && s
    );
  });
  assert.equal(status.serviceReady, true);
  assert.ok(
    !status.loader.nativeBoundary.entries.some(
      (r) => r.api === "initRenderDone",
    ),
  );
  const result = {
    passed: true,
    date: new Date().toISOString(),
    factories,
    managerError,
    logicAndViewFailExplicitly: true,
    inventoryVisibleViaMcp: true,
  };
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (e) {
  fs.writeFileSync(path.join(out, "failed.log"), t?.logs.join("") || "");
  throw e;
} finally {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
