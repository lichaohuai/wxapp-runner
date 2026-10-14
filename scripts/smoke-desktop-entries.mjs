import fs from 'node:fs';import path from 'node:path';
import {managedFixture} from './managed-test-runtime.mjs';
const samples=JSON.parse(fs.readFileSync('docs/desktop-loader-packages-result.json')).packages.slice(4);
const results=[];
for(const sample of samples){
 let t;const row={appid:sample.appid,packageSha256:sample.sha256,pages:sample.pages,accountUsed:false};
 const logFile=path.resolve('.local/loader-context-20260912',sample.appid+'-entry.log');const savedError=console.error;
 console.error=(...args)=>fs.appendFileSync(logFile,args.map(String).join(' ')+'\n',{mode:0o600});
 try{
  t=await managedFixture({packageDir:path.resolve(sample.relativeDirectory),appid:sample.appid,config:{loaderAdapter:'official',analysis:{enabled:false,networkMode:'normal'}}});
  const visible=await t.call('runner_wait',{kind:'element',selector:'wx-view,wx-text,wx-button,wx-image,wx-scroll-view',stableMs:0,timeoutMs:15000});
  const status=await t.call('runner_status');const snapshot=await t.call('runner_snapshot');
  const flow=t.logs.join('').match(/(?:expect START descriptor|FLOW_(?:DEPTH|APPLY_PROPERTY|SET_PLACEHOLDER))/g)||[];
  const images=await t.call('runner_network',{summary:true,filter:{resourceType:'Image'},limit:100});
  Object.assign(row,{route:status.current?.route,serviceReady:status.serviceReady,ready:status.current?.ready,routed:status.current?.routed,failed:status.current?.failed,visible:visible.status==='matched',textLength:snapshot.text.length,flowErrors:flow.length,imagesObserved:images.entries.length,imagesSucceeded:images.entries.filter(x=>x.status>=200&&x.status<400).length,businessFlowTested:false,status:visible.status==='matched'&&!flow.length?'验收通过':'失败',scope:'匿名入口加载与页面可见；完整业务及其他路由未由此验收'});
 }catch(e){Object.assign(row,{status:'失败',error:String(e.message).slice(0,400)});}
 finally{console.error=savedError;if(t){fs.writeFileSync(logFile,t.logs.join(''),{mode:0o600});await t.close();}}
 results.push(row);fs.writeFileSync('docs/desktop-loader-entries-result.json',JSON.stringify({date:new Date().toISOString(),platform:process.platform,results},null,2)+'\n');console.log(JSON.stringify(row));
}
