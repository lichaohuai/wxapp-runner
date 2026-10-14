import { nativeCurrentRoute } from "../src/loader/navigation";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeLibraries } from "../src/native-components/libraries";
import { officialModule } from "../src/loader/official-module";
const base = path.resolve("../baselib");
const decode = (v:any) => v.__nativeBuffers__ ? Buffer.from(v.__nativeBuffers__[0].base64, "base64") : undefined;

test("foundation read port matches official bytes, once-only callback and sync/async order", async()=>{
  const native = new NativeLibraries(base);
  const file="WAFlexLayout.wasm",expected=fs.readFileSync(path.join(base,file));
  const official=officialModule(base,"./src/base/program/jsapi/fs/loadWAFile.ts",{
    "./src/common/base/file.ts":{readLibSync:(f:string)=>fs.readFileSync(path.join(base,f))},
    "./src/common/base/util.ts":{noop(){},bufferToArray:(b:Buffer)=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)},
  }).exports;
  for(const api of ["loadWAFile","loadWAFileSync"]) {
    const order:string[]=[];let count=0;let value:any;
    const returned=native.invoke(api,{filename:file},r=>{order.push("callback");count++;value=r});
    order.push("return");
    if(api.endsWith("Sync")){assert.equal(count,0);value=JSON.parse(returned!);}
    else {assert.equal(returned,"");assert.deepEqual(order,["return"]);await new Promise(r=>setImmediate(r));assert.deepEqual(order,["return","callback"]);assert.equal(count,1);}
    assert.equal(value.errMsg,api+":ok");assert.deepEqual(decode(value),expected);
    const original=await new Promise<any>(resolve=>official[api]({filename:file},resolve));
    assert.equal(original.errMsg,value.errMsg);assert.deepEqual(Buffer.from(original.arrayBuffer),decode(value));
  }
  assert.equal(native.invoke("notLibrary",{},()=>assert.fail()),undefined);
  assert.equal(native.provenance.module,"./src/base/program/jsapi/fs/loadWAFile.ts");
});

test("foundation reads reject paths/escapes without evaluating scripts or leaking host paths",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"foundation-read-"));
  try {
    fs.copyFileSync(path.join(base,"WAPCAdapterAppIndex.js"),path.join(dir,"WAPCAdapterAppIndex.js"));
    fs.writeFileSync(path.join(dir,"inert.js"),"throw Error('MUST NOT EXECUTE');\u0000中文🙂");
    fs.symlinkSync(path.join(base,"WAFlexLayout.wasm"),path.join(dir,"escape.wasm"));
    const native=new NativeLibraries(dir);
    for(const filename of [undefined,42,"", "../baselib/WAFlexLayout.wasm","https://x/a", "a?x", "a\\b", "escape.wasm","absent.wasm","app-service.js"]) {
      const value=JSON.parse(native.invoke("loadWAFileSync",{filename},()=>assert.fail())!);
      assert.match(value.errMsg,/^loadWAFileSync:fail /);assert.equal(value.__nativeBuffers__,undefined);assert.ok(!value.errMsg.includes(dir));
    }
    const result=JSON.parse(native.invoke("loadWAFileSync",{filename:"/inert.js"},()=>assert.fail())!);
    assert.deepEqual(decode(result),fs.readFileSync(path.join(dir,"inert.js")));
    const failed=await new Promise<any>(resolve=>native.invoke("loadWAFile",{filename:"absent"},resolve));assert.match(failed.errMsg,/^loadWAFile:fail /);
    let alive=true,count=0;native.invoke("loadWAFile",{filename:"inert.js"},()=>count++,()=>alive);alive=false;
    await new Promise(r=>setImmediate(r));assert.equal(count,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test("current route aliases match the original PC lifecycle export", async()=>{
  let route="";
  const official=officialModule(base,"./src/app/index/jsapi/lifecycle.ts",{
    "./src/common/base/binding/xweb.ts":{},
    "./src/common/base/logger/index.ts":{},
    "./src/common/base/util.ts":{noop(){}},
    "./src/app/index/index.tsx":{navigator:{get currentRoute(){return route}}},
  }).exports;
  for(route of ["","home.html","feature/nested.html"]) {
    const value:any=await new Promise(resolve=>official.getCurrentRoute({},resolve));
    assert.deepEqual(nativeCurrentRoute(route),JSON.parse(JSON.stringify(value)));
  }
});
