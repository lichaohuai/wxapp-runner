import { redact } from "../../mcp/redact";
export function projectAnalysisEntries(output: any, fields?: string[]) {
  if (!fields || !Array.isArray(output?.entries)) return output;
  return {
    ...output,
    entries: output.entries.map((entry: any) =>
      Object.fromEntries(
        [...new Set(["id", ...fields])]
          .map((key) => {
            let value: any = entry;
            for (const part of key.split(".")) {
              const descriptor =
                value && typeof value === "object"
                  ? Object.getOwnPropertyDescriptor(value, part)
                  : undefined;
              value =
                descriptor && "value" in descriptor
                  ? descriptor.value
                  : undefined;
            }
            return [key, value];
          })
          .filter(([, value]) => value !== undefined),
      ),
    ),
  };
}
export function executionOutput(value: any, reveal = false): any {
  if (reveal) return value;
  const sensitive = new Set([
    "value",
    "storedValue",
    "args",
    "argumentsHeap",
    "input",
    "output",
    "result",
    "receiver",
    "expression",
    "callee",
    "chunks",
    "key",
    "iv",
    "verificationVector",
    "equals",
    "thisArg",
  ]);
  const visit = (v: any): any =>
    Array.isArray(v)
      ? v.map(visit)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [
              k,
              sensitive.has(k)
                ? "[REDACTED: use revealSensitive:true]"
                : visit(x),
            ]),
          )
        : v;
  return visit(redact(value));
}
export function sliceReport(graph: any) {
  const events = graph.semantic || [];
  return {
    representation:
      "observed execution slice; not recovered universal VM bytecode",
    generalizedAlgorithm: false,
    sink: graph.sink,
    pseudocode: events.map(
      (e: any) =>
        `v${e.id} = ${e.kind}${e.operator ? " " + e.operator : ""}(${(e.deps || []).map((id: number) => "v" + id).join(", ")}) // ${e.location?.file || "unknown"}:${e.location?.line || 0}:${e.location?.column || 0}`,
    ),
    steps: events.map((e: any) => ({
      eventId: e.id,
      kind: e.kind,
      operation: e.operator || e.native || e.property || e.kind,
      expression: e.location?.expression,
      location: e.location,
      value: e.value,
      dependencies: e.deps,
      opaque: !!e.opaque || !!e.provenance?.startsWith("unobserved"),
      provenance: e.provenance,
    })),
    missing: graph.missing || [],
    opaqueBoundaries: graph.opaqueBoundaries || [],
    truncated: !!graph.truncated,
    sources: [
      ...new Set(events.map((e: any) => e.location?.file).filter(Boolean)),
    ],
  };
}
