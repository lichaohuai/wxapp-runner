import { RunnerImportIndex } from "./imports";
import fs from "node:fs";
import path from "node:path";
import { contractId, type Contract, type Ledger } from "./model";
import { filesUnder, digest, contractInputs, inputsFingerprint } from "./fingerprint";
import { scanSource, layerFor } from "./scan";
import { evidenceFor, type Receipt } from "./evidence";
import { contractScenarios } from "./scenarios";

export function generateLedger(root: string, base: string, registry: any, receipts: Receipt[] = []): Ledger {
  const inputs = contractInputs(root,base), fingerprint = inputsFingerprint(inputs);
  const files: Ledger["files"] = [], unresolved: Ledger["unresolved"] = [];
  const official: any[] = [], implementations: any[] = [];
  const runnerSources=new Map(filesUnder(path.join(root,"src")).filter(f=>/\.(js|ts)$/.test(f))
    .map(f=>["src/"+path.relative(path.join(root,"src"),f).split(path.sep).join("/"),fs.readFileSync(f,"utf8")]));
  const runnerImports=new RunnerImportIndex(runnerSources);
  for (const [owner, directory] of [["official",base],["runner",path.join(root,"src")]] as const) {
    for (const absolute of filesUnder(directory)) {
      const relative = path.relative(directory,absolute).split(path.sep).join("/");
      const file = `${owner === "official" ? "baselib" : "src"}/${relative}`;
      const layer = layerFor(relative), source = fs.readFileSync(absolute);
      const entry: Ledger["files"][number] = {file,owner,layer,sha256:digest(source),bytes:source.byteLength,status:"excluded"};
      files.push(entry);
      if (!/\.(?:js|ts)$/.test(file)) {entry.reason="Non-JavaScript asset; fingerprint retained";continue;}
      try {
        const result=scanSource(source.toString("utf8"),file,layer,owner,owner==="runner"?(from,name)=>runnerImports.read(file,from,name):undefined);
        (owner === "official" ? official : implementations).push(...result.records);
        unresolved.push(...result.unresolved);
        entry.status="scanned";
      } catch(error:any) {
        entry.status="failed";entry.reason=String(error.message).slice(0,500);
      }
    }
  }
  const registrationFile=files.find(f=>f.file===`baselib/${registry.sourceFile}`);
  if (!registrationFile || registrationFile.sha256 !== registry.sha256) throw Error("Official registration index fingerprint mismatch");
  for (const row of registry.entries) {
    const location={file:registrationFile.file,sha256:registry.sha256,...row.registration};
    if (!row.api) {
      unresolved.push({id:`registration:${row.registration.offset}`,location,reason:row.unknownBoundary || "Unresolved registered name"});continue;
    }
    official.push({id:contractId("host","invoke",row.api),api:row.api,layer:"host",channel:"invoke",kind:"official-pc-registration",location,
      module:row.module,mode:row.registrationKind,unknownBoundary:row.unknownBoundary});
  }
  const contracts = new Map<string,Contract>();
  for (const item of official) {
    let row=contracts.get(item.id);
    if (!row) {
      row={id:item.id,api:item.api,layer:item.layer,channel:item.channel,official:[],
        implementation:{state:"not-indexed",entries:[],semanticSupport:"unknown"},
        verification:{status:null,evidence:[],scenarios:[]},boundaries:[]};
      contracts.set(item.id,row);
    }
    row.official.push(item);
  }
  // Matching API spelling only supplies candidate entrypoints, not a proven
  // route between contexts. Never interpret absence as unsupported or canIUse.
  for(const row of contracts.values()) {
    const candidates=implementations.filter(i=>i.api===row.api);
    row.implementation={state:candidates.length ? "entry-found" : "not-indexed",entries:candidates.map(i=>i.location),semanticSupport:"unknown"};
    row.boundaries.push("Source-family layer; actual calling context requires runtime evidence", "Name guard candidates require route/return/callback verification");
    if (!candidates.length) row.boundaries.push("No statically resolved guard; indirect/dynamic dispatch or missing implementation remains unclassified");
    row.verification.evidence=evidenceFor(row.id,receipts,fingerprint,process.platform);
    row.verification.scenarios=row.verification.evidence.map(e=>e.scenarioId);
    // Status always covers registered assertions ONLY. Unbound contracts remain
    // unverified even if a handler exists or runtime call returned :ok.
    if (row.verification.evidence.length) row.verification.status="已实现未验收";
    if (row.verification.evidence.some(e=>e.status==="失败")) row.verification.status="失败";
    else if(row.verification.evidence.length && row.verification.evidence.every(e=>e.status==="验收通过")) row.verification.status="验收通过";
    if(process.platform !== "darwin" && row.verification.evidence.length) row.verification.status="平台待验收";
  }
  const rows=[...contracts.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const unbound=contractScenarios.flatMap(s=>s.bindings.flatMap(b=>b.contracts.filter(id=>!contracts.has(id)).map(id=>({scenarioId:s.id,contractId:id}))));
  return {schemaVersion:1,generatedAt:new Date().toISOString(),fingerprint,inputs,files,contracts:rows,unresolved,
    summary:{contracts:rows.length,scanned:files.filter(f=>f.status==="scanned").length,failed:files.filter(f=>f.status==="failed").length,
      excluded:files.filter(f=>f.status==="excluded").length,unresolved:unresolved.length,
      entryFound:rows.filter(r=>r.implementation.state==="entry-found").length,
      notIndexed:rows.filter(r=>r.implementation.state==="not-indexed").length,
      assertionVerified:rows.filter(r=>r.verification.status==="验收通过").length,
      scenarioBound:rows.filter(r=>r.verification.scenarios.length).length,unboundTestReferences:unbound,
      completeness:"Every enumerated file accounted for; unresolved calls and runtime-generated code are not complete semantic coverage",
      scope:"Registered assertions only; not complete API certification",nativeJsVersionPair:"unconfirmed",platform:process.platform}};
}
export function ledgerMarkdown(ledger: Ledger) {
  const esc=(s:string)=>s.replace(/\|/g,"\\|").replace(/[\r\n]/g," ");
  return `# 官方契约差异账本\n\n生成时间：${ledger.generatedAt}\n\n指纹：\`${ledger.fingerprint}\`\n\n此表的通过状态仅认证显式绑定的断言。入口候选、成功回调、完整 API 语义三者分别判断；未索引不等于未实现。源码文件族用于初始分类，实际上下文需运行证据。动态名称及未确认绑定保留在 JSON unresolved；所有文件的扫描成败见 files。原生 4.1.9 与 JS ${ledger.inputs.baselibVersion} 配套关系未确认。\n\n`+
    `扫描 ${ledger.summary.scanned}，失败 ${ledger.summary.failed}，非代码资产 ${ledger.summary.excluded}；契约 ${ledger.summary.contracts}，未知调用点 ${ledger.summary.unresolved}。\n\n| 契约 ID | 官方证据数 | Runner 候选入口 | 验收状态（已登记断言范围） | 场景 |\n|---|---:|---:|---|---|\n`+
    ledger.contracts.map(r=>`| ${esc(r.id)} | ${r.official.length} | ${r.implementation.entries.length || "未索引"} | ${r.verification.status ?? "—（未登记断言，尚未分类）"} | ${r.verification.scenarios.join(", ") || "未绑定"} |`).join("\n")+"\n";
}
