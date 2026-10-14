import { contractId, type Layer } from "./model";
export function contractContext(context:any={}) {
  const result:any={};
  for(const key of ["pageId","contextId","workerId"]) if(Number.isSafeInteger(context?.[key]))result[key]=context[key];
  for(const key of ["operationId","rootOperationId"]) if(typeof context?.[key]==="string")result[key]=context[key].slice(0,120);
  return result;
}
function outcome(value:any) {
  // Do not execute getters/Proxy traps on opaque returned objects.
  if(typeof value!=="string") return "unknown";
  if(!value) return "pending";
  if(value.length>65536) return "unknown";
  try {
    const msg=JSON.parse(value)?.errMsg;
    return typeof msg!=="string" ? "unknown" : /:fail\b/.test(msg) ? "failure" : /:ok\b/.test(msg) ? "success" : "unknown";
  } catch{return "unknown";}
}
export function nativeObservation(api:string,layer:Layer,context:any,id:string,sink:(e:any)=>void) {
  const base={type:"native-contract-call",contractId:contractId(layer,"invoke",api),api:api.slice(0,160),layer,context:contractContext(context),callId:id};
  const emit=(phase:string,result="unknown")=>{try{sink({...base,phase,outcome:result});}catch{ /* Diagnostics must not alter bridge behavior. */ }};
  emit("invoked");
  return {returned:(value:any)=>emit("returned",outcome(value)),callback:()=>emit("callback-delivered"),threw:()=>emit("threw","failure"),discarded:()=>emit("callback-discarded")};
}
export class NativeContractObservations {
  private rows=new Map<string,any>();
  private events=0;private omitted=0;
  constructor(private limit=256) {}
  record(event:any) {
    if(!["logic","worker","view"].includes(event.layer)||typeof event.api!=="string")return;
    if(!["invoked","returned","callback-delivered","callback-discarded","threw"].includes(event.phase))return;
    this.events++;
    const context=contractContext(event.context), id=contractId(event.layer,"invoke",event.api.slice(0,160));
    const key=JSON.stringify([id,context.pageId,context.contextId,context.workerId]);
    let row=this.rows.get(key);
    if(!row) {
      if(this.rows.size>=this.limit){this.omitted++;return;}
      row={contractId:id,api:event.api.slice(0,160),layer:event.layer,context,phases:{},outcomes:{}};this.rows.set(key,row);
    }
    row.phases[event.phase]=(row.phases[event.phase]||0)+1;
    const result=["success","failure","pending"].includes(event.outcome)?event.outcome:"unknown";
    row.outcomes[result]=(row.outcomes[result]||0)+1;
  }
  snapshot(){return {events:this.events,omittedEvents:this.omitted,truncated:this.omitted>0,limit:this.limit,entries:structuredClone([...this.rows.values()]),scope:"Native boundary delivery only; callbacks do not certify business completion; opaque callback results are not inspected"};}
}
