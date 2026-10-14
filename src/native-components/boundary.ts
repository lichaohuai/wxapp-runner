import { contractId } from "../contracts/model";
/** Explicit SDK telemetry sinks. Local receipt is not a WeChat upload.
 * No prefix rule may turn an unknown state-changing API into success. */
const localTelemetry = new Set(["reportIDKey", "reportKeyValue"]);
export function nativeFallback(api: string) {
  return localTelemetry.has(api)
    ? { errMsg: api + ":ok", runnerDisposition: "local-only" as const }
    : {
        errMsg: api + ":fail native API is not implemented",
        runnerCode: "NATIVE_API_UNIMPLEMENTED",
        runnerDisposition: "unsupported" as const,
      };
}
export type BoundaryObservation = {
  api: string;
  layer: "logic" | "view" | "worker";
  disposition: "local-only" | "unsupported";
  context?: { pageId?: number; contextId?: number; workerId?: number };
};
/** Bounded metadata only, never request parameters, tokens or bodies.
 * This is an observed gap inventory, not an inferred compatibility score. */
export class NativeBoundaryDiagnostics {
  private rows = new Map<string, any>();
  private totals = {
    calls: 0,
    unsupported: 0,
    localOnly: 0,
    unretainedCalls: 0,
  };
  constructor(private limit = 64) {}
  record(observation: BoundaryObservation) {
    const { disposition } = observation;
    const layer = observation.context?.workerId !== undefined ? "worker" : observation.layer;
    const api = String(observation.api).slice(0, 160);
    const key = `${layer}:${disposition}:${api}`;
    this.totals.calls++;
    this.totals[disposition === "unsupported" ? "unsupported" : "localOnly"]++;
    let row = this.rows.get(key);
    const first = !row;
    if (!row && this.rows.size >= this.limit) {
      this.totals.unretainedCalls++;
      return false;
    }
    const now = new Date().toISOString();
    if (!row) {
      row = { contractId: contractId(layer,"invoke",api), api, layer, disposition, calls: 0, firstSeenAt: now };
      this.rows.set(key, row);
    }
    row.calls++;
    row.lastSeenAt = now;
    row.context = Object.fromEntries(
      ["pageId", "contextId", "workerId"].flatMap((key) => {
        const value = (observation.context as any)?.[key];
        return Number.isSafeInteger(value) ? [[key, value]] : [];
      }),
    );
    return first;
  }
  snapshot() {
    return {
      policy: "explicit-native-boundary",
      ...this.totals,
      limit: this.limit,
      truncated: this.totals.unretainedCalls > 0,
      entries: structuredClone([...this.rows.values()]),
      interpretation:
        "Observed native gaps and local-only telemetry; not full API coverage",
    };
  }
}
