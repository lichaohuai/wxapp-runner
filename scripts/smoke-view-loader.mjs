import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-view-loader-"));
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
// Official Page.load hands the complete code list to one PageFrame eval call.
// A microtask from the first file must see all subsequent registration files.
fs.writeFileSync(path.join(pkg, "page-frame.js"), `
window.bootOrder=['frame'];let bootLexical=7;
Promise.resolve().then(()=>window.bootObserved=window.bootOrder.slice());
`);
fs.writeFileSync(path.join(pkg, "app-wxss.js"),
  "window.bootOrder.push('style');window.bootLexicalResult=bootLexical+1;");
for (const [file, step] of [["page-frame.html", "template"], ["home.html", "page"]]) {
  const source = fs.readFileSync(path.join(pkg, file), "utf8");
  fs.writeFileSync(path.join(pkg, file), source.replace("<script>", `<script>window.bootOrder.push('${step}');`));
}
for (const [name, source] of Object.entries({
  "lazy-a.js":
    "window.lazyOrder=['a'];window.lazyLoads=(window.lazyLoads||0)+1;",
  "lazy-b.js":
    "if(window.lazyOrder?.[0]!=='a')throw Error('dependency not evaluated');window.lazyOrder.push('b');",
  "lazy-shared.js": "window.sharedLoads=(window.sharedLoads||0)+1;",
  "lazy-fail.js":
    "window.failedLoads=(window.failedLoads||0)+1;throw Error('partial dynamic script failure');",
  "lazy-invalid.js": "window.invalidLoads=(window.invalidLoads||0)+1;",
  "batch-first.js":
    "window.batchOrder=['first'];Promise.resolve().then(()=>window.batchObserved=window.batchOrder.slice());",
  "batch-second.js": "window.batchOrder.push('second');",
}))
  fs.writeFileSync(path.join(pkg, name), source);
const t = await managedFixture({ packageDir: pkg, debug:{nativeContractCalls:true} });
try {
  const readAllLogs=async filters=>{
    let after=0;const entries=[];
    for(let pageCount=0;pageCount<100;pageCount++) {
      const page=await t.call("runner_logs",{...filters,after,limit:200});
      assert.ok(!page.gap,"Required startup evidence was evicted");
      entries.push(...page.entries);after=page.nextCursor;
      if(!page.hasMore)return entries;
    }
    throw Error("Startup evidence read exceeded bounded pagination budget");
  };
  const targetId = `page:${(await t.call("runner_status")).current.id}`;
  const evaluate = async (expression) => {
    const result = await t.call("runner_evaluate", {
      targetId,
      expression,
      awaitPromise: true,
    });
    assert.ok(!result.exceptionDetails, JSON.stringify(result));
    return result.result.value;
  };
  const warm = await evaluate(
    `({ libraryLoads: performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === '/baselib/WAWebview.js').length, route: __wxRoute, preload: __wxConfig.preload })`,
  );
  assert.deepEqual(warm, { libraryLoads: 1, route: "home", preload: false });
  const sdk = await evaluate(`Promise.all([getRecordSDK(),getRecordSDK()]).then(([a,b])=>({same:a===b,init:typeof a?.init?.init,teardown:typeof a?.init?.teardown,loads:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname==='/baselib/WARecordSDK.js').length}))`);
  assert.deepEqual(sdk, {same:true,init:'function',teardown:'function',loads:1});
  const absentLibrary = await evaluate(`new Promise(resolve=>WeixinJSBridge.invoke('loadLibFiles',{paths:['app-service.js']},resolve))`);
  assert.match(absentLibrary.errMsg, /loadLibFiles:fail.*absent/);
  assert.deepEqual(await evaluate("window.bootObserved"), ["frame", "template", "style", "page"]);
  assert.equal(await evaluate("window.bootLexicalResult"), 8);
  const frames = (await t.call("runner_status")).loader.pageFrames;
  assert.ok(
    frames.some(
      (f) => f.route === "home" && f.preloaded && f.configured && f.routed,
    ),
  );
  const loaderEvents = await readAllLogs({source:"loader"});
  const ordered = loaderEvents
    .filter((e) =>
      [
        "page-preload-start",
        "page-preload-ready",
        "page-preload-consumed",
      ].includes(e.type),
    )
    .map((e) => e.type);
  assert.deepEqual(ordered, [
    "page-preload-start",
    "page-preload-ready",
    "page-preload-consumed",
  ]);
  const programEvents = (await readAllLogs({ source: "view" }))
    .filter((e) => e.type === "view-program-stage").map((e) => e.args[0]);
  assert.deepEqual(programEvents.map((e) => e.stage), ["reading", "executed"]);
  assert.equal(programEvents[1].scriptCount, 4);
  await evaluate(
    `globalThis.loadViewBatch = paths => new Promise(resolve => WeixinJSBridge.invoke('loadJsFiles',{paths}, r => resolve({errMsg:r.errMsg,order:window.lazyOrder?.slice(),loads:window.lazyLoads||0,shared:window.sharedLoads||0,failed:window.failedLoads||0,invalid:window.invalidLoads||0}))); true`,
  );
  assert.equal((await evaluate("loadViewBatch(['page-frame.js','app-wxss.js'])")).errMsg, "loadJsFiles:ok");
  assert.deepEqual(await evaluate("window.bootOrder"), ["frame", "template", "style", "page"]);
  assert.equal(await evaluate("window.bootLexicalResult"), 8);
  const loaded = await evaluate(`loadViewBatch(['/lazy-a.js','lazy-b.js'])`);
  assert.equal(loaded.errMsg, "loadJsFiles:ok");
  assert.deepEqual(loaded.order, ["a", "b"]);
  assert.equal(loaded.loads, 1);
  assert.equal(
    (await evaluate(`loadViewBatch(['lazy-a.js','lazy-b.js'])`)).loads,
    1,
  );
  const shared = await evaluate(
    `Promise.all([loadViewBatch(['lazy-shared.js']),loadViewBatch(['lazy-shared.js'])])`,
  );
  assert.ok(
    shared.every((r) => r.errMsg === "loadJsFiles:ok" && r.shared === 1),
  );
  await evaluate(`loadViewBatch(['batch-first.js','batch-second.js'])`);
  assert.deepEqual(await evaluate("window.batchObserved"), ["first", "second"]);
  const invalid = await evaluate(`loadViewBatch(['lazy-invalid.js',42])`);
  assert.match(invalid.errMsg, /:fail/);
  assert.equal(invalid.invalid, 0);
  const absent = await evaluate(`loadViewBatch(['does-not-exist.js'])`);
  assert.match(absent.errMsg, /:fail.*absent/);
  for (let i = 0; i < 2; i++) {
    const failed = await evaluate(`loadViewBatch(['lazy-fail.js'])`);
    assert.match(failed.errMsg, /:fail.*partial dynamic script failure/);
    assert.equal(failed.failed, 1);
  }
  assert.equal((await t.call("runner_status")).state, "running");
  let cursor = 0;
  await until(async () => {
    const page = await t.call("runner_logs", { after: cursor, limit: 200, source: "view", level: "error" });
    assert.ok(!page.gap);
    cursor = page.nextCursor;
    return page.entries.some(e => e.args?.[0] === "VIEW LAZY FILES FAILED" &&
      e.args?.[2]?.paths?.includes("lazy-fail.js") && e.args[2].stack.includes("partial dynamic script failure"));
  });
  const observations=await until(async()=>{
    const entries=(await t.call("runner_status")).loader.nativeContracts.entries;
    return entries.find(e=>e.api==="loadJsFiles"&&e.layer==="view"&&e.phases["callback-delivered"]) && entries;
  });
  assert.ok(observations.some(e=>e.api==="loadLibFiles"&&e.context.pageId===Number(targetId.split(":")[1])));
  const report = {
    observedNativeIds: [...new Set(observations.filter(e=>e.layer==="view"&&e.phases.invoked).map(e=>e.contractId))],
    nativeContractViewCallbacks: true,
    passed: true,
    platform: process.platform,
    callbackAfterExecution: true,
    actualBaseLibraryWarmup: true,
    actualAuxiliaryLibrary: true,
    auxiliaryLibrarySharedOnce: true,
    auxiliaryLibraryRejectsPackageFile: true,
    sameDocumentConsumedOnce: true,
    separatePreloadAndBindingAcknowledgements: true,
    orderedDependencies: true,
    batchCompletesBeforeMicrotasks: true,
    initialProgramCompletesBeforeMicrotasks: true,
    initialProgramRetainsGlobalLexicalBindings: true,
    initialAndDynamicLoadsShareCache: true,
    initialProgramStagesAvailableThroughMcp: true,
    sharedLoadOnce: true,
    leadingSlash: true,
    invalidArgumentsNoEffects: true,
    missingScriptFails: true,
    executionFailureNotReplayed: true,
    scriptFailureStructuredErrorLog: true,
  };
  fs.writeFileSync(
    "docs/view-loader-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
