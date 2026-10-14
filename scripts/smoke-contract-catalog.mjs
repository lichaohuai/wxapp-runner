import assert from "node:assert/strict";
import fs from "node:fs";
import { managedFixture, until } from "./managed-test-runtime.mjs";
const t=await managedFixture({debug:{nativeContractCalls:true}});
try {
  const status=await t.call("runner_status");
  assert.equal(status.contracts.current,true,JSON.stringify(status.contracts));
  const first=await t.call("runner_suite",{action:"contracts",limit:7});
  assert.equal(first.entries.length,7);assert.equal(first.hasMore,true);
  const next=await t.call("runner_suite",{action:"contracts",limit:7,offset:first.nextOffset,fingerprint:first.fingerprint});
  assert.equal(new Set([...first.entries,...next.entries].map(e=>e.id)).size,14);
  const selected=await t.call("runner_suite",{action:"contracts",contractId:"native:view:invoke:loadLibFiles",details:true,limit:1});
  assert.equal(selected.entries.length,1);assert.ok(selected.entries[0].official.length);
  assert.ok(selected.entries[0].verification.scenarios.includes("view-library-batches"));
  const files=await t.call("runner_suite",{action:"contracts",collection:"files",limit:500});
  assert.ok(files.entries.some(f=>f.file==="baselib/WAWorker.js"&&f.status==="scanned"));
  assert.ok(!files.entries.some(f=>f.status==="failed"));
  const exported=await t.call("runner_suite",{action:"contracts",exportReport:true,limit:1});
  assert.ok(exported.artifact.id);
  const readA=await t.call("runner_artifact",{action:"read",id:exported.artifact.id,length:1024});
  const readB=await t.call("runner_artifact",{action:"read",id:exported.artifact.id,length:1024});
  assert.equal(readA.requiresExplicitRawAccess,undefined);assert.equal(readA.redacted,true);
  assert.equal(readA.data,readB.data);assert.ok(readA.hasMore);assert.equal(readA.nextOffset,1024);
  assert.ok(Buffer.from(readA.data,"base64").toString().includes(first.fingerprint));
  const invalid=await t.client.callTool({name:"runner_suite",arguments:{action:"contractRun",scenarioId:"not-registered"}});
  assert.equal(invalid.isError,true);
  assert.equal((await t.call("runner_suite",{action:"list"})).jobs.length,0);
  const stale=await t.client.callTool({name:"runner_suite",arguments:{action:"contracts",fingerprint:"old"}});
  assert.equal(stale.isError,true);
  const value=await t.call("runner_evaluate",{expression:"new Promise(resolve=>internals.WeixinJSBridge.invoke('contractFixtureMissing',{},resolve))",awaitPromise:true});
  assert.equal(value.result.value.runnerCode,"NATIVE_API_UNIMPLEMENTED");
  await until(async()=> (await t.call("runner_status")).loader.nativeContracts.entries.some(e=>e.api==="contractFixtureMissing"&&e.phases.invoked===1));
  let cursor=0,found=false;
  await until(async()=>{
    const events=await t.call("runner_events",{source:"loader",contractId:"native:logic:invoke:contractFixtureMissing",after:cursor,limit:200});
    cursor=events.nextCursor;found ||= events.entries.length>0;
    return found;
  });
  await t.call("runner_debugger",{action:"open"});
  const devtools=await until(()=>t.app.windows().find(p=>p.url().includes("js_app.html")));
  await devtools.getByRole("tab",{name:"Wxapp",exact:true}).click();
  await devtools.getByRole("combobox",{name:"Wxapp section"}).selectOption({label:"官方契约"});
  await devtools.getByText("账本版本与范围",{exact:true}).waitFor();
  await devtools.getByRole("textbox",{name:"契约 ID",exact:true}).fill("native:view:invoke:loadLibFiles");
  await devtools.getByRole("button",{name:"证据、实现与断言",exact:true}).click();
  await devtools.getByText('"scenarioId": "view-library-batches"',{exact:false}).first().waitFor();
  fs.mkdirSync("docs/evidence/native-contracts",{recursive:true});
  await devtools.screenshot({path:"docs/evidence/native-contracts/f12-contracts.png"});
  // Contract jobs are explicit isolated operations. Wait for their receipt,
  // then cancel; no operation is submitted a second time on timeout.
  const job=await t.call("runner_suite",{action:"contractRun",scenarioId:"view-library-batches"});
  assert.ok(job.id.startsWith("contract:"));
  await until(()=>{
    try {const receipt=JSON.parse(fs.readFileSync(".local/contract-evidence/view-library-batches.json","utf8"));return receipt.startedAt>=job.startedAt;}catch{return false;}
  });
  await t.call("runner_suite",{action:"cancel",jobId:job.id});
  const stopped=await until(async()=>{const j=await t.call("runner_suite",{action:"get",jobId:job.id});return j.state!=="running"&&j;});
  assert.equal(stopped.state,"cancelled");
  const completedJob=await t.call("runner_suite",{action:"contractRun",scenarioId:"worker-native-isolation"});
  const completed=await until(async()=>{const j=await t.call("runner_suite",{action:"get",jobId:completedJob.id});return j.state!=="running"&&j;},60000);
  assert.equal(completed.state,"completed",JSON.stringify(completed));assert.equal(completed.receipt.status,"验收通过");
  assert.ok(completed.receipt.observedNativeIds.includes("native:worker:invoke:createRequestTask"));
  const after=await t.call("runner_status");
  assert.equal(after.sessionId,status.sessionId);assert.equal(after.current.id,status.current.id);assert.equal(after.serviceReady,true);
  const result={passed:true,platform:process.platform,fingerprint:first.fingerprint,standardMcpPagination:true,explicitBindings:true,
    staleCursorRejected:true,artifactExport:true,repeatableRedactedArtifactRead:true,invalidJobNoEffects:true,metadataObservations:true,nativeF12:true,
    isolatedCancellation:true,isolatedCompletion:true,selectedRuntimePreserved:true};
  fs.writeFileSync("docs/native-contract-ui-result.json",JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result));
} finally {await t.close();}
