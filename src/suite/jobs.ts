import { randomUUID } from "node:crypto";
import { parseTool } from "../mcp/tools";
export type SuiteStep = {
  tool: string;
  arguments?: any;
  saveAs?: string;
  bind?: Record<string, string>;
};
const analysisActions: Record<string, string[]> = {
  runner_source: ["list", "get", "search", "locate", "symbols"],
  runner_execution: [
    "status",
    "start",
    "stop",
    "read",
    "summary",
    "dependencies",
    "explain",
    "diff",
    "oracleExport",
    "oracleCall",
    "oracleList",
  ],
  runner_oracle: ["export", "list", "call"],
  runner_crypto_watch: ["status", "read", "diff"],
  runner_network: ["list", "get", "diff"],
};
// Only scalar selectors can be bound. Payloads and target/session identity remain explicit.
const bindingTypes: Record<string, string | number> = {
  runId: "run",
  runA: "a",
  runB: "b",
  oracleId: "oracle",
  eventId: 1,
  after: 0,
  sliceCursor: "cursor",
  id: "request",
  idA: "a",
  idB: "b",
};
function lookup(saved: Map<string, any>, ref: string) {
  const [name, ...parts] = ref.split(".");
  let value = saved.get(name);
  for (const key of parts) {
    if (!value || !Object.hasOwn(value, key))
      throw Error("SUITE_REFERENCE_MISSING: " + ref);
    value = value[key];
  }
  return value;
}
const allowed = new Set([
  "runner_click",
  "runner_input",
  "runner_gesture",
  "runner_wait",
  "runner_dialog",
  "runner_state",
  "runner_snapshot",
  "runner_screenshot",
]);
export class SuiteJobs {
  private jobs = new Map<string, any>();
  start(options: {
    runtimeId: string;
    sessionId: string;
    clientId: string;
    routes: string[];
    mode?: "pages" | "analysis";
    steps: SuiteStep[];
    timeoutMs: number;
    availableRoutes: string[];
    check: () => void;
    call: (name: string, args: any, signal: AbortSignal) => Promise<any>;
    emit: (e: any) => void;
    capture?: (image: string, name: string) => any;
  }) {
    if (
      [...this.jobs.values()].some(
        (j) => j.runtimeId === options.runtimeId && j.state === "running",
      )
    )
      throw Object.assign(
        Error("A suite is already running for this runtime"),
        { code: "SUITE_BUSY" },
      );
    for (const route of options.routes)
      if (!options.availableRoutes.includes(route))
        throw Error("Route not in package: " + route);
    const analysis = options.mode === "analysis";
    const names = new Set<string>();
    let invocations = 0;
    for (const step of options.steps) {
      if (
        !(
          analysis &&
          analysisActions[step.tool]?.includes(step.arguments?.action)
        ) &&
        !allowed.has(step.tool)
      )
        throw Error("Suite tool not allowed: " + step.tool);
      const placeholders: any = {};
      for (const [key, ref] of Object.entries(step.bind || {})) {
        if (
          !analysis ||
          !Object.hasOwn(bindingTypes, key) ||
          !/^[A-Za-z]\w*(?:\.(?:[A-Za-z]\w*|\d+))*$/.test(ref) ||
          ref
            .split(".")
            .some((k) =>
              ["constructor", "prototype", "__proto__"].includes(k),
            ) ||
          !names.has(ref.split(".")[0])
        )
          throw Error("Invalid suite binding: " + key);
        placeholders[key] = bindingTypes[key];
      }
      if (step.saveAs) {
        if (!/^[A-Za-z]\w{0,63}$/.test(step.saveAs) || names.has(step.saveAs))
          throw Error("Invalid or duplicate saveAs");
        names.add(step.saveAs);
      }
      if (
        (step.tool === "runner_oracle" && step.arguments?.action === "call") ||
        (step.tool === "runner_execution" &&
          step.arguments?.action === "oracleCall")
      )
        invocations++;
      if (analysis && invocations > 1)
        throw Error(
          "Analysis scenario permits one explicit function invocation per job",
        );
      parseTool(step.tool, {
        ...step.arguments,
        ...placeholders,
        ...(step.arguments?.after === "$before" ? { after: 0 } : {}),
      });
    }
    const abort = new AbortController();
    const job = {
      id: randomUUID(),
      runtimeId: options.runtimeId,
      sessionId: options.sessionId,
      clientId: options.clientId,
      state: "running",
      startedAt: new Date().toISOString(),
      mode: options.mode || "pages",
      total: analysis ? 1 : options.routes.length,
      completed: 0,
      results: [] as any[],
      abort,
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 100) {
      const entry = [...this.jobs].find(([, j]) => j.state !== "running");
      if (!entry) break;
      this.jobs.delete(entry[0]);
    }
    const call = async (
      name: string,
      args: any,
      received?: (result: any) => void,
    ) => {
      abort.signal.throwIfAborted();
      options.check();
      const result = await options.call(name, args, abort.signal);
      received?.(result);
      abort.signal.throwIfAborted();
      if (
        result?.exceptionDetails ||
        result?.status === "failed" ||
        result?.status === "error"
      )
        throw Object.assign(Error("Suite operation failed; no retry"), {
          code: "SUITE_OPERATION_FAILED",
        });
      if (name === "runner_wait" && result.status !== "matched")
        throw Object.assign(
          Error(
            "Suite assertion " + result.status + "; input will not be repeated",
          ),
          { code: "SUITE_ASSERTION_" + String(result.status).toUpperCase() },
        );
      return result;
    };
    void (async () => {
      try {
        for (const route of analysis ? ["@analysis"] : options.routes) {
          const row: any = {
            route,
            status: "已实现未验收",
            level: analysis
              ? "analysis-scenario"
              : options.steps.some(
                    (s) =>
                      s.tool === "runner_wait" &&
                      !["route", "element"].includes(s.arguments?.kind),
                  )
                ? "asserted-flow"
                : "page-ready",
            evidence: [],
          };
          const saved = new Map<string, any>();
          const ownedRuns: string[] = [];
          try {
            if (!analysis) {
              const nav = await call("runner_navigate", {
                method: "reLaunch",
                url: "/" + route,
              });
              row.evidence.push({ tool: "runner_navigate", result: nav });
              await call("runner_wait", {
                kind: "route",
                route,
                timeoutMs: options.timeoutMs,
              });
              await call("runner_wait", {
                kind: "element",
                selector: "body",
                timeoutMs: options.timeoutMs,
              });
            }
            let cursor = (await call("runner_status", {})).networkCursor;
            for (const step of options.steps) {
              // $before is captured before the first operation; never after a fast request.
              const args = { ...step.arguments };
              if (args.after === "$before") args.after = cursor;
              for (const [key, ref] of Object.entries(step.bind || {}))
                args[key] = lookup(saved, ref);
              const checked = parseTool(step.tool, args);
              const value = await call(step.tool, checked, (value) => {
                // Cancellation may arrive after start executed but before its
                // reply. Retain ownership before checking cancellation.
                if (
                  step.tool === "runner_execution" &&
                  args.action === "start" &&
                  value?.runId
                )
                  ownedRuns.push(value.runId);
              });
              if (step.saveAs) saved.set(step.saveAs, value);
              if (
                step.tool === "runner_screenshot" &&
                value.image &&
                options.capture
              )
                row.evidence.push({
                  tool: step.tool,
                  artifact: options.capture(value.image, route),
                });
              else row.evidence.push({ tool: step.tool, result: value });
            }
            if (!analysis) {
              const snapshot = await call("runner_snapshot", {});
              row.evidence.push({
                tool: "runner_snapshot",
                visibleElementCount: snapshot.elements?.length || 0,
                textLength: snapshot.text?.length || 0,
              });
            }
            row.status = "验收通过";
            row.note =
              row.level === "page-ready"
                ? "Only route readiness verified; business flow and native effects remain unverified."
                : "Only the supplied explicit assertions passed; native effect alignment remains unverified.";
          } catch (e: any) {
            row.status = "失败";
            row.error = {
              code: e.code || "SUITE_STEP_FAILED",
              message: e.message,
            };
            if (abort.signal.aborted) {
              row.cancelled = true;
              throw e;
            }
            if (
              [
                "CONTROL_CHANGED",
                "CONTROL_OCCUPIED",
                "SESSION_CHANGED",
                "RUNTIME_EXITED",
              ].includes(e.code)
            )
              throw e;
          } finally {
            // Stop only captures this job created. Never repeat or undo the original call.
            for (const runId of ownedRuns) {
              try {
                options.check();
                await options.call(
                  "runner_execution",
                  { action: "stop", runId },
                  new AbortController().signal,
                );
              } catch (e: any) {
                row.cleanupError = e.message;
              }
            }
            job.results.push(row);
            job.completed++;
            options.emit({ type: "suite-page", jobId: job.id, ...row });
          }
        }
        job.state = "complete";
      } catch (e: any) {
        job.state = abort.signal.aborted ? "cancelled" : "failed";
        Object.assign(job, { error: { code: e.code, message: e.message } });
      } finally {
        Object.assign(job, { endedAt: new Date().toISOString() });
        options.emit({
          type: "suite-finished",
          job: this.get(job.id, options.runtimeId),
        });
      }
    })();
    return this.get(job.id, options.runtimeId);
  }
  get(id: string, runtimeId: string) {
    const j = this.jobs.get(id);
    if (!j || j.runtimeId !== runtimeId)
      throw Error("Suite job not found for runtime");
    const { abort, ...data } = j;
    return structuredClone(data);
  }
  list(runtimeId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.runtimeId === runtimeId)
      .map(({ abort, results, ...j }) => j);
  }
  cancel(id: string, runtimeId: string, clientId: string) {
    const j = this.jobs.get(id);
    this.get(id, runtimeId);
    if (j.clientId !== clientId && clientId !== "human")
      throw Error("Only the job owner or human may cancel it");
    j.abort.abort();
    return this.get(id, runtimeId);
  }
  close() {
    for (const j of this.jobs.values()) j.abort.abort();
  }
  disconnect(clientId: string) {
    for (const j of this.jobs.values())
      if (j.clientId === clientId && j.state === "running") j.abort.abort();
  }
}
