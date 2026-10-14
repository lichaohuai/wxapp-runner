import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {PNG} from 'pngjs';
import {interactionFixture} from './interaction-fixture.mjs';import {managedFixture,until} from './managed-test-runtime.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runner-image-policy-'));const requests=[];
const png=new PNG({width:32,height:32});for(let i=0;i<png.data.length;i+=4){png.data[i]=250;png.data[i+1]=100;png.data[i+2]=20;png.data[i+3]=255;}const bytes=PNG.sync.write(png);
const server=http.createServer((req,res)=>{requests.push({url:req.url,referer:req.headers.referer,host:req.headers.host});res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(bytes);});await new Promise(r=>server.listen(0,r));const port=server.address().port;
const pkg=interactionFixture(dir,'http://127.0.0.1:'+port);
let frame=fs.readFileSync(path.join(pkg,'page-frame.html'),'utf8');frame=frame.replace("n('textarea'",`n('image',{id:'local-image',src:'http://127.0.0.1:${port}/local.png',style:'width:100px;height:100px',bindload:'imageLoaded',binderror:'imageFailed'}),n('image',{id:'remote-image',src:'http://localhost:${port}/external.png',style:'width:100px;height:100px',bindload:'imageLoaded',binderror:'imageFailed'}),n('textarea'`);fs.writeFileSync(path.join(pkg,'page-frame.html'),frame);
let logic=fs.readFileSync(path.join(pkg,'app-service.js'),'utf8').replace("input:'',", "loaded:0,failed:0,input:'',").replace('onInput(e)',`imageLoaded(){this.setData({loaded:this.data.loaded+1})},imageFailed(){this.setData({failed:this.data.failed+1})},onInput(e)`);fs.writeFileSync(path.join(pkg,'app-service.js'),logic);
const report={date:new Date().toISOString(),platform:process.platform,scenarios:[]};
try{for(const mode of ['normal','local-only']){
 const before=requests.length;const t=await managedFixture({packageDir:pkg,config:{analysis:{enabled:mode==='local-only',networkMode:mode}}});
 try{
  const id=(await t.call('runner_state')).pages[0].instanceId;
  const wait=await t.call('runner_wait',{kind:'state',instanceId:id,path:['loaded'],equals:mode==='normal'?2:1});assert.equal(wait.status,'matched');
  const completed=await t.call('runner_wait',{kind:'state',instanceId:id,path:['failed'],equals:mode==='normal'?0:1});assert.equal(completed.status,'matched');
  const targetId='page:'+(await t.call('runner_status')).current.id;const noRef=await t.call('runner_evaluate',{targetId,awaitPromise:true,expression:`new Promise(resolve=>{const image=new Image();image.referrerPolicy='no-referrer';image.onload=()=>resolve(true);image.onerror=()=>resolve(false);image.src='http://localhost:${port}/private.png';})`});assert.equal(noRef.result.value,mode==='normal');const rows=await t.call('runner_network',{after:0,filter:{resourceType:'Image'},limit:30,maxScan:1000});
  const image=rows.entries.find(r=>r.url.includes('/external.png'));assert.ok(image);
  if(mode==='normal'){
   assert.equal(image.status,200);const actual=requests.slice(before).find(r=>r.url==='/external.png');
   assert.equal(actual.referer,'https://servicewechat.com/');
   const detail=await t.call('runner_network',{id:image.id});assert.equal(Object.entries(detail.requestHeaders).find(([k])=>k.toLowerCase()==='referer')?.[1],actual.referer);assert.equal(requests.slice(before).find(r=>r.url==='/private.png').referer,undefined);
  }else{
   assert.equal(image.blockedReason,'ANALYSIS_LOCAL_ONLY');assert.deepEqual(image.ruleIds,['analysis:local-only']);
   assert.equal(requests.slice(before).filter(r=>r.url==='/external.png').length,0);
  }
  const ua=await t.call('runner_evaluate',{expression:'wx.getRendererUserAgent()',awaitPromise:true});
  const expected=await t.call('runner_evaluate',{targetId:'page:'+(await t.call('runner_status')).current.id,expression:'navigator.userAgent'});assert.equal(ua.result.value,expected.result.value);
  const shot=await t.client.callTool({name:'runner_screenshot',arguments:{}});assert.ok(shot.content.some(r=>r.type==='image'));
  const status=await t.call('runner_status');assert.equal(status.loader.stage,'page-ready');
  report.scenarios.push({mode,status:'验收通过',loaded:mode==='normal'?2:1,blocked:mode==='normal'?0:1,requests:requests.length-before,actualReferer:mode==='normal',rendererUA:true,originalCallbacks:true,screenshot:true});
 }finally{await t.close();}
}report.status='验收通过';}catch(e){report.status='失败';report.error=e.message;throw e;}finally{fs.writeFileSync('docs/view-resource-result.json',JSON.stringify(report,null,2)+'\n');server.close();fs.rmSync(dir,{recursive:true,force:true});}console.log(report);
