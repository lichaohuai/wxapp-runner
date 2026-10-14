import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installBootAnalysis, analysisConfig } from "../src/analysis/boot";
import { targetPlan } from "../src/analysis/targets";
import { hookRuntime } from "../src/analysis/hook-runtime";
import { vmFunction } from "../src/analysis/serialize";
import { instrumentExecution } from "../src/analysis/execution/instrument";
const realm = (options: any = {}) => {
  const c = vm.createContext({ setTimeout, clearTimeout, console });
  installBootAnalysis(c, { enabled: true, ttlMs: 2000, ...options });
  return {
    c,
    eval: (s: string) => vm.runInContext(s, c),
    api: vm.runInContext("__wxappBootAnalysisV1", c),
    close: () =>
      vm.runInContext('__wxappBootAnalysisV1.command({action:"stop"})', c),
  };
};
test("controlled hooks and crypto taps restore in either order, including taps enabled after hooks", () => {
  for (const order of ["hook-first", "tap-first", "late-analysis"]) {
    const c = vm.createContext({ setTimeout, clearTimeout });
    vm.runInContext(
      "globalThis.f=function(x){return x+1};globalThis.original=f;",
      c,
    );
    if (order !== "late-analysis")
      installBootAnalysis(c, { enabled: true, ttlMs: 2000 });
    const hook = vm.runInContext(`${vmFunction(hookRuntime)}()`, c);
    let h: any;
    const addHook = () =>
      (h = hook.install({
        hookId: crypto.randomUUID(),
        plan: targetPlan("f"),
        count: 2,
        capacity: 10,
        ttlMs: 2000,
        capture: ["args", "return"],
      }));
    if (order !== "tap-first") addHook();
    if (order === "late-analysis")
      installBootAnalysis(c, { enabled: true, ttlMs: 2000 });
    const api = vm.runInContext("__wxappBootAnalysisV1", c);
    api.command({
      action: "start",
      auto: false,
      taps: [{ plan: targetPlan("f"), algo: "addition" }],
    });
    if (order === "tap-first") addHook();
    assert.equal(vm.runInContext("f(1)+f(2)", c), 5);
    assert.equal(
      hook.read(h.hookId, 0, 10).restore,
      order === "tap-first" ? "restored" : "deferred",
    );
    api.command({ action: "stop" });
    assert.equal(hook.read(h.hookId, 0, 10).restore, "restored");
    assert.equal(vm.runInContext("f===original", c), true);
  }
});
test("coordinated observers preserve an unrelated external replacement", () => {
  const r = realm();
  r.eval("globalThis.f=x=>x");
  const hook = vm.runInContext(`${vmFunction(hookRuntime)}()`, r.c);
  const h = hook.install({
    hookId: crypto.randomUUID(),
    plan: targetPlan("f"),
    count: 3,
    capacity: 10,
    ttlMs: 2000,
    capture: ["args"],
  });
  r.api.command({
    action: "start",
    auto: false,
    taps: [{ plan: targetPlan("f"), algo: "identity" }],
  });
  r.eval("globalThis.replacement=x=>x+99;f=replacement;");
  hook.remove(h.hookId);
  r.close();
  assert.equal(hook.read(h.hookId, 0, 10).restore, "conflict");
  assert.equal(r.eval("f===replacement"), true);
});
test("observed modules expose the actually executed factory and writable default export owner without reloading", () => {
  const c = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(
    "var factories={},cache={},loads=0;globalThis.define=(name,fn)=>factories[name]=fn;globalThis.require=name=>{if(!cache[name]){var m={exports:{}};factories[name](require,m,m.exports);cache[name]=m;}return cache[name].exports;}",
    c,
  );
  installBootAnalysis(c, { enabled: true, ttlMs: 2000 });
  const api = vm.runInContext("__wxappBootAnalysisV1", c);
  try {
    vm.runInContext(
      'define("same.js",function first(r,m){loads++;m.exports=x=>"first:"+x});define("same.js",function second(r,m){loads++;m.exports=x=>"second:"+x});',
      c,
    );
    assert.equal(api.moduleStatus("same.js").state, "defined");
    assert.equal(api.moduleFactory("same.js"), undefined);
    vm.runInContext('require("same.js")', c);
    assert.equal(api.moduleFactory("same.js").name, "second");
    const hook = vm.runInContext(`${vmFunction(hookRuntime)}()`, c);
    const h = hook.install({
      hookId: crypto.randomUUID(),
      plan: targetPlan({ module: "same.js", export: "" }),
      count: 1,
      ttlMs: 1000,
      capacity: 10,
      capture: ["args", "return"],
    });
    assert.equal(vm.runInContext('require("same.js")("x")', c), "second:x");
    assert.equal(hook.read(h.hookId, 0, 10).entries[0].return, "second:x");
    assert.equal(vm.runInContext("loads", c), 1);
    assert.equal(api.moduleStatus("same.js").state, "loaded");
  } finally {
    api.command({ action: "stop" });
  }
});
test("boot aliases remain dormant until explicitly armed and can be rearmed without repatching", () => {
  const r = realm({
    execution: { enabled: true },
    taps: [{ target: "String.prototype.charCodeAt", scope: "armed", count: 2 }],
  });
  try {
    r.eval(
      'globalThis.alias=String.prototype.charCodeAt;for(var i=0;i<50;i++)alias.call("startup",0)',
    );
    let tap = r.api.status().taps[0];
    assert.equal(tap.state, "installed");
    assert.equal(tap.remaining, 2);
    const execution = r.eval("__wxappExecutionV1");
    const run = execution.command({ action: "start", ttlMs: 1000 });
    r.api.command({
      action: "arm",
      tapIds: [tap.tapId],
      runId: run.runId,
      count: 2,
    });
    r.eval('alias.call("outside-context",0)');
    assert.equal(r.api.status().taps[0].remaining, 2);
    const code = instrumentExecution(
      'alias.call("ABC",0);alias.call("ABC",1);alias.call("ABC",2)',
      "fixture.js",
    ).code;
    r.eval(code);
    tap = r.api.status().taps[0];
    assert.equal(tap.state, "exhausted");
    assert.equal(tap.installed, true);
    assert.equal(r.api.status().activeTapCount, 0);
    assert.equal(
      r.api
        .read({ runId: run.runId, limit: 100 })
        .entries.filter((e: any) => e.phase === "return").length,
      2,
    );
    r.api.command({
      action: "arm",
      tapIds: [tap.tapId],
      runId: run.runId,
      count: 1,
    });
    r.eval(code);
    assert.equal(
      r.api
        .read({ runId: run.runId, limit: 100 })
        .entries.filter((e: any) => e.phase === "return").length,
      3,
    );
    r.api.command({ action: "disarm", tapIds: [tap.tapId] });
    execution.command({ action: "stop", runId: run.runId });
    assert.throws(
      () =>
        r.api.command({ action: "arm", tapIds: [tap.tapId], runId: run.runId }),
      /Start an execution run/,
    );
    r.close();
    const cursor = r.api.status().latestCursor;
    assert.equal(r.eval('alias.call("ABC",0)'), 65);
    assert.equal(r.api.status().latestCursor, cursor);
  } finally {
    r.close();
  }
});
test("execution-scoped probes do not consume boot budget, expired probes are explicit", async () => {
  const r = realm({
    ttlMs: 100,
    taps: [{ target: "String.fromCharCode", scope: "execution", count: 3 }],
  });
  try {
    r.eval("for(var i=0;i<30;i++)String.fromCharCode(65)");
    assert.equal(r.api.status().taps[0].remaining, 3);
    await new Promise((resolve) => setTimeout(resolve, 130));
    const s = r.api.status();
    assert.equal(s.state, "idle");
    assert.equal(s.activeTapCount, 0);
    assert.equal(s.taps[0].state, "expired");
    assert.equal(s.taps[0].stopReason, "expired");
    assert.throws(
      () =>
        r.api.command({
          action: "arm",
          tapIds: [s.taps[0].tapId],
          operationId: "op",
        }),
      /absent or expired/,
    );
  } finally {
    r.close();
  }
});
test("boot runs after host setup and before captured aliases, relaxes only builtins and restores aliases", () => {
  const r = realm({
    defeatAntiHook: true,
    bootScript: 'globalThis.early="ready";',
    taps: [{ target: "String.prototype.charCodeAt", algo: "charCodeAt" }],
  });
  try {
    r.eval(
      `Object.freeze(String.prototype); Object.defineProperty(String.prototype,'charCodeAt',{writable:false,configurable:false}); Reflect.defineProperty(Array.prototype,'join',{writable:false}); globalThis.nv=String.prototype.charCodeAt;globalThis.f=Object.freeze;globalThis.normal=Object.freeze({x:1});`,
    );
    assert.equal(r.eval("early"), "ready");
    assert.equal(r.eval("Object.isFrozen(normal)"), true);
    assert.equal(
      r.eval(
        'Object.getOwnPropertyDescriptor(String.prototype,"charCodeAt").writable',
      ),
      true,
    );
    assert.equal(r.eval('nv.call("ABC",1)'), 66);
    assert.ok(
      r.api.read({ limit: 100 }).entries.some((x: any) => x.output === 66),
    );
    assert.equal(
      r.api.read({ limit: 100 }).entries.find((x: any) => x.output === 66)
        .thisArg,
      "ABC",
    );
    r.close();
    const before = r.api.status().latestCursor;
    assert.equal(r.eval('nv.call("ABC",1)'), 66);
    assert.equal(r.api.status().latestCursor, before);
    assert.equal(r.eval("Object.isFrozen(f(Array.prototype))"), true);
  } finally {
    r.close();
  }
});
test("seeded Math.random reproduces across realms, leaves host randomness intact and expires", async () => {
  const original = Math.random,
    a = realm({ randomSeed: 42, ttlMs: 100 }),
    b = realm({ randomSeed: 42, ttlMs: 100 });
  try {
    assert.equal(
      a.eval("JSON.stringify([Math.random(),Math.random()])"),
      b.eval("JSON.stringify([Math.random(),Math.random()])"),
    );
    assert.equal(Math.random, original);
    a.eval("globalThis.alias=Math.random");
    await new Promise((r) => setTimeout(r, 130));
    const count = a.api.status().randomCalls;
    a.eval("alias()");
    assert.equal(a.api.status().randomCalls, count);
  } finally {
    a.close();
    b.close();
  }
});
test("known output watch captures actual input and synchronous return, count is bounded", () => {
  const r = realm({
    bootScript: 'globalThis.demo={digest(x){return "digest:"+x;}}',
  });
  try {
    const w = r.api.command({
      action: "start",
      target: "digest:中文😀",
      match: "exact",
      count: 1,
      ttlMs: 1000,
      taps: [
        {
          plan: targetPlan("demo.digest"),
          algo: "fixture-digest",
          inputIndex: 0,
        },
      ],
    });
    r.eval('demo.digest("中文😀");demo.digest("中文😀")');
    const rows = r.api.read({ watchId: w.watchId, limit: 20 }).entries;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input, "中文😀");
    assert.equal(rows[0].output, "digest:中文😀");
    assert.match(rows[0].stack, /evalmachine/);
  } finally {
    r.close();
  }
});
test("causal slices distinguish async operations with reversed completion, property writes retain values", async () => {
  const r = realm({
    bootScript:
      'globalThis.obj={header:"",digest(x){return "hash:"+x},a(x){return new Promise(resolve=>setTimeout(()=>{obj.header=obj.digest(x);resolve(obj.header)},25))},b(x){return new Promise(resolve=>setTimeout(()=>{obj.header=obj.digest(x);resolve(obj.header)},1)))}}'.replace(
        ",1)))",
        ",1))",
      ),
  });
  try {
    const prop = r.api.slice({
      action: "watchProperty",
      plan: targetPlan("obj.header"),
      ttlMs: 1000,
    });
    const a = r.api.slice({
      action: "start",
      plan: targetPlan("obj.a"),
      probes: [{ plan: targetPlan("obj.digest"), algo: "fixture-digest" }],
      count: 1,
      ttlMs: 1000,
    });
    const b = r.api.slice({
      action: "start",
      plan: targetPlan("obj.b"),
      count: 1,
      ttlMs: 1000,
    });
    await r.eval('Promise.all([obj.a("A"),obj.b("B")])');
    const ar = r.api.slice({ action: "read", runId: a.runId, limit: 100 }),
      br = r.api.slice({ action: "read", runId: b.runId, limit: 100 });
    assert.ok(
      ar.entries.some(
        (x: any) => x.kind === "property-write" && x.value === "hash:A",
      ),
    );
    assert.ok(
      br.entries.some(
        (x: any) => x.kind === "property-write" && x.value === "hash:B",
      ),
    );
    assert.ok(!ar.entries.some((x: any) => x.value === "hash:B"));
    r.api.slice({ action: "removeProperty", propertyId: prop.propertyId });
    assert.equal(r.eval("obj.header"), "hash:A");
    assert.ok(
      r.eval('Object.getOwnPropertyDescriptor(obj,"header").value') ===
        "hash:A",
    );
  } finally {
    r.close();
  }
});
test("oracle exports without execution, calls once with original receiver and never retries throws", () => {
  const r = realm({
    bootScript:
      'globalThis.obj={count:0,sign(x){this.count++;if(x==="fail")throw Error("fixture error");return "s:"+x;}}',
  });
  try {
    const o = r.api.oracle({
      action: "export",
      plan: targetPlan("obj.sign"),
      ttlMs: 1000,
    });
    assert.equal(r.eval("obj.count"), 0);
    assert.equal(
      r.api.oracle({ action: "call", oracleId: o.oracleId, args: ["ok"] })
        .result,
      "s:ok",
    );
    assert.throws(
      () =>
        r.api.oracle({ action: "call", oracleId: o.oracleId, args: ["fail"] }),
      /fixture error/,
    );
    assert.equal(r.eval("obj.count"), 2);
  } finally {
    r.close();
  }
});
test("invalid script is rejected before mutation and ordinary no-analysis realm stays unchanged", () => {
  assert.throws(() =>
    analysisConfig({ enabled: true, bootScript: "const =;" }),
  );
  const c = vm.createContext({ setTimeout, clearTimeout });
  installBootAnalysis(c, {});
  assert.equal(vm.runInContext("typeof __wxappBootAnalysisV1", c), "undefined");
  const d = vm.createContext({ setTimeout, clearTimeout });
  assert.throws(() =>
    installBootAnalysis(d, {
      enabled: true,
      randomSeed: 1,
      bootScript: 'throw Error("boot failure")',
    }),
  );
  assert.equal(
    vm.runInContext("__wxappBootAnalysisV1.status().enabled", d),
    false,
  );
});
test("real WebCrypto hashes and HMAC with opaque keys; deterministic random enforces integer views and quota", async () => {
  const r = realm({
    cryptoTap: true,
    webCrypto: true,
    observePromise: true,
    randomSeed: 9,
  });
  try {
    const hash = await r.eval(
      '(async()=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array([97,98,99])))).map(b=>b.toString(16).padStart(2,"0")).join(""))()',
    );
    assert.equal(
      hash,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const mac = await r.eval(
      '(async()=>{const key=await crypto.subtle.importKey("raw",new Uint8Array([1,2,3]),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return (await crypto.subtle.sign("HMAC",key,new Uint8Array([1]))).byteLength;})()',
    );
    assert.equal(mac, 32);
    assert.throws(() => r.eval("crypto.getRandomValues(new Float32Array(2))"));
    assert.throws(() =>
      r.eval("crypto.getRandomValues(new Uint8Array(65537))"),
    );
    r.api.command({ action: "resetRandom", seed: 9 });
    const a = r.eval(
      "JSON.stringify(Array.from(crypto.getRandomValues(new Uint8Array(8))))",
    );
    r.api.command({ action: "resetRandom", seed: 9 });
    assert.equal(
      r.eval(
        "JSON.stringify(Array.from(crypto.getRandomValues(new Uint8Array(8))))",
      ),
      a,
    );
    assert.ok(
      r.api
        .read({ limit: 100 })
        .entries.some(
          (x: any) => x.algo === "WebCrypto.digest" && x.phase === "return",
        ),
    );
  } finally {
    r.close();
  }
});
test("tap exceptions preserve original identity and observer failures do not replace a return", () => {
  const r = realm({
    bootScript:
      'globalThis.err={id:7};globalThis.obj={f(){throw err},g(){return new Proxy({},{ownKeys(){throw Error("reflection trap")}})}}',
  });
  try {
    r.api.command({
      action: "start",
      taps: [
        { plan: targetPlan("obj.f"), algo: "throw" },
        { plan: targetPlan("obj.g"), algo: "proxy" },
      ],
    });
    assert.equal(
      r.eval("(()=>{try{obj.f()}catch(e){return e===err}})()"),
      true,
    );
    assert.equal(r.eval("typeof obj.g()"), "object");
  } finally {
    r.close();
  }
});
test("module auto adapters record exported functions before caller captures an alias", () => {
  const c = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(
    "globalThis.mods={};globalThis.define=function(name,f){mods[name]=f};globalThis.require=function(name){const m={exports:{}};mods[name](require,m,m.exports);return m.exports;}",
    c,
  );
  installBootAnalysis(c, { enabled: true, cryptoTap: true, ttlMs: 1000 });
  try {
    vm.runInContext(
      'define("utils/sm3.js",function(r,m,e){m.exports=function(x){return "fixture-sm3:"+x;}});globalThis.alias=require("utils/sm3.js");alias("a")',
      c,
    );
    assert.ok(
      vm.runInContext(
        '__wxappBootAnalysisV1.read({limit:100}).entries.some(x=>x.algo==="module:utils/sm3.js"&&x.output==="fixture-sm3:a")',
        c,
      ),
    );
  } finally {
    vm.runInContext('__wxappBootAnalysisV1.command({action:"stop"})', c);
  }
});
test("a tap stops at its hit budget and restoring a watched property preserves a later replacement", () => {
  const r = realm({ bootScript: "globalThis.obj={value:1,f(x){return x+1;}}" });
  try {
    r.api.command({
      action: "start",
      taps: [{ plan: targetPlan("obj.f"), algo: "bounded", count: 2 }],
    });
    r.eval("globalThis.saved=obj.f;saved(1);saved(2);saved(3)");
    assert.equal(
      r.api
        .read({ limit: 100 })
        .entries.filter((e: any) => e.phase === "return").length,
      2,
    );
    const p = r.api.slice({
      action: "watchProperty",
      plan: targetPlan("obj.value"),
      ttlMs: 1000,
    });
    r.eval(
      'Object.defineProperty(obj,"value",{value:99,writable:true,configurable:true})',
    );
    assert.equal(
      r.api.slice({ action: "removeProperty", propertyId: p.propertyId })
        .restore,
      "conflict",
    );
    assert.equal(r.eval("obj.value"), 99);
  } finally {
    r.close();
  }
});
test("multi-tap preflight rejects missing targets before touching earlier valid targets", () => {
  const r = realm({
    bootScript: "globalThis.obj={f(){return 1}};globalThis.original=obj.f;",
  });
  try {
    assert.throws(() =>
      r.api.command({
        action: "start",
        taps: [
          { plan: targetPlan("obj.f"), algo: "valid" },
          { plan: targetPlan("missing.f"), algo: "invalid" },
        ],
      }),
    );
    assert.equal(r.eval("obj.f===original"), true);
    assert.equal(r.api.status().taps.length, 0);
  } finally {
    r.close();
  }
});
test("boot crypto global publication is tapped synchronously before a caller captures its function", () => {
  const r = realm({ cryptoTap: true });
  try {
    r.eval(
      'globalThis.CryptoJS={MD5(x){return "fixture:"+x}};globalThis.nvMd5=CryptoJS.MD5;nvMd5("published")',
    );
    assert.ok(
      r.api
        .read({ limit: 100 })
        .entries.some(
          (e: any) => e.algo === "CryptoJS.MD5" && e.input === "published",
        ),
    );
    r.close();
    assert.equal(r.eval('CryptoJS.MD5("published")'), "fixture:published");
  } finally {
    r.close();
  }
});

test("full stop removes never-assigned global publication probes", () => {
  const r = realm({ cryptoTap: true });
  r.close();
  assert.equal(
    r.eval('Object.prototype.hasOwnProperty.call(globalThis,"JSEncrypt")'),
    false,
  );
  assert.equal(
    r.eval('Object.prototype.hasOwnProperty.call(globalThis,"crypto")'),
    false,
  );
});
