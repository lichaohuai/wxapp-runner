import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { scenario } from "./scenarios";
export class ContractJobs {
  private jobs=new Map<string,any>();
  private children=new Map<string,ChildProcess>();
  constructor(private root:string) {}
  start(scenarioId:string,runtimeId:string,sessionId:string,clientId:string) {
    scenario(scenarioId); // Validate before any side effect.
    if(this.children.size) throw Object.assign(Error("An isolated contract test is already running"),{code:"CONTRACT_TEST_BUSY"});
    if(process.platform!=="darwin") throw Object.assign(Error("Contract window tests are pending platform acceptance"),{code:"PLATFORM_PENDING"});
    if(this.jobs.size>=100) {const oldest=[...this.jobs.keys()].find(id=>!this.children.has(id));if(oldest)this.jobs.delete(oldest);}
    const id="contract:"+randomUUID();
    const row={id,scenarioId,runtimeId,sessionId,clientId,state:"running",status:"已实现未验收",startedAt:new Date().toISOString(),
      executionTarget:"new isolated fixture; selected runtime is not operated",reason:undefined as string|undefined};
    this.jobs.set(id,row);
    const out=path.join(this.root,".local/contract-evidence");fs.mkdirSync(out,{recursive:true});
    const fd=fs.openSync(path.join(out,id.slice(9)+".log"),"w",0o600);
    const env={...process.env,WXAPP_CONTRACT_RUN:"1",...(process.versions.electron?{ELECTRON_RUN_AS_NODE:"1"}:{})};
    const child=spawn(process.execPath,["--import","tsx",path.join(this.root,"scripts/run-contract.ts"),scenarioId],{cwd:this.root,env,stdio:["ignore",fd,fd]});
    fs.closeSync(fd);this.children.set(id,child);
    const timeout=setTimeout(()=>{row.reason="CONTRACT_TEST_TIMEOUT";this.cancelChild(id);},180000);
    child.once("error",()=>{row.reason="CONTRACT_PROCESS_FAILED";});
    child.once("close",code=>{
      clearTimeout(timeout);this.children.delete(id);
      row.state=row.reason?.includes("CANCEL")?"cancelled":code===0&&!row.reason?"completed":"failed";
      row.status=row.state==="completed"?"验收通过":"失败";
      Object.assign(row,{finishedAt:new Date().toISOString(),exitCode:code});
      const file=path.join(out,scenarioId+".json");
      try {
        const receipt=JSON.parse(fs.readFileSync(file,"utf8"));
        if(receipt.startedAt>=row.startedAt) Object.assign(row,{receipt});
        else if(row.state==="completed") throw Error("Old receipt");
        if(row.state==="completed" && receipt.status!=="验收通过") throw Error("Assertion receipt did not pass");
      } catch {if(row.state==="completed") {row.state="failed";row.status="失败";row.reason="CONTRACT_RECEIPT_INVALID";}}
    });
    return this.get(id,runtimeId);
  }
  get(id:string,runtimeId:string) {
    const row=this.jobs.get(id);
    if(!row||row.runtimeId!==runtimeId) throw Error("Contract job not found for this runtime");
    return structuredClone(row);
  }
  list(runtimeId:string) {return [...this.jobs.values()].filter(r=>r.runtimeId===runtimeId).map(r=>structuredClone(r));}
  private cancelChild(id:string) {
    const child=this.children.get(id);child?.kill("SIGTERM");
    const timer=setTimeout(()=>{if(this.children.get(id)===child)child?.kill("SIGKILL");},10000);timer.unref();
  }
  cancel(id:string,runtimeId:string,clientId:string) {
    const row=this.get(id,runtimeId);
    if(clientId!=="human"&&row.clientId!==clientId) throw Error("Contract job belongs to another client");
    if(this.children.has(id)) {this.jobs.get(id).reason="CONTRACT_TEST_CANCELLED";this.cancelChild(id);}
    return this.get(id,runtimeId);
  }
  close() {for(const id of this.children.keys()) {this.jobs.get(id).reason="CONTRACT_TEST_CANCELLED_SERVICE_CLOSE";this.cancelChild(id);}}
}
