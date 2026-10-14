import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {managedFixture,until} from './managed-test-runtime.mjs';import {interactionFixture} from './interaction-fixture.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wxapp-boot-analysis-')),requests=[];
const server=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{requests.push(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({message:'ok'}));});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let t;try{
 const pkg=interactionFixture(root,`http://127.0.0.1:${server.address().port}/fixture`);
 fs.appendFileSync(path.join(pkg,'app-service.js'),`
Object.freeze(String.prototype);Object.defineProperty(String.prototype,'charCodeAt',{writable:false,configurable:false});
globalThis.nv_fixture=String.prototype.charCodeAt;globalThis.bootCheck={marker:globalThis.bootMarker,code:nv_fixture.call('fixture',0)};
define('utils/analysis-fixture.js',function(require,module,exports){exports.digest=function(input){return 'fixture:'+input;};exports.sign=function(input){return exports.digest(input);};});
getApp().analysisUtils=require('utils/analysis-fixture.js');
getApp().sendA=function(input){return new Promise(resolve=>setTimeout(()=>{wx.request({url:${JSON.stringify(`http://127.0.0.1:${server.address().port}/signed`)},method:'POST',data:{message:input,sign:getApp().analysisUtils.sign(input)},success:resolve});},40));};
getApp().sendB=function(input){return new Promise(resolve=>setTimeout(()=>{wx.request({url:${JSON.stringify(`http://127.0.0.1:${server.address().port}/signed`)},method:'POST',data:{message:input,sign:getApp().analysisUtils.sign(input)},success:resolve});},1));};
`);
 t=await managedFixture({packageDir:pkg,config:{analysis:{enabled:true,defeatAntiHook:true,cryptoTap:true,webCrypto:true,observePromise:true,randomSeed:42,bootScript:'globalThis.bootMarker="before-package";',ttlMs:120000,taps:[{target:'String.prototype.charCodeAt',algo:'String.charCodeAt'}]}}});const call=t.call;
 const status=await call('runner_status');assert.match(status.profile,/^analysis-/);assert.equal(status.analysis.enabled,true);
 const boot=(await call('runner_evaluate',{expression:'bootCheck'})).result.value;assert.equal(boot.marker,'before-package');assert.equal(boot.code,102);
 const all=await call('runner_crypto_watch',{action:'read',revealSensitive:true});assert.ok(all.entries.some(e=>e.algo==='String.charCodeAt'&&e.output===102));
 const watch=await call('runner_crypto_watch',{action:'start',target:'fixture:中文😀',auto:false,taps:[{target:{module:'utils/analysis-fixture.js',export:'digest'},algo:'fixture-digest'}]});
 const a=await call('runner_slice',{action:'start',target:'getApp().sendA'}),b=await call('runner_slice',{action:'start',target:'getApp().sendB'});
 await call('runner_evaluate',{expression:'Promise.all([getApp().sendA("中文😀"),getApp().sendB("second")])',awaitPromise:true});
 const matches=await call('runner_crypto_watch',{action:'read',watchId:watch.watchId,revealSensitive:true});assert.equal(matches.entries.length,1);assert.equal(matches.entries[0].input,'中文😀');assert.equal(matches.entries[0].runId,a.runId);
 const hidden=await call('runner_crypto_watch',{action:'read',watchId:watch.watchId});assert.ok(!JSON.stringify(hidden).includes('中文😀'));
 const bs=await call('runner_slice',{action:'read',runId:b.runId,revealSensitive:true});assert.ok(bs.entries.some(e=>e.output==='fixture:second'));assert.ok(!bs.entries.some(e=>e.input==='中文😀'));
 const diff=await call('runner_crypto_watch',{action:'diff',runA:a.runId,runB:b.runId,revealSensitive:true});assert.ok(diff.changes.length);
 const net=await call('runner_network',{filter:{urlIncludes:'/signed'},fields:['id','url','context.analysisRunId']});assert.equal(net.entries.length,2);assert.deepEqual(new Set(net.entries.map(e=>e['context.analysisRunId'])),new Set([a.runId,b.runId]));assert.equal(requests.length,2);
 const expected=createHash('sha256').update('abc').digest('hex');const cryptoWatch=await call('runner_crypto_watch',{action:'start',target:expected,observePromise:true});
 await call('runner_evaluate',{expression:'crypto.subtle.digest("SHA-256",new Uint8Array([97,98,99]))',awaitPromise:true});
 const wc=await until(async()=>{const r=await call('runner_crypto_watch',{action:'read',watchId:cryptoWatch.watchId,revealSensitive:true});return r.entries.length&&r;});assert.equal(wc.entries[0].output.data,expected);
 const o=await call('runner_oracle',{action:'export',target:{module:'utils/analysis-fixture.js',export:'sign'}});const oracle=await call('runner_oracle',{action:'call',oracleId:o.oracleId,args:['verify'],revealSensitive:true});assert.equal(oracle.result,'fixture:verify');assert.equal(requests.length,2);
 const other=await t.newClient();await t.callAs(other,'runner_control',{action:'acquire'});assert.equal((await call('runner_crypto_watch',{action:'status'})).enabled,true);await t.callAs(other,'runner_control',{action:'release'});
 await call('runner_debugger',{action:'open'});const debug=await until(()=>t.app.windows().find(w=>w.url().includes('js_app.html')));await debug.getByRole('tab',{name:'Wxapp',exact:true}).click();const section=debug.getByRole('combobox',{name:'Wxapp section'});await section.selectOption({label:'Crypto 采集'});await debug.getByRole('button',{name:'执行分析命令'}).waitFor();await section.selectOption({label:'启动分析'});await debug.getByRole('button',{name:'新建隔离分析实例'}).waitFor();
 const originalSession=status.sessionId;const invalid=await t.client.callTool({name:'runner_runtime',arguments:{action:'restart',bootScript:'const =;'}});assert.equal(invalid.isError,true);assert.equal((await call('runner_status')).sessionId,originalSession);
 await call('runner_crypto_watch',{action:'stop'});const afterStop=(await call('runner_crypto_watch',{action:'status'})).latestCursor;assert.equal((await call('runner_evaluate',{expression:'nv_fixture.call("A",0)'})).result.value,65);assert.equal((await call('runner_crypto_watch',{action:'status'})).latestCursor,afterStop);
 const result={passed:true,date:new Date().toISOString(),platform:process.platform,standardMcp:true,realBaselib:true,bootBeforeFirstPackage:true,capturedAliasAfterFreeze:true,isolatedProfile:true,actualWebCryptoSha256:true,outputMatch:true,redactedByDefault:true,asyncSlicesReversedCompletion:true,networkCausalIds:true,oracleOneCall:true,readDuringOtherClientLease:true,nativePanel:true,invalidBootPreservesRuntime:true,stopDisablesCapturedAlias:true,liveUserRuntimeTouched:false};fs.writeFileSync('docs/boot-analysis-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await t?.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
