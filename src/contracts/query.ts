import { evidenceFor } from "./evidence";
import fs from "node:fs";
import path from "node:path";
import { contractInputs, inputsFingerprint } from "./fingerprint";
import { contractScenarios } from "./scenarios";
import type { Ledger } from "./model";
declare const __WXAPP_CONTRACT_BUILD__: string;
export const compiledContractFingerprint = typeof __WXAPP_CONTRACT_BUILD__ === "string" ? __WXAPP_CONTRACT_BUILD__ : undefined;
export function contractPage(ledger: Ledger, args: any = {}) {
  if(args.fingerprint && args.fingerprint!==ledger.fingerprint) throw Object.assign(Error("Contract catalog changed; restart pagination"),{code:"CONTRACT_CURSOR_STALE"});
  const offset=args.offset??0,limit=args.limit??30;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500) throw Error("Invalid contract pagination");
  let rows:any[];
  const collection=args.collection||"contracts";
  if(collection==="files") rows=ledger.files;
  else if(collection==="unresolved") rows=ledger.unresolved;
  else if(collection==="scenarios") rows=contractScenarios.map(s=>({...s,evidence:ledger.contracts.filter(c=>c.verification.scenarios.includes(s.id)).map(c=>({contractId:c.id,...c.verification}))}));
  else if(collection==="contracts") rows=ledger.contracts;
  else throw Error("Unknown contract collection");
  const q=String(args.q||"").toLowerCase();
  rows=rows.filter(r=>(!args.contractId || r.id===args.contractId) && (!args.layer || r.layer===args.layer) &&
    (!args.verdict || r.verification?.status===args.verdict) && (!q || JSON.stringify(r).toLowerCase().includes(q)));
  return {fingerprint:ledger.fingerprint,summary:ledger.summary,collection,matched:rows.length,offset,
    nextOffset:offset+Math.min(limit,Math.max(0,rows.length-offset)),hasMore:offset+limit<rows.length,
    entries:rows.slice(offset,offset+limit).map(r=>collection==="contracts" && !args.details ? {
      id:r.id,api:r.api,layer:r.layer,channel:r.channel,officialLocations:r.official.length,
      entry:r.implementation.state,entryCandidates:r.implementation.entries.length,
      verdict:r.verification.status,scenarios:r.verification.scenarios,
    }:r)};
}
/** The loaded binary, current sources and supplied baselib must all agree.
 * Never certify an old, still-running instance with a newly generated report. */
export class ContractCatalog {
  private cached?: {key:string;until:number;ledger?:Ledger;reason?:string};
  constructor(private root: string, private compiled=compiledContractFingerprint) {}
  read(base:string) {
    const file=path.join(this.root,"docs/native-contracts.json");
    const key=base+":"+(fs.existsSync(file)?fs.statSync(file).mtimeMs:0);
    if(this.cached?.key===key && this.cached.until>Date.now()) return this.cached;
    const result:{key:string;until:number;ledger?:Ledger;reason?:string}={key,until:Date.now()+5000};
    try {
      const ledger:Ledger=JSON.parse(fs.readFileSync(file,"utf8"));
      result.ledger=ledger;
      const receiptDir=path.join(this.root,".local/contract-evidence");
      const receipts=fs.existsSync(receiptDir)?fs.readdirSync(receiptDir).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(fs.readFileSync(path.join(receiptDir,n),"utf8"))).filter(r=>r.scenarioId):[];
      for(const contract of ledger.contracts) {
        const evidence=evidenceFor(contract.id,receipts,ledger.fingerprint,process.platform);
        contract.verification.evidence=evidence;
        contract.verification.status=!evidence.length?null:process.platform!=="darwin"?"平台待验收":evidence.some(e=>e.status==="失败")?"失败":evidence.length&&evidence.every(e=>e.status==="验收通过")?"验收通过":"已实现未验收";
      }
      ledger.summary.assertionVerified=ledger.contracts.filter(c=>c.verification.status==="验收通过").length;
      if(ledger.schemaVersion!==1) result.reason="CONTRACT_SCHEMA_UNSUPPORTED";
      else if(!this.compiled || this.compiled!==ledger.fingerprint) result.reason="CONTRACT_BUILD_STALE";
      else if(inputsFingerprint(contractInputs(this.root,base))!==ledger.fingerprint) result.reason="CONTRACT_INPUTS_STALE";
    } catch {result.reason="CONTRACT_CATALOG_UNAVAILABLE";}
    this.cached=result;return result;
  }
  status(base:string) {
    const {ledger,reason}=this.read(base);
    return {schemaVersion:1,fingerprint:ledger?.fingerprint,compiledFingerprint:this.compiled,current:!reason,
      reason,generatedAt:ledger?.generatedAt,summary:ledger?.summary,
      acceptance:reason ? "已实现未验收" : "See per-contract registered assertions; no global certification"};
  }
  query(base:string,args:any) {
    const {ledger,reason}=this.read(base);
    if(!ledger) throw Object.assign(Error(reason),{code:reason});
    const value=contractPage(ledger,args);
    return {...value,current:!reason,reason,...(reason?{warning:"Historical catalog only; listed passes do not certify this runtime"}:{})};
  }
}
