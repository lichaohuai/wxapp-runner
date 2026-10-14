import { managedFixture, until } from "./managed-test-runtime.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WebSocket } from "ws";

// Each launch uses a new isolated profile. Repeated trials exercise the startup
// race; no failed evaluation is retried, and no real business package is used.
const launches = 4;
const hitsPerLaunch = 5;
for (let launch = 0; launch < launches; launch++) {
  const t = await managedFixture();
  const { call } = t;
  try {
    await call("runner_evaluate", {
      expression:
        "globalThis.pauseFixture = function pauseFixture(n) {\n return n + 1;\n};\n//# sourceURL=wxapp-pause-stability.js",
    });
    const bp = await call("runner_debugger", {
      action: "setBreakpoint",
      url: "wxapp-pause-stability.js",
      line: 2,
      column: 2,
      condition: "n === 2",
    });
    assert.ok(bp.locations.length);
    for (let hit = 0; hit < hitsPerLaunch; hit++) {
      assert.equal(
        (await call("runner_evaluate", { expression: "pauseFixture(1)" }))
          .result.value,
        2,
      );
      const evaluation = call("runner_evaluate", {
        expression: "pauseFixture(2)",
      });
      evaluation.catch(() => {});
      const paused = await until(
        async () => (await call("runner_debugger", { action: "state" })).paused,
      );
      assert.ok(paused.hitBreakpoints.includes(bp.breakpointId));
      if (launch === 0 && hit === 0) {
        // Deliberately hold a breakpoint beyond the former five-second V8
        // execution deadline. This is a timeout-boundary test, not a UI wait.
        await new Promise((resolve) => setTimeout(resolve, 5500));
        assert.equal((await call("runner_status")).state, "running");
        assert.ok((await call("runner_debugger", { action: "state" })).paused);
      }
      assert.equal(
        (
          await call("runner_evaluate", {
            expression: "n",
            callFrameId: paused.callFrames[0].callFrameId,
          })
        ).result.value,
        2,
      );
      await call("runner_debugger", { action: "resume" });
      assert.equal((await evaluation).result.value, 3);
    }
    await call("runner_debugger", {
      action: "removeBreakpoint",
      breakpointId: bp.breakpointId,
    });
    if (launch === 0) {
      const socket = new WebSocket((await call("runner_status")).devtoolsUrl);
      const pending = new Map();
      const contexts = [];
      let sequence = 0;
      socket.on("message", (data) => {
        const m = JSON.parse(String(data));
        if (m.method === "Runtime.executionContextCreated")
          contexts.push(m.params.context);
        if (pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          clearTimeout(p.timer);
          m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
        }
      });
      const raw = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(Error("Native protocol timeout"));
          }, 10000);
          pending.set(id, { resolve, reject, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      try {
        await new Promise((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        await raw("Runtime.enable");
        const context = contexts.find((c) =>
          c.name.startsWith("Mini-program business"),
        );
        assert.ok(context?.uniqueId);
        const evaluate = (expression, options = {}) =>
          raw("Runtime.evaluate", {
            expression,
            uniqueContextId: context.uniqueId,
            replMode: true,
            returnByValue: true,
            awaitPromise: true,
            ...options,
          });
        assert.equal(
          (
            await evaluate(
              "let nativeReplValue = await Promise.resolve(17); nativeReplValue",
            )
          ).result.value,
          17,
        );
        assert.equal(
          (await evaluate("let nativeReplValue = 19; nativeReplValue")).result
            .value,
          19,
        );
        const promise = (
          await evaluate("Promise.resolve(23)", {
            awaitPromise: false,
            returnByValue: false,
          })
        ).result;
        assert.equal(promise.className, "Promise");
        assert.equal(
          (
            await raw("Runtime.awaitPromise", {
              promiseObjectId: promise.objectId,
              returnByValue: true,
            })
          ).result.value,
          23,
        );
        await raw("Runtime.releaseObject", { objectId: promise.objectId });
        assert.equal((await evaluate("23n")).result.unserializableValue, "23n");
        assert.ok(
          (await evaluate("throw new Error('scheduled-native-error')"))
            .exceptionDetails,
        );
      } finally {
        socket.close();
        for (const p of pending.values()) clearTimeout(p.timer);
      }
    }
    assert.equal((await call("runner_status")).state, "running");
  } catch (error) {
    console.error("stability-failure", {
      launch,
      status: await call("runner_status").catch(() => null),
    });
    console.error(t.logs.join(""));
    throw error;
  } finally {
    await t.close();
  }
}
const result = {
  passed: true,
  platform: process.platform,
  isolatedLaunches: launches,
  conditionalBreakpointHits: launches * hitsPerLaunch,
  manualPauseBeyondFormerExecutionTimeout: true,
  nativeReplTopLevelAwaitAndRedeclaration: true,
  promiseIdentityAndExceptions: true,
  noEvaluationReplay: true,
};
fs.writeFileSync(
  "docs/breakpoint-stability-result.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
