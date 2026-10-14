import type { Verdict } from "./model";
import { contractScenarios } from "./scenarios";
export type Receipt = {
  scenarioId: string; fingerprint: string; platform: string; startedAt: string; finishedAt?: string;
  status: Verdict; observedNativeIds?: string[]; exitCode?: number | null; assertions: string[]; error?: string;
};
export function verifyReceipt(receipt: Receipt, fingerprint: string, platform: string) {
  const scenario = contractScenarios.find(s=>s.id===receipt.scenarioId);
  if (!scenario) return {valid:false,reason:"UNREGISTERED_SCENARIO"};
  if (receipt.fingerprint !== fingerprint) return {valid:false,reason:"STALE_FINGERPRINT"};
  if (receipt.platform !== platform) return {valid:false,reason:"OTHER_PLATFORM"};
  if (receipt.status !== "验收通过") return {valid:true,reason:receipt.status};
  if (receipt.exitCode !== 0 || !receipt.finishedAt || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.finishedAt)) || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) return {valid:false,reason:"INVALID_COMPLETION"};
  if (!scenario.bindings.every(b=>b.assertions.every(a=>receipt.assertions.includes(a)))) return {valid:false,reason:"ASSERTIONS_MISSING"};
  const expected=scenario.bindings.flatMap(b=>[...("observedAs" in b ? b.observedAs : b.contracts)]);
  if(!expected.every(id=>receipt.observedNativeIds?.includes(id))) return {valid:false,reason:"NATIVE_CALL_NOT_OBSERVED"};
  return {valid:true,reason:"REGISTERED_ASSERTIONS_PASSED"};
}
export function evidenceFor(contract: string, receipts: Receipt[], fingerprint: string, platform: string) {
  // Latest attempt wins, including failed, cancelled and unfinished attempts.
  // A stale pass is retained as history only; it never certifies this build.
  return contractScenarios.filter(s=>s.bindings.some(b=>(b.contracts as readonly string[]).includes(contract))).map(s=>{
    const row = receipts.filter(r=>r.scenarioId===s.id).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0];
    const check = row && verifyReceipt(row,fingerprint,platform);
    return {scenarioId:s.id, assertions:s.bindings.filter(b=>(b.contracts as readonly string[]).includes(contract)),
      status: check?.valid ? row!.status : "已实现未验收", reason:check?.reason || "NOT_RUN",
      historicalReceipt:row};
  });
}
