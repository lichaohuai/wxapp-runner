import { ownContractFixture } from "./contract-lifecycle.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scenario } from "../src/contracts/scenarios";
import { contractInputs, inputsFingerprint } from "../src/contracts/fingerprint";
import type { Receipt } from "../src/contracts/evidence";
const root=path.resolve(import.meta.dirname,".."), spec=scenario(process.argv[2]);
const output=path.join(root,".local/contract-evidence");
fs.mkdirSync(output,{recursive:true});
const lockPath=path.join(output,"run.lock");
// Serialize report writers across CLI, the gate, and multiple controllers.
const lock=fs.openSync(lockPath,"wx",0o600);fs.writeSync(lock,String(process.pid));
const release=()=>{fs.closeSync(lock);try{fs.unlinkSync(lockPath);}catch{}};

process.env.WXAPP_CONTRACT_RUN="1";
ownContractFixture(async()=>{});
const receipt:Receipt={scenarioId:spec.id,fingerprint:inputsFingerprint(contractInputs(root,path.resolve(root,"../baselib"))),
  platform:process.platform,startedAt:new Date().toISOString(),status:"已实现未验收",assertions:[]};
const save=()=>fs.writeFileSync(path.join(output,spec.id+".json"),JSON.stringify(receipt,null,2)+"\n");
save();
process.once("exit",code=>{try{if(!receipt.finishedAt){receipt.status="失败";receipt.error="CONTRACT_PROCESS_EXITED_BEFORE_COMPLETION";receipt.exitCode=code;receipt.finishedAt=new Date().toISOString();save();}}finally{release();}});
try {
  if(JSON.parse(fs.readFileSync(path.join(root,"dist/native-contract-build.json"),"utf8")).fingerprint!==receipt.fingerprint) throw Error("Build fingerprint stale; run npm run build before contract tests");
  if(process.platform!=="darwin") {receipt.status="平台待验收";throw Error("Contract UI runner is only validated on macOS");}
  const reportPath=path.join(root,spec.report),before=fs.existsSync(reportPath)?fs.statSync(reportPath).mtimeMs:0;
  await import(pathToFileURL(path.join(root,"scripts",spec.script+".mjs")).href);
  receipt.exitCode=0;
  if(!fs.existsSync(reportPath) || fs.statSync(reportPath).mtimeMs<=before || fs.statSync(reportPath).mtimeMs<Date.parse(receipt.startedAt)) throw Error("Fixture did not create a fresh result");
  const report=JSON.parse(fs.readFileSync(reportPath,"utf8"));
  if(report.passed!==true || report.platform!==process.platform) throw Error("Fixture result/platform mismatch");
  const expected=spec.bindings.flatMap(b=>[...("observedAs" in b ? b.observedAs : b.contracts)]);
  if(!expected.every(id=>report.observedNativeIds?.includes(id))) throw Error("Required native call was not observed in fixture");
  receipt.observedNativeIds=expected;
  for(const assertion of spec.bindings.flatMap(b=>[...b.assertions])) {
    if(report[assertion]!==true) throw Error(`Assertion did not pass: ${assertion}`);
    receipt.assertions.push(assertion);
  }
  if(receipt.fingerprint!==inputsFingerprint(contractInputs(root,path.resolve(root,"../baselib")))) throw Error("Inputs changed during contract test");
  receipt.status="验收通过";
} catch(error:any) {
  if(receipt.status!=="平台待验收") receipt.status="失败";
  receipt.error=error.message;process.exitCode=1;
} finally {receipt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify(receipt));}
