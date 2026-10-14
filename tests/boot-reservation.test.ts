import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { prepareBootAnalysis, installBootAnalysis } from "../src/analysis/boot";

const cfg = {
  enabled: true,
  defeatAntiHook: true,
  cryptoTap: true,
  ttlMs: 3000,
  taps: [
    { target: "String.prototype.charCodeAt", algo: "charCodeAt", count: 5 },
    { target: "String.fromCharCode", algo: "fromCharCode", count: 5 },
    { target: "encodeURIComponent", algo: "encodeURIComponent", count: 5 },
  ],
};
test("pre-baselib reservation survives plugin-style getter hardening without evaluating getters or touching ordinary objects", () => {
  const c = vm.createContext({ setTimeout, clearTimeout });
  const evalIn = (s: string) => vm.runInContext(s, c);
  evalIn(
    "globalThis.define=function(){};globalThis.getterCalls=0;globalThis.ordinary={value:7};globalThis.originalChar=String.prototype.charCodeAt;",
  );
  const reservation = prepareBootAnalysis(c, cfg)!;
  evalIn(
    `var nativeD=Object.defineProperty;function harden(obj,name){var d=Object.getOwnPropertyDescriptor(obj,name);nativeD(obj,name,{get(){getterCalls++;return d.value},set(){},enumerable:d.enumerable,configurable:false});}harden(Object,'freeze');harden(Object,'defineProperty');harden(String.prototype,'charCodeAt');harden(String,'fromCharCode');harden(globalThis,'encodeURIComponent');harden(globalThis,'define');harden(ordinary,'value');Object.freeze(String.prototype);Object.freeze(ordinary);`,
  );
  const preparation = reservation.finish();
  assert.equal(preparation.skippedAccessors, 6);
  assert.equal(evalIn("getterCalls"), 0);
  assert.equal(
    evalIn('Object.getOwnPropertyDescriptor(ordinary,"value").configurable'),
    false,
  );
  assert.equal(evalIn("Object.isFrozen(ordinary)"), true);
  installBootAnalysis(c, cfg, preparation);
  try {
    evalIn(
      `Object.defineProperty(String.prototype,'nv_charCodeAt',{value:String.prototype.charCodeAt});Object.freeze(String.prototype);globalThis.uriAlias=encodeURIComponent;`,
    );
    assert.equal(evalIn(`String.prototype.nv_charCodeAt.call('AB',1)`), 66);
    assert.equal(evalIn(`uriAlias('中文')`), "%E4%B8%AD%E6%96%87");
    const entries = evalIn("__wxappBootAnalysisV1.read({limit:100}).entries");
    assert.ok(
      entries.some(
        (e: any) =>
          e.algo === "charCodeAt" && e.thisArg === "AB" && e.output === 66,
      ),
    );
    assert.ok(
      entries.some(
        (e: any) => e.algo === "encodeURIComponent" && e.input === "中文",
      ),
    );
    evalIn('__wxappBootAnalysisV1.command({action:"stop"})');
    assert.equal(evalIn("String.prototype.charCodeAt===originalChar"), true);
    const cursor = evalIn("__wxappBootAnalysisV1.status().latestCursor");
    assert.equal(evalIn(`String.prototype.nv_charCodeAt.call('AB',0)`), 65);
    assert.equal(evalIn("__wxappBootAnalysisV1.status().latestCursor"), cursor);
  } finally {
    evalIn('__wxappBootAnalysisV1.command({action:"stop"})');
  }
});
test("reservation is opt-in and a too-late installation returns a diagnosable failed analysis status", () => {
  const c = vm.createContext({ setTimeout, clearTimeout });
  assert.equal(prepareBootAnalysis(c, { enabled: true }), undefined);
  assert.equal(
    prepareBootAnalysis(c, { enabled: false, defeatAntiHook: true }),
    undefined,
  );
  vm.runInContext(
    `var original=Object.freeze;Object.defineProperty(Object,'freeze',{get(){return original},set(){},configurable:false});`,
    c,
  );
  assert.throws(() => installBootAnalysis(c, cfg), /accessor 'freeze'/);
  const status = vm.runInContext("__wxappBootAnalysisV1.status()", c);
  assert.equal(status.enabled, false);
  assert.equal(status.state, "failed");
  assert.equal(status.initializationFailure.code, "ACCESSOR_TARGET");
  assert.equal(status.taps.length, 0);
});
