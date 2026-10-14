import { z } from "zod";
export const executionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  files: z.array(z.string().max(2000)).max(100).default([]),
  modules: z.array(z.string().max(1000)).max(100).default([]),
  capacity: z.number().int().min(100).max(1000000).default(10000),
  maxEvents: z.number().int().min(100).max(1000000).default(20000),
  ttlMs: z.number().int().min(100).max(300000).default(60000),
  byteLimit: z.number().int().min(65536).max(4294967296).default(268435456),
  initialization: z.object({
    enabled: z.boolean().default(false),
    maxEvents: z.number().int().min(100).max(1000000).default(20000),
    ttlMs: z.number().int().min(100).max(300000).default(60000),
    // "full": record every init event (bounded by maxEvents/FIFO-exempt) — the
    // original behaviour. "state": record ONLY property writes during init and
    // retain just the CURRENT value per (object,key), evicting superseded
    // writes. This captures the plugin's startup state tables (e.g. Fireye's
    // h[] slots) compactly so later invocation reads resolve their source
    // instead of hitting an evicted/never-recorded init write ("unknown
    // boundary"), without storing the whole VM-startup event stream.
    mode: z.enum(["full", "state"]).default("full"),
    stateCap: z.number().int().min(1000).max(2000000).default(200000),
    stateByteBudget: z.number().int().min(1048576).max(1073741824).default(134217728),
  }).default({enabled: false, maxEvents: 20000, ttlMs: 60000, mode: "full", stateCap: 200000, stateByteBudget: 134217728}),
  valueLimit: z.number().int().min(128).max(8192).default(1024),
});
export const executionSchema = z
  .object({
    action: z
      .enum([
        "status",
        "export",
        "getExport",
        "cancelExport",
        "dependencies",
        "start",
        "stop",
        "read",
        "summary",
        "watch",
        "unwatch",
        "explain",
        "diff",
        "oracleExport",
        "oracleCall",
        "oracleRemove",
        "oracleList",
        "logpoint",
        "cryptoCandidates",
      ])
      .default("status"),
    jobId: z.string().optional(),
    runA: z.string().optional(),
    runB: z.string().optional(),
    oracleId: z.string().optional(),
    args: z.array(z.unknown()).max(32).default([]),
    awaitPromise: z.boolean().default(false),
    location: z
      .object({
        file: z.string(),
        line: z.number().int().positive(),
        column: z.number().int().positive().optional(),
      })
      .optional(),
    when: z.string().max(2000).optional(),
    count: z.number().int().min(1).max(1000).default(5),
    functionSite: z.string().optional(),
    kinds: z.array(z.string()).max(30).optional(),
    natives: z.array(z.string().min(1).max(200)).max(30).optional(),
    expressionIncludes: z.string().max(2000).optional(),
    beforeEvent: z.number().int().nonnegative().optional(),
    groupBy: z.enum(["source", "native", "kind"]).default("source"),
    offset: z.number().int().min(0).max(100000).default(0),
    fields: z
      .array(z.string().regex(/^[A-Za-z][\w.]*$/))
      .max(40)
      .optional(),
    includeAddress: z.boolean().optional(),
    expandEvents: z.array(z.number().int().positive()).max(100).optional(),
    maxNodes: z.number().int().min(1).max(2000).optional(),
    paged: z.boolean().optional(),
    sliceCursor: z.string().min(1).max(500).optional(),
    maxTotalNodes: z.number().int().min(1).max(1000000).optional(),
    runId: z.string().optional(),
    watchId: z.string().optional(),
    properties: z.array(z.string().max(200)).max(100).default([]),
    objectId: z.string().optional(),
    eventId: z.number().int().positive().optional(),
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(30),
    maxEvents: z.number().int().min(100).max(1000000).default(20000),
    ttlMs: z.number().int().min(100).max(300000).default(60000),
    revealSensitive: z.boolean().default(false),
    pinRun: z.boolean().optional(),
    partial: z.boolean().optional(),
    hmac: z.boolean().default(false),
    mode: z.enum(["full", "state"]).optional(),
    stateCap: z.number().int().min(1000).max(2000000).optional(),
  })
  .superRefine((a, c) => {
    if (a.action === "export" && !a.runId) c.addIssue({code:"custom",message:"runId required"});
    if (["getExport","cancelExport"].includes(a.action) && !a.jobId) c.addIssue({code:"custom",message:"jobId required"});
    if (a.action === "dependencies" && !a.eventId) c.addIssue({code: "custom", message: "eventId required"});
    if (a.action === "logpoint" && !a.location)
      c.addIssue({ code: "custom", message: "logpoint requires location" });
    if (a.action === "diff" && (!a.runA || !a.runB))
      c.addIssue({ code: "custom", message: "diff requires runA and runB" });
    if (a.action === "oracleExport" && !a.eventId)
      c.addIssue({ code: "custom", message: "oracleExport requires eventId" });
    if (["oracleCall", "oracleRemove"].includes(a.action) && !a.oracleId)
      c.addIssue({ code: "custom", message: "oracleId required" });
    if (a.action === "explain" && !a.eventId && !a.sliceCursor)
      c.addIssue({
        code: "custom",
        message: "eventId or sliceCursor required",
      });
    if ((a.sliceCursor || a.paged || a.maxTotalNodes) && a.action !== "explain")
      c.addIssue({
        code: "custom",
        message: "slice pagination requires explain",
      });
    if (a.sliceCursor && a.paged === false)
      c.addIssue({
        code: "custom",
        message: "sliceCursor requires paged explain",
      });
    if (a.maxTotalNodes && !a.paged && !a.sliceCursor)
      c.addIssue({
        code: "custom",
        message: "maxTotalNodes requires paged explain",
      });
    if (a.action === "unwatch" && !a.watchId)
      c.addIssue({ code: "custom", message: "watchId required" });
  });
export const businessConditionSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("text"), text: z.string().min(1).max(2000) })
    .strict(),
  z
    .object({
      kind: z.literal("element"),
      selector: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hidden"),
      selector: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({ kind: z.literal("route"), route: z.string().min(1).max(2000) })
    .strict(),
  z
    .object({
      kind: z.literal("state"),
      instanceId: z.string().min(1),
      path: z.array(z.string().max(200)).min(1).max(20),
      equals: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("log"),
      text: z.string().min(1).max(2000),
      source: z.string().optional(),
      level: z.string().optional(),
    })
    .strict(),
]);
export const autopsySchema = z
  .object({
    action: z
      .enum(["start", "get", "cancel", "list", "preflight"])
      .default("list"),
    resultCondition: businessConditionSchema.optional(),
    jobId: z.string().optional(),
    requestId: z.string().optional(),
    urlIncludes: z.string().max(2000).optional(),
    resetSeed: z.number().int().min(0).max(4294967295).optional(),
    field: z
      .object({
        in: z.enum(["header", "body", "query"]),
        name: z.string().min(1).max(200),
      })
      .optional(),
    trigger: z
      .object({
        tool: z.enum(["runner_click", "runner_gesture", "runner_oracle"]),
        arguments: z.record(z.string(), z.unknown()),
      })
      .optional(),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
    revealSensitive: z.boolean().default(false),
    dialogPolicy: z.enum(["error", "auto-dismiss", "auto-confirm"]).optional(),
  })
  .superRefine((a, c) => {
    if (a.action === "start" && !a.field && !a.requestId && !a.urlIncludes)
      c.addIssue({
        code: "custom",
        message:
          "start requires a field, requestId or urlIncludes; missing trigger waits for manual input",
      });
    if (["get", "cancel"].includes(a.action) && !a.jobId)
      c.addIssue({ code: "custom", message: "jobId required" });
  });
