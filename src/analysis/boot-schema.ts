import { executionConfigSchema } from "./execution/schema";
import { z } from "zod";
export const probeTarget = z.union([
  z.string().min(1).max(1000),
  z.object({
    module: z.string().min(1).max(1000),
    export: z.string().max(1000).default(""),
  }),
]);
export const tapSchema = z.object({
  target: probeTarget,
  scope: z.enum(["all", "execution", "operation", "armed"]).default("all"),
  algo: z.string().max(100).default("user-specified"),
  count: z.number().int().min(1).max(10000).default(1000),
  inputIndex: z.number().int().min(0).max(32).default(0),
  keyIndex: z.number().int().min(0).max(32).optional(),
  ivIndex: z.number().int().min(0).max(32).optional(),
  observePromise: z.boolean().default(false),
});
export const bootAnalysisSchema = z.object({
  execution: executionConfigSchema.optional(),
  enabled: z.boolean().default(false),
  networkMode: z.enum(["normal", "local-only"]).default("normal"),
  defeatAntiHook: z.boolean().default(false),
  cryptoTap: z.boolean().default(false),
  webCrypto: z.boolean().default(false),
  observePromise: z.boolean().default(false),
  randomSeed: z.number().int().min(0).max(4294967295).optional(),
  now: z.number().int().nonnegative().optional(),
  bootScript: z.string().max(65536).optional(),
  ttlMs: z.number().int().min(100).max(300000).default(60000),
  capacity: z.number().int().min(10).max(2000).default(300),
  captureBytes: z.number().int().min(128).max(16384).default(4096),
  taps: z.array(tapSchema).max(64).default([]),
});
const paging = {
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(20),
  revealSensitive: z.boolean().default(false),
};
export const cryptoWatchSchema = z
  .object({
    action: z
      .enum([
        "status",
        "start",
        "read",
        "stop",
        "diff",
        "resetRandom",
        "arm",
        "disarm",
      ])
      .default("status"),
    target: z.string().min(1).max(1024).optional(),
    match: z.enum(["exact", "includes", "regex"]).default("exact"),
    tapIds: z.array(z.string()).max(512).optional(),
    watchId: z.string().optional(),
    taps: z.array(tapSchema).max(64).default([]),
    auto: z.boolean().default(true),
    observePromise: z.boolean().default(false),
    count: z.number().int().min(1).max(1000).default(5),
    ttlMs: z.number().int().min(100).max(300000).default(60000),
    seed: z.number().int().min(0).max(4294967295).optional(),
    matchedOnly: z.boolean().default(false),
    summary: z.boolean().default(false),
    runId: z.string().optional(),
    operationId: z.string().optional(),
    runA: z.string().optional(),
    runB: z.string().optional(),
    ...paging,
  })
  .superRefine((a, c) => {
    if (["arm", "disarm"].includes(a.action) && !a.tapIds?.length)
      c.addIssue({ code: "custom", message: "arm/disarm requires tapIds" });
    if (a.action === "arm" && Number(!!a.runId) + Number(!!a.operationId) !== 1)
      c.addIssue({
        code: "custom",
        message: "arm requires exactly one runId or operationId",
      });
    if (a.action === "diff" && (!a.runA || !a.runB))
      c.addIssue({ code: "custom", message: "diff requires runA and runB" });
  });
export const sliceSchema = z
  .object({
    action: z
      .enum([
        "start",
        "stop",
        "read",
        "list",
        "watchProperty",
        "removeProperty",
      ])
      .default("list"),
    target: probeTarget.optional(),
    runId: z.string().optional(),
    propertyId: z.string().optional(),
    probes: z.array(tapSchema).max(32).default([]),
    count: z.number().int().min(1).max(100).default(1),
    ttlMs: z.number().int().min(100).max(300000).default(30000),
    ...paging,
  })
  .superRefine((a, c) => {
    if (["start", "watchProperty"].includes(a.action) && !a.target)
      c.addIssue({ code: "custom", message: "target required" });
    if (a.action === "removeProperty" && !a.propertyId)
      c.addIssue({ code: "custom", message: "propertyId required" });
  });
export const oracleSchema = z
  .object({
    action: z
      .enum(["export", "list", "call", "remove", "batch"])
      .default("list"),
    eventId: z.number().int().positive().optional(),
    inputs: z.array(z.array(z.unknown()).max(32)).max(50).optional(),
    target: probeTarget.optional(),
    oracleId: z.string().optional(),
    args: z.array(z.unknown()).max(32).default([]),
    awaitPromise: z.boolean().default(false),
    ttlMs: z.number().int().min(100).max(300000).default(60000),
    revealSensitive: z.boolean().default(false),
  })
  .superRefine((a, c) => {
    if (a.action === "export" && !a.target && !a.eventId)
      c.addIssue({ code: "custom", message: "target required" });
    if (["call", "remove", "batch"].includes(a.action) && !a.oracleId)
      c.addIssue({ code: "custom", message: "oracleId required" });
    if (a.action === "batch" && !a.inputs)
      c.addIssue({ code: "custom", message: "batch requires inputs" });
    if (JSON.stringify([a.args, a.inputs]).length > 65536)
      c.addIssue({ code: "custom", message: "Oracle arguments exceed 64 KiB" });
  });
