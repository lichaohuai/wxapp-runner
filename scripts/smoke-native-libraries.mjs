import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const file="WAFlexLayout.wasm",bytes=fs.readFileSync(path.resolve("../baselib",file));
const checksum = data => {let hash=2166136261;for(const b of data)hash=Math.imul(hash^b,16777619);return hash>>>0};
const expected={size:bytes.length,hash:checksum(bytes),first:Array.from(bytes.subarray(0,8))};
const t=await managedFixture({debug:{nativeContractCalls:true}});
try {
  const pageId=(await t.call("runner_status")).current.id;
  const evaluate=async(targetId,expression)=>{
    const result=await t.call("runner_evaluate",{targetId,expression,awaitPromise:true});assert.ok(!result.exceptionDetails,JSON.stringify(result));return result.result.value;
  };
  for(const target of ["logic",`page:${pageId}`]) {
    const bridge=target==="logic"?"internals.WeixinJSBridge":"WeixinJSBridge";
    const r=await evaluate(target,`(async()=>{
      const bridge=${bridge},rows=[];
      for(const api of ['loadWAFile','loadWAFileSync']) {
        const order=[];let calls=0;
        const value=await new Promise(resolve=>{bridge.invoke(api,{filename:${JSON.stringify(file)}},r=>{calls++;order.push('callback');resolve(r)});order.push('return')});
        const data=new Uint8Array(value.arrayBuffer);let hash=2166136261;for(const b of data)hash=Math.imul(hash^b,16777619);
        rows.push({api,errMsg:value.errMsg,valid:Object.prototype.toString.call(value.arrayBuffer)==='[object ArrayBuffer]',size:data.length,hash:hash>>>0,first:Array.from(data.slice(0,8)),order,calls});
      }
      return rows;
    })()`);
    for(const value of r) {
      assert.equal(value.errMsg,value.api+":ok");assert.equal(value.valid,true);assert.equal(value.calls,1);
      assert.deepEqual({size:value.size,hash:value.hash,first:value.first},expected);
      assert.deepEqual(value.order,value.api.endsWith("Sync")?["callback","return"]:["return","callback"]);
    }
    for(const filename of ["app-service.js","../package/app-service.js"]) {
      const result=await evaluate(target,`new Promise(resolve=>${bridge}.invoke('loadWAFile',{filename:${JSON.stringify(filename)}},r=>resolve({errMsg:r.errMsg,hasBuffer:!!r.arrayBuffer})))`);
      assert.match(result.errMsg,/loadWAFile:fail /);assert.equal(result.hasBuffer,false);
    }
  }
  const observations=await until(async()=>{
    const s=(await t.call("runner_status")).loader.nativeContracts;
    return ["logic","view"].every(layer=>s.entries.some(e=>e.layer===layer&&e.api==="loadWAFile"&&e.phases['callback-delivered']))&&s.entries;
  });
  const report={passed:true,platform:process.platform,officialFoundationBytes:true,originalBridgeBinaryDecode:true,syncAsyncCallbackOrder:true,
    absentLibraryFails:true,packageDirectoryRejected:true,callbackOnce:true,observedNativeIds:[...new Set(observations.map(e=>e.contractId))]};
  fs.writeFileSync("docs/native-libraries-result.json",JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));
}finally{await t.close();}
