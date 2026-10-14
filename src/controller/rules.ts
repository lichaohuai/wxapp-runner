import { z } from "zod";
import { randomUUID } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
const headerName = z.string().refine((value) => {
  try {
    validateHeaderName(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid HTTP header name");
const headers = z.record(headerName, z.string()).refine((value) => {
  try {
    for (const [name, item] of Object.entries(value))
      validateHeaderValue(name, item);
    return true;
  } catch {
    return false;
  }
}, "Invalid HTTP header value");
const validBody = (value: { body?: string; bodyEncoding: string }) =>
  value.bodyEncoding !== "base64" ||
  value.body === undefined ||
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value.body,
  );
const changeSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((url) => /^https?:/.test(url), "Only HTTP(S) URLs are supported")
      .optional(),
    method: z
      .string()
      .regex(/^[A-Za-z]+$/)
      .optional(),
    headers: headers.optional(),
    removeHeaders: z.array(headerName).optional(),
    body: z.string().optional(),
    bodyEncoding: z.enum(["text", "base64"]).default("text"),
  })
  .refine(validBody, "Invalid base64 body");
export const ruleSchema = z
  .object({
    id: z.string().optional(),
    enabled: z.boolean().default(false),
    priority: z.number().int().default(0),
    match: z
      .object({
        url: z.string().min(1).max(2048).optional(),
        urlIncludes: z.string().min(1).max(2048).optional(),
        method: z.string().optional(),
        source: z.enum(["logic", "view"]).optional(),
      })
      .refine((m) => !!m.url || !!m.urlIncludes, "A URL matcher is required"),
    action: z.enum(["modify", "block", "mock", "pause"]),
    change: changeSchema.optional(),
    response: z
      .object({
        status: z.number().int().min(200).max(599).default(200),
        headers: headers.default({}),
        body: z.string().default(""),
        bodyEncoding: z.enum(["text", "base64"]).default("text"),
      })
      .refine(validBody, "Invalid base64 body")
      .optional(),
  })
  .refine((r) => r.action !== "modify" || !!r.change, "modify requires change")
  .refine((r) => r.action !== "mock" || !!r.response, "mock requires response");
function matches(pattern: string, url: string) {
  return new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  ).test(url);
}
export function changeRequest(request: any, raw: any) {
  const change = changeSchema.parse(raw);
  const result = {
    ...request,
    headers: { ...request.headers },
    ...(change.url ? { url: change.url } : {}),
    ...(change.method ? { method: change.method.toUpperCase() } : {}),
  };
  if (!["http:", "https:"].includes(new URL(result.url).protocol))
    throw Error("Only HTTP(S) requests can be modified");
  for (const key of change.removeHeaders || [])
    delete result.headers[key.toLowerCase()];
  for (const [key, value] of Object.entries(change.headers || {}))
    result.headers[key.toLowerCase()] = value;
  if (change.body !== undefined) {
    result.body = change.body;
    result.bodyEncoding = change.bodyEncoding;
    delete result.headers["content-length"];
  }
  if (["GET", "HEAD"].includes(result.method) && change.body !== undefined)
    throw Error("GET/HEAD requests cannot have a replacement body");
  return result;
}
export class NetworkRules {
  experimentMode: "normal" | "local-only" = "normal";
  private rules = new Map<string, any>();
  private sequence = 0;
  conditions = {
    offline: false,
    latencyMs: 0,
    uploadBytesPerSecond: 0,
    downloadBytesPerSecond: 0,
    cacheDisabled: false,
  };
  list() {
    return {
      experimentMode: this.experimentMode,
      rules: [...this.rules.values()].sort(
        (a, b) => b.priority - a.priority || a.order - b.order,
      ),
      conditions: { ...this.conditions },
    };
  }
  set(raw: unknown, clientId: string) {
    const rule = ruleSchema.parse(raw);
    const id = rule.id || randomUUID();
    const previous = this.rules.get(id);
    const value = {
      ...rule,
      id,
      order: previous?.order ?? ++this.sequence,
      owner: clientId,
    };
    this.rules.set(id, value);
    return value;
  }
  update(id: string, action: "remove" | "enable" | "disable") {
    const rule = this.rules.get(id);
    if (!rule) throw Error("Network rule not found");
    if (action === "remove") this.rules.delete(id);
    else rule.enabled = action === "enable";
    return this.list();
  }
  evaluate(original: any) {
    let request = {
      ...original,
      headers: Object.fromEntries(
        Object.entries(original.headers || {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    };
    const hits: any[] = [];
    for (const rule of this.list().rules) {
      const m = rule.match;
      if (
        !rule.enabled ||
        (m.source && request.source !== m.source) ||
        (m.method && request.method.toUpperCase() !== m.method.toUpperCase()) ||
        (m.urlIncludes && !request.url.includes(m.urlIncludes)) ||
        (m.url && !matches(m.url, request.url))
      )
        continue;
      const before = request;
      if (rule.action === "modify")
        request = changeRequest(request, rule.change);
      hits.push({ id: rule.id, action: rule.action, before, after: request });
      if (rule.action !== "modify") {
        if (rule.action === "pause" && !this.allowedDestination(request.url))
          return this.blockExperiment(request, hits);
        return {
          request,
          hits,
          action: rule.action,
          response: rule.response,
          owner: rule.owner,
          conditions: { ...this.conditions },
        };
      }
    }
    if (!this.allowedDestination(request.url))
      return this.blockExperiment(request, hits);
    return {
      request,
      hits,
      action: "continue",
      conditions: { ...this.conditions },
    };
  }
  private allowedDestination(raw: string) {
    if (this.experimentMode !== "local-only") return true;
    const url = new URL(raw);
    // Literal loopback only. A name containing 'localhost' or a redirect is not
    // proof of a local destination. Every redirect receives its own evaluation.
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  }
  socketPolicy(raw: string) {
    const url = new URL(raw);
    if (!["ws:", "wss:"].includes(url.protocol)) throw Error("Invalid socket URL");
    if (this.conditions.offline) return { allowed: false, reason: "Network offline" };
    if (this.experimentMode === "local-only" && !["127.0.0.1", "[::1]"].includes(url.hostname))
      return { allowed: false, reason: "ANALYSIS_LOCAL_ONLY" };
    return { allowed: true };
  }
  private blockExperiment(request: any, hits: any[]) {
    return {
      request,
      hits: [
        ...hits,
        {
          id: "analysis:local-only",
          action: "block",
          before: request,
          after: request,
        },
      ],
      action: "block",
      conditions: { ...this.conditions },
      reason: "ANALYSIS_LOCAL_ONLY",
      owner: undefined,
      response: undefined,
    };
  }
  enforceExperiment(plan: any) {
    return ["continue", "pause"].includes(plan.action) &&
      !this.allowedDestination(plan.request.url)
      ? { ...plan, ...this.blockExperiment(plan.request, plan.hits || []) }
      : plan;
  }
}
