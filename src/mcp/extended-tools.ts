import { bootAnalysisSchema } from "../analysis/boot-schema";
import { z } from "zod";
import {
  devicePresetSchema,
  deviceStateSchema,
  deviceEventSchemas,
} from "../device/runtime";
import { locationOverrideSchema } from "../location/override";
import { fieldsSchema } from "../analysis/projection";
const paging = {
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
  revealSensitive: z.boolean().default(false),
};
const eventFilters = {
  contractId: z.string().optional(),
  callId: z.string().optional(),
  contextId: z.number().int().optional(),
  workerId: z.number().int().optional(),
  fields: fieldsSchema,
  ...paging,
  source: z.string().optional(),
  level: z.string().optional(),
  operationId: z.string().optional(),
};
export const extendedTools = {
  runner_native: {
    description:
      "Inspect native component DOM surfaces and recorded bridge calls. A wx tag without a DOM backend is reported as unavailable. Control actual media surfaces with explicit play/pause/seek; absent engines fail rather than report success. IDs belong to the current page and expire on destruction.",
    readOnly: false,
    schema: z
      .object({
        action: z
          .enum([
            "list",
            "capabilities",
            "get",
            "play",
            "pause",
            "seek",
            "camera-input",
            "scan",
            "stop",
          ])
          .default("list"),
        id: z.string().optional(),
        position: z.number().finite().nonnegative().optional(),
        mode: z.enum(["system", "image", "simulated"]).optional(),
        file: z.string().min(1).optional(),
        result: z.string().min(1).max(65536).optional(),
        codeType: z.enum(["qrcode", "barcode"]).default("qrcode"),
      })
      .refine(
        (a) => ["list", "capabilities"].includes(a.action) || !!a.id,
        "id required",
      )
      .refine(
        (a) => a.action !== "seek" || a.position !== undefined,
        "position required",
      )
      .refine(
        (a) => a.action !== "camera-input" || !!a.mode,
        "camera input mode required",
      )
      .refine((a) => a.action !== "scan" || !!a.result, "scan result required")
      .refine(
        (a) => !a.file || (a.action === "camera-input" && a.mode === "image"),
        "file requires image input",
      ),
  },
  runner_cloud: {
    description:
      "Inspect the real base-library cloud SDK or start an explicit remote cloud job. No mock fallback. Queries and file URL lookups are read-only; functions and mutations require confirm:true and may write to the remote environment. Jobs return IDs and do not block debugger controls. No bulk database modifications. SDK completion is not page/business acceptance.",
    readOnly: false,
    schema: z
      .object({
        action: z.enum(["status", "list", "get", "start"]).default("status"),
        jobId: z.string().optional(),
        operation: z
          .enum([
            "function",
            "databaseQuery",
            "databaseAdd",
            "databaseUpdate",
            "databaseRemove",
            "fileUrl",
            "downloadFile",
            "deleteFile",
          ])
          .optional(),
        env: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        collection: z.string().min(1).optional(),
        documentId: z.string().min(1).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        where: z.record(z.string(), z.unknown()).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        fileList: z.array(z.string().min(1)).min(1).max(50).optional(),
        fileId: z.string().min(1).optional(),
        confirm: z.boolean().optional(),
        revealSensitive: z.boolean().default(false),
      })
      .refine((a) => a.action !== "get" || !!a.jobId, "jobId required")
      .refine(
        (a) => a.action !== "start" || !!a.operation,
        "operation required",
      )
      .refine(
        (a) =>
          a.action !== "start" ||
          ![
            "function",
            "databaseAdd",
            "databaseUpdate",
            "databaseRemove",
            "deleteFile",
          ].includes(a.operation!) ||
          a.confirm === true,
        "Remote functions and writes require confirm:true",
      )
      .refine(
        (a) => a.operation !== "function" || !!a.name,
        "function name required",
      )
      .refine(
        (a) => !a.operation?.startsWith("database") || !!a.collection,
        "collection required",
      )
      .refine(
        (a) =>
          !["databaseUpdate", "databaseRemove"].includes(a.operation!) ||
          !!a.documentId,
        "documentId required",
      )
      .refine(
        (a) =>
          !["databaseAdd", "databaseUpdate"].includes(a.operation!) || !!a.data,
        "data required",
      )
      .refine(
        (a) =>
          !["fileUrl", "deleteFile"].includes(a.operation!) || !!a.fileList,
        "fileList required",
      )
      .refine(
        (a) => a.operation !== "downloadFile" || !!a.fileId,
        "fileId required",
      ),
  },
  runner_device: {
    description:
      "Inspect or explicitly enable PC/Android/iOS device simulation. Hardware input events are delivered to original wx listeners only in a valid started state. Simulation does not grant account or location permission. location is compatible with runner_state location. Profile changes affect public device info, not the internal baselib bridge platform.",
    readOnly: false,
    schema: z
      .object({
        action: z
          .enum(["get", "capabilities", "preset", "set", "emit", "location"])
          .default("get"),
        preset: devicePresetSchema.optional(),
        simulation: z.boolean().optional(),
        state: deviceStateSchema.optional(),
        event: z
          .enum([
            "accelerometer",
            "compass",
            "gyroscope",
            "deviceMotion",
            "network",
            "theme",
            "bleValue",
            "bleDisconnect",
          ])
          .optional(),
        data: z.unknown().optional(),
        location: locationOverrideSchema.optional(),
        persist: z.boolean().optional(),
      })
      .refine((a) => a.action !== "preset" || !!a.preset, "preset required")
      .refine((a) => a.action !== "set" || !!a.state, "state required")
      .refine(
        (a) =>
          a.action !== "emit" ||
          (!!a.event && deviceEventSchemas[a.event].safeParse(a.data).success),
        "event data must match the device event schema",
      )
      .refine(
        (a) => a.location === undefined || a.action === "location",
        "location only with action:location",
      )
      .refine(
        (a) =>
          a.persist === undefined ||
          (a.action === "location" && a.location !== undefined),
        "persist requires action:location and an explicit location",
      ),
  },
  runner_suite: {
    description:
      "Inspect the package's per-page catalog, start explicit page/flow scenarios as background jobs, query results or cancel without replay. A page-ready pass is never a business-flow or native-effect pass. $before in a wait's after refers to the request cursor before scenario input.",
    readOnly: false,
    schema: z
      .object({
        action: z
          .enum(["catalog", "start", "get", "list", "cancel", "contracts", "contractRun"])
          .default("catalog"),
        collection: z.enum(["contracts","files","unresolved","scenarios"]).default("contracts"),
        contractId: z.string().optional(),
        scenarioId: z.string().optional(),
        q: z.string().max(200).optional(),
        fingerprint: z.string().optional(),
        layer: z.enum(["logic","view","worker","host","shared"]).optional(),
        verdict: z.enum(["已实现未验收","验收通过","失败","平台待验收"]).optional(),
        details: z.boolean().default(false),
        exportReport: z.boolean().default(false),
        sourceDir: z.string().optional(),
        route: z.string().optional(),
        group: z.string().optional(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(500).default(30),
        mode: z.enum(["pages", "analysis"]).default("pages"),
        routes: z.array(z.string().min(1)).min(1).max(500).optional(),
        steps: z
          .array(
            z.object({
              tool: z.string(),
              arguments: z.record(z.string(), z.unknown()).optional(),
              saveAs: z.string().optional(),
              bind: z.record(z.string(), z.string()).optional(),
            }),
          )
          .max(100)
          .default([]),
        timeoutMs: z.number().int().min(1).max(60000).default(10000),
        jobId: z.string().optional(),
      })
      .refine(a=>a.action!=="contractRun" || !!a.scenarioId,"scenarioId required")
      .refine((a) => a.action !== "start" || a.mode === "analysis" || !!a.routes, "routes required for pages mode")
      .refine(
        (a) => !["get", "cancel"].includes(a.action) || !!a.jobId,
        "jobId required",
      ),
  },
  runner_events: {
    description:
      "Read ordered structured events from the persistent debugger, including exited runtimes. Cursor gaps and session identity are explicit.",
    readOnly: true,
    schema: z.object(eventFilters),
  },
  runner_trace: {
    description:
      "Read a causally linked operation timeline. Unlinked events and input delivery are not proof of business completion.",
    readOnly: true,
    schema: z.object(eventFilters).extend({ operationId: z.string().min(1) }),
  },
  runner_runtime: {
    description:
      "List, start, stop, restart or switch isolated runtime processes. Preflight failures preserve the current runtime. Crashes never auto-restart or replay operations.",
    readOnly: false,
    schema: z
      .object({
        action: z
          .enum(["list", "start", "stop", "restart", "switch", "closeSession"])
          .default("list"),
        packageDir: z.string().min(1).optional(),
        pagePath: z.string().min(1).max(8192).optional(),
        appid: z
          .string()
          .regex(/^wx[0-9a-f]{16}$/i)
          .optional(),
        baselibDir: z.string().optional(),
        loaderAdapter: z.enum(["legacy", "official"]).optional(),
        appVersion: z.number().int().nonnegative().optional(),
        profile: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,80}$/)
          .optional(),
        analysis: bootAnalysisSchema.partial().optional(),
        bootScript: z.string().max(65536).optional(),
        defeatAntiHook: z.boolean().optional(),
        configFile: z.string().optional(),
        contactsFile: z.string().min(1).optional().describe("Explicit host metadata snapshot for this appid/version; validated before replacing the instance. Never synthesized from package/plugin semver."),
        devtools: z.boolean().optional(),
      })
      .refine(
        (a) => !["start", "switch"].includes(a.action) || !!a.packageDir,
        "packageDir is required",
      ),
  },
  runner_control: {
    description:
      "Inspect, acquire, renew or release a per-runtime control lease. Human interaction preempts queued AI writes. Recovery controls never wait behind business evaluation.",
    readOnly: false,
    schema: z.object({
      action: z.enum(["state", "acquire", "renew", "release"]).default("state"),
      ttlMs: z.number().int().min(1000).max(300000).default(60000),
    }),
  },
  runner_profile: {
    description:
      "Start, inspect, list or stop CPU, Chromium trace, heap snapshot and allocation-sampling jobs. Large results are artifacts; unsupported targets fail explicitly.",
    readOnly: false,
    schema: z
      .object({
        action: z.enum(["start", "get", "list", "stop"]).default("list"),
        kind: z.enum(["cpu", "trace", "heap", "allocations"]).optional(),
        jobId: z.string().optional(),
      })
      .refine((a) => a.action !== "start" || !!a.kind, "kind required")
      .refine(
        (a) => !["get", "stop"].includes(a.action) || !!a.jobId,
        "jobId required",
      ),
  },
  runner_network_rules: {
    description:
      "Manage explicit HTTP(S) rules, emulation and paused requests. New rules are disabled. Modify continues; block/mock terminates. Releasing a paused request is explicit and never a replay.",
    readOnly: false,
    schema: z
      .object({
        action: z
          .enum([
            "list",
            "set",
            "remove",
            "enable",
            "disable",
            "conditions",
            "paused",
            "resolve",
          ])
          .default("list"),
        revealSensitive: z.boolean().default(false),
        id: z.string().optional(),
        rule: z.record(z.string(), z.unknown()).optional(),
        conditions: z
          .object({
            offline: z.boolean().optional(),
            latencyMs: z.number().min(0).max(60000).optional(),
            uploadBytesPerSecond: z.number().min(0).optional(),
            downloadBytesPerSecond: z.number().min(0).optional(),
            cacheDisabled: z.boolean().optional(),
          })
          .optional(),
        decision: z.record(z.string(), z.unknown()).optional(),
      })
      .refine(
        (a) =>
          !["remove", "enable", "disable", "resolve"].includes(a.action) ||
          !!a.id,
        "id required",
      )
      .refine((a) => a.action !== "set" || !!a.rule, "rule required"),
  },
  runner_replay: {
    description:
      "Explicitly send one new HTTP request linked to a captured request, using current rules. Does not invoke the original handler. Incomplete bodies require a replacement; no automatic retries.",
    readOnly: false,
    schema: z.object({
      id: z.string().min(1),
      url: z.string().url().optional(),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      bodyEncoding: z.enum(["text", "base64"]).default("text"),
    }),
  },
  runner_artifact: {
    description:
      "List, read bounded chunks, or explicitly export body/HAR/profile artifacts. Text credentials are redacted unless revealSensitive is explicit. Export writes only the selected destination.",
    readOnly: false,
    schema: z
      .object({
        action: z
          .enum(["list", "read", "export", "har", "session"])
          .default("list"),
        id: z.string().optional(),
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().min(1).max(262144).default(262144),
        destination: z.string().optional(),
        revealSensitive: z.boolean().default(false),
      })
      .refine(
        (a) => !["read", "export"].includes(a.action) || !!a.id,
        "id required",
      )
      .refine(
        (a) => !["export", "session"].includes(a.action) || !!a.destination,
        "destination required",
      ),
  },
};

export const identitySchema = z.object({
  runtimeId: z.string().optional(),
  sessionId: z.string().optional(),
  targetId: z.string().optional(),
});
