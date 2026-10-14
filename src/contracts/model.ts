export type Layer = "logic" | "view" | "worker" | "host" | "shared";
export type Verdict = "已实现未验收" | "验收通过" | "失败" | "平台待验收";
export type Location = { file: string; sha256: string; offset: number; line: number; column: number };
export type Contract = {
  id: string;
  api: string;
  layer: Layer;
  channel: "invoke" | "event" | "lifecycle";
  official: { kind: string; location: Location; requestFields?: string[]; callbackFields?: string[]; mode?: string }[];
  implementation: { state: "entry-found" | "not-indexed"; entries: Location[]; semanticSupport: "unknown" };
  verification: { status: Verdict | null; evidence: any[]; scenarios: string[] };
  boundaries: string[];
};
export const contractId = (layer: Layer, channel: Contract["channel"], api: string) =>
  `native:${layer}:${channel}:${encodeURIComponent(api)}`;
export type Ledger = {
  schemaVersion: 1;
  generatedAt: string;
  fingerprint: string;
  inputs: { baselibVersion: string; baselib: string; implementation: string; tests: string };
  files: { file: string; sha256: string; bytes: number; owner: string; layer: Layer; status: "scanned" | "failed" | "excluded"; reason?: string }[];
  contracts: Contract[];
  unresolved: { id: string; reason: string; location: Location; candidateApi?: string }[];
  summary: Record<string, any>;
};
