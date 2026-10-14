import { test } from "node:test";
import assert from "node:assert/strict";
import { DebugState } from "../src/debug/state";
import { debugContext, copyDebug } from "../src/debug/context";

test("real-instance wrappers preserve lifecycle precedence, setData callbacks and async causality", async () => {
  const definitions: any = {};
  const events: any[] = [];
  const pages: any[] = [];
  const sub: any = {
    __wxRoute: "components/probe",
    internals: { __appServiceEngine__: { getCurrentPages: () => pages } },
  };
  for (const k of ["App", "Page", "Component"])
    sub[k] = (def: any) => ((definitions[k] = def), "registration-result");
  const observer = new DebugState(
    sub,
    (e) => events.push(e),
    () => {},
  );
  observer.install();
  let attached = 0,
    legacy = 0,
    callbacks = 0;
  const receiver: any = {
    data: { count: 0 },
    properties: { label: "中文" },
    setData(p: any, cb: any) {
      Object.assign(this.data, p);
      cb?.call(this);
      return "original-return";
    },
  };
  const original = {
    attached() {
      legacy++;
    },
    lifetimes: {
      attached() {
        attached++;
      },
    },
    methods: {
      async tap(this: any) {
        await Promise.resolve();
        assert.equal(debugContext.getStore()?.handler, "tap");
        assert.equal(
          this.setData({ count: 1 }, () => callbacks++),
          "original-return",
        );
      },
    },
  };
  assert.equal(sub.Component(original), "registration-result");
  definitions.Component.lifetimes.created.call(receiver);
  definitions.Component.lifetimes.attached.call(receiver);
  await definitions.Component.methods.tap.call(receiver);
  assert.equal(attached, 1);
  assert.equal(legacy, 0);
  assert.equal(callbacks, 1);
  assert.equal(original.methods.tap.name, "tap");
  const change = events.find((e) => e.type === "setData");
  assert.equal(change.context.handler, "tap");
  assert.equal(change.before.count, 0);
  assert.equal(events.find((e) => e.type === "data").data.count, 1);
  assert.equal(
    (observer.state({}) as any).instances[0].properties.label,
    "中文",
  );
  assert.equal(debugContext.getStore(), undefined);
  definitions.Component.lifetimes.detached.call(receiver);
  assert.equal((observer.state({}) as any).instances.length, 0);
  definitions.Component.lifetimes.attached.call(receiver);
  assert.notEqual(
    (observer.state({}) as any).instances[0].id,
    change.instanceId,
  );
});
test("debug copies retain cross-realm-shaped errors, handle cycles and mark truncation", () => {
  const cycle: any = { name: "x" };
  cycle.self = cycle;
  assert.equal(copyDebug(cycle).value.self, "[Circular]");
  const result = copyDebug({ message: "中文".repeat(100) }, 30);
  assert.equal(result.truncated, true);
  assert.ok(!result.value.message.includes("�"));
  assert.equal(
    copyDebug({ name: "Error", message: "失败", stack: "at original.js:1" })
      .value.stack,
    "at original.js:1",
  );
});

test("setData observation preserves non-callable callbacks and the original API policy", () => {
  let definition: any;
  const events: any[] = [],
    calls: any[] = [];
  const sub: any = { Page: (d: any) => (definition = d) };
  new DebugState(
    sub,
    (e) => events.push(e),
    () => {},
  ).install();
  sub.Page({});
  const receiver: any = {
    data: {},
    setData(patch: any, callback: any, extra: any) {
      calls.push({ callback, extra });
      if (
        extra === "strict" &&
        callback !== undefined &&
        typeof callback !== "function"
      )
        throw new TypeError("invalid original callback");
      Object.assign(this.data, patch);
      if (typeof callback === "function") return callback.call(this, "applied");
      return "ignored";
    },
  };
  definition.onLoad.call(receiver);
  for (const callback of [
    false,
    true,
    0,
    "options",
    null,
    { complete: true },
  ]) {
    assert.equal(receiver.setData({ value: 1 }, callback, "extra"), "ignored");
    assert.equal(calls.at(-1).callback, callback);
    assert.equal(calls.at(-1).extra, "extra");
  }
  assert.equal(events.filter((e) => e.type === "setData-applied").length, 0);
  assert.throws(
    () => receiver.setData({}, true, "strict"),
    /invalid original callback/,
  );
  let callbackCalls = 0;
  const callback = function (this: any, value: string) {
    assert.equal(this, receiver);
    assert.equal(value, "applied");
    callbackCalls++;
    return "original callback return";
  };
  Object.defineProperty(callback, "apply", { value: false });
  assert.equal(receiver.setData({}, callback), "original callback return");
  assert.equal(callbackCalls, 1);
  receiver.setData({ value: 2 });
  assert.equal(events.filter((e) => e.type === "setData-applied").length, 2);
});

test("read-only setData cannot break lifecycle and later business replacements survive cleanup", () => {
  let definition: any;
  let lifecycleCalls = 0;
  const events: any[] = [];
  const sub: any = { Page: (d: any) => (definition = d) };
  const observer = new DebugState(
    sub,
    (e) => events.push(e),
    () => {},
  );
  observer.install();
  sub.Page({
    onLoad() {
      lifecycleCalls++;
    },
    onUnload() {
      lifecycleCalls++;
    },
  });
  const original = function (this: any, patch: any) {
    Object.assign(this.data, patch);
    return "original";
  };
  const locked: any = { data: {} };
  Object.defineProperty(locked, "setData", { get: () => original });
  definition.onLoad.call(locked);
  const state = observer.state({}) as any;
  assert.equal(state.instances[0].setDataObservation.status, "unavailable");
  assert.equal(locked.setData({ value: 1 }), "original");
  assert.equal(locked.data.value, 1);
  definition.onUnload.call(locked);
  assert.equal(lifecycleCalls, 2);
  const replaceable: any = { data: {}, setData: original };
  definition.onLoad.call(replaceable);
  const replacement = () => "business replacement";
  replaceable.setData = replacement;
  definition.onUnload.call(replaceable);
  assert.equal(replaceable.setData, replacement);
  const hardened: any = { data: {}, setData: original };
  definition.onLoad.call(hardened);
  Object.freeze(hardened);
  definition.onUnload.call(hardened);
  const before = events.length;
  assert.equal(hardened.setData({ value: 2 }), "original");
  assert.equal(
    events.length,
    before,
    "detached wrappers no longer record stale instance IDs",
  );
  assert.ok(
    events.some(
      (e) => e.type === "instrumentation-unavailable" && e.phase === "restore",
    ),
  );
  assert.equal((observer.state({}) as any).instances.length, 0);
});
