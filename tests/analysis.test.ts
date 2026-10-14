import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { hookRuntime } from "../src/analysis/hook-runtime";
import { targetPlan, conditionPlan } from "../src/analysis/targets";
import { networkSchema } from "../src/analysis/schemas";
import { queryNetwork } from "../src/analysis/network";
import { ModuleSource } from "../src/analysis/source";
import { vmFunction } from "../src/analysis/serialize";
import { instrumentExecution } from "../src/analysis/execution/instrument";
const plain = (v: any) => JSON.parse(JSON.stringify(v));
function host() {
  const c = vm.createContext({ setTimeout, clearTimeout });
  const api = vm.runInContext(`${vmFunction(hookRuntime)}()`, c);
  const run = (s: string) => vm.runInContext(s, c);
  return { api, run };
}
const install = (api: any, target: string, options: any = {}) =>
  api.install({
    hookId: crypto.randomUUID(),
    target,
    plan: targetPlan(target),
    count: 5,
    capacity: 50,
    ttlMs: 1000,
    capture: ["args", "return", "this", "stack"],
    ...options,
  });
test("controlled hooks remain compatible with live older analysis runtimes", () => {
  const { api, run } = host();
  run("globalThis.__wxappBootAnalysisV1={};globalThis.f=x=>x+1;globalThis.original=f;");
  const h = install(api, "f", { count: 1 });
  assert.equal(run("f(2)"), 3);
  assert.equal(api.read(h.hookId, 0, 10).restore, "restored");
  assert.equal(run("f===original"), true);
});
test("controlled hook preserves receiver, return and descriptor; stops at count including recursive calls", () => {
  const { api, run } = host();
  run(
    'globalThis.app={prefix:"签名", getSign(x){return this.prefix+x}};globalThis.getApp=()=>app;globalThis.before=Object.getOwnPropertyDescriptor(app,"getSign");',
  );
  const h = install(api, "getApp().getSign", { count: 2 });
  assert.equal(run('app.getSign("原文😀")'), "签名原文😀");
  assert.equal(run('app.getSign("第二次")'), "签名第二次");
  assert.ok(
    run('Object.getOwnPropertyDescriptor(app,"getSign").value===before.value'),
  );
  const r = api.read(h.hookId, 0, 20);
  assert.equal(r.status, "removed");
  assert.equal(r.restore, "restored");
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].args[0], "原文😀");
  assert.equal(r.entries[0].return, "签名原文😀");
  assert.ok(r.entries[0].stack.includes("Error"));
  run("globalThis.recur=function(n){return n?recur(n-1)+1:0}");
  const h2 = install(api, "recur", { count: 1 });
  assert.equal(run("recur(4)"), 4);
  assert.equal(api.read(h2.hookId, 0, 10).entries.length, 1);
  const h3 = install(api, "recur", { count: 3 });
  assert.equal(run("recur(4)"), 4);
  const ids = api.read(h3.hookId, 0, 10).entries.map((e: any) => e.id);
  assert.deepEqual(plain(ids), plain([...ids].sort((a, b) => a - b)));
});
test("hook filters are non-evaluating, buffers expose gaps, TTL restores and newer property changes survive removal", async () => {
  assert.throws(() => conditionPlan("JSON.stringify(args)"));
  assert.throws(() => conditionPlan("args[0]=4"));
  assert.throws(() => targetPlan("getApp().doEvil()"));
  const { api, run } = host();
  run("globalThis.f=x=>x;globalThis.original=f;");
  const h = install(api, "f", {
    count: 10,
    capacity: 2,
    condition: conditionPlan("args[0] >= 2 && args[0] < 9"),
    ttlMs: 100,
  });
  for (let i = 0; i < 5; i++) run(`f(${i})`);
  const r = api.read(h.hookId, 0, 20);
  assert.equal(r.count, 3);
  assert.equal(r.entries.length, 2);
  assert.equal(r.gap, true);
  await delay(130);
  assert.equal(api.read(h.hookId, 0, 20).reason, "expired");
  assert.ok(run("f===original"));
  const h2 = install(api, "f");
  run("globalThis.newer=()=>999;f=newer");
  api.remove(h2.hookId);
  assert.ok(run("f===newer"));
  assert.equal(api.read(h2.hookId, 0, 20).restore, "conflict");
});
test("hook preserves thrown value and Promise identity, avoids getters and restores after exception", () => {
  const { api, run } = host();
  run(
    'globalThis.err={message:"原错误"};globalThis.f=()=>{throw err};globalThis.original=f;',
  );
  const h = install(api, "f");
  assert.ok(run("(()=>{try{f()}catch(e){return e===err}})()"));
  assert.ok(run("f===original"));
  assert.equal(api.read(h.hookId, 0, 20).reason, "throw");
  run("globalThis.p=Promise.resolve(42);globalThis.f=()=>p;");
  const h2 = install(api, "f", { count: 1 });
  assert.ok(run("f()===p"));
  assert.match(
    api.read(h2.hookId, 0, 20).entries[0].returnObservation,
    /not awaited/,
  );
  run("globalThis.gets=0;globalThis.obj={get f(){gets++;return()=>1}};");
  assert.throws(() => install(api, "obj.f"));
  assert.equal(run("gets"), 0);
});
test("source index exposes factory boundaries and columns, matching search pagination and changed-file invalidation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-source-"));
  try {
    const code =
      'define("utils/utils.js",function(require,module,exports){exports.getSign=function(x){return "key="+x;};});define("a.js",function(){return "key=two";});';
    fs.writeFileSync(path.join(root, "app-service.js"), code);
    const s = new ModuleSource(),
      list = s.query(root, { action: "list", offset: 0, limit: 1 });
    assert.equal(list.total, 2);
    assert.equal(list.hasMore, true);
    const page = s.query(root, {
      action: "get",
      path: "utils/utils.js",
      offset: 0,
      length: 30,
    });
    assert.equal(page.source, "function(require,module,exports){".slice(0, 30));
    assert.equal(page.hasMore, true);
    const first = s.query(root, {
      action: "search",
      q: "key=",
      offset: 0,
      limit: 1,
    });
    const next = s.query(root, {
      action: "search",
      q: "key=",
      offset: first.nextOffset,
      limit: 1,
    });
    assert.notEqual(first.matches?.[0].path, next.matches?.[0].path);
    const found = s.locate(
      root,
      path.join(root, "app-service.js"),
      1,
      code.indexOf("function(x)") + 1,
    );
    assert.equal(found[0].path, "utils/utils.js");
    fs.appendFileSync(
      path.join(root, "app-service.js"),
      'define("b.js",function(){});',
    );
    assert.equal(
      s.query(root, { action: "list", offset: 0, limit: 10 }).total,
      3,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("same-file duplicate factories require exact identity and stale identities fail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-factories-"));
  try {
    const file = path.join(root, "app-service.js"),
      s = new ModuleSource();
    fs.writeFileSync(
      file,
      'define("same.js",function(){return 1});define("same.js",function(){return 2});',
    );
    const a = {
      action: "get",
      path: "same.js",
      file: "app-service.js",
      offset: 0,
      length: 1000,
    };
    assert.throws(() => s.query(root, a), { code: "MODULE_AMBIGUOUS" });
    const list = s.query(root, {
      action: "list",
      offset: 0,
      limit: 10,
    }).modules;
    assert.notEqual(list[0].factoryId, list[1].factoryId);
    const selected = s.query(root, { ...a, factoryId: list[1].factoryId });
    assert.match(selected.source, /return 2/);
    assert.equal(
      s.locate(root, file, selected.line, selected.column)[0].factoryId,
      selected.factoryId,
    );
    fs.writeFileSync(file, 'define("same.js",function(){return 3});');
    assert.throws(() => s.query(root, { ...a, factoryId: list[1].factoryId }), {
      code: "MODULE_NOT_FOUND",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("generated V8 positions map to the correct original factory and reject changed package source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-factory-map-"));
  try {
    const file = path.join(root, "app-service.js"),
      s = new ModuleSource();
    const original =
      'define("same.js",function first(){return "first"});define("same.js",function second(){return "second"});';
    fs.writeFileSync(file, original);
    const generated = instrumentExecution(original, "app-service.js", {
      modules: ["unselected"],
    }).code;
    const before = generated
      .slice(0, generated.indexOf('return "second"'))
      .split("\n");
    const script = {
      url: file,
      sourceMapURL: generated.split("//# sourceMappingURL=")[1],
    };
    const mapped = s.originalLocation(
      root,
      script,
      before.length,
      before.at(-1)!.length + 1,
    );
    assert.equal(mapped.mapped, true);
    assert.match(
      s.query(root, {
        action: "get",
        path: "same.js",
        factoryId: s.locate(root, mapped.url, mapped.line, mapped.column)[0]
          .factoryId,
        offset: 0,
        length: 1000,
      }).source,
      /second/,
    );
    fs.appendFileSync(file, ";");
    assert.match(
      s.originalLocation(root, script, before.length, before.at(-1)!.length + 1)
        .reason!,
      /does not match/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function netProvider() {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: String(i + 1),
    cursor: i + 1,
    source: i % 2 ? "logic" : "view",
    url: "http://fixture/" + i,
    method: "POST",
    status: i % 3 ? 200 : 500,
    requestHeaders: { authorization: "secret", extra: "x".repeat(10000) },
    context: { handler: "getSign" },
    requestBody: JSON.stringify({ sign: i, value: "原像😀" }),
    requestArtifactId: "body-" + i,
    requestBodyEncoding: "text",
  }));
  const call = async (_: string, a: any) => {
    if (a.id) return rows.find((r) => r.id === a.id);
    const found = rows.filter(
        (r) => a.after === undefined || r.cursor > a.after,
      ),
      entries = (
        a.after === undefined ? found.slice(-a.limit) : found.slice(0, a.limit)
      ).map(({ requestBody, ...rest }) => rest);
    return a.after === undefined
      ? entries
      : {
          entries,
          nextCursor: entries.at(-1)?.cursor ?? a.after,
          latestCursor: 150,
          hasMore: found.length > entries.length,
          gap: a.after === 0,
        };
  };
  return { rows, call };
}
test("network defaults are compact, projections retrieve bodies and filtered cursors never skip scanned records", async () => {
  const { call } = netProvider(),
    all = await queryNetwork(call, networkSchema.parse({ limit: 40 }));
  assert.equal(all.length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(all)) < 20000);
  assert.equal(all[0].requestHeaders, undefined);
  assert.equal(all[0].handler, "getSign");
  assert.equal(all.at(-1).id, "150");
  let after = 0,
    seen: string[] = [],
    r: any;
  do {
    r = await queryNetwork(
      call,
      networkSchema.parse({
        after,
        limit: 11,
        filter: { source: "logic", status: 200, bodyIncludes: "sign" },
        fields: ["id", "cursor", "method"],
      }),
    );
    seen.push(...r.entries.map((x: any) => x.id));
    assert.ok(r.nextCursor > after);
    after = r.nextCursor;
  } while (r.hasMore);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 50);
  const detail = await queryNetwork(call, networkSchema.parse({ id: "1" }));
  assert.equal(detail.requestBodyPreview.parsed.value, "原像😀");
  assert.equal(detail.requestHeaders.authorization, "[REDACTED]");
  assert.equal(detail.requestBodyPreview.artifactId, "body-0");
});
test("network diff protects secrets, reports truncated body uncertainty and keeps initial cursor gaps", async () => {
  const { rows, call } = netProvider();
  const r = await queryNetwork(
    call,
    networkSchema.parse({ action: "diff", idA: "1", idB: "2" }),
  );
  assert.ok(r.changes.some((c: any) => c.path === "/body/sign"));
  assert.ok(!JSON.stringify(r).includes("secret"));
  rows[0].requestBody = "partial";
  (rows[0] as any).requestBodyTruncated = true;
  const q = await queryNetwork(
    call,
    networkSchema.parse({
      after: 0,
      filter: { bodyIncludes: "not-there" },
      maxScan: 150,
    }),
  );
  assert.equal(q.filterIncomplete, true);
  assert.equal(q.unsearchedBodies, 1);
  assert.equal(q.gap, true);
  assert.equal(q.nextCursor, 150);
  assert.equal(q.hasMore, false);
});
