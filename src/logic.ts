import { NativeLibraries } from "./native-components/libraries";
import { nativeObservation } from "./contracts/observe";
import { BackgroundFetchToken } from "./native-components/background-fetch";
import { nativeFallback } from "./native-components/boundary";
import { NativeRealtimeData } from "./native-components/realtime-data";
import { pageUiApis } from "./loader/page-ui";
import { tabUiApis } from "./loader/tab-ui";
import { OfficialWorkers } from "./loader/workers";
import { RealmTimers } from "./loader/realm-timers";
import { OfficialContexts } from "./loader/contexts";
import { OfficialServiceAdapter } from "./loader/service";
import { executionSource } from "./analysis/execution/host";
import { installBootAnalysis, prepareBootAnalysis } from "./analysis/boot";
import { safePath } from "./loader";
import { RunnerError, diagnostic } from "./diagnostics";
import { mapNativeMethods } from "./native-components/contracts";
import {
  mergeHardwareAuthorization,
  nativeAuthorization,
} from "./location/native-contract";
import { createWxShim } from "./wx-shim";
import { createHostApis } from "./wx-shim/host";
import { NativeFilesStorage } from "./native-components/files-storage";
import { NativeNetwork } from "./native-components/network";
import { NativeTransfers } from "./native-components/transfers";
import { NativeSocket } from "./native-components/socket";
import { ImageData, Path2D, loadImage } from "@napi-rs/canvas";
import { ServiceCanvas2D, ServiceCanvasRegistry, CanvasAnimationFrames } from "./native-components/service-canvas";
import { bridgeWxToRealm } from "./wx-shim/realm";
import { DeviceRuntime } from "./device/runtime";
import { CloudRuntime } from "./cloud/runtime";
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import * as inspector from "node:inspector";
import { installInspectorCompatibility } from "./inspector-compat";
import { observeFetch } from "./mcp/network";
import { installTransport } from "./debug/transport";
import { DebugState } from "./debug/state";
import { installEvaluationScheduler } from "./debug/evaluation-scheduler";
import { copyDebug, debugContext, setDebugEmitter } from "./debug/context";
import fs from "node:fs";
import { PackageScripts, resolvePackageScript } from "./loader/scripts";
import { nativeSkylineInfo } from "./loader/renderer";
import { localSubpackage } from "./loader/subpackages";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { wxConfig, systemInfo } from "./config";
import { HostContactStore } from "./loader/contacts";
import { WxbotClient } from "./wxbot";
const pendingRPC = new Map<number, any>();
let rpcSeq = 0;
let nativeBufferSequence = 0;
const nativeBuffers = new Map<number, ArrayBuffer>();
const cameraBuffers = new Map<string, number>();
function rpc(name: string, args: any, timeoutMs?: number) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    const timer = timeoutMs ? setTimeout(() => {
      pendingRPC.delete(id);
      reject(Error(name + ": local receipt timed out"));
    }, timeoutMs) : undefined;
    pendingRPC.set(id, {
      resolve(value: any) { clearTimeout(timer); resolve(value); },
      reject(error: any) { clearTimeout(timer); reject(error); },
    });
    port.postMessage({
      type: "rpc",
      id,
      name,
      args,
      context: debugContext.getStore() || null,
    });
  });
}
const cfg = workerData;
const nativeLibraries = new NativeLibraries(cfg.baselibDir);
const serviceCanvases = new ServiceCanvasRegistry(frame => port.postMessage({ type: "canvas-frame", ...frame }));
const canvasFrames = new CanvasAnimationFrames(error => logger.error("CANVAS_ANIMATION_ERROR", error));
const port = parentPort!;
if (cfg.managedBoot)
  cfg.checkSocketURL = (url: string) =>
    rpc("__debug_network", { action: "socket-policy", url });
cfg.emitNetwork = (record: any) =>
  port.postMessage({ type: "mcp-network", record });
if (cfg.managedBoot)
  cfg.captureSocketFrame = async (bytes: Buffer, binary: boolean) => {
    const { id } = (await rpc("__debug_network", {
      action: "artifact-create",
      kind: "body",
      mimeType: binary
        ? "application/octet-stream"
        : "text/plain; charset=utf-8",
      representation: "websocket-message",
    })) as any;
    for (let offset = 0; offset < bytes.length; offset += 262144)
      await rpc("__debug_network", {
        action: "artifact-append",
        id,
        data: bytes.subarray(offset, offset + 262144),
      });
    await rpc("__debug_network", { action: "artifact-finish", id });
    return id;
  };
setDebugEmitter((event) => port.postMessage({ type: "debug-event", event }));
if (cfg.managedBoot)
  installTransport(
    (action, args) => rpc("__debug_network", { action, ...args }),
    (record) => port.postMessage({ type: "mcp-network", record }),
    cfg.debug?.bodyLimit,
    cfg.debug?.previewBytes,
  );
else
  observeFetch((record) => port.postMessage({ type: "mcp-network", record }));
installInspectorCompatibility();
inspector.open(0, "127.0.0.1", false);
port.postMessage({ type: "inspector-ready", url: inspector.url() });
const log = (...a: any[]) =>
  port.postMessage({
    type: "log",
    args: a
      .map((x) => (typeof x === "string" ? x : String(x)))
      .map((x) => (x.length > 1800 ? x.slice(0, 1800) : x)),
  });
const logger = Object.fromEntries(
  ["log", "info", "warn", "error", "debug", "trace"].map((k) => [
    k,
    (...a: any[]) => {
      const method = (inspector.console as any)[k];
      if (typeof method === "function") method(...a);
      const snapshot = copyDebug(a, 32000);
      port.postMessage({
        type: "structured-log",
        level: k,
        args: snapshot.value,
        truncated: snapshot.truncated,
        context: debugContext.getStore() || null,
      });
    },
  ]),
);
const c: any = {
  console: logger,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  TextEncoder,
  TextDecoder,
  performance,
  NativeGlobal: {
    OffscreenCanvas: ServiceCanvas2D, ImageData, Path2D, Blob,
    getOffScreenCanvas: (id: number) => serviceCanvases.get(id),
    removeOffScreenCanvas: (id: number) => serviceCanvases.remove(id),
    requestAnimationFrame: (cb: Function | number) => canvasFrames.request(cb, debugContext.getStore()?.pageId),
    cancelAnimationFrame: (id: number) => canvasFrames.cancel(id),
    fetchAsBlob: (url: string) => fetch(url).then(r => { if (!r.ok) throw Error("Canvas image HTTP " + r.status); return r.blob(); }),
  },
  createImageBitmap: async (blob: Blob) => loadImage(Buffer.from(await blob.arrayBuffer())),
  WeixinArrayBuffer: { get: (id: number) => nativeBuffers.get(id) },
  getNativeBufferId: () => ++nativeBufferSequence,
  setNativeBuffer: (id: number, data: ArrayBuffer) =>
    nativeBuffers.set(id, data),
  getNativeBuffer: (id: number) => nativeBuffers.get(id),
  __wxConfig: wxConfig(cfg),
  __wxAppData: {},
  __wxAppCode__: {},
  __wxRoute: "",
};
process.on("unhandledRejection", (e: any) =>
  logger.error("UNHANDLED REJECTION", e),
);
const contexts = new Map<number, any>();
// Only contexts initialized as app business hosts receive automatic route bundles.
// SDKs can allocate auxiliary contexts later; injecting app chunks into those
// contexts corrupts their initialization and poisons every later navigation.
const businessContexts = new Set<number>();
const analysisReservations = new Map<number, { finish(): any }>();
const packageScripts = new Map<number, PackageScripts>();
const contextDebugDisposers = new Map<number, () => void>();
const contextInfo = new Map<number, any>();
const realmTimers = new Map<number, RealmTimers>();
let workers: OfficialWorkers | undefined;
let startupStage = "preflight";
let pluginVerification: any = { state: "not-requested" };
const hostContacts = new HostContactStore(cfg);
function loaderEvent(type: string, data: any = {}) {
  port.postMessage({
    type: "loader-event",
    event: { type, ...data },
    status: {
      stage: startupStage,
      contexts: [...contextInfo.values()],
      workers: workers?.snapshot() || [],
      pluginVerification,
      pluginContacts: hostContacts.snapshot(),
      nativeLibraryModule: nativeLibraries.provenance,
    },
  });
}
function stage(value: string, data: any = {}) {
  startupStage = value;
  loaderEvent("loader-stage", { stage: value, ...data });
}
let seq = 0;
const hostApis = createHostApis(cfg, log);
const backgroundFetchToken = new BackgroundFetchToken(path.join(path.dirname(cfg.storageFile), "background-fetch-token.json"));
const nativeFilesStorage = new NativeFilesStorage(hostApis, (id) => {
  const value = nativeBuffers.get(id);
  nativeBuffers.delete(id);
  return value;
});
const nativeNetwork = new NativeNetwork(
  cfg,
  log,
  (id) => {
    const value = nativeBuffers.get(id);
    nativeBuffers.delete(id);
    return value;
  },
  (name, value) => c.WeixinJSBridge.subscribeHandler(name, value),
);
const nativeTransfers = new NativeTransfers(hostApis, log, (name, value) =>
  c.WeixinJSBridge.subscribeHandler(name, value),
);
const nativeSocket = new NativeSocket(
  cfg,
  (id) => {
    const value = nativeBuffers.get(id);
    nativeBuffers.delete(id);
    return value;
  },
  (name, value) => c.WeixinJSBridge.subscribeHandler(name, value),
);
const nativeRealtimeData = new NativeRealtimeData(
  record => rpc("__debug_realtime_data", record, 5000) as Promise<{ eventId: number }>,
  (name, value) => c.WeixinJSBridge.subscribeHandler(name, value),
);
let subpackageTaskId = 0;
function routeContextIds(contextId?: number) {
  if (contextId !== undefined) return [contextId];
  const owner = debugContext.getStore()?.contextId;
  if (businessContexts.has(owner)) return [owner];
  if (businessContexts.size === 1) return [...businessContexts];
  throw Error(
    "CONTEXT_AMBIGUOUS: package load requires its owning business context",
  );
}
function createSubpackageTask(name: unknown, contextId?: number) {
  const pkg = localSubpackage(cfg.packageDir, cfg.app, name);
  const ids = routeContextIds(contextId);
  if (
    !ids.length ||
    ids.some((id) => !businessContexts.has(id) || !contexts.has(id))
  )
    throw Error("Subpackage logic context is unavailable");
  const taskId = ++subpackageTaskId;
  // Native task creation returns its ID before completion events. Yield past
  // the invoking JS stack so the real base library can register its listeners.
  setTimeout(() => {
    const data = { taskId, moduleName: pkg.moduleName };
    try {
      for (const id of ids) for (const file of pkg.files) evaluate(id, file);
      c.WeixinJSBridge.subscribeHandler("onSubPackageReady", {
        moduleName: pkg.moduleName,
      });
      c.WeixinJSBridge.subscribeHandler("onLoadSubPackageTaskStateChange", {
        ...data,
        state: "success",
      });
    } catch (error: any) {
      logger.error("SUBPACKAGE LOAD FAILED", error);
      c.WeixinJSBridge.subscribeHandler("onLoadSubPackageTaskStateChange", {
        ...data,
        state: "fail",
        errMsg: error.message,
      });
    }
  }, 0);
  return taskId;
}
let nativeCallSequence=0;
function invoke(n:string,a:any,id:number,reply?:(value:any)=>void,backends?:Parameters<typeof invokeImplementation>[4]) {
  if(!cfg.debug?.nativeContractCalls) return invokeImplementation(n,a,id,reply,backends);
  const context=debugContext.getStore(), layer=context?.workerId!==undefined?"worker":"logic";
  const observation=nativeObservation(n,layer,context,`logic:${++nativeCallSequence}`,event=>port.postMessage({type:"native-contract",event}));
  try {
    const result=invokeImplementation(n,a,id,value=>{
      const target=reply || ((v:any)=>c.WeixinJSBridge.invokeCallbackHandler(id,v));
      const result=target(value);observation.callback();return result;
    },backends);
    observation.returned(result);return result;
  } catch(error) {observation.threw();throw error;}
}
function invokeImplementation(
  n: string,
  a: any,
  id: number,
  reply: (value: any) => void = (value) =>
    c.WeixinJSBridge.invokeCallbackHandler(id, value),
  backends = {
    network: nativeNetwork,
    transfers: nativeTransfers,
    socket: nativeSocket,
    files: nativeFilesStorage,
    realtime: nativeRealtimeData,
  },
) {
  const ownerId = debugContext.getStore()?.contextId;
  const sendReply = reply;
  reply = (value) => {
    if (ownerId !== undefined && !contextInfo.has(ownerId)) return;
    sendReply(value);
  };
  const library = nativeLibraries.invoke(n, a, value => reply(value), () => ownerId === undefined || contextInfo.has(ownerId));
  if (library !== undefined) return library;
  const network = backends.network.invoke(n, a, (value) => reply(value));
  if (network !== undefined) return network;
  const transfer = backends.transfers.invoke(n, a, (value) => reply(value));
  if (transfer !== undefined) return transfer;
  const socket = backends.socket.invoke(n, a, (value) => reply(value));
  if (socket !== undefined) return socket;
  const filesStorage = backends.files.invoke(n, a, (value) => reply(value));
  if (filesStorage !== undefined) return filesStorage;
  const realtime = backends.realtime.invoke(n, a, (value) => reply(value));
  if (realtime !== undefined) return realtime;
  let r: any = { errMsg: n + ":ok" };
  if (n === "setBackgroundFetchToken" || n === "getBackgroundFetchToken") {
    try {
      const result = n === "setBackgroundFetchToken" ? backgroundFetchToken.set(a.token) : backgroundFetchToken.get();
      return JSON.stringify({ ...r, ...result });
    } catch (error: any) { return JSON.stringify({ errMsg: n + ":fail " + error.message }); }
  }
  if (n === "systemLog") {
    // Original PC SystemLogJsApiImpl forwards dataArray[].message to its log
    // sink. Keep the native batch and its embedded level/stack intact; a batch
    // can contain different levels, so do not invent a single severity for it.
    if (!Array.isArray(a.dataArray))
      return JSON.stringify({ errMsg: "systemLog:fail dataArray must be an array" });
    logger.info("[native.systemLog]", a.dataArray.map((entry: any) => entry?.message || ""));
    return JSON.stringify(r);
  }
  if (n === "authorize") {
    try {
      a = nativeAuthorization(a);
    } catch (error: any) {
      return JSON.stringify({ errMsg: n + ":fail " + error.message });
    }
  }
  if (n === "operateCamera" || mapNativeMethods.has(n)) {
    const context = debugContext.getStore();
    rpc(n === "operateCamera" ? "__cameraOperate" : "__mapOperate", {
      ...a,
      method: n,
    }).then(
      (data: any) => {
        if (n === "operateCamera") {
          const key = `${data.__runnerPageId}_${a.cameraId}`;
          delete data.__runnerPageId;
          if (a.type === "listenFrameChange") {
            const old = cameraBuffers.get(key);
            if (old) nativeBuffers.delete(old);
            const bufferId = ++nativeBufferSequence;
            nativeBuffers.set(
              bufferId,
              vm.runInContext(
                `new ArrayBuffer(${data.width * data.height * 4})`,
                c,
              ),
            );
            cameraBuffers.set(key, bufferId);
            data = { ...data, bufferId };
          }
          if (a.type === "closeFrameChange") {
            const old = cameraBuffers.get(key);
            if (old) nativeBuffers.delete(old);
            cameraBuffers.delete(key);
          }
        }
        reply({
          errMsg: n + ":ok",
          ...data,
        });
      },
      (e) =>
        reply({
          errMsg: n + ":fail " + e.message,
        }),
    );
    return "";
  }
  if (n === "operateVideoPlayer") {
    rpc("__videoOperate", a).then(
      (result) =>
        reply({
          errMsg: n + ":ok",
          ...(result as any),
        }),
      (error) =>
        reply({
          errMsg: n + ":fail " + error.message,
        }),
    );
    return "";
  }
  if (n === "verifyPlugin") {
    const started = Date.now();
    let providers: any[] = [];
    try {
      const request = typeof a.data === "string" ? JSON.parse(a.data) : a.data;
      providers = (request?.plugins || []).map((p: any) => ({ provider: p.provider, inner_version: p.inner_version }));
    } catch { /* The client reports a structured validation failure below. */ }
    const verification = { state: "pending", providers, contextId: ownerId, startedAt: new Date(started).toISOString() };
    pluginVerification = verification;
    loaderEvent("plugin-verification", pluginVerification);
    new WxbotClient(cfg, log).verifyPlugin(a.data).then(result => {
      pluginVerification = { ...verification, state: "response-received", elapsedMs: Date.now() - started };
      loaderEvent("plugin-verification", pluginVerification);
      reply({ errMsg: "verifyPlugin:ok", ...result });
    }, error => {
      pluginVerification = { ...verification, state: "failed", elapsedMs: Date.now() - started,
        code: error.runnerCode || "PLUGIN_VERIFY_FAILED", reason: error.message };
      logger.error("PLUGIN_VERIFICATION_FAILED", pluginVerification);
      loaderEvent("plugin-verification", pluginVerification);
      reply({ errMsg: "verifyPlugin:fail " + error.message, runnerCode: pluginVerification.code });
    });
    return;
  }
  if (n === "batchGetContact") {
    // Same owner-aware reply path as other async native APIs. The stored
    // response is cloned on each read and never treated as verifyPlugin data.
    queueMicrotask(() => {
      if (ownerId !== undefined && !contextInfo.has(ownerId)) return;
      try {
        const result = hostContacts.batch(a);
        loaderEvent("plugin-contacts", hostContacts.snapshot());
        reply({ errMsg: "batchGetContact:ok", ...result });
      } catch (e: any) {
        loaderEvent("plugin-contacts", hostContacts.snapshot());
        reply({ errMsg: "batchGetContact:fail " + e.message, runnerCode: e.runnerCode,
          ...(e.missingAppIds ? { missingAppIds: e.missingAppIds } : {}) });
      }
    });
    return "";
  }
  if (n === "operateWXData") {
    const context = debugContext.getStore();
    port.postMessage({
      type: "debug-event",
      event: {
        type: "cloud-invoke",
        apiName: a.data?.api_name,
        qbaseApi: a.data?.data?.qbase_api_name,
        context,
      },
    });
    new WxbotClient(cfg, log)
      .operate(a.data)
      .then(async (result) => {
        const request =
          typeof a.data === "string" ? JSON.parse(a.data) : a.data;
        if (
          ["webapi_getuserallappauth", "webapi_getwxapluginuserscope"].includes(
            request?.api_name,
          )
        ) {
          const local: any = await rpc("getSetting", {});
          return mergeHardwareAuthorization(result, local.authSetting);
        }
        return result;
      })
      .then(
        (result) =>
          reply({
            errMsg: n + ":ok",
            ...result,
          }),
        (error) =>
          reply({
            errMsg: n + ":fail " + error.message,
            runnerCode: error.runnerCode,
          }),
      );
    return "";
  }
  if (n === "getSystemInfo" || n === "getDeviceInfo")
    Object.assign(r, systemInfo);
  else if (n === "getSkylineInfo" || n === "getSkylineInfoSync")
    Object.assign(r, nativeSkylineInfo());
  else if (
    n === "createLoadSubPackageTask" ||
    n === "createLoadSubPackageTaskForWaiter"
  ) {
    try {
      r.loadTaskId = createSubpackageTask(a.moduleName, a.contextId);
    } catch (error: any) {
      r = { errMsg: n + ":fail " + error.message };
    }
  } else if (n === "listenLoadSubPackageTaskStateChange") {
    // Local files have no download progress; completion is always delivered.
  } else if (n === "getPermissionBytes")
    // Base-library guardPermissions treats zero as "not service-banned".
    // These feature gates are unrelated to user consent or OS hardware access.
    r.permissionBytes = a.indexes.map((index: number) =>
      index === 708 ? 0 : 1,
    );
  else if (n === "getNetworkType") r.networkType = "wifi";
  else if (n === "getMenuButtonBoundingClientRect")
    Object.assign(r, {
      left: 290,
      top: 28,
      right: 380,
      bottom: 60,
      width: 90,
      height: 32,
    });
  else if (
    [
      "getCurrentRoute",
      "navigateTo",
      "redirectTo",
      "switchTab",
      "reLaunch",
      "navigateBack",
      "showToast",
      "hideToast",
      "showLoading",
      "hideLoading",
      "showModal",
      "showActionSheet",
      "authorize",
      "getSetting",
      "openSetting",
      "getLocation",
      "openLocation",
      "openMapApp",
      "scanCode",
      "setTabBarBadge",
      ...pageUiApis,
      ...tabUiApis,
      "shareAppMessage",
      "shareTimeline",
    ].includes(n)
  ) {
    const isNavigation = [
      "navigateTo",
      "redirectTo",
      "switchTab",
      "reLaunch",
      "navigateBack",
    ].includes(n);
    rpc(
      isNavigation ? "__nativeNavigation" : n,
      isNavigation ? { name: n, args: a } : a,
    ).then(
      (result) =>
        reply({
          errMsg: n + ":ok",
          ...(result as any),
        }),
      (error) =>
        reply({
          errMsg: n + ":fail " + error.message,
        }),
    );
    return "";
  } else if (n === "getABTestConfig") r.testConfig = "0";
  else {
    r = nativeFallback(n);
    port.postMessage({ type: "native-boundary", api: n, layer: debugContext.getStore()?.workerId !== undefined ? "worker" : "logic",
      disposition: r.runnerDisposition, context: debugContext.getStore() });
  }
  return JSON.stringify(r);
}
c.WeixinJSCore = {
  invokeHandler: (n: string, a: string, id: number) =>
    invoke(n, JSON.parse(a || "{}"), id),
  publishHandler: (n: string, a: string, ids: string) => {
    log("PUBLISH", n, ids);
    port.postMessage({
      type: "publish",
      name: n,
      data: JSON.parse(a || "{}"),
      ids: JSON.parse(ids || "[]"),
      context: debugContext.getStore() || null,
    });
  },
};
const evalFile = (ctx: any, root: string, f: string) => {
  try {
    const p = safePath(root, f);
    const original = fs.readFileSync(p, "utf8");
    const source =
      root === cfg.packageDir
        ? executionSource(original, f, cfg.analysis?.execution)
        : original;
    const execution =
      root === cfg.packageDir ? ctx.__wxappExecutionV1 : undefined;
    const marker = execution?.beginSource?.(f);
    try {
      return vm.runInContext(source, ctx, { filename: p });
    } finally {
      execution?.endSource?.(marker);
    }
  } catch (e: any) {
    if (e.diagnostic) throw e;
    throw new RunnerError(
      diagnostic(
        "SCRIPT_EXECUTION_FAILED",
        "logic",
        e.message,
        "Check this script and the native globals it requires.",
        { file: f },
      ),
      e,
    );
  }
};
const evaluate = (id: number, f: string) => {
  const scripts = packageScripts.get(id);
  if (!scripts) throw Error("Logic context no longer exists: " + id);
  const name = path.posix.normalize(f.replace(/^\//, ""));
  const actual = resolvePackageScript(name, cfg.plan.scriptAliases);
  if (actual !== name) log("LOAD ALIAS", name, actual);
  initializeContext(id);
  return scripts.load(actual);
};
const legacyJsctx: any = {
  alloc(name = "subContext", callback?: () => void, empty = false) {
    const id = ++seq;
    log("HOST CONTEXT ALLOC", id, name);
    contextInfo.set(id, {
      id,
      name,
      role: "auxiliary",
      state: "initializing",
      empty,
    });
    loaderEvent("context-created", { contextId: id, name });
    const sub: any = {
      __wxConfig: c.__wxConfig,
      __wxAppCode__: {},
      __wxAppData: {},
      __WXML_GLOBAL__: {},
      __GWX_GLOBAL__: {},
      __vd_version_info__: {},
      console: logger,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      WeixinJSContext: legacyJsctx,
      WeixinJSContextId: id,
      __passWAServiceGlobal__: (o: any) => (sub.internals = o),
    };
    vm.createContext(sub, { name: `Mini-program business ${id}` });
    const reservation = prepareBootAnalysis(sub, cfg.analysis);
    if (reservation) analysisReservations.set(id, reservation);
    contextDebugDisposers.set(id, installEvaluationScheduler(sub));
    contexts.set(id, sub);
    packageScripts.set(
      id,
      new PackageScripts((f) => {
        const info = contextInfo.get(id);
        info.files ??= [];
        info.files.push(f);
        loaderEvent("context-script-start", {
          contextId: id,
          file: f,
          role: info.role,
        });
        try {
          const result = evalFile(sub, cfg.packageDir, f);
          loaderEvent("context-script-ready", {
            contextId: id,
            file: f,
            role: info.role,
          });
          return result;
        } catch (error: any) {
          loaderEvent("context-script-failed", {
            contextId: id,
            file: f,
            error: error.message,
          });
          throw error;
        }
      }),
    );
    if (!empty) evalFile(sub, cfg.baselibDir, "WASubContext.js");
    contextInfo.get(id).state = "ready";
    loaderEvent("context-ready", { contextId: id });
    callback?.();
    return id;
  },
  allocEmpty(name: string, callback?: () => void) {
    return legacyJsctx.alloc(name, callback, true);
  },
  evaluateScriptFile(id: number, file: string, callback?: () => void) {
    evaluate(id, file);
    callback?.();
    return 1;
  },
  loadJsFiles(id: number, files: string) {
    for (const f of JSON.parse(files)) evaluate(id, f);
    return 1;
  },
  loadLibFiles(id: number, files: string) {
    const target = id === 0 ? c : contexts.get(id);
    if (!target) throw Error("Logic context no longer exists: " + id);
    for (const f of JSON.parse(files)) evalFile(target, cfg.baselibDir, f);
    return 1;
  },
  destroy(id: number) {
    nativeRealtimeData.closeContext(id);
    analysisReservations.get(id)?.finish();
    analysisReservations.delete(id);
    businessContexts.delete(id);
    contextDebugDisposers.get(id)?.();
    contextDebugDisposers.delete(id);
    if (contextInfo.has(id)) {
      contextInfo.get(id).state = "destroyed";
      loaderEvent("context-destroyed", { contextId: id });
      contextInfo.delete(id);
    }
    contexts.delete(id);
    packageScripts.delete(id);
  },
};
let officialContexts: OfficialContexts | undefined;
if (cfg.loaderAdapter !== "legacy") {
  officialContexts = new OfficialContexts(cfg.baselibDir, c.__wxConfig, {
    create(id, options) {
      if (options.name === "main" && id === 1) {
        c.WeixinJSContextId = id;
        contextInfo.set(id, {
          id,
          name: options.name,
          role: "main-service",
          state: "initializing",
        });
        loaderEvent("context-created", { contextId: id, role: "main-service" });
        return c;
      }
      const timers = new RealmTimers();
      realmTimers.set(id, timers);
      const sub: any = {
        console: logger,
        ...timers.globals,
        __wxAppCode__: {},
        __wxAppData__: {},
        __WXML_GLOBAL__: {},
        __GWX_GLOBAL__: {},
        __vd_version_info__: {},
        WeixinJSContextId: id,
        __passWAServiceGlobal__: (o: any) => {
          sub.internals = o;
        },
      };
      vm.createContext(sub, { name: `Mini-program business ${id}` });
      contexts.set(id, sub);
      contextInfo.set(id, {
        id,
        name: options.name,
        role: "auxiliary",
        state: "initializing",
        empty: true,
      });
      const reservation = prepareBootAnalysis(sub, cfg.analysis);
      if (reservation) analysisReservations.set(id, reservation);
      contextDebugDisposers.set(id, installEvaluationScheduler(sub));
      packageScripts.set(
        id,
        new PackageScripts((file) => {
          const info = contextInfo.get(id);
          info.files ??= [];
          info.files.push(file);
          loaderEvent("context-script-start", {
            contextId: id,
            file,
            role: info.role,
          });
          try {
            const result = evalFile(sub, cfg.packageDir, file);
            loaderEvent("context-script-ready", {
              contextId: id,
              file,
              role: info.role,
            });
            return result;
          } catch (error: any) {
            loaderEvent("context-script-failed", {
              contextId: id,
              file,
              error: error.message,
            });
            throw error;
          }
        }),
      );
      loaderEvent("context-created", { contextId: id, name: options.name });
      return sub;
    },
    ready(id) {
      contextInfo.get(id).state = "ready";
      loaderEvent("context-ready", { contextId: id });
    },
    read(file, library) {
      return fs.readFileSync(
        safePath(library ? cfg.baselibDir : cfg.packageDir,
          library ? file : resolvePackageScript(file, cfg.plan.scriptAliases)),
        "utf8",
      );
    },
    evaluate(id, source) {
      const target = id === 1 ? c : contexts.get(id);
      if (!target) throw Error("CONTEXT_CLOSED: " + id);
      if (source.type === "usr" && source.src) return evaluate(id, source.src);
      const value = vm.runInContext(source.code, target, {
        filename: source.src || "wxapp-host-config.js",
      });
      if (source.src === "WASubContext.js") contextInfo.get(id).empty = false;
      return value;
    },
    dispose(id) {
      realmTimers.get(id)?.close();
      realmTimers.delete(id);
      workers?.closeContext(id);
      nativeNetwork.closeContext(id);
      nativeTransfers.closeContext(id);
      nativeSocket.closeContext(id);
      nativeRealtimeData.closeContext(id);
      if (id !== 1) legacyJsctx.destroy(id);
    },
    publish(name, value) {
      c.WeixinJSBridge.subscribeHandler(name, value);
    },
    event: loaderEvent,
    log,
  });
}
c.WeixinJSContext = officialContexts?.api || legacyJsctx;
workers = new OfficialWorkers({
  baselibDir: cfg.baselibDir,
  packageDir: cfg.packageDir,
  bootstrap: path.join(__dirname, "business-worker.cjs"),
  config: wxConfig(cfg),
  analysis: cfg.analysis,
  global: () => c,
  systemInfo,
  inspector(workerId, url) {
    port.postMessage({ type: "worker-inspector", workerId, url });
    if (!cfg.managedBoot) workers!.continue(workerId);
  },
  event: loaderEvent,
  log(level, args, context) {
    port.postMessage({ type: "structured-log", level, args, context });
  },
  native(workerId, publish) {
    const config = {
      ...cfg,
      emitNetwork: (record: any) =>
        cfg.emitNetwork({ ...record, targetId: `worker:${workerId}` }),
    };
    const network = new NativeNetwork(config, log, () => undefined, publish);
    const transfers = new NativeTransfers(hostApis, log, publish);
    const socket = new NativeSocket(config, () => undefined, publish);
    const files = new NativeFilesStorage(hostApis, () => undefined);
    const realtime = new NativeRealtimeData(
      record => rpc("__debug_realtime_data", record, 5000) as Promise<{ eventId: number }>,
      publish,
    );
    let live = true;
    return {
      invoke(name, args, privateArgs, callback) {
        return debugContext.run(
          {
            ...debugContext.getStore(),
            workerId,
            targetId: `worker:${workerId}`,
            pageId: -9,
          },
          () =>
            invoke(
              name,
              args,
              0,
              (value) => {
                if (live) callback(value);
              },
              { network, transfers, socket, files, realtime },
            ),
        );
      },
      close() {
        live = false;
        network.close();
        transfers.close();
        socket.close();
        realtime.close();
      },
    };
  },
});
c.WeixinWorker = workers.api;
vm.createContext(c, { name: "WeChat service base library" });
let booted = false;
let bootStarted = false;
let bootError: Error | undefined;
const routePreparations: any[] = [];
function prepareLogicRoute(m: any) {
  try {
    if (m.moduleName) {
      const files =
        m.moduleName === "__APP__"
          ? cfg.plan.logicFiles
          : localSubpackage(cfg.packageDir, cfg.app, m.moduleName).files;
      if (!businessContexts.size) throw Error("Package has no logic context");
      for (const id of routeContextIds(m.contextId))
        for (const file of files) evaluate(id, file);
      port.postMessage({ type: "route-prepared", id: m.id, route: m.route });
      return;
    }
    const plan = cfg.plan.pages[m.route];
    if (!plan || plan.issues.length || !businessContexts.size)
      throw Error("Route has no valid logic context or package plan");
    for (const id of routeContextIds(m.contextId))
      for (const file of plan.logicFiles || []) evaluate(id, file);
    port.postMessage({ type: "route-prepared", id: m.id, route: m.route });
  } catch (e: any) {
    port.postMessage({
      type: "route-prepared",
      id: m.id,
      error: e.message,
      diagnostic: e.diagnostic,
    });
  }
}
function initializeContext(id: number) {
  const sub = contexts.get(id);
  if (!sub) throw Error("Logic context closed: " + id);
  if (contextInfo.get(id)?.hostInitialized) return;

  const preparation = analysisReservations.get(id)?.finish();
  analysisReservations.delete(id);
  // The base library replaces console during initialization; expose the native
  // inspector-backed host console to business modules afterwards.
  sub.console = Object.assign(Object.create(sub.console || null), logger);
  if (!contextInfo.get(id).empty) {
    const device = new DeviceRuntime(systemInfo);
    sub.__runnerDeviceDebug = (args: any) => device.debug(args);
    sub.wx = bridgeWxToRealm(
      sub,
      createWxShim(sub.wx, cfg, rpc, log, device, hostApis),
    );
    const cloud = new CloudRuntime(sub.wx.cloud, !!(cfg.wxbot && cfg.deviceId));
    sub.__runnerCloudDebug = (args: any) => cloud.query(args);
    new DebugState(
      sub,
      (event) => port.postMessage({ type: "debug-event", event }),
      log,
    ).install();
  }
  const analysisBoot = installBootAnalysis(sub, cfg.analysis, preparation);
  if (analysisBoot)
    port.postMessage({
      type: "debug-event",
      event: { type: "analysis-boot", ...analysisBoot },
    });

  contextInfo.get(id).hostInitialized = true;
}
async function boot() {
  if (bootStarted) return;
  bootStarted = true;
  try {
    stage("contexts");
    if (cfg.loaderAdapter !== "legacy") {
      // WAPCAdapterAppIndex App.preloadContext reserves main/app before
      // AppServiceManager consumes main and WeixinJSContext later consumes app.
      await officialContexts!.manager.init({
        preloadContexts: [
          { name: "main", needBridgeContext: true },
          { name: "app" },
        ],
      });
      await officialContexts!.idle();
      loaderEvent("contexts-preloaded", { names: ["main", "app"] });
      const adapter = new OfficialServiceAdapter(
        cfg.baselibDir,
        wxConfig(cfg),
        {
          initialize: (options) => {
            // Official Context.init copies these frame globals before library evaluation.
            Object.assign(c, options);
            loaderEvent("main-context-initialized", options);
          },
          contextManager: officialContexts!.manager,
          read: (file) =>
            fs.readFileSync(safePath(cfg.baselibDir, file), "utf8"),
          evaluate: (source, file) =>
            vm.runInContext(source, c, {
              filename: file || "wxapp-host-config.js",
            }),
          publish: (name, data) =>
            c.WeixinJSBridge.subscribeHandler(name, data),
          log,
        },
      );
      await adapter.preload();
      stage("configuration", { provenance: adapter.provenance });
      workers!.bind(cfg.appid, wxConfig(cfg));
      await adapter.configure();
      officialContexts!.configurationReady();
      await officialContexts!.idle();
      loaderEvent("official-context-adapter", {
        provenance: officialContexts!.provenance,
      });
    } else {
      workers!.bind(cfg.appid, wxConfig(cfg));
      evalFile(c, cfg.baselibDir, "WAServiceMainContext.js");
    }
    stage("code");
    for (const [id, sub] of [...contexts]) {
      if (
        contextInfo.get(id)?.empty ||
        (officialContexts && contextInfo.get(id)?.name !== "app")
      )
        continue;
      initializeContext(id);
      businessContexts.add(id);
      Object.assign(contextInfo.get(id), { role: "business", state: "ready" });
      loaderEvent("context-role", { contextId: id, role: "business" });
      const entry = cfg.plan.entry;
      const independent = (cfg.app.subPackages || []).find(
        (p: any) =>
          p.independent &&
          entry.startsWith(p.root.replace(/^\//, "").replace(/\/?$/, "/")),
      );
      const initialFiles = independent
        ? localSubpackage(cfg.packageDir, cfg.app, independent.root).files
        : cfg.plan.logicFiles;
      if (independent) {
        contextInfo.get(id).role = "independent-business";
        contextInfo.get(id).packageRoot = independent.root;
      }
      for (const file of initialFiles)
        debugContext.run({ contextId: id }, () => evaluate(id, file));
      log("M1 APP LOADED", JSON.stringify(cfg.app.pages));
      log(
        "WX WRITABLE",
        String(Object.getOwnPropertyDescriptor(sub, "wx")?.writable),
      );
    }
    booted = true;
    stage("logic-ready");
    port.postMessage({ type: "ready" });
    for (const message of routePreparations.splice(0))
      prepareLogicRoute(message);
  } catch (e: any) {
    for (const reservation of analysisReservations.values())
      reservation.finish();
    analysisReservations.clear();
    bootError = e;
    for (const m of routePreparations.splice(0))
      port.postMessage({
        type: "route-prepared",
        id: m.id,
        error: e.message,
        diagnostic: e.diagnostic,
      });
    stage("failed", { error: e.message });
    logger.error("BOOT ERROR", {
      name: e.name,
      code: e.code,
      message: e.message,
      stack: e.stack,
    });
    port.postMessage({
      type: "fatal",
      message: e.message,
      error: { name: e.name, code: e.code, message: e.message, stack: e.stack },
      diagnostic:
        e.diagnostic ||
        diagnostic(
          "LOGIC_BOOT_FAILED",
          "logic",
          e.message,
          "Check the logic bundle and base library compatibility.",
        ),
    });
  }
}
if (!cfg.managedBoot) boot();
port.on("message", (m) => {
  if (m.type === "worker-continue") {
    workers?.continue(m.workerId);
    return;
  }
  if (m.type === "prepare-route") {
    if (bootError)
      port.postMessage({
        type: "route-prepared",
        id: m.id,
        error: bootError.message,
      });
    else if (!booted) routePreparations.push(m);
    else prepareLogicRoute(m);
    return;
  }
  if (m.type === "boot-continue") {
    boot();
    return;
  }
  if (m.type === "debug-replay") {
    void (async () => {
      const a = m.args;
      const context: any = {
        kind: "debug-replay",
        replayOf: a.originalId,
        operationId: randomUUID(),
      };
      context.rootOperationId = context.operationId;
      const body = a.bodyPath
        ? fs.createReadStream(a.bodyPath)
        : a.body === undefined
          ? undefined
          : Buffer.from(
              a.body,
              a.bodyEncoding === "base64" ? "base64" : "utf8",
            );
      const response = debugContext.run(context, () =>
        fetch(a.url, {
          method: a.method,
          headers: a.headers,
          body,
          duplex: "half",
          signal: AbortSignal.timeout(60000),
        } as any),
      );
      if (!context.networkRequestId) await response;
      port.postMessage({
        type: "debug-replay-result",
        id: m.id,
        result: {
          status: "request-sent",
          requestId: context.networkRequestId,
          operationId: context.operationId,
          originalId: a.originalId,
          businessCompleted: false,
        },
      });
      void response
        .then(async (r) => {
          if (r.body)
            for await (const _ of r.body as any) {
            }
        })
        .catch((error) => logger.error("REPLAY ERROR", error));
    })().catch((error) =>
      port.postMessage({
        type: "debug-replay-result",
        id: m.id,
        error: error.message,
      }),
    );
    return;
  }

  try {
    if (m.type === "camera-page-closed") {
      for (const [key, id] of cameraBuffers)
        if (key.startsWith(m.viewId + "_")) {
          nativeBuffers.delete(id);
          cameraBuffers.delete(key);
        }
      return;
    }
    if (m.type === "camera-initialized") {
      c.WeixinJSBridge.subscribeHandler(
        "onCameraInitDone",
        { cameraId: m.cameraId },
        m.viewId,
      );
      return;
    }
    if (m.type === "camera-frame") {
      const id = cameraBuffers.get(`${m.viewId}_${m.cameraId}`),
        buffer = id && nativeBuffers.get(id);
      if (buffer && buffer.byteLength === m.data.byteLength) {
        new Uint8Array(buffer).set(new Uint8Array(m.data));
        c.WeixinJSBridge.subscribeHandler(
          "onCameraFrame",
          { cameraId: m.cameraId },
          m.viewId,
        );
      }
      return;
    }
    if (m.type === "rpc-result") {
      const p = pendingRPC.get(m.id);
      pendingRPC.delete(m.id);
      m.error
        ? p?.reject(
            Object.assign(
              Error(m.error),
              typeof m.runnerCode === "string"
                ? { runnerCode: m.runnerCode }
                : {},
            ),
          )
        : p?.resolve(m.result);
      return;
    }
    if (m.type === "canvas-save") {
      try { serviceCanvases.save(m.pageId, m.canvasNumber, m.width, m.height); }
      catch (error) { logger.error("CANVAS_REGISTER_FAILED", error); }
      return;
    }
    if (m.type === "canvas-close-page") { serviceCanvases.closePage(m.pageId); canvasFrames.closePage(m.pageId); return; }
    if (m.type === "publish" && m.name === "canvasRemoved")
      serviceCanvases.remove((m.data?.data || m.data).canvasNumber, m.viewId);
    if (m.type === "publish" && m.name === "custom_event_cameraRemoved") {
      const a = m.data?.data || m.data,
        key = `${m.viewId}_${a.cameraId}`,
        id = cameraBuffers.get(key);
      if (id) nativeBuffers.delete(id);
      cameraBuffers.delete(key);
    }
    if (m.type === "publish")
      debugContext.run(m.context || {}, () =>
        c.WeixinJSBridge.subscribeHandler(m.name, m.data, m.viewId || 1),
      );
    if (m.type === "native-event") {
      if (m.name === "onViewDidResize") {
        Object.assign(systemInfo, m.data.size);
      }
      debugContext.run(m.context || {}, () => c.WeixinJSBridge.subscribeHandler(m.name, m.data, m.viewId));
    }
    if (m.type === "route-done")
      c.WeixinJSBridge.subscribeHandler("onAppRouteDone", m.data);
    if (m.type === "route") {
      log("ROUTE", JSON.stringify(m.data));
      c.WeixinJSBridge.subscribeHandler("onAppRoute", m.data);
    }
    if (m.type === "inspect") {
      const sub = contexts.get([...businessContexts][0]);
      log(
        "INSPECT",
        JSON.stringify(
          sub?.internals.__appServiceEngine__
            .getCurrentPages()
            .map((p: any) => ({ route: p.route, data: p.data })),
        ),
      );
    }
  } catch (e: any) {
    logger.error("BRIDGE ERROR", e);
  }
});
