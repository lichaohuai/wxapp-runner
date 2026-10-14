import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseTool } from "../../mcp/tools";
import { executionOutput, sliceReport } from "./output";
import { summarizeCrypto } from "../crypto-evidence";
import { businessConditionSchema } from "./schema";
export type AutopsyOptions = {
  runtimeId: string;
  sessionId: string;
  clientId: string;
  check: () => void;
  call: (name: string, args: any, signal?: AbortSignal) => Promise<any>;
  artifact: (report: any, sensitive: boolean) => string;
  requestStatus?: (id: string) => any;
};
function resultWait(a: any) {
  if (!a.resultCondition) return undefined;
  return parseTool("runner_wait", {
    action: "start",
    ...businessConditionSchema.parse(a.resultCondition),
    timeoutMs: a.timeoutMs,
  });
}
export async function autopsyPreflight(a: any, o: AutopsyOptions) {
  resultWait(a);
  const trigger =
    a.trigger && (parseTool(a.trigger.tool, a.trigger.arguments) as any);
  if (
    trigger &&
    ((a.trigger.tool === "runner_oracle" && trigger.action !== "call") ||
      (trigger.runtimeId && trigger.runtimeId !== o.runtimeId) ||
      (trigger.sessionId && trigger.sessionId !== o.sessionId))
  )
    throw Error("TRIGGER_TARGET_MISMATCH_OR_ACTION_INVALID");
  o.check();
  const [status, execution, crypto] = await Promise.all([
    o.call("runner_status", {}),
    o.call("runner_execution", { action: "status" }),
    o.call("runner_crypto_watch", { action: "status" }),
  ]);
  const reasons = [
    ...(!status.serviceReady ? ["SERVICE_NOT_READY"] : []),
    ...(!execution.enabled || !execution.files?.length
      ? ["EXECUTION_NOT_INSTRUMENTED"]
      : []),
  ];
  if (a.requestId) {
    try {
      await o.call("runner_network", { id: a.requestId });
    } catch {
      reasons.push("REQUEST_NOT_AVAILABLE");
    }
  }
  if (a.trigger?.tool === "runner_oracle") {
    const list = await o.call("runner_oracle", { action: "list" });
    const oracle = list.oracles?.find(
      (v: any) => (v.oracleId || v.id) === trigger.oracleId,
    );
    if (
      !oracle ||
      (oracle.expiresAt !== undefined && oracle.expiresAt <= Date.now())
    )
      reasons.push("ORACLE_NOT_AVAILABLE");
  }
  o.check();
  return {
    runtimeId: o.runtimeId,
    sessionId: o.sessionId,
    ready: reasons.length === 0,
    serviceReady: !!status.serviceReady,
    instrumentedFiles: execution.files?.map((f: any) => ({
      file: f.file,
      sha256: f.sha256,
    })),
    reasons,
    cryptoProbes: {
      installed: crypto.installedTapCount || 0,
      armed: crypto.activeTapCount || 0,
    },
    triggerMode: a.trigger ? "explicit-once" : "manual",
    actionsSubmitted: 0,
    resultCondition: a.resultCondition || null,
    networkMode:
      status.analysis?.networkMode ||
      status.config?.analysis?.networkMode ||
      "unknown",
    limits: [
      "Preflight does not invoke the trigger or verify business results",
      "Unobserved code and native internals remain boundaries",
    ],
  };
}
export function requestSink(event: any, field: { in: string; name: string }) {
  const root = event?.argumentsHeap?.[0]?.properties;
  if (!root)
    return {
      reason: "Request option object was not observed at the causal call site",
    };
  if (field.in === "query")
    return root.url?.ref
      ? {
          eventId: root.url.ref,
          precision: "whole-url",
          reason:
            "Query serialization is traced as a whole URL, not a fabricated per-character dependency",
        }
      : { reason: "URL construction not observed" };
  const container = root[field.in === "header" ? "header" : "data"];
  const props = container?.object?.properties;
  const key = Object.keys(props || {}).find((k) =>
    field.in === "header"
      ? k.toLowerCase() === field.name.toLowerCase()
      : k === field.name,
  );
  if (key && props[key].ref)
    return { eventId: props[key].ref, precision: "exact-option-property" };
  if (container?.ref)
    return {
      eventId: container.ref,
      precision: "whole-container",
      reason:
        "Field-specific provenance is unavailable for a serialized or externally-created container",
    };
  return {
    reason:
      "Field write not observed; select the module/file that computes request options",
  };
}
/** Controller-owned jobs survive tool returns. Each job invokes exactly one supplied trigger. */
export class AutopsyJobs {
  private jobs = new Map<string, any>();
  start(a: any, o: AutopsyOptions) {
    o.check();
    const condition = resultWait(a);
    if (
      [...this.jobs.values()].some(
        (j) => j.runtimeId === o.runtimeId && j.state === "running",
      )
    )
      throw Error("AUTOPSY_BUSY");
    const trigger = a.trigger
      ? (parseTool(a.trigger.tool, a.trigger.arguments) as any)
      : undefined;
    if (a.trigger?.tool === "runner_oracle" && trigger.action !== "call")
      throw Error("Autopsy oracle trigger requires action:call");
    if (
      (trigger?.runtimeId && trigger.runtimeId !== o.runtimeId) ||
      (trigger?.sessionId && trigger.sessionId !== o.sessionId)
    )
      throw Error("TRIGGER_TARGET_MISMATCH");
    const abort = new AbortController();
    const j: any = {
      id: randomUUID(),
      runtimeId: o.runtimeId,
      sessionId: o.sessionId,
      clientId: o.clientId,
      state: "running",
      phase: "arming",
      triggerTool: a.trigger?.tool || "manual",
      triggerCount: 0,
      createdAt: new Date().toISOString(),
      abort,
      requestStatus: o.requestStatus,
      businessResult: condition ? "waiting" : "not-evaluated",
    };
    this.jobs.set(j.id, j);
    while (this.jobs.size > 50) {
      const old = [...this.jobs.values()].find((v) => v.state !== "running");
      if (!old) break;
      this.jobs.delete(old.id);
    }
    const timer = setTimeout(() => abort.abort("timeout"), a.timeoutMs);
    const resultAbort = new AbortController();
    let resultPromise: Promise<void> | undefined;
    const call = async (name: string, args: any) => {
      abort.signal.throwIfAborted();
      o.check();
      let r = await o.call(name, args, abort.signal);
      // The tool preview is bounded for clients, but is not the analysis input.
      // Consume its immutable artifact through the same public service interface.
      if (
        name === "runner_execution" &&
        args.action === "explain" &&
        r.outputLimited &&
        r.artifactId
      ) {
        const parts: Buffer[] = [];
        let offset = 0,
          eof = false;
        while (offset < 16 * 1024 * 1024) {
          abort.signal.throwIfAborted();
          o.check();
          const page = await o.call(
            "runner_artifact",
            {
              action: "read",
              id: r.artifactId,
              offset,
              length: 65536,
              revealSensitive: true,
            },
            abort.signal,
          );
          if (page.truncated || page.evicted) break;
          const b = Buffer.from(page.data || "", "base64");
          if (!b.length) {
            eof = page.hasMore === false;
            break;
          }
          parts.push(b);
          offset += b.length;
          if (page.hasMore === false || offset >= page.readableBytes) {
            eof = true;
            break;
          }
        }
        if (eof) r = JSON.parse(Buffer.concat(parts).toString("utf8"));
        else r = { ...r, truncated: true, artifactIncomplete: true };
      }
      abort.signal.throwIfAborted();
      return r;
    };
    void (async () => {
      try {
        const before = await call("runner_status", {});
        let url = a.urlIncludes;
        if (a.requestId) {
          const original = await call("runner_network", {
            id: a.requestId,
            revealSensitive: true,
          });
          url ||= original.url?.split("?")[0];
        }
        const status = await call("runner_execution", { action: "status" });
        if (!status.enabled || !status.files?.length)
          throw Error(
            "EXECUTION_NOT_INSTRUMENTED: enable analysis.execution before boot",
          );
        j.coverage = {
          files: status.files,
          externalBoundaries: [
            "uninstrumented JS",
            "dynamic eval/Function",
            "native/WASM internals",
            "unexecuted branches",
          ],
        };
        if (a.resetSeed !== undefined)
          await call("runner_crypto_watch", {
            action: "resetRandom",
            seed: a.resetSeed,
          });
        const cryptoStatus = await call("runner_crypto_watch", {
          action: "status",
        });
        j.cryptoCursor = cryptoStatus.latestCursor || 0;
        await call("runner_crypto_watch", {
          action: "start",
          auto: true,
          observePromise: true,
          ttlMs: a.timeoutMs,
        });
        const armed = await call("runner_crypto_watch", { action: "status" });
        j.coverage.cryptoProbes = {
          installed:
            armed.installedTapCount ??
            (armed.taps || []).filter((p: any) => p.active).length,
          armed:
            armed.activeTapCount ??
            (armed.taps || []).filter((p: any) => p.active && p.remaining !== 0)
              .length,
        };
        if (!j.coverage.cryptoProbes.armed)
          j.coverage.cryptoWarning =
            "NO_ARMED_CRYPTO_PROBES: execution tracing may work, but no crypto input/output capture is ready";
        j.ownedTapIds = (armed.taps || [])
          .filter(
            (p: any) =>
              p.active &&
              !(cryptoStatus.taps || []).some(
                (old: any) => old.tapId === p.tapId && old.active,
              ),
          )
          .map((p: any) => p.tapId);
        const run = await o.call(
          "runner_execution",
          { action: "start", ttlMs: a.timeoutMs, maxEvents: 100000, pinRun: true },
          abort.signal,
        );
        j.runId = run.runId;
        abort.signal.throwIfAborted();
        if (condition) {
          // Start observation before submitting input; log queries retain the
          // pre-operation cursor. A condition match is explicit, not causal proof.
          const cursor =
            a.resultCondition.kind === "log"
              ? await call("runner_logs", { limit: 1 })
              : undefined;
          j.businessCheck = {
            condition: a.resultCondition,
            status: "waiting",
            basis: "caller-specified-result-condition",
            startedAt: new Date().toISOString(),
          };
          resultPromise = o
            .call(
              "runner_wait",
              {
                ...condition,
                waitId: "autopsy-result-" + j.id,
                ...(cursor
                  ? { after: cursor.latestId ?? cursor.latestCursor }
                  : {}),
                runtimeId: o.runtimeId,
                sessionId: o.sessionId,
              },
              AbortSignal.any([abort.signal, resultAbort.signal]),
            )
            .then(
              (r: any) => {
                j.businessResult =
                  r.status === "matched"
                    ? "condition-matched"
                    : abort.signal.reason === "timeout"
                      ? "timeout"
                      : r.status;
                j.businessCheck = {
                  ...j.businessCheck,
                  ...r,
                  status: j.businessResult,
                  endedAt: new Date().toISOString(),
                };
              },
              (e: any) => {
                j.businessResult = abort.signal.aborted
                  ? abort.signal.reason === "timeout"
                    ? "timeout"
                    : "cancelled"
                  : "error";
                j.businessCheck = {
                  ...j.businessCheck,
                  status: j.businessResult,
                  error: { code: e.code, message: e.message || String(e) },
                };
              },
            );
        }
        j.phase = a.trigger ? "triggering" : "waiting-manual-action";
        if (a.trigger) j.triggerCount = 1;
        // Dispatch once. A lost receipt is never permission to repeat the action.
        let receipt: any;
        if (a.trigger) {
          receipt = await call(a.trigger.tool, {
            ...trigger,
            ...(a.dialogPolicy && a.trigger.tool !== "runner_oracle"
              ? { dialogPolicy: a.dialogPolicy }
              : {}),
            runtimeId: o.runtimeId,
            sessionId: o.sessionId,
          });
          j.inputStatus = "sent";
          j.phase = "waiting-request";
        }
        const operationId = receipt?.operationId;
        let after = before.networkCursor || 0,
          request: any;
        while (!request) {
          const net = await call("runner_network", {
            after,
            limit: 100,
            fields: [
              "id",
              "cursor",
              "url",
              "context",
              "method",
              "state",
              "status",
              "error",
              "durationMs",
            ],
            revealSensitive: true,
          });
          if (net.gap || net.cursorResetRequired)
            throw Error("REQUEST_CURSOR_GAP");
          const rows = net.entries || [];
          request = rows.find(
            (r: any) =>
              r.context?.executionRunId === j.runId &&
              r.context?.executionEventId &&
              (!operationId ||
                r.context?.rootOperationId === operationId ||
                r.context?.operationId === operationId) &&
              (!url || r.url.includes(url)),
          );
          after = net.nextCursor ?? after;
          if (!request) await delay(40, undefined, { signal: abort.signal });
        }
        j.requestId = request.id;
        j.phase = "slicing";
        const graph = await call("runner_execution", {
          action: "explain",
          eventId: request.context.executionEventId,
          revealSensitive: true,
        });
        const site = graph.sink,
          root = site?.argumentsHeap?.[0]?.properties;
        const fields = a.field
          ? [a.field]
          : [
              ...Object.keys(root?.header?.object?.properties || {}).map(
                (name) => ({ in: "header", name }),
              ),
              ...Object.keys(root?.data?.object?.properties || {}).map(
                (name) => ({ in: "body", name }),
              ),
              ...[...new URL(request.url).searchParams.keys()].map((name) => ({
                in: "query",
                name,
              })),
            ];
        const reports: any[] = [];
        j.report = {
          request: { id: request.id, method: request.method, url: request.url },
          fields: reports,
          cryptoCalls: [],
          evidence: { complete: false, reasons: ["ANALYSIS_IN_PROGRESS"] },
        };
        const exported = new Map<number, any>();
        for (const field of fields.slice(0, 100)) {
          const sink = requestSink(site, field),
            slice = sink.eventId
              ? await call("runner_execution", {
                  action: "explain",
                  eventId: sink.eventId,
                  revealSensitive: true,
                  maxNodes: 2000,
                })
              : graph;
          for (const candidate of slice.oracleCandidates || [])
            if (!exported.has(candidate.eventId) && exported.size < 16) {
              try {
                exported.set(
                  candidate.eventId,
                  await call("runner_oracle", {
                    action: "export",
                    eventId: candidate.eventId,
                    revealSensitive: true,
                  }),
                );
              } catch {}
            }
          reports.push({
            field,
            selection: sink,
            ...sliceReport(slice),
            events: slice.events,
          });
        }
        const cryptoCalls: any[] = [],
          reasons = new Set<string>();
        j.report.cryptoCalls = cryptoCalls;
        let cryptoAfter = j.cryptoCursor,
          cryptoTruncated = false;
        // The run filter belongs in the collector, before pagination. Bounded even if
        // another client continuously records or a disconnected target repeats a cursor.
        for (let page = 0; page < 20; page++) {
          const crypto = await call("runner_crypto_watch", {
            action: "read",
            runId: j.runId,
            after: cryptoAfter,
            limit: 100,
            revealSensitive: true,
          });
          if (crypto.gap) reasons.add("CRYPTO_CURSOR_GAP");
          if (crypto.cursorResetRequired) reasons.add("CRYPTO_CURSOR_RESET");
          cryptoCalls.push(
            ...(crypto.entries || []).filter(
              (e: any) => e.executionRunId === j.runId || e.runId === j.runId,
            ),
          );
          cryptoTruncated = !!crypto.hasMore;
          if (!crypto.hasMore || crypto.cursorResetRequired) break;
          if (!(crypto.nextCursor > cryptoAfter)) {
            reasons.add("CRYPTO_CURSOR_STALLED");
            break;
          }
          cryptoAfter = crypto.nextCursor;
        }
        if (cryptoTruncated) reasons.add("CRYPTO_TRUNCATED");
        const completedCalls = new Set(
          cryptoCalls
            .filter((e) => ["return", "throw", "reject"].includes(e.phase))
            .map((e) => e.callId),
        );
        if (
          cryptoCalls.some(
            (e) => e.phase === "call" && !completedCalls.has(e.callId),
          )
        )
          reasons.add("CRYPTO_CALL_INCOMPLETE");
        const valueTruncated = (v: any): boolean =>
          !!v &&
          typeof v === "object" &&
          (v.truncated === true ||
            v.__truncated === true ||
            Object.values(v).some(valueTruncated));
        if (
          cryptoCalls.some(
            (e) =>
              e.streamTruncated ||
              [e.input, e.output, e.key, e.iv, e.chunks].some(valueTruncated),
          )
        )
          reasons.add("CRYPTO_VALUE_TRUNCATED");
        if (!reports.length) reasons.add("NO_FIELDS_OBSERVED");
        if (fields.length > 100) reasons.add("FIELDS_TRUNCATED");
        for (const r of reports) {
          if (!r.selection.eventId) reasons.add("FIELD_ORIGIN_MISSING");
          if (r.selection.precision !== "exact-option-property")
            reasons.add("FIELD_ORIGIN_IMPRECISE");
          if (r.truncated) reasons.add("EXECUTION_TRUNCATED");
          if (r.missing.length) reasons.add("EXECUTION_EVENTS_MISSING");
          if (r.opaqueBoundaries.length) reasons.add("OPAQUE_BOUNDARY");
        }
        const evidence = {
          complete: reasons.size === 0,
          reasons: [...reasons],
          meaning:
            "completeness of the observed field slice and retained crypto records; not proof of an algorithm",
        };
        if (resultPromise) {
          j.phase = "waiting-result";
          await resultPromise;
          o.check();
        }
        const transport = o.requestStatus?.(request.id) || request;
        const outcome = {
          inputStatus: j.inputStatus || "manual",
          requestObserved: true,
          transportFinished: transport.state
            ? ["complete", "failed", "capture-error"].includes(transport.state)
            : null,
          transportState: transport.state || "unknown",
          responseStatus: transport.status ?? null,
          businessResult: j.businessResult,
          businessCheck: j.businessCheck,
          sampledAt: new Date().toISOString(),
        };
        const report = {
          request: { id: request.id, method: request.method, url: request.url },
          fields: reports,
          cryptoCalls,
          cryptoSummary: summarizeCrypto(cryptoCalls, reports),
          cryptoTruncated,
          evidence,
          outcome,
          oracles: [...exported.values()],
          coverage: j.coverage,
          fieldsTruncated: fields.length > 100,
        };
        j.artifactId = o.artifact(
          executionOutput(report, a.revealSensitive),
          a.revealSensitive,
        );
        j.report = {
          ...report,
          fields: reports.map(({ events, steps, ...r }) => ({
            ...r,
            steps: steps.slice(-30),
            outputLimited: steps.length > 30,
          })),
        };
        j.state =
          j.businessResult === "timeout"
            ? "timed-out"
            : j.businessResult === "cancelled"
              ? "cancelled"
              : j.businessResult === "error"
                ? "failed"
                : evidence.complete
                  ? "complete"
                  : "partial";
        j.conclusion =
          "Observed path only; opaque and unexecuted operations are not an extracted signing algorithm";
      } catch (e: any) {
        j.state = abort.signal.aborted
          ? abort.signal.reason === "timeout"
            ? "timed-out"
            : "cancelled"
          : "failed";
        if (j.businessResult === "waiting")
          j.businessResult =
            j.state === "timed-out"
              ? "timeout"
              : j.state === "cancelled"
                ? "cancelled"
                : "error";
        j.error = {
          code: e?.code || j.state.toUpperCase().replace("-", "_"),
          message: e?.message || String(e),
        };
        if (j.triggerCount && !j.inputStatus)
          j.inputStatus =
            "receipt-unknown; inspect original operation, do not retry automatically";
      } finally {
        clearTimeout(timer);
        resultAbort.abort();
        await resultPromise;
        // Event-based crypto reverse-lookup over this run's execution events.
        // Recovers hash(input)->output pairs even when the crypto ran inside a
        // webpack/VMP closure that crypto_watch's module taps cannot reach, and
        // even when no network request was matched (e.g. timeout). Runs before
        // the run is stopped and before the artifact is built, so it is
        // included in both the report and the exported artifact.
        if (j.runId)
          try {
            const cc = await o.call("runner_execution", {
              action: "cryptoCandidates",
              runId: j.runId,
              limit: 50,
              revealSensitive: a.revealSensitive,
            });
            if (cc?.candidates?.length) {
              j.cryptoCandidates = cc.candidates;
              j.report = j.report || {
                fields: [],
                cryptoCalls: [],
                note: "No network request was matched; crypto was recovered from execution events (VMP/closure-safe reverse lookup).",
              };
              j.report.cryptoCandidates = cc.candidates;
            }
          } catch (e: any) {
            j.cryptoCandidatesError = e?.message || String(e);
          }
        if (j.report && !j.artifactId) {
          j.report.evidence = {
            complete: false,
            reasons: ["ANALYSIS_INTERRUPTED"],
          };
          j.report.cryptoSummary = summarizeCrypto(
            j.report.cryptoCalls || [],
            j.report.fields || [],
          );
          j.report.outcome = {
            businessResult: j.businessResult,
            businessCheck: j.businessCheck,
            inputStatus: j.inputStatus || "manual",
          };
          try {
            j.artifactId = o.artifact(
              executionOutput(j.report, a.revealSensitive),
              a.revealSensitive,
            );
          } catch (e: any) {
            j.artifactError = e.message || String(e);
          }
        }
        if (j.ownedTapIds?.length)
          try {
            await o.call("runner_crypto_watch", {
              action: "stop",
              tapIds: j.ownedTapIds,
            });
          } catch (e: any) {
            j.cleanupError = e?.message || String(e);
          }
        if (j.runId)
          try {
            await o.call("runner_execution", {
              action: "stop",
              runId: j.runId,
            });
          } catch (e: any) {
            j.cleanupError = e?.message || String(e);
          }
        j.endedAt = new Date().toISOString();
        j.phase = "finished";
      }
    })();
    return this.get(j.id, o.runtimeId, a.revealSensitive);
  }
  get(id: string, runtimeId: string, reveal = false) {
    const j = this.jobs.get(id);
    if (!j || j.runtimeId !== runtimeId) throw Error("AUTOPSY_NOT_FOUND");
    const { abort, requestStatus, ...v } = j,
      result = executionOutput(structuredClone(v), reveal);
    if (j.requestId && requestStatus) {
      const r = requestStatus(j.requestId);
      result.outcome = {
        ...(result.report?.outcome || {}),
        transportState: r?.state || "unavailable",
        transportFinished: r?.state
          ? ["complete", "failed", "capture-error"].includes(r.state)
          : null,
        responseStatus: r?.status ?? null,
        error: executionOutput(r?.error, reveal),
        durationMs: r?.durationMs ?? null,
        businessResult: j.businessResult,
        businessCheck: executionOutput(j.businessCheck, reveal),
        sampledAt: new Date().toISOString(),
      };
    }
    const fullBytes = Buffer.byteLength(JSON.stringify(result));
    if (fullBytes <= 131072) return result;
    // The complete report is already an artifact. Do not send large nested
    // source metadata and per-field slices through every job-status poll.
    const { report, coverage, ...summary } = result;
    return {
      ...summary,
      outputLimited: true,
      fullBytes,
      coverage: {
        files: coverage?.files
          ?.map((f: any) => ({ file: f.file, sha256: f.sha256 }))
          .slice(0, 100),
        externalBoundaries: coverage?.externalBoundaries,
      },
      report: report
        ? {
            request: report.request,
            fieldCount: report.fields.length,
            fields: report.fields.slice(0, 100).map((f: any) => ({
              field: f.field,
              selection: f.selection,
              stepCount: f.steps?.length,
              missingCount: f.missing?.length,
              opaqueCount: f.opaqueBoundaries?.length,
              truncated: f.truncated,
            })),
            oracles: report.oracles?.map((o: any) => ({
              oracleId: o.oracleId,
              eventId: o.eventId,
              source: {
                file: o.source?.file,
                line: o.source?.line,
                column: o.source?.column,
              },
            })),
            cryptoCount: report.cryptoCalls?.length,
            cryptoSummary: {
              counts: report.cryptoSummary?.counts,
              meaning: report.cryptoSummary?.meaning,
              steps: report.cryptoSummary?.steps?.slice(0, 30),
              outputLimited: report.cryptoSummary?.steps?.length > 30,
            },
            cryptoTruncated: report.cryptoTruncated,
            evidence: report.evidence,
            outcome: report.outcome,
            fieldsTruncated: report.fieldsTruncated,
          }
        : undefined,
    };
  }
  list(runtimeId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.runtimeId === runtimeId)
      .map(({ id, state, phase, sessionId, createdAt, triggerCount }) => ({
        id,
        state,
        phase,
        sessionId,
        createdAt,
        triggerCount,
      }));
  }
  cancel(id: string, runtimeId: string, clientId: string) {
    this.get(id, runtimeId);
    const j = this.jobs.get(id);
    if (j.clientId !== clientId && clientId !== "human")
      throw Error("AUTOPSY_OWNER_REQUIRED");
    j.abort.abort("cancelled");
    return this.get(id, runtimeId);
  }
  disconnect(id: string) {
    for (const j of this.jobs.values())
      if (j.clientId === id && j.state === "running")
        j.abort.abort("client-disconnected");
  }
  close() {
    for (const j of this.jobs.values()) j.abort.abort("service-closed");
  }
}
