import { executionOutput, projectAnalysisEntries } from "./execution/output";
import { summarizeCrypto } from "./crypto-evidence";
import { bootAnalysisRuntime } from "./boot-runtime";
import { randomUUID } from "node:crypto";
import { ModuleSource } from "./source";
import { hookRuntime } from "./hook-runtime";
import { conditionPlan, targetPlan } from "./targets";
import { queryNetwork, type DebugCall } from "./network";
import { redact } from "../mcp/redact";
import { vmFunction } from "./serialize";
import { inspectorFunctionLocation } from "./function-location";
function resolveFunction(p: any) {
  const g: any = globalThis;
  let value =
    p.root === "app"
      ? g.getApp()
      : p.root === "module"
        ? (g.__wxappBootAnalysisV1?.moduleOwner(p.module)?.exports ??
          g.require(p.module))
        : g;
  for (const k of p.keys) {
    let found = false;
    for (let o = value; o != null; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (d) {
        if (!("value" in d)) throw Error("Accessor targets are not evaluated");
        value = d.value;
        found = true;
        break;
      }
    }
    if (!found) throw Error("Function target not found");
  }
  if (typeof value !== "function") throw Error("Target is not a function");
  return value;
}
const sources = new ModuleSource();
export class AnalysisTools {
  readonly sources = sources;
  constructor(
    private call: DebugCall,
    private artifact?: (data: any, identity: any) => string,
  ) {}
  async dispatch(name: string, a: any) {
    if (name === "runner_network") return queryNetwork(this.call, a);
    const status = await this.call("runner_status", { runtimeId: a.runtimeId });
    if (a.sessionId && a.sessionId !== status.sessionId)
      throw Object.assign(Error("Analysis target session changed"), {
        code: "SESSION_CHANGED",
      });
    if (a.targetId && a.targetId !== "logic")
      throw Error("Hook and module source currently support the logic target");
    const identity = {
      runtimeId: status.runtimeId,
      sessionId: status.sessionId,
      targetId: "logic",
    };
    const call = (n: string, args: any) =>
      this.call(n, { ...identity, ...args });
    const evaluate = async (
      expression: string,
      returnByValue = true,
      awaitPromise = false,
    ) => {
      const r = await call("runner_evaluate", {
        expression,
        returnByValue,
        awaitPromise,
        contextId: a.contextId,
      });
      if (r.exceptionDetails)
        throw Object.assign(
          Error(
            r.exceptionDetails.exception?.description ||
              r.exceptionDetails.text ||
              "Analysis evaluation failed",
          ),
          { code: "ANALYSIS_EVALUATION_FAILED" },
        );
      return r.result;
    };
    if (name === "runner_oracle" && a.action === "batch") {
      const results: any[] = [];
      for (const args of a.inputs) {
        try {
          results.push(
            await this.dispatch(name, { ...a, args, action: "call" }),
          );
        } catch (e: any) {
          return {
            ...identity,
            status: "failed",
            completed: results.length,
            attempted: results.length + 1,
            results,
            error: { code: e.code, message: e.message },
            retry: false,
          };
        }
      }
      return {
        ...identity,
        status: "complete",
        calls: results.length,
        results,
      };
    }
    if (
      name === "runner_oracle" &&
      (a.eventId || a.oracleId?.startsWith("execution-oracle-"))
    ) {
      return this.dispatch("runner_execution", {
        ...a,
        action:
          a.action === "export"
            ? "oracleExport"
            : a.action === "remove"
              ? "oracleRemove"
              : "oracleCall",
      });
    }
    if (name === "runner_execution") {
      if (a.when) a = { ...a, condition: conditionPlan(a.when) };
      const exists = (await evaluate("!!globalThis.__wxappExecutionV1"))?.value;
      if (!exists) {
        if (a.action === "status")
          return {
            ...identity,
            enabled: false,
            files: [],
            reason: "Enable analysis.execution before package boot",
          };
        throw Error(
          "EXECUTION_NOT_INSTRUMENTED: enable analysis.execution before boot",
        );
      }
      const value = (
        await evaluate(
          `globalThis.__wxappExecutionV1.command(${JSON.stringify(a)})`,
          true,
          a.action === "oracleCall" && a.awaitPromise,
        )
      )?.value;
      const output = projectAnalysisEntries(
        executionOutput(value, a.revealSensitive),
        a.fields,
      );
      const bytes = Buffer.byteLength(JSON.stringify(output));
      if (bytes > 131072) {
        const artifactId = this.artifact?.(output, identity);
        if (output.sliceCursor) {
          if (!artifactId)
            throw Error(
              "SLICE_ARTIFACT_UNAVAILABLE: request fewer fields or a smaller initial maxNodes",
            );
          // A preview limit is not a traversal limit. Keep the immutable slice
          // cursors; advancing a numeric log cursor here would lose graph nodes.
          const { entries, ...metadata } = output;
          return {
            ...identity,
            ...metadata,
            entries: [],
            outputLimited: true,
            fullPageInArtifact: true,
            pageEntriesReturned: 0,
            pageEntriesTotal: entries.length,
            artifactId,
            fullBytes: bytes,
            summary:
              "Read the full page artifact before following nextSliceCursor",
          };
        }
        for (const key of [
          "entries",
          "events",
          "semantic",
          "changes",
          "candidates",
          "files",
          "runs",
          "watches",
          "oracleCandidates",
        ])
          if (Array.isArray(output[key])) {
            let size = 0;
            const original = output[key];
            output[key] = original.filter((e: any) => {
              size += Buffer.byteLength(JSON.stringify(e));
              return size < 24000;
            });
            if (key === "entries" && output[key].length < original.length) {
              output.nextCursor = output[key].at(-1)?.id ?? a.after;
              output.hasMore = true;
            }
          }
        if (a.action === "explain") output.truncated = true;
        if (Buffer.byteLength(JSON.stringify(output)) > 131072)
          return {
            ...identity,
            outputLimited: true,
            artifactId,
            fullBytes: bytes,
            enabled: output.enabled,
            status: output.state,
            runId: output.runId,
            summary: "Read the artifact for the complete bounded result",
          };
        return {
          ...identity,
          ...output,
          outputLimited: true,
          artifactId,
          fullBytes: bytes,
        };
      }
      return { ...identity, ...output };
    }
    if (
      ["runner_crypto_watch", "runner_slice", "runner_oracle"].includes(name)
    ) {
      const readOnly = ["status", "read", "list", "diff"].includes(a.action);
      const payload = { ...a };
      if (name !== "runner_crypto_watch" && a.target)
        payload.plan = targetPlan(a.target);
      if (a.taps)
        payload.taps = a.taps.map((t: any) => ({
          ...t,
          plan: targetPlan(t.target),
        }));
      if (a.probes)
        payload.probes = a.probes.map((t: any) => ({
          ...t,
          plan: targetPlan(t.target),
        }));
      const exists = (await evaluate("!!globalThis.__wxappBootAnalysisV1"))
        ?.value;
      if (!exists && readOnly)
        return {
          ...identity,
          enabled: false,
          phase: "not-installed",
          entries: [],
          reason:
            "Enable runner_runtime.analysis before boot, or explicitly start live taps",
        };
      if (!exists)
        await evaluate(
          `${vmFunction(bootAnalysisRuntime)}({phase:"live",ttlMs:${a.ttlMs || 60000}})`,
        );
      const method =
        name === "runner_crypto_watch"
          ? "command"
          : name === "runner_slice"
            ? "slice"
            : "oracle";
      const value = (
        await evaluate(
          `globalThis.__wxappBootAnalysisV1.${method}(${JSON.stringify(payload)})`,
          true,
          name === "runner_oracle" && a.action === "call" && a.awaitPromise,
        )
      )?.value;
      if (
        name === "runner_oracle" &&
        a.action === "list" &&
        (await evaluate("!!globalThis.__wxappExecutionV1"))?.value
      ) {
        const extra = (
          await evaluate(
            'globalThis.__wxappExecutionV1.command({action:"oracleList"})',
          )
        )?.value;
        value.oracles.push(...(extra.oracles || []));
      }
      if (value?.entries) {
        let bytes = 0;
        const entries: any[] = [];
        for (const entry of value.entries) {
          const size = Buffer.byteLength(JSON.stringify(entry));
          if (entries.length && bytes + size > 131072) break;
          entries.push(entry);
          bytes += size;
        }
        if (entries.length < value.entries.length) {
          value.entries = entries;
          value.nextCursor = entries.at(-1)?.id ?? a.after;
          value.hasMore = true;
          value.outputLimited = true;
        }
      }
      if (
        name === "runner_crypto_watch" &&
        a.action === "read" &&
        a.summary &&
        value?.entries
      ) {
        const summary = summarizeCrypto(value.entries);
        value.entries = summary.steps;
        value.counts = summary.counts;
        value.meaning = summary.meaning;
        value.pagination =
          "cursor follows raw capture records; a call crossing pages can have a pending then terminal summary";
      }
      const conceal = (v: any): any =>
        Array.isArray(v)
          ? v.map(conceal)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [
                  k,
                  [
                    "input",
                    "thisArg",
                    "args",
                    "key",
                    "iv",
                    "output",
                    "before",
                    "value",
                    "result",
                    "verificationVector",
                    "chunks",
                    "expression",
                  ].includes(k)
                    ? "[REDACTED: use revealSensitive:true]"
                    : conceal(x),
                ]),
              )
            : v;
      return {
        ...identity,
        ...(a.revealSensitive ? value : conceal(redact(value))),
      };
    }
    if (name === "runner_source" && a.action === "graph" && a.runId) {
      const graph = this.sources.query(status.packageDir, a),
        dynamic = await this.dispatch("runner_execution", {
          ...identity,
          action: "read",
          runId: a.runId,
          after: a.offset,
          limit: a.limit,
          kinds: ["call"],
          revealSensitive: false,
        });
      return {
        ...identity,
        ...graph,
        observedCalls: dynamic.entries?.map((e: any) => ({
          eventId: e.id,
          from: e.location,
          to: e.calleeLocation,
          callPath: e.callPath,
          observed: true,
        })),
        observedNextCursor: dynamic.nextCursor,
        observedHasMore: dynamic.hasMore,
        observedGap: dynamic.gap,
      };
    }
    if (name === "runner_source" && a.action !== "locate") {
      if (a.current) {
        const actual = await this.dispatch("runner_source", {
          ...a,
          action: "locate",
          target: { module: a.path, export: "" },
          factory: true,
          current: false,
        });
        const factories = (actual.modules || []).filter(
          (m: any) => m.path === a.path && (!a.file || m.file === a.file),
        );
        if (!actual.found || factories.length !== 1)
          throw Object.assign(
            Error(
              "Cannot uniquely map the observed factory to the current package; select factoryId explicitly",
            ),
            { code: "CURRENT_FACTORY_UNKNOWN" },
          );
        a = { ...a, factoryId: factories[0].factoryId };
      }
      const result = this.sources.query(status.packageDir, a);
      const fullBytes = Buffer.byteLength(JSON.stringify(result));
      if (fullBytes > 131072) {
        const artifactId = this.artifact?.(result, identity);
        return {
          ...identity,
          path: result.path,
          file: result.file,
          factoryId: result.factoryId,
          source: result.source?.slice(0, 16000),
          offset: result.offset,
          nextOffset:
            typeof result.source === "string" && result.source.length > 16000
              ? result.offset + 16000
              : result.nextOffset,
          hasMore: !!result.hasMore || (result.source?.length || 0) > 16000,
          representation: result.representation,
          sourceMapAvailable: result.sourceMapAvailable,
          outputLimited: true,
          fullBytes,
          artifactId,
          summary: "Complete source metadata and mapping are in the artifact",
        };
      }
      return { ...identity, ...result };
    }
    const plan = a.target ? targetPlan(a.target) : undefined;
    if (plan?.root === "module" && !a.allowModuleLoad)
      await this.assertModuleLoaded(plan.module!, evaluate, call);
    if (name === "runner_source") {
      const functionExpression = a.factory
        ? `globalThis.__wxappBootAnalysisV1?.moduleFactory(${JSON.stringify(plan?.module)})`
        : `${vmFunction(resolveFunction)}(${JSON.stringify(plan)})`;
      const mapped = (
        await evaluate(
          `globalThis.__wxappExecutionV1?.functionLocation(${functionExpression})`,
        )
      )?.value;
      if (mapped) {
        const modules = this.sources
          .index(status.packageDir)
          .modules.filter(
            (m) =>
              m.file === mapped.file &&
              m.start <= mapped.start &&
              m.end >= mapped.end,
          )
          .map((m) => ({
            factoryId: m.factoryId,
            path: m.path,
            file: m.file,
            line: m.line,
            column: m.column,
            plugin: m.plugin,
          }));
        return {
          ...identity,
          found: true,
          location: mapped,
          modules,
          basis:
            "original AST location bound to the observed function identity",
        };
      }
      const result = await evaluate(functionExpression, false);
      if (!result?.objectId)
        throw Object.assign(
          Error(
            a.factory
              ? "No boot-observed factory is available for this module. Start an isolated instance with analysis.enabled:true, or select a factoryId from runner_source list for static source."
              : "The selected function is no longer available in this target; obtain a fresh function target.",
          ),
          {
            code: a.factory
              ? "CURRENT_FACTORY_UNAVAILABLE"
              : "FUNCTION_TARGET_UNAVAILABLE",
          },
        );
      const resolved = await inspectorFunctionLocation(
        result.objectId,
        (objectId) =>
          call("runner_debugger", {
            action: "properties",
            objectId,
          }),
      );
      const location = resolved.location;
      if (!location)
        return {
          ...identity,
          found: false,
          reason: resolved.reason + "; no toString guess was used",
          wrappers: resolved.wrappers,
        };
      const state = await call("runner_debugger", {
          action: "state",
          scriptId: location.scriptId,
          includeSourceMaps: true,
        }),
        script = state.scripts.find(
          (s: any) => s.scriptId === location.scriptId,
        ),
        line = location.lineNumber + 1,
        column = location.columnNumber + 1;
      const original = this.sources.originalLocation(
        status.packageDir,
        script,
        line,
        column,
      );
      return {
        ...identity,
        found: true,
        scriptId: location.scriptId,
        wrappers: resolved.wrappers,
        url: original.url,
        line: original.line,
        column: original.column,
        generatedLocation: original.mapped
          ? { url: script.url, line, column }
          : undefined,
        mappingError: original.reason,
        modules:
          original.url && !original.reason
            ? this.sources.locate(
                status.packageDir,
                original.url,
                original.line,
                original.column,
              )
            : [],
        basis: original.mapped
          ? "V8 FunctionLocation mapped through the matching analysis source map"
          : "V8 FunctionLocation; wrapper/interpreter locations remain their actual locations",
      };
    }
    const existing = "globalThis.__wxappControlledHooksV1";
    let expression: string;
    if (a.action === "install")
      expression = `${vmFunction(hookRuntime)}().install(${JSON.stringify({ ...a, hookId: randomUUID(), plan, condition: conditionPlan(a.when) })})`;
    else if (a.action === "list")
      expression = `${existing}?${existing}.list():({hooks:[]})`;
    else
      expression = `(()=>{if(!${existing})throw Error('No hooks installed in this context');return ${existing}.${a.action}(${JSON.stringify(a.hookId)}${a.action === "read" ? `,${a.after},${a.limit}` : ""});})()`;
    const result = await evaluate(expression);
    const value = result?.value || {};
    if (value.entries) {
      let bytes = 0;
      const entries: any[] = [];
      for (const row of value.entries) {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (entries.length && bytes + size > 65536) break;
        entries.push(row);
        bytes += size;
      }
      if (entries.length < value.entries.length) {
        value.hasMore = true;
        value.nextCursor = entries.at(-1)?.id ?? a.after;
        value.entries = entries;
        value.outputLimited = true;
      }
    }
    return { ...identity, ...(a.revealSensitive ? value : redact(value)) };
  }
  /** Inspect the real require closure cache without calling require or a factory. */
  private async assertModuleLoaded(
    module: string,
    evaluate: (s: string, v?: boolean) => Promise<any>,
    call: DebugCall,
  ) {
    const observed = (
      await evaluate(
        `globalThis.__wxappBootAnalysisV1?.moduleStatus(${JSON.stringify(module)})`,
      )
    )?.value;
    if (observed?.observed && observed.state === "loaded") return;
    const fn = await evaluate(
      "globalThis.internals?.__wxModule__?.require",
      false,
    );
    if (fn?.objectId) {
      const props = await call("runner_debugger", {
          action: "properties",
          objectId: fn.objectId,
        }),
        scopeId = props.internalProperties?.find(
          (p: any) => p.name === "[[Scopes]]",
        )?.value?.objectId;
      if (scopeId) {
        const scopes = await call("runner_debugger", {
          action: "properties",
          objectId: scopeId,
        });
        for (const scope of (scopes.result || [])
          .filter(
            (p: any) =>
              /^\d+$/.test(p.name) &&
              p.value?.objectId &&
              !/Global/.test(p.value.description || ""),
          )
          .slice(0, 8)) {
          const vars = await call("runner_debugger", {
            action: "properties",
            objectId: scope.value.objectId,
          });
          const candidates = (vars.result || [])
            .filter(
              (p: any) =>
                p.value?.type === "object" &&
                p.value?.subtype !== "array" &&
                p.value?.objectId,
            )
            .sort(
              (a: any, b: any) =>
                Number(b.name === "j") - Number(a.name === "j"),
            )
            .slice(0, 30);
          for (const candidate of candidates) {
            const map = await call("runner_debugger", {
                action: "properties",
                objectId: candidate.value.objectId,
              }),
              entry = map.result?.find(
                (p: any) =>
                  p.name === module ||
                  p.name === module.replace(/^\//, "") ||
                  p.name === module + ".js",
              );
            if (!entry?.value?.objectId) continue;
            const state = await call("runner_debugger", {
              action: "properties",
              objectId: entry.value.objectId,
            });
            if (
              state.result?.some(
                (p: any) => p.name === "status" && p.value?.value === 2,
              ) &&
              state.result?.some(
                (p: any) =>
                  p.name === "factory" && p.value?.type === "function",
              ) &&
              state.result?.some((p: any) => p.name === "exports" && p.value)
            )
              return;
          }
        }
      }
    }
    throw Object.assign(
      Error(
        "Cannot confirm this module is already loaded. Open its page first, or explicitly set allowModuleLoad:true to permit require() initialization.",
      ),
      {
        code:
          observed?.state && observed.state !== "unknown"
            ? "MODULE_NOT_LOADED"
            : "MODULE_LOAD_STATE_UNKNOWN",
      },
    );
  }
}
