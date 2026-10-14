import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ExecutionExports} from '../src/analysis/execution/export';import {ArtifactStore} from '../src/controller/artifacts';
import {setTimeout as delay} from 'node:timers/promises';
test('execution export streams repeatable bounded pages, reports eviction and never runs business code',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'execution-export-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const artifacts=new ArtifactStore(dir), jobs=new ExecutionExports();let calls:any[]=[];
 const j=jobs.start({runtimeId:'r',sessionId:'s',clientId:'c',runId:'run',revealSensitive:false,artifacts,read:async a=>{calls.push(a);return a.action==='status'?{runs:[{id:'run',state:'stopped'}]}:{entries:[{id:a.after+1,value:'中文'}],nextCursor:a.after+1,hasMore:a.after<2,gap:a.after===1};}});
 while(jobs.get(j.id,'r').state==='running') await delay(1);
 const done=jobs.get(j.id,'r');assert.equal(done.state,'incomplete');assert.equal(done.records,3);
 const file=artifacts.get(done.artifactId).file, first=fs.readFileSync(file,'utf8');assert.equal(first,fs.readFileSync(file,'utf8'));assert.equal(first.trim().split('\n').length,4);
 assert.ok(calls.every(a=>['status','read'].includes(a.action)));
 assert.throws(()=>jobs.cancel(j.id,'r','other'),/OWNED/);
});
