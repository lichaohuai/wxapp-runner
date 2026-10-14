import { RunnerImportIndex } from "../src/contracts/imports";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/controller/artifacts";
import { EventStore } from "../src/controller/events";
import test from "node:test";
import assert from "node:assert/strict";
import { scanSource } from "../src/contracts/scan";
import { contractId } from "../src/contracts/model";
import { evidenceFor, verifyReceipt, type Receipt } from "../src/contracts/evidence";
import { contractScenarios } from "../src/contracts/scenarios";
import { contractPage } from "../src/contracts/query";
import { nativeObservation, NativeContractObservations } from "../src/contracts/observe";
import { NativeBoundaryDiagnostics } from "../src/native-components/boundary";
import { parseTool } from "../src/mcp/tools";
import { isRead } from "../src/controller/control";

test("native AST index resolves immutable bridge aliases and excludes shadowed receivers",()=>{
  const source=`const b=globalThis.WeixinJSBridge; const api='loadJsFiles'; b.invoke(api,{paths:[]},r=>r.errMsg);
    function unrelated(WeixinJSBridge){WeixinJSBridge.invoke('fake',{})} function aliased(){const b={invoke(){}}; b.invoke('fake2')}`;
  const r=scanSource(source,"example.js","view","official");
  assert.equal(r.records.length,1);assert.equal(r.records[0].api,"loadJsFiles");
  assert.deepEqual(r.records[0].requestFields,["paths"]);assert.deepEqual(r.records[0].callbackFields,["errMsg"]);
  assert.equal(r.unresolved.length,2);assert.equal(r.records[0].location.offset,source.indexOf("b.invoke"));
});
test("conditional bridge names retain branch uncertainty and dynamic names retain locations",()=>{
  const r=scanSource(`WeixinJSBridge.invoke(sync?'loadLibFilesSync':'loadLibFiles',{});WeixinJSBridge.invoke(choose(),{});` ,"view.js","view","official");
  assert.deepEqual(r.records.map(r=>r.api),["loadLibFilesSync","loadLibFiles"]);
  assert.equal(r.unresolved.length,2);assert.match(r.records[0].mode,/condition unresolved/);
});
test("rest forwarding bridge is resolved but wrappers with side effects are not certified",()=>{
  const r=scanSource(`function forward(...args){return WeixinJSBridge.invoke(...args)} forward('yes',{});
    function changed(...args){args[0]='else';return WeixinJSBridge.invoke(...args)} changed('no',{});`,"sample.js","logic","official");
  assert.ok(r.records.some(r=>r.api==="yes"));assert.ok(!r.records.some(r=>r.api==="no"));
});
test("Worker APIList reads immutable binding and keeps dynamic extensions unresolved",()=>{
  const r=scanSource(`const names=['createRequestTask','readFile'];const config={APIList:names};const extra={APIList:names.concat(dynamic)};`,"WAWorker.js","worker","official");
  assert.equal(r.records.length,2);assert.equal(r.records[0].kind,"worker-APIList-declaration");assert.equal(r.unresolved.length,1);
});
test("Runner guard candidates require parameter binding and do not imply semantic support",()=>{
  const r=scanSource(`const supported=['loadA','loadB'];function invoke(n){if(supported.includes(n))return 1;if(n==='loadC')throw Error();} const api='loadA';if(api==='unrelated'){};`,"src/native.ts","logic","runner");
  assert.deepEqual(r.records.map(r=>r.api),["loadA","loadB","loadC"]);
  assert.throws(()=>scanSource("function {","bad.js","logic","official"));
});
const receipt=(fingerprint="current"):Receipt=>({scenarioId:"view-library-batches",fingerprint,platform:"darwin",status:"验收通过",exitCode:0,
  startedAt:"2026-09-13T00:00:00Z",finishedAt:"2026-09-13T00:01:00Z",observedNativeIds:["native:view:invoke:loadLibFiles","native:view:invoke:loadJsFiles"],assertions:contractScenarios.find(s=>s.id==="view-library-batches")!.bindings.flatMap(b=>[...b.assertions])});
test("contract evidence rejects stale code, wrong platforms and missing assertions",()=>{
  assert.equal(verifyReceipt(receipt(),"current","darwin").valid,true);
  assert.equal(verifyReceipt(receipt("old"),"current","darwin").reason,"STALE_FINGERPRINT");
  assert.equal(verifyReceipt(receipt(),"current","win32").reason,"OTHER_PLATFORM");
  assert.equal(verifyReceipt({...receipt(),assertions:[]},"current","darwin").valid,false);
  assert.equal(verifyReceipt({...receipt(),exitCode:1},"current","darwin").valid,false);
});
test("latest unfinished/failed attempt prevents old passing receipt from certifying contract",()=>{
  for(const status of ["失败","已实现未验收"] as const) {
    const r=evidenceFor(contractId("view","invoke","loadLibFiles"),[receipt(),{...receipt(),startedAt:"2026-09-13T01:00:00Z",status,exitCode:1}],"current","darwin");
    assert.equal(r[0].status,status);
  }
  assert.deepEqual(evidenceFor("native:view:invoke:unbound",[receipt()],"current","darwin"),[]);
});
test("contract pagination has no omitted rows and refuses cross-fingerprint continuation",()=>{
  const ledger:any={fingerprint:"a",summary:{},contracts:Array.from({length:5},(_,i)=>({id:"c"+i,api:"api"+i,layer:"view",channel:"invoke",official:[],implementation:{entries:[],state:"not-indexed"},verification:{status:"已实现未验收",scenarios:[]}}))};
  let offset=0;const ids:string[]=[];
  for(;;){const page=contractPage(ledger,{offset,limit:2});ids.push(...page.entries.map(r=>r.id));offset=page.nextOffset;if(!page.hasMore)break;}
  assert.equal(new Set(ids).size,5);assert.equal(offset,5);
  assert.throws(()=>contractPage(ledger,{fingerprint:"old"}),/changed/);
  assert.throws(()=>contractPage(ledger,{limit:0}),/pagination/);
  assert.equal(contractPage(ledger,{q:"api3"}).matched,1);
  assert.equal(contractPage(ledger,{contractId:"c0",details:true}).entries[0].implementation.state,"not-indexed");
});
test("native observation never stores payloads or evaluates callback objects",()=>{
  const events:any[]=[];const context={pageId:4,workerId:8,token:"private"};
  const o=nativeObservation("request","worker",context,"call:1",e=>events.push(e));
  o.returned("");o.callback();o.returned('{"errMsg":"request:fail private"}');
  const poison=new Proxy({}, {get(){throw Error("must not inspect");}});o.returned(poison);
  assert.deepEqual(events.map(e=>e.phase),["invoked","returned","callback-delivered","returned","returned"]);
  assert.equal(events[1].outcome,"pending");assert.equal(events[2].outcome,"unknown");
  assert.ok(!JSON.stringify(events).includes("private"));
  assert.doesNotThrow(()=>nativeObservation("safe","view",{},"1",()=>{throw Error();}).returned(""));
});
test("native observations distinguish Worker identities and disclose bounded omissions",()=>{
  const s=new NativeContractObservations(2);
  for(const workerId of [1,2,3]) nativeObservation("request","worker",{workerId},String(workerId),e=>s.record(e)).callback();
  const r=s.snapshot();assert.equal(r.entries.length,2);assert.equal(r.omittedEvents,2);assert.equal(r.entries[0].context.workerId,1);
  const gaps=new NativeBoundaryDiagnostics();gaps.record({api:"unknown",layer:"logic",disposition:"unsupported",context:{workerId:9}});
  assert.equal(gaps.snapshot().entries[0].contractId,"native:worker:invoke:unknown");
});
test("incremental suite schema keeps old calls and validates contract commands before dispatch",()=>{
  assert.equal((parseTool("runner_suite",{}) as any).action,"catalog");
  assert.equal((parseTool("runner_suite",{action:"contracts",collection:"files"}) as any).collection,"files");
  assert.throws(()=>parseTool("runner_suite",{action:"contractRun"}));
  assert.throws(()=>parseTool("runner_suite",{action:"contracts",limit:-1}));
  assert.equal(isRead("runner_suite",{action:"contracts"}),true);
  assert.equal(isRead("runner_suite",{action:"contractRun"}),false);
});

 test("mutated arrays and reassigned bridge wrappers stay unresolved",()=>{
  const worker=scanSource(`const names=['old']; names[0]='new'; const config={APIList:names};`,"WAWorker.js","worker","official");
  assert.equal(worker.records.length,0);assert.ok(worker.unresolved.length);
  const bridge=scanSource(`function call(...args){WeixinJSBridge.invoke(...args)} call=other; call('wrong');`,"sample.js","logic","official");
  assert.ok(!bridge.records.some(r=>r.api==='wrong'));
  assert.equal(verifyReceipt({...receipt(),observedNativeIds:[]},"current","darwin").reason,"NATIVE_CALL_NOT_OBSERVED");
});

test("contract metadata artifacts have repeatable redacted reads; other analysis kinds keep raw-access gate",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"contract-artifact-")), store=new ArtifactStore(dir);
  try {
    const id=store.put({runtimeId:"r",sessionId:"s",kind:"native-contract-ledger",mimeType:"application/json",representation:"metadata-only"},Buffer.from(JSON.stringify({contractId:"c",token:"private-secret",value:"中文"})));
    const a:any=store.read(id),b:any=store.read(id);assert.equal(a.data,b.data);assert.equal(a.redacted,true);
    assert.ok(!Buffer.from(a.data,"base64").toString().includes("private-secret"));
    const other=store.put({runtimeId:"r",sessionId:"s",kind:"heap",mimeType:"application/json"},Buffer.from("{}"));
    const protectedRead=store.read(other);
    assert.ok("requiresExplicitRawAccess" in protectedRead);
    assert.equal(protectedRead.requiresExplicitRawAccess,true);
  } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test("contract event filters advance across unrelated entries and retain Worker/context identity",()=>{
  const s=new EventStore();s.push("r","s","loader",{contractId:"other",context:{workerId:1}});
  s.push("r","s","loader",{contractId:"wanted",callId:"c",context:{workerId:2,contextId:4}});
  const first=s.page({contractId:"wanted",workerId:2,limit:1});assert.equal(first.entries.length,0);assert.equal(first.hasMore,true);
  const second=s.page({contractId:"wanted",workerId:2,contextId:4,callId:"c",after:first.nextCursor,limit:1});
  assert.equal(second.entries.length,1);assert.equal(second.entries[0].context.workerId,2);
  assert.equal(s.page({contractId:"wanted",workerId:1,limit:10}).entries.length,0);
});


test("named imported literal guards resolve with readonly whole-tree consumers",()=>{
  const sources=new Map([
    ['src/ports.ts',`export const names=new Set(['setTabBarItem','showTabBar']);export const other=['one'];`],
    ['src/host.ts',`import {names as tab,other} from './ports';function invoke(name){if(tab.has(name))return 1;if(['direct',...other].includes(name))return 2}`],
  ]);
  const index=new RunnerImportIndex(sources);
  const r=scanSource(sources.get('src/host.ts')!,'src/host.ts','host','runner',(from,name)=>index.read('src/host.ts',from,name));
  assert.deepEqual(r.records.map(r=>r.api),['setTabBarItem','showTabBar','direct','one']);
  assert.equal(r.unresolved.length,0);
});
test("imported guard arrays reject mutations through aliases, other imports and escapes",()=>{
  for(const other of [
    `import {names} from './ports';names.add('changed');`,
    `import {alias} from './ports';alias.clear();`,
    `import * as ports from './ports';ports.names.add('changed');`,
    `export {names} from './ports';`,
    `import {names} from './ports';unknown(names);`,
  ]) {
    const sources=new Map([
      ['src/ports.ts',`export const names=new Set(['old']);export {names as alias};`],
      ['src/host.ts',`import {names} from './ports';function invoke(name){if(names.has(name))return 1}`],
      ['src/other.ts',other],
    ]);
    const index=new RunnerImportIndex(sources);
    assert.equal(index.read('src/host.ts','./ports','names'),undefined,other);
  }
});
test("imported guard index does not evaluate dynamic initializers or misidentify shadowed names",()=>{
  const sources=new Map([
    ['src/ports.ts',`export const names=new Set(getNames());export const literal=['literal'];`],
    ['src/host.ts',`import {literal} from './ports';function invoke(name){const literal=unknown; if(literal.includes(name))return 1}`],
  ]);
  const index=new RunnerImportIndex(sources);
  assert.equal(index.read('src/host.ts','./ports','names'),undefined);
  const r=scanSource(sources.get('src/host.ts')!,'src/host.ts','host','runner',(from,name)=>index.read('src/host.ts',from,name));
  assert.equal(r.records.length,0);assert.equal(r.unresolved.length,1);
});
