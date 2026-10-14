import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { types } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { instrumentExecution } from "../src/analysis/execution/instrument";
import { executionRuntime } from "../src/analysis/execution/runtime";
import { sliceReport } from "../src/analysis/execution/output";
import { vmFunction } from "../src/analysis/serialize";
import { executionSchema } from "../src/analysis/execution/schema";
import {
  executionOutput,
  projectAnalysisEntries,
} from "../src/analysis/execution/output";
import { isRead } from "../src/controller/control";
import { AnalysisTools } from "../src/analysis/tools";
function host(config: any = { capacity: 20000 }) {
  const als = new AsyncLocalStorage<any>();
  const c = vm.createContext({
    setTimeout,
    clearTimeout,
    __runnerAnalysisContext: {
      now: config.clock,
      get: () => als.getStore(),
      isProxy: types.isProxy,
      run: (c: any, f: () => any) => als.run(c, f),
    },
  });
  vm.runInContext(
    `${vmFunction(executionRuntime)}(${JSON.stringify(config)})`,
    c,
  );
  const api = vm.runInContext("__wxappExecutionV1", c);
  api.command({ action: "start", maxEvents: 50000, ttlMs: 30000 });
  return {
    c,
    api,
    exec: (s: string) => {
      const r = instrumentExecution(s, "fixture.js");
      return vm.runInContext(r.code, c);
    },
  };
}
const plain = (s: string) =>
  vm.runInNewContext(s, { setTimeout, clearTimeout });
test("large execution captures retain full order and page with bounded cursor seeks", () => {
  const h = host({ capacity: 300000 });
  h.api.command({ action: "stop" });
  const run = h.api.command(
    executionSchema.parse({ action: "start", maxEvents: 300000, ttlMs: 30000 }),
  );
  assert.equal(
    h.exec("let sum=0;for(let i=0;i<25000;i++){sum+=i;}sum;"),
    (24999 * 25000) / 2,
  );
  const stopped = h.api.command({ action: "stop", runId: run.runId });
  assert.ok(stopped.count > 100000);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.evicted, 0);
  let after = run.cursor,
    count = 0;
  for (;;) {
    const page = h.api.command(
      executionSchema.parse({
        action: "read",
        runId: run.runId,
        after,
        limit: 200,
      }),
    );
    assert.ok(page.scanned <= 201);
    assert.equal(page.gap, false);
    for (const e of page.entries) {
      assert.equal(e.id, ++after);
      count++;
    }
    assert.equal(page.nextCursor, after);
    if (!page.hasMore) break;
  }
  assert.equal(count, stopped.count);
});
test("ordered execution cache eviction exposes cursor gaps and preserves retained dependency records", () => {
  const h = host({ capacity: 100 });
  h.exec("let a=0;for(let i=0;i<100;i++)a+=i;");
  const stopped = h.api.command({ action: "stop" });
  assert.equal(stopped.evicted, stopped.count - 100);
  const p = h.api.command(
    executionSchema.parse({ action: "read", limit: 200 }),
  );
  assert.equal(p.entries.length, 100);
  assert.equal(p.gap, true);
  assert.equal(p.oldestCursor, p.entries[0].id);
  assert.equal(p.hasMore, false);
  assert.equal(p.scanned, 100);
});
test("execution summaries filter interpreter noise and freeze grouped pagination", () => {
  const h = host();
  h.exec(
    'for(let i=0;i<4;i++){"private-input".charCodeAt(i);Math.floor(i+0.5);}',
  );
  const query = executionSchema.parse({
    action: "summary",
    natives: ["String.charCodeAt"],
    kinds: ["call-return"],
    limit: 1,
  });
  const p = h.api.command(query);
  assert.equal(p.matchedEvents, 4);
  assert.equal(p.groupCount, 1);
  assert.equal(p.entries[0].count, 4);
  assert.equal(p.hasMore, false);
  assert.ok(isRead("runner_execution", query));
  assert.ok(!JSON.stringify(executionOutput(p)).includes("private-input"));
  const first = h.api.command(
    executionSchema.parse({ action: "summary", groupBy: "kind", limit: 1 }),
  );
  h.exec('globalThis.other="new-event";');
  let offset = 0;
  const groups: any[] = [];
  do {
    const page = h.api.command(
      executionSchema.parse({
        action: "summary",
        groupBy: "kind",
        limit: 1,
        offset,
        beforeEvent: first.snapshotCursor,
      }),
    );
    assert.equal(page.matchedEvents, first.matchedEvents);
    groups.push(...page.entries);
    if (!page.hasMore) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (true);
  assert.equal(new Set(groups.map((g) => g.kind)).size, groups.length);
  assert.equal(
    groups.reduce((n, g) => n + g.count, 0),
    first.matchedEvents,
  );
  const end = h.api.command(
    executionSchema.parse({
      action: "read",
      after: first.snapshotCursor,
      beforeEvent: first.snapshotCursor,
    }),
  );
  assert.equal(end.entries.length, 0);
  assert.equal(end.nextCursor, first.snapshotCursor);
  assert.ok(end.latestCursor > first.snapshotCursor);
  const filtered = h.api.command(
    executionSchema.parse({
      action: "read",
      natives: ["String.charCodeAt"],
      kinds: ["call-return"],
      expressionIncludes: "private-input",
      location: { file: "fixture.js", line: 1 },
    }),
  );
  assert.equal(filtered.entries.length, 4);
  assert.ok(
    h.api.command(
      executionSchema.parse({ action: "summary", beforeEvent: 999999 }),
    ).cursorResetRequired,
  );
  assert.throws(
    () =>
      h.api.command(
        executionSchema.parse({ action: "summary", runId: "stale-run" }),
      ),
    /RUN_NOT_FOUND/,
  );
});
test("comma-return slices retain nested calls and exclude discarded operand values", () => {
  const h = host();
  const source = `var effects=[];
    function discarded(){effects.push("first");return "unrelated-value"}
    function inner(x){effects.push("second");return x+"!"}
    function outer(x){return discarded(),inner(x)}
    globalThis.sink=outer("input");JSON.stringify([sink,effects])`;
  assert.equal(h.exec(source), plain(source));
  const rows = h.api.command({ action: "read", after: 0, limit: 1000 }).entries;
  const sink = rows.find((e: any) => e.kind === "put" && e.property === "sink");
  const graph = h.api.command({ action: "explain", eventId: sink.id });
  assert.ok(graph.events.some((e: any) => e.kind === "sequence"));
  assert.ok(
    graph.events.some((e: any) => e.kind === "binary" && e.value === "input!"),
  );
  assert.ok(
    graph.events.some(
      (e: any) =>
        e.kind === "return" && e.location?.expression === 'return x+"!"',
    ),
  );
  assert.ok(!graph.events.some((e: any) => e.value === "unrelated-value"));
  assert.deepEqual(Array.from(graph.missing), []);
});
test("comma operands preserve indirect eval, detached receivers and abrupt completion", () => {
  for (const source of [
    'var o={m(){"use strict";return this===undefined}};(0,o.m)()',
    'var x="global";function f(){var x="local";return (0,eval)("x")}f()',
    'var log=[];function fail(){log.push("throw");throw Error("stop")};try{(fail(),log.push("wrong"))}catch(e){log.push(e.message)}JSON.stringify(log)',
    "var n=0;var o={get x(){n++;return 2}};JSON.stringify([delete (0,o.x),n])",
  ])
    assert.equal(host().exec(source), plain(source));
});
test("method receivers preserve origin through direct calls, call/apply and aliases", () => {
  for (const expression of [
    "s.toUpperCase()",
    "String.prototype.toUpperCase.call(s)",
    "String.prototype.toUpperCase.apply(s, [])",
    "upper.call(s)",
  ]) {
    const h = host();
    h.exec(`const upper=String.prototype.toUpperCase; const unrelated="ab"+"cd";
      const s="abc"+"def"; globalThis.sink=${expression};`);
    const rows = h.api.command({
      action: "read",
      after: 0,
      limit: 1000,
    }).entries;
    const sink = rows.find(
      (e: any) => e.kind === "put" && e.property === "sink",
    );
    const graph = h.api.command({ action: "explain", eventId: sink.id });
    assert.ok(
      graph.events.some(
        (e: any) => e.kind === "binary" && e.value === "abcdef",
      ),
      expression,
    );
    assert.ok(!graph.events.some((e: any) => e.value === "abcd"), expression);
    assert.ok(
      graph.events.some(
        (e: any) =>
          e.kind === "call-return" &&
          e.native === "String.toUpperCase" &&
          !e.opaque,
      ),
    );
  }
});
test("native concat preserves per-index provenance through VM byte buffers", () => {
  const h = host();
  const code =
    'const unused="discarded";const a=[2+3,9+1],b=[7+4];const c=a.concat(b);globalThis.sink=c[2]+c[0];sink';
  assert.equal(h.exec(code), plain(code));
  const rows = h.api.command({ action: "read", after: 0, limit: 1000 }).entries;
  const sink = rows.find((e: any) => e.kind === "put" && e.property === "sink");
  const graph = h.api.command({ action: "explain", eventId: sink.id });
  assert.ok(
    graph.events.some(
      (e: any) =>
        e.native === "Array.concat" && e.storage === "native-concat-copy",
    ),
  );
  for (const value of [5, 11])
    assert.ok(
      graph.events.some((e: any) => e.kind === "binary" && e.value === value),
    );
  assert.ok(
    !graph.events.some((e: any) => e.kind === "binary" && e.value === 10),
  );
  assert.deepEqual(Array.from(graph.opaqueBoundaries), []);
});
test("concat observers preserve Proxy, accessors, holes, species and spreadability effects", () => {
  for (const code of [
    'var log=[];var a=[1];Object.defineProperty(a,0,{get(){log.push("get");return 3}});JSON.stringify([a.concat([2]),log])',
    'var log=[];var a=new Proxy([1],{get(t,k,r){log.push(String(k));return Reflect.get(t,k,r)},getOwnPropertyDescriptor(t,k){log.push("descriptor:"+String(k));return Reflect.getOwnPropertyDescriptor(t,k)}});JSON.stringify([a.concat([2]),log])',
    'var log=[];class A extends Array{static get [Symbol.species](){log.push("species");return Array}};JSON.stringify([new A(1,2).concat([3]),log])',
    'var log=[];var a=[1];Object.defineProperty(a,Symbol.isConcatSpreadable,{get(){log.push("spread");return false}});JSON.stringify([a.concat([2]),log])',
    "var a=[,2];var out=a.concat([3]);JSON.stringify([0 in out,out])",
  ])
    assert.equal(host().exec(code), plain(code));
});
test("slice and primitive string properties retain the selected data source", () => {
  const h = host();
  h.exec(
    'const a=[2+3,9+1,7+4];const c=a.slice(-2);const s="ab"+"cd";globalThis.sink=c[1]+s.length+s[2].charCodeAt(0)',
  );
  const rows = h.api.command({ action: "read", after: 0, limit: 1000 }).entries;
  const sink = rows.find((e: any) => e.kind === "put" && e.property === "sink");
  const graph = h.api.command({ action: "explain", eventId: sink.id });
  assert.ok(
    graph.events.some((e: any) => e.kind === "binary" && e.value === 11),
  );
  assert.ok(
    !graph.events.some((e: any) => e.kind === "binary" && e.value === 10),
  );
  assert.ok(
    graph.events.some((e: any) => e.kind === "binary" && e.value === "abcd"),
  );
  assert.deepEqual(Array.from(graph.opaqueBoundaries), []);
  for (const code of [
    'var log=[];var a=[1,2,3];var start={valueOf(){log.push("coerce");return 1}};JSON.stringify([a.slice(start),log])',
    'var log=[];var a=[1,2];Object.defineProperty(a,1,{get(){log.push("get");return 3}});JSON.stringify([a.slice(-1),log])',
    "var a=[,2,3];var b=a.slice(0,2);JSON.stringify([0 in b,b])",
  ])
    assert.equal(host().exec(code), plain(code));
});
test("receiver observation does not change dynamic getter, Proxy or argument effects", () => {
  for (const s of [
    'var log=[];var o={get f(){log.push("get");return function(v){log.push(this===o);return v}}};var k={toString(){log.push("key");return "f"}};var x=o[k]((log.push("arg"),3));JSON.stringify([log,x])',
    "var log=[];var p=new Proxy({f(v){return v}},{get(t,k,r){log.push(k);return Reflect.get(t,k,r)}});p.f(7);JSON.stringify(log)",
    'var s="abc";var r=s.concat((s="changed","def"));JSON.stringify([r,s])',
  ])
    assert.equal(host().exec(s), plain(s));
});
test("module selection reaches define factories nested inside an unselected bootstrap closure", () => {
  const h = host(),
    source =
      'var define=(name,f)=>{var m={exports:{}};f(null,m,m.exports);globalThis.out=m.exports};(function(){define("chosen.js",function(r,m,e){e.value="selected"+"!";});})();out.value';
  const compiled = instrumentExecution(source, "modules.js", {
    modules: ["chosen.js"],
  });
  assert.deepEqual(compiled.modules, ["chosen.js"]);
  assert.equal(vm.runInContext(compiled.code, h.c), "selected!");
  const rows = h.api.command({ action: "read", after: 0, limit: 200 }).entries;
  assert.ok(
    rows.some(
      (e: any) =>
        e.kind === "put" && e.property === "value" && e.value === "selected!",
    ),
  );
});

test("captured Oracle identities cannot alias a new realm and watch/cursor limits are explicit", () => {
  const capture = () => {
    const h = host();
    h.exec('function sign(x){return x+"!"}sign("first")');
    const event = h.api
      .command({ action: "read", after: 0, limit: 200 })
      .entries.find(
        (e: any) => e.kind === "call" && e.callee === 'sign("first")',
      );
    return {
      ...h,
      oracle: h.api.command({ action: "oracleExport", eventId: event.id }),
    };
  };
  const a = capture(),
    b = capture();
  assert.notEqual(a.oracle.oracleId, b.oracle.oracleId);
  assert.throws(
    () =>
      b.api.command({
        action: "oracleCall",
        oracleId: a.oracle.oracleId,
        args: ["x"],
      }),
    /ORACLE_EXPIRED/,
  );
  for (let i = 0; i < 100; i++)
    b.api.command({ action: "watch", properties: ["sign"] });
  assert.throws(
    () => b.api.command({ action: "watch", properties: ["sign"] }),
    /WATCH_LIMIT/,
  );
  assert.equal(
    b.api.command({ action: "read", after: 1000000, limit: 1 })
      .cursorResetRequired,
    true,
  );
});
test("instrumentation preserves strict errors, property-key coercion order, getter counts, calls, BigInt and update values", () => {
  for (const s of [
    'var log=[];var o={};var key={toString(){log.push("key");return "x"}};o[key]=(log.push("rhs"),3);JSON.stringify([log,o.x])',
    '"use strict";var o=Object.freeze({});var result;try{o.x=1}catch(e){result=e.name}result',
    "var count=0;var o={get x(){count++;return function(v){return this===o?v:0}}};JSON.stringify([o.x(7),count])",
    "var a=1n;var o={n:2n};JSON.stringify([String(a++),String(a),String(o.n++),String(++o.n)])",
    "function f(x){if(x>0)return f(x-1)+1;return 0};f(4)",
    'var a=0;var x=null;var y={x:3};[x?.x??7,y?.x, false && ++a,a].join(",")',
    "var o={x:1};var x=delete o.x;JSON.stringify([x,o])",
    "class A{constructor(){this.x=1}}class B extends A{constructor(){super();this.x=2}}new B().x",
    "function f(){try{return 2}finally{var x=3}}f()",
  ]) {
    const h = host();
    assert.equal(h.exec(s), plain(s), s);
  }
});
test("all instrumented object writes can be watched without pre-existing objects or setters", () => {
  const h = host(),
    w = h.api.command({ action: "watch", properties: ["X-Sign"] });
  h.exec(
    'function work(v){var h={};h["X-"+"Sign"]=v+"!";return h}work("a");work("b")',
  );
  const r = h.api.command({
    action: "read",
    watchId: w.watchId,
    after: 0,
    limit: 100,
  });
  assert.equal(
    r.entries.filter((e: any) => e.kind === "write-attempt").length,
    2,
  );
  r.entries = r.entries.filter((e: any) => e.kind === "put");
  assert.equal(r.entries.length, 2);
  assert.deepEqual(
    Array.from(r.entries, (x: any) => x.value),
    ["a!", "b!"],
  );
  assert.notEqual(r.entries[0].objectId, r.entries[1].objectId);
  const graph = h.api.command({ action: "explain", eventId: r.entries[0].id });
  assert.ok(
    graph.events.some((x: any) => x.kind === "binary" && x.value === "a!"),
  );
  assert.ok(!graph.events.some((x: any) => x.value === "b!"));
});
test("virtual stack-machine execution yields canonical string and signer call provenance", () => {
  const h = host();
  const code = `function hash(x){return "digest:"+x}function vmRun(code,input){var stack=[],pc=0;while(pc<code.length){switch(code[pc++]){case 1:stack.push(input.a);break;case 2:stack.push("=");break;case 3:stack.push(input.b);break;case 4:var b=stack.pop(),a=stack.pop();stack.push(a+b);break;case 5:stack.push(hash(stack.pop()));break;case 6:var headers={};headers["X-Sign"]=stack.pop();return headers;}}}globalThis.result=vmRun([1,2,4,3,4,5,6],{a:"name",b:"value"});result["X-Sign"]`;
  assert.equal(h.exec(code), "digest:name=value");
  const rows = h.api.command({ action: "read", after: 0, limit: 200 }).entries;
  const sink = rows.find(
    (e: any) => e.kind === "put" && e.property === "X-Sign",
  );
  assert.ok(sink);
  const graph = h.api.command({ action: "explain", eventId: sink.id });
  assert.ok(
    graph.events.some(
      (e: any) => e.kind === "binary" && e.value === "name=value",
    ),
  );
  assert.equal(graph.generalizedAlgorithm, false);
});

test("modern syntax, proxy traps, default params, native callbacks and lexical scope preserve effects", () => {
  for (const s of [
    "function f(a=1,b=a+1){return b}f()",
    "var f=x=>x+1;JSON.stringify([f.name,f(2)])",
    'var log=[];var p=new Proxy({},{getOwnPropertyDescriptor(t,k){log.push("descriptor");return Reflect.getOwnPropertyDescriptor(t,k)},set(t,k,v){log.push("set");t[k]=v;return true}});p.x=3;JSON.stringify(log)',
    "var obj={};({x:obj.x,y:obj.y=4}={x:3});JSON.stringify(obj)",
    "var o={};for(o.x of [1,2]){};o.x",
    "var o={};for(o.x in {a:1,b:2}){};o.x",
    "function f(){return h();function h(){return 7}}f()",
    'var o={};var s=Symbol("x");o[s]=3;o[s]',
    'var calls=0;var k={toString(){calls++;return "x"}};var o={x:1};o[k]+=2;JSON.stringify([calls,o.x])',
    'var c=0;var k={toString(){c++;return "x"}};try{null[k]}catch(e){};c',
    "var a=[1,2].map(x=>x+1);JSON.stringify(a)",
  ])
    assert.equal(host().exec(s), plain(s), s);
});

test("reversed async completions retain distinct input provenance", async () => {
  const h = host();
  await h.exec(
    'async function work(x,ms){await new Promise(r=>setTimeout(r,ms));var h={};h.sign=x+"!";return h;}Promise.all([work("slow",15),work("fast",0)])',
  );
  const rows = h.api
    .command({ action: "read", after: 0, limit: 1000 })
    .entries.filter((r: any) => r.kind === "put" && r.property === "sign");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].value, "fast!");
  const graph = h.api.command({ action: "explain", eventId: rows[0].id });
  assert.ok(
    graph.events.some((e: any) => e.kind === "parameter" && e.value === "fast"),
  );
  assert.ok(!graph.events.some((e: any) => e.value === "slow"));
});
test("Function.call/apply arguments, trace export and logpoint return pairs are observed", () => {
  const h = host();
  h.exec('function f(x){return "signed:"+x;}globalThis.f=f;');
  const w = h.api.command({
    action: "logpoint",
    location: { file: "fixture.js", line: 1 },
    kinds: ["call"],
    count: 2,
    ttlMs: 10000,
  });
  h.exec('var a=f.call(null,"one");var b=f.apply(null,["two"]);');
  const rows = h.api.command({
    action: "read",
    watchId: w.watchId,
    after: 0,
    limit: 1000,
  }).entries;
  assert.ok(
    rows.some((r: any) => r.kind === "call-return" && r.value === "signed:one"),
  );
  const call = rows.find((r: any) => r.kind === "call" && r.args[0] === "one");
  assert.ok(call);
  const o = h.api.command({ action: "oracleExport", eventId: call.id });
  assert.equal(
    h.api.command({
      action: "oracleCall",
      oracleId: o.oracleId,
      args: ["three"],
    }).result,
    "signed:three",
  );
});

test("native mutations only report touched keys and do not report unrelated sign fields", () => {
  const h = host();
  h.exec(
    'var o={sign:"unchanged"};Object.defineProperty(o,"other",{value:1});Reflect.set(o,"last",2);Reflect.deleteProperty(o,"last");',
  );
  const rows = h.api.command({ action: "read", after: 0, limit: 1000 }).entries;
  assert.equal(
    rows.filter((r: any) => r.kind === "put" && r.property === "sign").length,
    1,
  );
  assert.ok(
    rows.some((r: any) => r.kind === "delete" && r.property === "last"),
  );
});

test("spread preserves iteration effects and never assigns later syntactic arguments to expanded positions", () => {
  const h = host(),
    s =
      'var effects=[];var it={*[Symbol.iterator](){effects.push("next");yield "first";yield "second"}};function f(a,b,c){return [a,b,c].join("/")}var result=f(...it,"tail");JSON.stringify([result,effects])';
  assert.equal(h.exec(s), plain(s));
  const rows = h.api.command({ action: "read", after: 0, limit: 200 }).entries;
  const call = rows.find(
    (e: any) => e.kind === "call" && e.unknownArgumentPositions,
  );
  assert.ok(call);
  assert.equal(call.opaque, true);
  assert.equal(call.deps.length, 0);
  const params = rows.filter(
    (e: any) =>
      e.kind === "parameter" && ["first", "second", "tail"].includes(e.value),
  );
  assert.ok(params.every((e: any) => !e.deps.length));
  assert.ok(params.every((e: any) => e.provenance === "unobserved-argument"));
  for (const parameter of params) {
    const slice = h.api.command({ action: "explain", eventId: parameter.id });
    assert.ok(slice.opaqueBoundaries.includes(parameter.id));
  }
});
test("native callback arguments remain explicit boundaries rather than fabricated caller edges", () => {
  const h = host();
  h.exec('var results=[];["input"].forEach(value=>{results.push(value+"!")});');
  const rows = h.api.command({ action: "read", after: 0, limit: 200 }).entries;
  const parameter = rows.find(
    (e: any) => e.kind === "parameter" && e.value === "input",
  );
  assert.ok(parameter);
  assert.equal(parameter.provenance, "unobserved-argument");
  assert.equal(parameter.deps.length, 0);
  const graph = h.api.command({ action: "explain", eventId: parameter.id });
  assert.ok(graph.opaqueBoundaries.includes(parameter.id));
  assert.equal(sliceReport(graph).steps[0].opaque, true);
});
test("object keys coerce at native timing and their actual keys remain watchable", () => {
  const h = host();
  const w = h.api.command({ action: "watch", properties: ["sign"] });
  assert.equal(
    h.exec(
      'var calls=0;var key={[Symbol.toPrimitive](){calls++;return "sign"}},o={};o[key]="ok";calls',
    ),
    1,
  );
  const rows = h.api.command({
    action: "read",
    watchId: w.watchId,
    after: 0,
    limit: 1000,
  }).entries;
  assert.ok(
    rows.some(
      (e: any) => e.kind === "put" && e.property === "sign" && e.value === "ok",
    ),
  );
});

test("primitive string and numeric native boundaries retain names and split provenance", () => {
  const h = host();
  const source = `let input="CAB"; const split=input.split(""); split.reverse();
    let code=String.fromCharCode(split[0].charCodeAt(0));
    [code, (0.25).toString(2), input.indexOf("A"), parseInt("11", 2)].join(":");`;
  assert.equal(h.exec(source), plain(source));
  const rows = h.api.command({ action: "read", limit: 1000 }).entries;
  for (const name of [
    "String.fromCharCode",
    "Number.toString",
    "String.indexOf",
    "Global.parseInt",
    "String.split",
  ]) {
    const e = rows.find(
      (e: any) => e.kind === "call-return" && e.native === name,
    );
    assert.ok(e, name);
    assert.equal(e.opaque, false, name);
  }
  const splitReturn = rows.find(
    (e: any) => e.kind === "call-return" && e.native === "String.split",
  );
  const splitWrites = rows.filter(
    (e: any) => e.storage === "native-split-result",
  );
  assert.equal(splitWrites.length, 3);
  assert.ok(splitWrites.every((e: any) => e.deps.includes(splitReturn.id)));
  const reverse = rows.find(
    (e: any) => e.kind === "call-return" && e.native === "Array.reverse",
  );
  assert.equal(reverse.opaque, true); // A native mutation boundary remains explicitly coarse.
  assert.ok(splitWrites.every((e: any) => reverse.deps.includes(e.id)));
  const read = rows.find(
    (e: any) => e.kind === "get" && e.location.expression === "split[0]",
  );
  assert.ok(read.deps.includes(reverse.id));
  assert.ok(!read.deps.includes(splitWrites[0].id)); // No stale pre-reversal index mapping.
});

test("native observation does not repeat coercion or custom Symbol.split", () => {
  const h = host();
  const source = `let calls=[];const separator={ [Symbol.split](s){calls.push(s);return ["custom"]} };
    const number={valueOf(){calls.push("coerce");return 65}};
    let a="source".split(separator),b=String.fromCharCode(number);[a,b,calls];`;
  assert.equal(JSON.stringify(h.exec(source)), JSON.stringify(plain(source)));
  const rows = h.api.command({ action: "read", limit: 1000 }).entries;
  for (const name of ["String.split", "String.fromCharCode"]) {
    const e = rows.find(
      (e: any) => e.kind === "call-return" && e.native === name,
    );
    assert.equal(e.opaque, true);
  }
  assert.ok(!rows.some((e: any) => e.storage === "native-split-result"));
});

test("compound assignments and updates remain explicit calculation steps", () => {
  const h = host();
  const source =
    "var m=259896, bytes=[];do{bytes.push(m&127);m>>=7}while(m);m++;m";
  assert.equal(h.exec(source), plain(source));
  const rows = h.api.command({ action: "read", limit: 1000 }).entries;
  const shifts = rows.filter(
    (e: any) => e.kind === "write" && e.operator === ">>=",
  );
  assert.deepEqual(
    Array.from(shifts, (e: any) => e.value),
    [2030, 15, 0],
  );
  assert.ok(shifts[1].deps.includes(shifts[0].id));
  assert.ok(shifts[2].deps.includes(shifts[1].id));
  const last = rows.at(-1);
  const graph = h.api.command({ action: "explain", eventId: last.id });
  assert.ok(
    shifts.every((e: any) => graph.semantic.some((s: any) => s.id === e.id)),
  );
  assert.ok(sliceReport(graph).steps.some((e: any) => e.operation === ">>="));
  assert.ok(sliceReport(graph).steps.some((e: any) => e.operation === "++"));
});

test("native array search follows only inspected indices, preserving actual equality semantics", () => {
  const h = host();
  const source =
    'var a=[];a[0]="A";a[1]="B";a[2]="A";a[3]=NaN;var b=a.indexOf("B"),c=a.lastIndexOf("A"),d=a.includes(NaN),e=a.indexOf("A",-2);[b,c,d,e]';
  assert.equal(JSON.stringify(h.exec(source)), JSON.stringify(plain(source)));
  const rows = h.api.command({ action: "read", limit: 1000 }).entries;
  const searches = rows.filter(
    (e: any) =>
      e.kind === "call-return" &&
      /^Array\.(indexOf|lastIndexOf|includes)$/.test(e.native),
  );
  assert.equal(searches.length, 4);
  assert.ok(searches.every((e: any) => e.opaque === false));
  const writes = rows.filter(
    (e: any) => e.kind === "put" && /^(0|1|2|3)$/.test(e.property),
  );
  assert.ok(searches[0].deps.includes(writes[0].id));
  assert.ok(searches[0].deps.includes(writes[1].id));
  assert.ok(!searches[0].deps.includes(writes[2].id));
  assert.equal(searches[1].searchRange.count, 2);
  assert.equal(searches[2].searchRange.count, 4);
  assert.equal(searches[3].searchRange.count, 1);
});

test("array search leaves accessors, proxies, holes and coercions explicit without extra effects", () => {
  const h = host();
  const source = `var effects=[],a=["A"],b=new Proxy(["B"],{get(t,k,r){effects.push(String(k));return Reflect.get(t,k,r)}});
    Object.defineProperty(a,"0",{get(){effects.push("getter");return "A"}});
    var from={valueOf(){effects.push("from");return 0}};
    var results=[a.indexOf("A"),b.includes("B"),["C"].indexOf("C",from),[,].indexOf(undefined)];[results,effects];`;
  assert.equal(JSON.stringify(h.exec(source)), JSON.stringify(plain(source)));
  const rows = h.api.command({ action: "read", limit: 1000 }).entries;
  const searches = rows.filter(
    (e: any) =>
      e.kind === "call-return" && /^Array\.(indexOf|includes)$/.test(e.native),
  );
  assert.equal(searches.length, 4);
  assert.ok(searches.every((e: any) => e.opaque === true));
});

test("paged explanation traverses deep graphs once and retries the same page idempotently", () => {
  const h = host();
  h.exec("var result=0;for(let i=0;i<1200;i++)result+=i;result;");
  const last = h.api.command({ action: "status" }).latestCursor;
  const start = h.api.command(
    executionSchema.parse({
      action: "explain",
      eventId: last,
      paged: true,
      maxNodes: 71,
    }),
  );
  let page = start,
    ids = new Set<number>();
  for (;;) {
    assert.ok(page.scanned <= 71);
    const retry = h.api.command(
      executionSchema.parse({
        action: "explain",
        sliceCursor: page.sliceCursor,
      }),
    );
    assert.equal(JSON.stringify(retry), JSON.stringify(page));
    for (const entry of page.entries) {
      assert.ok(!ids.has(entry.id));
      ids.add(entry.id);
    }
    if (!page.hasMore) break;
    page = h.api.command(
      executionSchema.parse({
        action: "explain",
        sliceCursor: page.nextSliceCursor,
      }),
    );
  }
  assert.ok(ids.size > 2000);
  assert.equal(page.complete, true);
  assert.equal(page.truncated, false);
  assert.equal(page.visitedNodes, ids.size);
  assert.equal(page.missingCount, 0);
  assert.equal(page.snapshotCursor, start.snapshotCursor);
  const projected = projectAnalysisEntries(executionOutput(start), [
    "kind",
    "value",
    "location.expression",
  ]);
  assert.deepEqual(
    Object.keys(projected.entries[0]).sort(),
    ["id", "kind", "location.expression", "value"].sort(),
  );
  assert.equal(
    projected.entries[0].value,
    "[REDACTED: use revealSensitive:true]",
  );
  assert.equal(h.api.command({ action: "status" }).latestCursor, last);
});

test("slice continuation rejects mismatches, exposes limits and reports eviction", () => {
  const h = host({ capacity: 100 });
  h.exec("var x=1;x+=2;x+=3;x;");
  const last = h.api.command({ action: "status" }).latestCursor;
  const a = h.api.command({
    action: "explain",
    eventId: last,
    paged: true,
    maxNodes: 2,
    maxTotalNodes: 3,
  });
  assert.throws(
    () =>
      h.api.command({
        action: "explain",
        sliceCursor: a.nextSliceCursor,
        maxNodes: 4,
      }),
    /SLICE_OPTIONS_MISMATCH/,
  );
  const b = h.api.command({
    action: "explain",
    sliceCursor: a.nextSliceCursor,
  });
  assert.equal(b.truncated, true);
  assert.equal(b.reason, "node-limit");
  assert.equal(b.complete, false);
  assert.equal(b.hasMore, false);
  const other = host();
  assert.throws(
    () => other.api.command({ action: "explain", sliceCursor: a.sliceCursor }),
    /SLICE_CURSOR_EXPIRED_OR_UNKNOWN/,
  );
  h.exec("for(var j=0;j<100;j++)x+=j;");
  assert.throws(
    () => h.api.command({ action: "explain", sliceCursor: a.sliceCursor }),
    /SLICE_PAGE_EVICTED/,
  );
  assert.equal(
    executionSchema.safeParse({
      action: "explain",
      sliceCursor: "old",
      paged: false,
    }).success,
    false,
  );
  assert.equal(
    executionSchema.safeParse({ action: "read", paged: true }).success,
    false,
  );
});

test("paged slices report missing dependencies, expired cursors and bounded session retention", () => {
  let clock = 1000;
  const h = host({ capacity: 100, clock: () => clock });
  h.exec("var x=0;for(var i=0;i<100;i++)x+=i;x");
  const last = h.api.command({ action: "status" }).latestCursor;
  const missing = h.api.command({
    action: "explain",
    eventId: last,
    paged: true,
    maxNodes: 2000,
  });
  assert.ok(missing.missingCount > 0);
  assert.equal(missing.complete, false);
  assert.equal(missing.truncated, false);
  for (let i = 0; i < 4; i++)
    h.api.command({ action: "explain", eventId: last, paged: true });
  assert.throws(
    () =>
      h.api.command({ action: "explain", sliceCursor: missing.sliceCursor }),
    /SLICE_CURSOR_EXPIRED_OR_UNKNOWN/,
  );
  const page = h.api.command({ action: "explain", eventId: last, paged: true });
  clock += 300001;
  assert.throws(
    () => h.api.command({ action: "explain", sliceCursor: page.sliceCursor }),
    /SLICE_CURSOR_EXPIRED_OR_UNKNOWN/,
  );
});

test("large slice transport preserves traversal cursors and puts a complete projected page in an artifact", async () => {
  const graph = {
    entries: [{ id: 7, value: "字".repeat(70000) }],
    sliceCursor: "slice:0",
    nextSliceCursor: "slice:1",
    hasMore: true,
    truncated: false,
    complete: false,
    missingCount: 0,
  };
  let saved: any;
  const debug = async (name: string, a: any) =>
    name === "runner_status"
      ? { runtimeId: "r", sessionId: "s" }
      : {
          result: {
            value: a.expression.startsWith("!!")
              ? true
              : structuredClone(graph),
          },
        };
  const tool = new AnalysisTools(debug, (data) => {
    saved = structuredClone(data);
    return "artifact-1";
  });
  const page = await tool.dispatch("runner_execution", {
    action: "explain",
    paged: true,
    eventId: 7,
    revealSensitive: true,
  });
  assert.equal(page.fullPageInArtifact, true);
  assert.equal(page.truncated, false);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextSliceCursor, "slice:1");
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.entries.length, 0);
  assert.equal(page.pageEntriesTotal, 1);
  assert.equal(saved.entries[0].value, graph.entries[0].value);
  const safe = await tool.dispatch("runner_execution", {
    action: "explain",
    paged: true,
    eventId: 7,
  });
  assert.equal(safe.entries[0].value, "[REDACTED: use revealSensitive:true]");
  assert.equal(safe.artifactId, undefined);
});

test("dense splice maps retained, inserted and removed elements instead of erasing their origins", () => {
  const h = host();
  const s =
    'var a=[];a[0]="one";a[1]="two";a[2]="three";var item="inserted";var removed=a.splice(1,1,item,"extra");[a[0],a[1],a[2],a[3],removed[0]]';
  assert.equal(JSON.stringify(h.exec(s)), JSON.stringify(plain(s)));
  const rows = h.api.command({ action: "read", limit: 1000 }).entries;
  const moved = rows.filter((e: any) => e.storage === "native-splice-move");
  const removed = rows.find((e: any) => e.storage === "native-splice-removed");
  const previous = rows.filter(
    (e: any) => e.kind === "put" && e.storage === "own-data-observed",
  );
  assert.equal(moved.length, 3);
  assert.ok(
    moved.find((e: any) => e.property === "3").deps.includes(previous[2].id),
  );
  assert.ok(removed.deps.includes(previous[1].id));
  const third = rows.find(
    (e: any) => e.kind === "get" && e.location.expression === "a[3]",
  );
  assert.ok(third.deps.includes(moved.find((e: any) => e.property === "3").id));
  const graph = h.api.command({ action: "explain", eventId: third.id });
  assert.ok(graph.events.some((e: any) => e.id === previous[2].id));
  assert.ok(!graph.events.some((e: any) => e.id === previous[1].id));
  const assigned = rows.find(
    (e: any) =>
      e.kind === "write" && e.location.expression.startsWith("removed="),
  );
  const returned = rows.find(
    (e: any) => e.kind === "call-return" && e.native === "Array.splice",
  );
  assert.ok(assigned.deps.includes(returned.id));
  assert.ok(!assigned.deps.includes(removed.id));
});

test("splice observation preserves delete counts, holes, accessors, coercion, species and Proxy effects", () => {
  const sources = [
    "var a=[1,2,3],r=a.splice();[a,r]",
    "var a=[1,2,3],r=a.splice(-2);[a,r]",
    "var a=[1,2,3],r=a.splice(-100,Infinity,4);[a,r]",
    "var a=[,2,3],r=a.splice(0,1);[a,r,Object.keys(a)]",
    'var log=[],a=[1,2];Object.defineProperty(a,"0",{get(){log.push("get");return 1},set(v){log.push(v)}});var r=a.splice(0,1);[a,r,log]',
    'var log=[],a=[1,2],n={valueOf(){log.push("index");return 0}};var r=a.splice(n,1);[a,r,log]',
    "var log=[],a=[1,2];a.constructor={[Symbol.species]:class extends Array{constructor(n){super(n);log.push(n)}}};var r=a.splice(0,1);[a,r,log]",
    "var log=[],a=new Proxy([1,2],{get(t,k,r){log.push(String(k));return Reflect.get(t,k,r)}});var r=a.splice(0,1);[a,r,log]",
  ];
  for (const s of sources)
    assert.equal(JSON.stringify(host().exec(s)), JSON.stringify(plain(s)), s);
});

test("partial native mutation failures invalidate old element provenance", () => {
  const h = host();
  const s =
    'var a=[];a[0]=1;a[1]=2;a[2]=3;Object.defineProperty(a,"1",{writable:false});try{a.splice(0,1)}catch(e){}a[0]';
  assert.equal(h.exec(s), plain(s));
  const rows = h.api.command({ action: "read", limit: 1000 }).entries;
  const read = rows.find(
    (e: any) => e.kind === "get" && e.location.expression === "a[0]",
  );
  assert.equal(read.value, 2);
  assert.equal(read.provenance, "unobserved-property");
  assert.equal(read.deps.length, 0);
});

test("initialization origins survive the first manual run without linking equal values", () => {
  const h=host({capacity:20000}); h.api.command({action:"stop"});
  // A fresh realm is needed because auto initialization starts during installation.
  const c=vm.createContext({});
  vm.runInContext(`${vmFunction(executionRuntime)}(${JSON.stringify({initialization:{enabled:true},capacity:20000})})`,c);
  const {__wxappExecutionV1: api}=c;
  vm.runInContext(instrumentExecution('var initialized=12;var unrelated=12;function later(){return initialized+1}', 'init.js').code,c);
  const init=api.command({action:"status"}).initialization;
  const run=api.command({action:"start"});
  assert.equal(vm.runInContext('later()',c),13);
  api.command({action:"stop"});
  const entries=api.command({action:"read",after:0,limit:200,revealSensitive:true}).entries;
  const read=entries.find((e:any)=>e.runId===run.runId && e.kind==='read' && e.location.expression==='initialized');
  assert.ok(read);
  const origin=entries.find((e:any)=>read.deps.includes(e.id));
  assert.equal(origin.runId,init.id);
  assert.equal(origin.location.expression.includes('initialized'),true);
});

test("state-mode init records only current property writes and resolves later reads to them", () => {
  const c=vm.createContext({});
  vm.runInContext(`${vmFunction(executionRuntime)}(${JSON.stringify({initialization:{enabled:true,mode:"state"},capacity:20000})})`,c);
  const {__wxappExecutionV1: api}=c;
  // init phase: property writes (h.a superseded 1->2) + read noise; state mode
  // must keep only the current write per (object,key) and skip non-writes.
  vm.runInContext(instrumentExecution('var h={};h.a=1;h.a=2;h.b=3;var noise=h.a+h.b;function rd(){return h.a+h.b}', 'init.js').code,c);
  const status=api.command({action:"status"});
  const init=status.initialization;
  assert.equal(init.mode,"state");
  assert.ok(status.initStateRetained>=2); // h.a(current) + h.b retained
  const initEntries=api.command({action:"read",after:0,limit:500,revealSensitive:true})
    .entries.filter((e:any)=>e.runId===init.id);
  // non-writes (reads of h.a/h.b in `noise`) are not recorded in state mode
  assert.equal(initEntries.some((e:any)=>e.kind==='read'),false);
  // only the CURRENT write to h.a is retained (superseded h.a=1 evicted)
  const putsA=initEntries.filter((e:any)=>e.kind==='put'&&e.property==='a');
  assert.equal(putsA.length,1);
  assert.equal(putsA[0].value,2);
  const putB=initEntries.find((e:any)=>e.kind==='put'&&e.property==='b');
  assert.ok(putB&&putB.value===3);
  // an invocation read resolves its source to the retained init write (not unknown)
  const run=api.command({action:"start"});
  assert.equal(vm.runInContext('rd()',c),5);
  api.command({action:"stop"});
  const entries=api.command({action:"read",after:0,limit:500,revealSensitive:true}).entries;
  const resolved=entries.find((e:any)=>e.runId===run.runId&&(e.deps||[]).includes(putsA[0].id));
  assert.ok(resolved, "invocation read links back to the retained init-state write");
});

test("byte budget stops recording without changing business return values", () => {
  const h=host({capacity:20000,byteLimit:65536});
  assert.equal(h.exec('let sum=0;for(let i=0;i<2000;i++)sum+=i;sum;'),1999000);
  const s=h.api.command({action:"status"});
  assert.equal(s.active.reason,'byte-limit');
  assert.ok(s.cache.retainedBytes<=65536);
});

test("active parent bindings survive more than 20000 child calls", () => {
  const h=host({capacity:300000,byteLimit:1073741824});
  h.api.command({action:'stop'});h.api.command({action:'start',maxEvents:300000,ttlMs:30000});
  assert.equal(h.exec('function child(){};function parent(){let keep=73;for(let i=0;i<20010;i++)child();return keep;}parent();'),73);
  const s=h.api.command({action:'status'});
  const rows=h.api.command({action:'read',after:s.latestCursor-100,limit:200}).entries;
  assert.ok(rows.some((e:any)=>e.kind==='read'&&e.location.expression==='keep'&&e.provenance==='binding'));
});

test('if control dependencies are local and finally clears them across throw and return', () => {
  const h = host();
  const source = `var observed=[];function pick(flag){if(flag){observed.push('yes');return 7;}else{try{throw 2}catch(e){observed.push(e)}}return 8;}var result=[pick(true),pick(false),observed];result`;
  assert.equal(JSON.stringify(h.exec(source)), JSON.stringify(plain(source)));
  const events = h.api.command({action:'read',limit:200}).entries;
  const selected = events.find((e:any)=>e.kind==='return' && e.value===7);
  assert.ok(selected.controlDeps.length);
  const classified=h.api.command({action:'dependencies',eventId:selected.id});
  assert.ok(classified.control.every((e:any)=>e.retained));
  const after=events.find((e:any)=>e.kind==='return' && e.value===8);
  assert.deepEqual(Array.from(after.controlDeps),[]);
  const slice=h.api.command({action:'explain',eventId:selected.id,expandEvents:[selected.id],maxNodes:200});
  assert.ok(slice.events?.some((e:any)=>e.kind==='branch') || slice.entries?.some((e:any)=>e.kind==='branch'));
});

test('synchronous completed frames are released without evicting a still-running parent', () => {
 const h=host({capacity:100,maxEvents:1000000});
 assert.equal(h.exec('function child(x){return x}function parent(){let keep=77;for(let i=0;i<25000;i++)child(i);return keep;}parent()'),77);
 const status=h.api.command({action:'status'});assert.ok(status.frameEvictions>0);assert.equal(status.frameGaps,0);assert.ok(status.retainedFrames<=20000);
});

test('escaped closure keeps its lexical origin through completed-frame eviction', () => {
 const h=host({capacity:500000,maxEvents:1000000});
 h.api.command({action:'stop'});const run=h.api.command({action:'start',maxEvents:500000,ttlMs:30000});
 h.exec('function creator(){let preserved=91;return ()=>preserved;}var kept=creator();function child(){return 1;}');
 assert.equal(h.exec('for(let i=0;i<23000;i++)child();kept()'),91);
 const status=h.api.command({action:'status'});assert.equal(status.frameGaps,0);
 const tail=h.api.command({action:'read',runId:run.runId,after:status.latestCursor-50,limit:100});
 const read=tail.entries.find((e:any)=>e.kind==='read'&&e.value===91);assert.ok(read);assert.equal(read.provenance,'binding');
});
