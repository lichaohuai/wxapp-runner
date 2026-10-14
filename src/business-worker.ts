import { parentPort, workerData, threadId } from "node:worker_threads";
import fs from "node:fs";
import vm from "node:vm";
import inspector from "node:inspector";
import { safePath } from "./loader/paths";
import { PackageScripts } from "./loader/scripts";
import { RealmTimers } from "./loader/realm-timers";
import { installEvaluationScheduler } from "./debug/evaluation-scheduler";
import { copyDebug, debugContext } from "./debug/context";
import { prepareBootAnalysis, installBootAnalysis } from "./analysis/boot";
import { executionSource } from "./analysis/execution/host";
import { createWorkerMessageAdopter } from "./loader/worker-message";

const port = parentPort!,
  config = workerData;
const timers = new RealmTimers(),
  listeners = new Set<(e: any) => void>();
let alive = true,
  continued = false;
let scriptFailed = false;
const reported = new WeakSet<object>();
const send = (m: any) => {
  if (alive) port.postMessage(m);
};
const consoleBridge = Object.fromEntries(
  ["log", "info", "warn", "error", "debug", "trace"].map((level) => [
    level,
    (...args: any[]) => {
      (inspector.console as any)[level]?.(...args);
      send({
        kind: "log",
        level,
        ...copyDebug(args, 32000),
        context: debugContext.getStore(),
      });
    },
  ]),
);
const realm = vm.createContext(
  { console: consoleBridge, ...timers.globals },
  { name: "Mini-program worker (host thread " + threadId + ")" },
);
let global: any = vm.runInContext("globalThis", realm);
const adoptMessage = createWorkerMessageAdopter(realm);
// WorkerGlobalScope members are inherited in Chromium, so the official
// clearGlobal pass must not delete importScripts/self while initializing.
const scope = Object.create(Object.getPrototypeOf(realm));
Object.defineProperties(scope, {
  self: { get: () => global },
  importScripts: { value: (...urls: string[]) => urls.forEach(load) },
  postMessage: {
    value: (data: any) =>
      send({ kind: "message", data, context: debugContext.getStore() }),
  },
  addEventListener: {
    value: (name: string, cb: any) => {
      if (name === "message") listeners.add(cb);
    },
  },
  removeEventListener: {
    value: (name: string, cb: any) => {
      if (name === "message") listeners.delete(cb);
    },
  },
});
Object.setPrototypeOf(realm, scope);
let reservation: ReturnType<typeof prepareBootAnalysis>;
let analysisReady = false;
const scripts = new PackageScripts((url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "wxapp:" || !["app", "lib"].includes(parsed.host))
    throw Error("WORKER_SCRIPT_URL_INVALID");
  const library = parsed.host === "lib";
  const file = decodeURIComponent(parsed.pathname);
  const absolute = safePath(
    library ? config.baselibDir : config.packageDir,
    file,
  );
  if (!library && !analysisReady) {
    installEvaluationScheduler(realm);
    const prepared = reservation?.finish();
    reservation = undefined;
    installBootAnalysis(realm, config.analysis, prepared);
    analysisReady = true;
  }
  const source = fs.readFileSync(absolute, "utf8");
  const execution = !library ? realm.__wxappExecutionV1 : undefined;
  const marker = execution?.beginSource?.(file);
  try {
    const result = vm.runInContext(
      library
        ? source
        : executionSource(source, file, config.analysis?.execution),
      realm,
      { filename: absolute },
    );
    send({ kind: "script-ready", file, library });
    return result;
  } catch (error) {
    scriptFailed = true;
    report(error, file);
    throw error;
  } finally {
    execution?.endSource?.(marker);
  }
});
function load(url: string) {
  if (!alive) throw Error("WORKER_CLOSED");
  return scripts.load(url);
}
function report(error: any, file?: string) {
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  send({
    kind: "error",
    error: {
      name: error?.name,
      message: String(error?.message || error),
      stack: error?.stack,
      file,
    },
  });
}
port.on("message", (message) => {
  if (message.kind === "continue") {
    if (continued) return;
    continued = true;
    config.workerId = message.workerId;
    try {
      load("wxapp://lib/WAPCAdapterWorker.js");
      reservation = prepareBootAnalysis(realm, config.analysis);
      send({ kind: "ready" });
    } catch (error) {
      report(error);
    }
    return;
  }
  if (message.kind === "stop") {
    alive = false;
    timers.close();
    listeners.clear();
    reservation?.finish();
    return;
  }
  if (message.kind !== "message" || !continued || !alive) return;
  if (scriptFailed) {
    send({ kind: "message-discarded", reason: "WORKER_SCRIPT_FAILED" });
    return;
  }
  debugContext.run(message.context || { workerId: config.workerId }, () => {
    // Transfer through structured clone, then into the worker's own realm.
    // The official callback bridge handles native binary descriptors itself.
    const data = adoptMessage(message.data);
    for (const listener of listeners)
      try {
        listener({ data });
      } catch (error) {
        report(error);
      }
  });
});
process.on("unhandledRejection", (error) => report(error));
process.on("uncaughtException", (error) => report(error));
inspector.open(0, "127.0.0.1", false);
send({ kind: "inspector", url: inspector.url() });
