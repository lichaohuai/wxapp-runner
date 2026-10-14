import fs from "node:fs";
import path from "node:path";
import { officialNativeRegistry } from "./audit-official-native.mjs";
import { generateLedger, ledgerMarkdown } from "../src/contracts/ledger";
const root=path.resolve(import.meta.dirname,"..");
const base=path.resolve(root,"../baselib");
const receiptDir=path.join(root,".local/contract-evidence");
const receipts=fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(fs.readFileSync(path.join(receiptDir,n),"utf8"))) : [];
const registry=officialNativeRegistry(base);
const ledger=generateLedger(root,base,registry,receipts);
fs.mkdirSync(path.join(root,"docs"),{recursive:true});
fs.writeFileSync(path.join(root,"docs/official-native-registry.json"),JSON.stringify(registry,null,2)+"\n");
fs.writeFileSync(path.join(root,"docs/native-contracts.json"),JSON.stringify(ledger,null,2)+"\n");
fs.writeFileSync(path.join(root,"docs/native-contracts.md"),ledgerMarkdown(ledger));
fs.writeFileSync(path.join(root,"docs/native-contracts-unresolved.json"),JSON.stringify({fingerprint:ledger.fingerprint,files:ledger.files.filter(f=>f.status==="failed"),unresolved:ledger.unresolved},null,2)+"\n");
const rank=(api:string)=> /(?:Context|load.*(?:Package|File|Lib)|Plugin|Worker)/i.test(api)?0 : /(?:Route|Page|Tab|HTMLWebView|Image|Video)/i.test(api)?1 : /(?:Storage|File|Request|Socket|UI|Toast)/i.test(api)?2 : /(?:report|log|performance)/i.test(api)?3 :4;
fs.writeFileSync(path.join(root,"docs/native-contracts-queue.json"),JSON.stringify({fingerprint:ledger.fingerprint,
  interpretation:"Triage queue, not confirmed missing APIs; priority by declared capability family, then evidence gaps",
  items:ledger.contracts.filter(c=>c.verification.status!=="验收通过").map(c=>({contractId:c.id,priority:rank(c.api),entry:c.implementation.state,next:c.implementation.state==="not-indexed"?"resolve dispatch/provider before proposing fix":"verify route and bind behavioral assertions"})).sort((a,b)=>a.priority-b.priority||a.contractId.localeCompare(b.contractId))},null,2)+"\n");
console.log(JSON.stringify({fingerprint:ledger.fingerprint,...ledger.summary},null,2));
if (ledger.summary.failed || ledger.summary.unboundTestReferences.length) process.exitCode=1;
