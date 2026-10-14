import { z } from "zod";
const target = z.union([
  z.string().min(1).max(1000),
  z.object({
    module: z.string().min(1).max(1000),
    export: z.string().max(1000).default(""),
  }),
]);
export const hookSchema = z
  .object({
    action: z.enum(["install", "list", "read", "remove"]).default("install"),
    target: target.optional(),
    hookId: z.string().uuid().optional(),
    capture: z
      .array(z.enum(["args", "return", "this", "stack"]))
      .default(["args", "return", "stack"]),
    count: z.number().int().min(1).max(1000).default(5),
    ttlMs: z.number().int().min(100).max(300000).default(30000),
    capacity: z.number().int().min(1).max(200).default(50),
    when: z.string().max(2000).optional(),
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
    allowModuleLoad: z.boolean().default(false),
    revealSensitive: z.boolean().default(false),
  })
  .superRefine((a, c) => {
    if (a.action === "install" && !a.target)
      c.addIssue({ code: "custom", message: "target required" });
    if (["read", "remove"].includes(a.action) && !a.hookId)
      c.addIssue({ code: "custom", message: "hookId required" });
  });
export const sourceSchema = z
  .object({
    action: z
      .enum([
        "list",
        "get",
        "search",
        "locate",
        "graph",
        "dependencies",
        "format",
        "deobfuscate",
      ])
      .default("list"),
    runId: z.string().optional(),
    includeMap: z.boolean().default(false),
    path: z.string().max(1000).optional(),
    factoryId: z.string().max(2500).optional(),
    current: z.boolean().default(false),
    file: z.string().max(2000).optional(),
    q: z.string().min(1).max(1000).optional(),
    target: target.optional(),
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().min(1).max(65536).default(12000),
    limit: z.number().int().min(1).max(200).default(50),
    caseSensitive: z.boolean().default(false),
    dedupe: z
      .boolean()
      .default(false)
      .describe(
        "search: collapse byte-identical match contexts that recur across sibling bundles into one hit (with alsoIn paths + dedupedDuplicates count). Cuts the cross-package noise from copied obfuscated code.",
      ),
    pathIncludes: z
      .string()
      .max(1000)
      .optional()
      .describe(
        "search: only scan modules whose path/file contains this substring (e.g. one package) to avoid duplicate hits from copied code.",
      ),
    allowModuleLoad: z.boolean().default(false),
  })
  .superRefine((a, c) => {
    if (
      a.current &&
      (a.factoryId || !["get", "format", "deobfuscate"].includes(a.action))
    )
      c.addIssue({
        code: "custom",
        message:
          "current requires get/format/deobfuscate and cannot be mixed with factoryId",
      });
    for (const [action, key] of [
      ["get", "path"],
      ["format", "path"],
      ["deobfuscate", "path"],
      ["search", "q"],
      ["locate", "target"],
    ] as const)
      if (a.action === action && !a[key])
        c.addIssue({ code: "custom", message: `${key} required` });
  });
export const networkSchema = z
  .object({
    offset: z.number().int().nonnegative().default(0),
    action: z.enum(["list", "get", "diff"]).optional(),
    id: z.string().optional(),
    idA: z.string().optional(),
    idB: z.string().optional(),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(30),
    filter: z
      .object({
        urlIncludes: z.string().max(2000).optional(),
        bodyIncludes: z.string().max(2000).optional(),
        source: z.enum(["logic", "view"]).optional(),
        resourceType: z.string().max(100).optional(),
        state: z.string().max(100).optional(),
        blockedReason: z.string().max(200).optional(),
        hasBody: z.boolean().optional(),
        status: z
          .union([z.number().int(), z.array(z.number().int()).max(100)])
          .optional(),
      })
      .optional(),
    fields: z
      .array(z.string().regex(/^[A-Za-z][\w.]*$/))
      .max(40)
      .optional(),
    summary: z.boolean().default(true),
    previewBytes: z.number().int().min(0).max(262144).default(4096),
    maxScan: z.number().int().min(1).max(1000).default(200),
    revealSensitive: z.boolean().default(false),
  })
  .superRefine((a, c) => {
    if (a.action === "get" && !a.id)
      c.addIssue({ code: "custom", message: "get requires id" });
    if (a.action === "diff" && (!a.idA || !a.idB))
      c.addIssue({ code: "custom", message: "diff requires idA and idB" });
  });
