import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {managedFixture} from './managed-test-runtime.mjs';import {interactionFixture} from './interaction-fixture.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'loader-lifecycle-')),pkg=interactionFixture(dir,'http://127.0.0.1:1/unused');
let t;const report={date:new Date().toISOString(),platform:process.platform};
try {
 const config=JSON.parse(fs.readFileSync(path.join(pkg,'app-config.json')));
 config.entryPagePath='ind/home.html';config.pages.push('ind/home');config.subPackages=[{root:'ind/',independent:true}];fs.writeFileSync(path.join(pkg,'app-config.json'),JSON.stringify(config));
 fs.mkdirSync(path.join(pkg,'ind'));
 fs.writeFileSync(path.join(pkg,'ind','app-service.js'),`globalThis.indLoads=(globalThis.indLoads||0)+1;App({});__wxRoute='ind/home';__wxRouteBegin=true;Page({data:{ready:true}});`);
 fs.writeFileSync(path.join(pkg,'ind','page-frame.html'),`<script>__wxAppCode__['ind/home.wxss']=function(){};$gwx=function(){return function(){return {tag:'wx-page',children:[{tag:'wx-text',children:['Independent ready'],attr:{},n:[],raw:{},generics:{}}]}}}</script>`);
 fs.writeFileSync(path.join(pkg,'ind','home.html'),`<script>__wxAppCode__['ind/home.wxss']();document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:$gwx('ind/home.wxml')}}));</script>`);
 fs.appendFileSync(path.join(pkg,'app-service.js'),';globalThis.mainLoads=(globalThis.mainLoads||0)+1;');
 fs.writeFileSync(path.join(pkg,'aux.js'),'globalThis.auxCount=(globalThis.auxCount||0)+1;console.log("aux-count",auxCount);');
 fs.writeFileSync(path.join(pkg,'empty.js'),'if(typeof wx!=="undefined") throw Error("Empty context received business APIs");globalThis.emptyReady=true;');
 fs.writeFileSync(path.join(pkg,'broken.js'),'console.log("broken-executed-once");throw Error("fixture broken");');
 t=await managedFixture({packageDir:pkg});
 let status=await t.call('runner_status');assert.equal(status.current.route,'ind/home');assert.equal(status.loader.stage,'page-ready');
 let state=await t.call('runner_evaluate',{expression:'({main:globalThis.mainLoads||0,ind:globalThis.indLoads})'});assert.deepEqual(state.result.value,{main:0,ind:1});
 await t.call('runner_navigate',{method:'navigateTo',url:'/home'});
 state=await t.call('runner_evaluate',{expression:'({main:globalThis.mainLoads,ind:globalThis.indLoads})'});assert.deepEqual(state.result.value,{main:1,ind:1});
 await t.call('runner_navigate',{method:'navigateBack'});
 state=await t.call('runner_evaluate',{expression:'({main:globalThis.mainLoads,ind:globalThis.indLoads})'});assert.deepEqual(state.result.value,{main:1,ind:1});
 Object.assign(report,{status:'验收通过',independentColdWithoutMain:true,mainLaterOnce:true,backWithoutReexecution:true,loader:status.loader});
} catch(e){report.status='失败';report.error=e.message;console.error(t?.logs.join('').slice(-6000));throw e;} finally{fs.writeFileSync('docs/loader-lifecycle-result.json',JSON.stringify(report,null,2)+'\n');await t?.close();fs.rmSync(dir,{recursive:true,force:true});}
console.log(report);
