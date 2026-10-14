import { NativeLibraries } from "./native-components/libraries";
import { NativeContractObservations, contractContext } from "./contracts/observe";
import { contractId } from "./contracts/model";
import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  clipboard,
  shell,
  systemPreferences,
  Menu,
} from "electron";
import { Worker } from "node:worker_threads";
import { NativeBoundaryDiagnostics, nativeFallback, type BoundaryObservation } from "./native-components/boundary";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { readConfig, wxConfig, systemInfo } from "./config";
import { bindDevToolsShortcut, installDevToolsMenu } from "./devtools";
import { safePath, routeName, pagePlan, inspectPackage } from "./loader";
import { RunnerError, diagnostic, type Diagnostic } from "./diagnostics";
import { LogicDevTools } from "./logic-devtools";
import { DialogController } from "./dialogs";
import { randomUUID } from "node:crypto";
import { LocationService } from "./location/service";
import { MacLocationProvider } from "./location/provider";
import { copyDebug, debugContext } from "./debug/context";
import { RuntimeMcp } from "./mcp/runtime";
import { pageChrome } from "./shell-layout";
import { TabBarState } from "./tab-bar";
import { navigationTarget, serviceRouteQuery, nativeCurrentRoute } from "./loader/navigation";
import { HtmlWebviews } from "./native-components/html-webview";
import { runtimeTitle } from "./runtime-title";
import { OfficialPackageAdapter } from "./loader/official";
import { OfficialPageUi, pageUiApis } from "./loader/page-ui";
import { OfficialTabUi, tabUiApis } from "./loader/tab-ui";
import { OfficialPages } from "./loader/pages";
import { ApplicationVisibility } from "./loader/visibility";
import { managed, emitController, controllerCall } from "./controller/child";
// Preserve native failures even when Electron displays a blocking error dialog.
// Monitoring does not swallow the exception or claim the instance is healthy.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  const record = { type: "host-uncaught-exception", origin,
    name: error.name, message: error.message, stack: error.stack };
  console.error("HOST_UNCAUGHT", JSON.stringify(record));
  emitController(record);
});
let cfg: any;
let startupFailure: string | undefined;
try {
  cfg = managed
    ? JSON.parse(fs.readFileSync(process.env.WXAPP_RUNTIME_CONFIG!, "utf8"))
    : readConfig();
  if (managed) fs.unlinkSync(process.env.WXAPP_RUNTIME_CONFIG!);
  if (cfg.userDataDir) {
    fs.mkdirSync(cfg.userDataDir, { recursive: true });
    app.setPath("userData", cfg.chromiumDataDir || cfg.userDataDir);
  }
  cfg.plan = inspectPackage(cfg);
  console.log(
    "PREFLIGHT",
    JSON.stringify({
      format: cfg.plan.format,
      baselibVersion: cfg.plan.baselibVersion,
      pages: Object.keys(cfg.plan.pages).length,
      blockedPages: Object.values(cfg.plan.pages).filter(
        (p: any) => p.issues.length,
      ).length,
      startupReady: cfg.plan.startupReady,
    }),
  );
  for (const issue of cfg.plan.warnings)
    console.warn("PREFLIGHT WARNING", JSON.stringify(issue));
  if (!cfg.plan.startupReady) throw new RunnerError(cfg.plan.errors[0]);
} catch (e: any) {
  startupFailure = e.message;
}
const root = path.resolve(__dirname);
let win: BrowserWindow;
let logic: Worker;
let logicDevTools: LogicDevTools;
let mcp: RuntimeMcp | undefined;
let dialogs: DialogController;
let locationService: LocationService;
let serviceReady = false;
let logicFailure: any;
let loaderStatus: any = { stage: "preflight", contexts: [] };
const nativeBoundary = new NativeBoundaryDiagnostics();
const nativeContracts = new NativeContractObservations();
let boundaryStatusTimer: NodeJS.Timeout | undefined;
function observeNativeBoundary(observation: BoundaryObservation) {
  if (nativeBoundary.record(observation)) {
    if (observation.disposition === "unsupported")
      console.warn(`UNIMPLEMENTED: native.${observation.api} (${observation.layer})`);
    mcp?.log("loader", [
    { type: "native-capability-gap", api: observation.api, layer: observation.layer,
      disposition: observation.disposition, contractId:contractId(observation.context?.workerId !== undefined ? "worker" : observation.layer,"invoke",observation.api), context:contractContext(observation.context) },
  ], { level: observation.disposition === "unsupported" ? "warn" : "debug" });
  }
  // SDK telemetry can be frequent; keep status fresh without flooding IPC.
  boundaryStatusTimer ||= setTimeout(() => { boundaryStatusTimer = undefined; publishStatus(); }, 50);
}
let prepareSequence = 0;
let officialAdapter: OfficialPackageAdapter | undefined;
let officialPages: OfficialPages | undefined;
let pageUi: OfficialPageUi | undefined;
function ensurePageUi(v: any) {
  pageUi ||= new OfficialPageUi(cfg.baselibDir, {
    alive: p => !!p && views.get(p.id) === p && !p.view.webContents.isDestroyed(),
    changed: p => { if (p === current()) layout(); publishStatus(); },
    log: (...args) => mcp?.log("page-ui", args),
  });
  pageUi.ensure(v, { ...cfg.app.global?.window, ...cfg.app.page?.[v.route + ".html"]?.window });
  return pageUi;
}
let htmlViews: HtmlWebviews | undefined;
const pendingPreparations = new Map<
  number,
  { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();
function prepareRoute(route: string, files: string[], moduleName?: string) {
  if (!files.length) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const id = ++prepareSequence;
    const timer = setTimeout(() => {
      pendingPreparations.delete(id);
      reject(
        new RunnerError(
          diagnostic(
            "ROUTE_PREPARE_TIMEOUT",
            "logic",
            "Logic dependencies did not finish loading",
            "Check the debugger pause state and logic diagnostics; the navigation was not sent.",
            { route },
          ),
        ),
      );
    }, 10000);
    pendingPreparations.set(id, { resolve, reject, timer });
    logic.postMessage({ type: "prepare-route", id, route, moduleName });
  });
}
function rejectPreparations(error: Error) {
  for (const p of pendingPreparations.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pendingPreparations.clear();
}
const visibility = new ApplicationVisibility((background) => {
  const name = background ? "onAppEnterBackground" : "onAppEnterForeground";
  const data = background
    ? {}
    : {
        query: { ...(current()?.query || cfg.launchTarget?.query || {}) },
        path: current()?.route || cfg.launchTarget?.path || "",
        reLaunch: false,
        relaunch: false,
        referrerInfo: {},
      };
  logic?.postMessage({ type: "native-event", name, data });
  mcp?.log("loader", [{ type: name, data }], { type: name });
  htmlViews?.layout();
  publishStatus();
});
let nextId = 0;
let origin = "";
let stack: number[] = [];
const views = new Map<number, any>();
const bySender = new Map<number, any>();
const tabs = new Map<string, number>();
const tabBarState = new TabBarState(cfg.app.tabBar);
let tabUi: OfficialTabUi | undefined;
function ensureTabUi() {
  tabUi ||= new OfficialTabUi(cfg.baselibDir, cfg.app.tabBar, {
    alive: () => !!win && !win.isDestroyed(),
    changed: () => { layout(); publishStatus(); },
  });
  return tabUi;
}
const outbox: any[] = [];
const navNames = [
  "navigateTo",
  "redirectTo",
  "switchTab",
  "reLaunch",
  "navigateBack",
];
function sendToView(v: any, m: any) {
  if (v.failed) return;
  if (v.ready) v.view.webContents.send("message", m);
  else v.queue.push(m);
}
function current() {
  return views.get(stack.at(-1)!);
}
function sizeSurface(v: any) {
  if (!win || win.isDestroyed() || v.view.webContents.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const chrome = pageChrome(cfg.app, v.route, tabUi?.hidden);
  v.view.setBounds({
    x: 0,
    y: chrome.navigationBarHeight,
    width,
    height: Math.max(1, height - chrome.navigationBarHeight - chrome.tabBarHeight),
  });
}
function layout() {
  if (!win || win.isDestroyed()) return;
  // Detached warm/cached pages must also have a real viewport. WAWebview caches
  // its rpx conversion before a surface is attached to the visible window.
  for (const v of views.values()) sizeSurface(v);
  const v = current();
  if (!v) return;
  const chrome = pageChrome(cfg.app, v.route, tabUi?.hidden);
  htmlViews?.layout();
  win.webContents.send("message", {
    type: "shell-state",
    tabBadges: tabBarState.snapshot(),
    tabBar: tabUi?.snapshot() || cfg.app.tabBar,
    route: v.route,
    canBack: stack.length > 1,
    ...chrome,
    pageId: v.id,
    pageUi: ensurePageUi(v).snapshot(v),
    title: v.pageUi.navbar.state.navigationBarTitleText,
  });
}
function publishStatus() {
  if (mcp)
    void mcp
      .dispatch("runner_status", {})
      .then((status) => emitController({ type: "status", status }));
}
function activate(v: any) {
  if (win.isDestroyed()) throw Error("PAGE_CLOSED: host window closed");
  for (const view of views.values())
    if (!view.view.webContents.isDestroyed())
      void view.view.webContents
        .executeJavaScript(
          "delete globalThis.__runnerMcpSnapshot; delete globalThis.__runnerMcpSnapshots",
        )
        .catch(() => {});
  for (const old of views.values())
    if (old !== v && win.contentView.children.includes(old.view))
      win.contentView.removeChildView(old.view);
  if (!win.contentView.children.includes(v.view))
    win.contentView.addChildView(v.view);
  layout();
  publishStatus();
}
function routeDone(v: any) {
  if (v.failed) return;
  logic.postMessage({
    type: "route-done",
    data: {
      path: v.route + ".html",
      webviewId: v.id,
      viewId: v.id,
      openType: v.openType,
    },
  });
}
function routeReady(v: any) {
  if (officialPages) {
    if (serviceReady && v.ready && !v.failed)
      officialPages.acknowledge(v.id, "loaded");
    return;
  }
  if (serviceReady && v.ready && !v.routed && !v.failed) {
    v.routed = true;
    loaderStatus.stage = "page-ready";
    logic.postMessage({
      type: "route",
      data: {
        path: v.route + ".html",
        webviewId: v.id,
        viewId: v.id,
        query: serviceRouteQuery(
          v.query,
          v.launchView ? "appLaunch" : v.openType,
        ),
        openType: v.openType,
        scene: 1001,
        renderer: v.plan.effectiveRenderer,
        componentFramework: v.plan.framework,
        delta: v.delta || 1,
      },
    });
    if (v.initialized) setTimeout(() => routeDone(v), 0);
    clearTimeout(v.bootTimer);
    publishStatus();
    v.resolve?.({});
    v.resolve = undefined;
  }
}
function closeView(id: number) {
  const v = views.get(id);
  if (!v) return;
  if (!win.isDestroyed() && win.contentView.children.includes(v.view))
    win.contentView.removeChildView(v.view);
  clearTimeout(v.bootTimer);
  clearTimeout(v.preloadTimer);
  v.preloadReject?.(Error("PAGE_CLOSED"));
  v.preloadResolve = v.preloadReject = undefined;
  officialPages?.fail(v.id, Error("PAGE_CLOSED"));
  v.reject?.(new Error("Page closed during startup"));
  v.resolve = v.reject = undefined;
  htmlViews?.closePage(v.id);
  dialogs?.closeView(v.id);
  logic?.postMessage({ type: "canvas-close-page", pageId: v.id });
  locationService?.closeView(v.id);
  logic?.postMessage({ type: "camera-page-closed", viewId: v.id });
  emitController({
    type: "target-closed",
    targetId: "page:" + v.id,
    route: v.route,
  });
  bySender.delete(v.view.webContents.id);
  if (!v.view.webContents.isDestroyed()) v.view.webContents.close();
  views.delete(id);
  for (const [r, i] of tabs) if (i === id) tabs.delete(r);
  publishStatus();
}
let navigationTail: Promise<unknown> = Promise.resolve();
function navigate(name: string, args: any = {}, nativeEncoded = false) {
  // Business RPC and MCP must use the same queue. Either can navigate while a
  // preceding view is still attaching to CDP or loading its templates.
  const result = navigationTail.then(() =>
    navigateInternal(name, args, nativeEncoded),
  );
  navigationTail = result.catch(() => {});
  return result;
}
async function navigateInternal(
  name: string,
  args: any = {},
  nativeEncoded = false,
) {
  if (win.isDestroyed()) throw Error("PAGE_CLOSED: host window closed");
  if (cfg.loaderAdapter === "official")
    return navigateOfficial(name, args, nativeEncoded);
  const prev = current();
  if (name === "navigateBack") {
    const remaining =
      htmlViews?.back(prev?.id, Math.max(1, Number(args.delta) || 1)) ??
      Math.max(1, Number(args.delta) || 1);
    if (remaining === 0) return { historyHandled: true };
    const delta = Math.min(remaining, stack.length - 1);
    if (delta < 1) throw Error("no previous page");
    const removed = stack.splice(-delta);
    const v = current();
    v.openType = name;
    v.delta = delta;
    v.routed = false;
    activate(v);
    routeReady(v);
    for (const id of removed) closeView(id);
    return {};
  }
  if (!args.url || typeof args.url !== "string" || !args.url.trim())
    throw Error("Navigation requires url");
  const parsed = navigationTarget(args.url, prev?.route, nativeEncoded);
  const route = routeName(parsed.pathname);
  const plan = pagePlan(cfg, route);
  const isTab = cfg.app.tabBar?.list.some(
    (t: any) => routeName(t.pagePath) === route,
  );
  if (name === "switchTab" && !isTab)
    throw Error("switchTab requires a tabBar page");
  if (name === "navigateTo" && isTab)
    throw Error("Use switchTab for a tabBar page");
  if (name === "navigateTo" && stack.length >= 10)
    throw Error("page stack limit reached");
  // Register a subpackage before the base library receives onAppRoute. Doing
  // this after routing lets the base library construct wx://not-found instead.
  let viewPlan = plan;
  let preparationFailure: Diagnostic | undefined;
  try {
    if (cfg.loaderAdapter === "official") {
      officialAdapter ||= new OfficialPackageAdapter(
        { ...cfg, wxConfig: wxConfig(cfg) },
        {
          preparePackage: (name) =>
            prepareRoute(route, ["official-package"], name),
          publish: (name, data) =>
            logic.postMessage({ type: "native-event", name, data }),
          log: (...args) => console.log("OFFICIAL ADAPTER", ...args),
        },
      );
      // The adapter chooses bootstrap files. Chunk requests remain the base
      // library's job, and are fulfilled through the native script bridge.
      viewPlan = { ...plan, files: await officialAdapter.pageFiles(route) };
    } else await prepareRoute(route, plan.logicFiles);
  } catch (error: any) {
    // Later navigation must keep the existing page/stack intact. Initial boot
    // still needs a visible diagnostic page, even when preparation fails before
    // a renderer exists; do not evaluate its business templates after failure.
    if (prev) throw error;
    preparationFailure =
      error.diagnostic ||
      logicFailure?.diagnostic ||
      diagnostic(
        "PACKAGE_START_FAILED",
        "logic",
        error.message || String(error),
        "Inspect the package preparation error; no business operation was retried.",
        { route },
      );
    viewPlan = { ...plan, files: [] };
  }
  let v = name === "switchTab" ? views.get(tabs.get(route)!) : undefined;
  if (v?.failure) throw new RunnerError(v.failure);
  const removed =
    name === "redirectTo"
      ? stack.splice(-1)
      : ["switchTab", "reLaunch", "appLaunch"].includes(name)
        ? stack.splice(0)
        : [];
  if (!v) {
    v = createSurface(route, viewPlan, parsed, name, isTab);
  } else {
    v.openType = name;
    v.routed = false;
  }
  stack.push(v.id);
  activate(v);
  for (const id of removed)
    if (
      id !== v.id &&
      !(name === "switchTab" && [...tabs.values()].includes(id))
    )
      closeView(id);
  const done = new Promise((resolve, reject) => {
    v.resolve = resolve;
    v.reject = reject;
    v.bootTimer = setTimeout(
      () =>
        failView(
          v,
          diagnostic(
            "PAGE_START_TIMEOUT",
            "bridge",
            "Page startup did not complete within 30 seconds",
            "Check logic/view diagnostics and the required base library files.",
            { route },
          ),
        ),
      30000,
    );
  });
  if (!v.ready) {
    if (managed && !v.observed) {
      await v.view.webContents.loadURL("about:blank");
      v.view.webContents.__runnerDocumentURL = origin + "/page/" + v.id;
      await observeWebContents(v.view.webContents, "page:" + v.id, v);
      v.observed = true;
    }
    v.view.webContents
      .loadURL(origin + "/page/" + v.id)
      .catch((e: Error) =>
        failView(
          v,
          diagnostic(
            "VIEW_DOCUMENT_FAILED",
            "view",
            e.message,
            "Check local page serving and renderer availability.",
            { route },
          ),
        ),
      );
  } else routeReady(v);
  if (preparationFailure) failView(v, preparationFailure);
  return done;
}
async function navigateOfficial(
  name: string,
  args: any,
  nativeEncoded: boolean,
) {
  const previous = current();
  let rawPath: string | undefined;
  if (name !== "navigateBack") {
    if (typeof args.url !== "string" || !args.url.trim())
      throw Error("Navigation requires url");
    const parsed = navigationTarget(args.url, previous?.route, nativeEncoded),
      route = routeName(parsed.pathname);
    pagePlan(cfg, route);
    const isTab = !!cfg.app.tabBar?.list.some(
      (p: any) => routeName(p.pagePath) === route,
    );
    if (name === "switchTab" && !isTab)
      throw Error("switchTab requires a tabBar page");
    if (["navigateTo", "redirectTo"].includes(name) && isTab)
      throw Error("Use switchTab for a tabBar page");
    if (name === "navigateTo" && stack.length >= 10)
      throw Error("page stack limit reached");
    // The supplied Navigator decodes parsePath once then encodes route query.
    // Encode the host transport once so business URL encoding survives it.
    const query = Object.entries(parsed.query)
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
      .join("&");
    rawPath = route + ".html" + (query ? "?" + query : "");
  } else if (!previous) throw Error("no previous page");
  const plans = new Map<string, any>();
  const init = () => {
    const config = wxConfig(cfg);
    const query = rawPath?.split("?")[1];
    // The official abstract navigator constructs the launch path itself.
    if (name === "appLaunch")
      config.appLaunchInfo = {
        ...config.appLaunchInfo,
        path: rawPath!.split("?")[0],
        query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
      };
    return new OfficialPages(cfg.baselibDir, config, {
      create: async () => {
        if (win.isDestroyed()) throw Error("PAGE_CLOSED: host window closed");
        const id = ++nextId;
        const view = new WebContentsView({
          webPreferences: {
            backgroundThrottling: false,
            preload: path.join(root, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        await view.webContents.loadURL("about:blank");
        try {
          (view.webContents as any).__runnerDocumentURL =
            origin + "/page/" + id;
          await observeWebContents(view.webContents, "page:" + id, {});
        } catch (error) {
          view.webContents.close();
          throw error;
        }
        const page: any = { id, view };
        const v = createSurface("", { files: [] }, { query: {} }, "preload", false, page);
        page.surface = v;
        v.preloadOnly = true;
        page.evalPreloadCode = () => {
          if (v.preloadPromise) return v.preloadPromise;
          v.preloadPromise = new Promise<void>((resolve, reject) => {
            v.preloadResolve = resolve;
            v.preloadReject = reject;
            if (view.webContents.isDestroyed()) {
              reject(Error("PAGE_CLOSED"));
              return;
            }
            mcp?.log("loader", [{ type: "page-preload-start", pageId: id }], { type: "page-preload-start" });
            v.preloadTimer = setTimeout(() => failView(v, diagnostic(
              "PAGE_PRELOAD_TIMEOUT", "view", "WAWebview preloading did not acknowledge within 30 seconds",
              "Inspect the original base library startup error; no script was replayed.",
            )), 30000);
            void view.webContents.loadURL(origin + "/page/" + id).catch((error: Error) =>
              failView(v, diagnostic("VIEW_DOCUMENT_FAILED", "view", error.message, "Inspect preloaded renderer loading.")),
            );
          });
          return v.preloadPromise;
        };
        return page;
      },
      prepare: async (pathname) => {
        const route = routeName(pathname.split("?")[0]),
          plan = pagePlan(cfg, route);
        officialAdapter ||= new OfficialPackageAdapter(
          { ...cfg, wxConfig: wxConfig(cfg) },
          {
            preparePackage: (module) =>
              prepareRoute(route, ["official-package"], module),
            publish: (name, data) =>
              logic.postMessage({ type: "native-event", name, data }),
            log: (...args) => console.log("OFFICIAL ADAPTER", ...args),
          },
        );
        officialPagePlans.set(route, {
          ...plan,
          files: await officialAdapter.pageFiles(route),
        });
      },
      load: (page, path) => {
        const route = routeName(path.split("?")[0]);
        const parsed = navigationTarget("/" + path, undefined, true);
        const plan = officialPagePlans.get(route);
        if (!plan) throw Error("PAGE_NOT_PREPARED");
        const v = createSurface(
          route,
          plan,
          parsed,
          officialNavigation.name,
          !!page.isTabBarPage,
          page,
        );
        v.officialPage = page;
        page.surface = v;
        v.bootTimer = setTimeout(
          () =>
            failView(
              v,
              diagnostic(
                "PAGE_START_TIMEOUT",
                "bridge",
                "Page startup did not complete within 30 seconds",
                "Inspect the view and logic acknowledgements; no script was replayed.",
                { route },
              ),
            ),
          30000,
        );
        if (!v.preloaded || v.failed) throw Error("PAGE_PRELOAD_NOT_READY");
        v.preloadOnly = false;
        v.view.webContents.send("message", { type: "bind-page" });
        mcp?.log("loader", [{ type: "page-preload-consumed", pageId: v.id, route }], { type: "page-preload-consumed", route });
      },
      remove: (page) => {
        if (page.surface) closeView(page.id);
        else {
          emitController({
            type: "target-closed",
            targetId: "page:" + page.id,
          });
          if (!page.view.webContents.isDestroyed())
            page.view.webContents.close();
        }
      },
      show: (page, visible) => {
        const v = page.surface;
        if (!v) return;
        if (visible) activate(v);
        else if (win.contentView.children.includes(v.view))
          win.contentView.removeChildView(v.view);
        htmlViews?.layout();
      },
      changed: (pages, tabPages) => {
        stack = pages.map((p) => p.id);
        tabs.clear();
        for (const p of tabPages) tabs.set(routeName(p.path), p.id);
        layout();
        publishStatus();
      },
      event: (event, data) => {
        if (event === "onAppRoute" || event === "onAppRouteDone") {
          const v = views.get(data.webviewId);
          if (!v || v.failed) return;
          v.openType = data.openType;
          const payload = {
            ...data,
            viewId: v.id,
            scene: 1001,
            renderer: v.plan.effectiveRenderer,
            componentFramework: v.plan.framework,
          };
          if (data.openType === "navigateBack")
            payload.delta = Number(officialNavigation.args.delta) || 1;
          if (event === "onAppRoute") {
            v.routed = true;
            loaderStatus.stage = "page-ready";
            clearTimeout(v.bootTimer);
            visibility.start();
            logic.postMessage({ type: "route", data: payload });
          } else logic.postMessage({ type: "route-done", data: payload });
        }
        mcp?.log("loader", [{ type: event, ...data }], {
          type: event,
          context: debugContext.getStore(),
        });
        publishStatus();
      },
      back: (page, delta) => htmlViews?.back(page.id, delta) ?? delta,
      modal: (options) => dialogs.request("showModal", options, current()?.id),
      log: (...args) => console.log("OFFICIAL PAGE", ...args),
    });
  };
  const firstPageManager = !officialPages;
  if (!officialPages) {
    officialPages = init();
    loaderStatus.pageModules = officialPages.provenance;
  }
  // The host ports outlive this invocation; store only the current preflight
  // data in a shared map, never retain a previous route's closure.
  officialPagePlans = plans;
  officialNavigation = { name, args };
  try {
    if (firstPageManager) await officialPages.preload(true);
    const result = await officialPages.navigate(
      name,
      rawPath,
      Math.max(1, Number(args.delta) || 1),
      args.routeId,
    );
    loaderStatus.pageModules = officialPages.provenance;
    return result;
  } catch (error: any) {
    if (!win.isDestroyed() && !previous && !current()) {
      // Diagnostics are host UI; no business fallback or failed-script replay.
      const route = routeName(rawPath!.split("?")[0]);
      const v = createSurface(
        route,
        { ...pagePlan(cfg, route), files: [] },
        { query: {} },
        name,
        false,
      );
      stack = [v.id];
      activate(v);
      loaderStatus.stage = "failed";
      failView(
        v,
        error.diagnostic ||
          logicFailure?.diagnostic ||
          diagnostic(
            "PACKAGE_START_FAILED",
            "logic",
            error.message,
            "Inspect original startup diagnostics; no business script was retried.",
            { route },
          ),
      );
      if (managed) {
        await v.view.webContents.loadURL("about:blank");
        await observeWebContents(v.view.webContents, "page:" + v.id, v);
      }
      await v.view.webContents.loadURL(origin + "/page/" + v.id);
    }
    throw error;
  }
}
let officialPagePlans = new Map<string, any>();
let officialNavigation: any = {};

function createSurface(
  route: string,
  viewPlan: any,
  parsed: any,
  name: string,
  isTab: boolean,
  reserved?: any,
) {
  if (reserved?.surface) {
    const v = reserved.surface;
    if (v.route) throw Error("PAGE_ALREADY_BOUND");
    Object.assign(v, { route, plan: viewPlan, query: parsed.query,
      launchView: ["appLaunch", "autoReLaunch"].includes(name), openType: name });
    if (isTab) tabs.set(route, v.id);
    sizeSurface(v);
    return v;
  }
  const id = reserved?.id ?? ++nextId;
  const view =
    reserved?.view ||
    new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(root, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  const v: any = {
    id,
    view,
    route,
    plan: viewPlan,
    query: parsed.query,
    launchView: ["appLaunch", "autoReLaunch"].includes(name),
    openType: name,
    ready: false,
    routed: false,
    queue: [],
  };
  bindDevToolsShortcut(
    view.webContents,
    () => current()?.view.webContents,
    () => logicDevTools.toggle(),
  );
  views.set(id, v);
  bySender.set(view.webContents.id, v);
  sizeSurface(v);
  view.webContents.on("did-finish-load", () => {
    if (v.failure)
      view.webContents.send("message", {
        type: "fatal",
        diagnostic: v.failure,
      });
  });
  view.webContents.on("render-process-gone", (_e, details) =>
    failView(
      v,
      diagnostic(
        "VIEW_PROCESS_EXITED",
        "view",
        details.reason,
        "Check the renderer error and base library compatibility.",
        { route: v.route },
      ),
    ),
  );
  if (isTab) tabs.set(route, id);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin + "/")) e.preventDefault();
  });
  view.webContents.on(
    "console-message",
    (_e, level, message, line, sourceId) => {
      mcp?.log("view", [message], {
        level: ["debug", "info", "warn", "error"][level] || "info",
        route: v.route,
        sourceId,
        line,
      });
      if (/Error|error|warn|fail/.test(message))
        console.log("VIEW", id, message.slice(0, 1200));
    },
  );
  return v;
}

async function observeWebContents(wc: any, targetId: string, parent: any) {
  if (!managed) return;
  const activePort = path.join(app.getPath("userData"), "DevToolsActivePort");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(activePort) && !process.env.WXAPP_DEBUG_PORT) {
    if (Date.now() > deadline)
      throw Error("Chromium CDP endpoint did not become ready");
    await new Promise((r) => setTimeout(r, 25));
  }
  if (wc.isDestroyed()) throw Error("Target closed before observation");
  const port =
    process.env.WXAPP_DEBUG_PORT ||
    fs.readFileSync(activePort, "utf8").split("\n")[0];
  wc.debugger.attach("1.3");
  let info: any;
  try {
    info = await wc.debugger.sendCommand("Target.getTargetInfo");
  } finally {
    wc.debugger.detach();
  }
  wc.__runnerTargetId = targetId;
  await controllerCall("__debug_view", {
    targetId,
    route: parent?.route,
    documentURL: targetId.startsWith("page:")
      ? wc.__runnerDocumentURL
      : undefined,
    parentTargetId: targetId.startsWith("h5:")
      ? "page:" + parent?.id
      : undefined,
    url:
      "ws://127.0.0.1:" + port + "/devtools/page/" + info.targetInfo.targetId,
  });
}
function failView(v: any, issue: Diagnostic) {
  if (!v || v.failed) return;
  v.failed = true;
  v.failure = issue;
  officialPages?.fail(v.id, new RunnerError(issue));
  clearTimeout(v.bootTimer);
  clearTimeout(v.preloadTimer);
  v.preloadReject?.(new RunnerError(issue));
  v.preloadResolve = v.preloadReject = undefined;
  console.error("DIAGNOSTIC", JSON.stringify(issue));
  mcp?.log("diagnostic", [issue], { level: "error", route: v.route });
  v.reject?.(new RunnerError(issue));
  v.resolve = v.reject = undefined;
  if (!v.view.webContents.isDestroyed())
    v.view.webContents.send("message", { type: "fatal", diagnostic: issue });
}
function currentRouteResult() {
  return nativeCurrentRoute(officialPages ? officialPages.navigator.currentRoute : current() ? current()!.route.replace(/\.html$/, "") + ".html" : "");
}
async function rpc(name: string, a: any) {
  if (name === "getCurrentRoute") return currentRouteResult();
  const contextPageId = debugContext.getStore()?.pageId;
  if (tabUiApis.has(name)) return ensureTabUi().invoke(name, a);
  if (name === "setTabBarBadge") {
    if (!win || win.isDestroyed()) throw Error("Window closed");
    const badges = tabBarState.updateBadge(a);
    await win.webContents.executeJavaScript(
      `__runnerSetTabBarBadges(${JSON.stringify(badges)})`,
    );
    return {};
  }
  if (name === "getRendererUserAgent") {
    const wc = (views.get(Number(contextPageId)) || current())?.view
      .webContents;
    return {
      userAgent:
        wc && !wc.isDestroyed() ? wc.getUserAgent() : app.userAgentFallback,
    };
  }
  if (name === "openLocation" || name === "openMapApp") {
    if (
      ![a.latitude, a.longitude].every(Number.isFinite) ||
      Math.abs(a.latitude) > 90 ||
      Math.abs(a.longitude) > 180
    )
      throw Error("Invalid map coordinates");
    const v = views.get(Number(contextPageId)) || current();
    if (!v) throw Error("Page closed");
    return v.view.webContents.executeJavaScript(
      `__runnerOpenLocation(${JSON.stringify(a)})`,
    );
  }
  if (name === "scanCode") {
    await locationService.authorize({ scope: "scope.camera" }, current()?.id);
    return current().view.webContents.executeJavaScript(
      `__runnerScan(${JSON.stringify(a)})`,
    );
  }
  if (name === "__mapOperate" || name === "__cameraOperate") {
    const kind = name === "__mapOperate" ? "Map" : "Camera",
      id = a.mapId ?? a.cameraId;
    const candidates =
      contextPageId === undefined
        ? [...views.values()]
        : [views.get(Number(contextPageId))].filter(Boolean);
    const matches: any[] = [];
    for (const v of candidates)
      if (
        !v.view.webContents.isDestroyed() &&
        (await v.view.webContents.executeJavaScript(
          `!!window.__runner${kind}?.has(${JSON.stringify(id)})`,
        ))
      )
        matches.push(v);
    if (matches.length !== 1)
      throw Error(kind + " identity unavailable or ambiguous");
    const result = await matches[0].view.webContents.executeJavaScript(
      `window.__runner${kind}.operate(${JSON.stringify(a)})`,
    );
    return kind === "Camera"
      ? { ...result, __runnerPageId: matches[0].id }
      : result;
  }
  if (name === "__videoOperate") {
    if (!Number.isFinite(a.videoPlayerId))
      throw Error("videoPlayerId is required");
    const candidates =
      contextPageId === undefined
        ? [...views.values()]
        : [views.get(Number(contextPageId))].filter(Boolean);
    const matches: any[] = [];
    for (const view of candidates)
      if (
        view &&
        !view.view.webContents.isDestroyed() &&
        (await view.view.webContents.executeJavaScript(
          `!!window.__runnerVideo?.has(${JSON.stringify(a.videoPlayerId)})`,
        ))
      )
        matches.push(view);
    if (matches.length !== 1)
      throw Error(
        matches.length
          ? "Ambiguous video identity"
          : "Video component is stale or unavailable",
      );
    return matches[0].view.webContents.executeJavaScript(
      `window.__runnerVideo.operate(${JSON.stringify(a)})`,
    );
  }
  const locationViewId =
    contextPageId === undefined ? current()?.id : Number(contextPageId);
  if (
    ["getLocation", "authorize", "openSetting"].includes(name) &&
    locationViewId !== undefined &&
    !views.has(locationViewId)
  )
    throw Object.assign(Error("originating page closed"), {
      runnerCode: "PAGE_CLOSED",
    });
  if (name === "getLocation")
    return locationService.getLocation(a, locationViewId);
  if (name === "getSetting") return locationService.getSetting(a);
  if (name === "authorize") return locationService.authorize(a, locationViewId);
  if (name === "openSetting")
    return locationService.openSetting(a, locationViewId);
  if (managed && ["__debug_network", "__debug_view", "__debug_realtime_data"].includes(name))
    return controllerCall(name, a);
  if (name === "__debug_realtime_data") {
    if (!mcp) throw Error("Local realtime log receiver is not ready");
    const record = mcp.log("realtime", [a], { level: "info", context: a.context });
    if (record.truncated) throw Error("Local realtime log was truncated");
    return { eventId: record.id };
  }
  if (pageUiApis.has(name)) {
    const v = contextPageId === undefined ? current() : views.get(Number(contextPageId));
    if (!v) throw Error("PAGE_CLOSED: originating page closed");
    return ensurePageUi(v).invoke(v, name, a);
  }
  if (name === "shareAppMessage" || name === "shareTimeline") {
    const v = contextPageId === undefined ? current() : views.get(Number(contextPageId));
    if (!v) throw Error("PAGE_CLOSED: originating page closed");
    await dialogs.request("showModal", {
      title: "分享内容预览（未发送）",
      content: `${String(a.title || "")}\n${String(a.path || a.link || "")}`,
      showCancel: false, confirmText: "关闭",
    }, v.id);
    throw Error("cancel: local preview closed; external sharing unavailable");
  }
  if (navNames.includes(name)) return navigate(name, a);
  if (name === "__nativeNavigation" && navNames.includes(a.name))
    return navigate(a.name, a.args, true);
  if (["showToast", "showLoading", "hideLoading", "hideToast"].includes(name)) {
    sendToView(current(), { type: "ui", name, args: a });
    return {};
  }
  if (
    [
      "showModal",
      "showActionSheet",
      "chooseImage",
      "chooseMedia",
      "chooseMessageFile",
    ].includes(name)
  )
    return dialogs.request(name, a, current()?.id);
  if (name === "setClipboardData") {
    clipboard.writeText(a.data);
    return {};
  }
  if (name === "getClipboardData") return { data: clipboard.readText() };
  if (name === "makePhoneCall") {
    if (!/^[+\d() -]+$/.test(a.phoneNumber))
      throw Error("invalid phone number");
    await shell.openExternal("tel:" + a.phoneNumber);
    return {};
  }
  if (name === "previewImage") {
    const p = new BrowserWindow({
      width: 800,
      height: 650,
      parent: win,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    await p.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          '<body style="background:#111;display:grid;place-items:center;margin:0"><img style="max-width:100vw;max-height:100vh" src="' +
            String(a.current || a.urls[0])
              .replaceAll("&", "&amp;")
              .replaceAll('"', "&quot;") +
            '"></body>',
        ),
    );
    return {};
  }
  throw Error("UNIMPLEMENTED: wx." + name);
}
if (managed || process.env.WXAPP_DEBUG_PORT)
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.WXAPP_DEBUG_PORT || "0",
  );
if (managed)
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app
  .whenReady()
  .then(async () => {
    if (startupFailure) {
      console.error("STARTUP FAILED", startupFailure);
      dialog.showErrorBox("WxappRunner — 启动检查失败", startupFailure);
      app.exit(1);
      return;
    }
    logicDevTools = managed
      ? ({
          toggle: () => emitController({ type: "open-devtools" }),
          open: () => emitController({ type: "open-devtools" }),
          setEndpoint: () => {},
          close: () => {},
          owns: () => false,
        } as any)
      : new LogicDevTools(cfg.appid);
    cfg.storageFile = path.join(
      cfg.userDataDir || app.getPath("userData"),
      "apps",
      cfg.appid,
      "storage.json",
    );
    cfg.dataDir = path.join(
      cfg.userDataDir || app.getPath("userData"),
      "apps",
      cfg.appid,
      "files",
    );
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const shellHTML =
      '<!DOCTYPE html><html><meta charset="UTF-8"><style>*{box-sizing:border-box}body{margin:0;font:13px -apple-system,sans-serif;background:white}header{height:36px;display:flex;align-items:center;padding:0 10px;gap:12px;border-bottom:1px solid #eee}button{border:0;background:none;font:inherit;color:inherit;cursor:pointer}#share-menu{margin-left:auto}#nav-loading{display:none;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}#title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}nav{position:fixed;bottom:0;height:58px;width:100%;display:flex;border-top:1px solid #eee;background:white}nav button{flex:1;font-size:11px}nav img{display:block;width:24px;height:24px;margin:0 auto 3px}#toast{color:#b22222}</style><header><button id="back">‹</button><span id="title">WxappRunner</span><span id="nav-loading" role="status" aria-label="加载中"></span><span id="toast"></span><button id="share-menu" aria-label="分享菜单">···</button></header><nav></nav><script src="/shell.js"></script></html>';
    const server = http.createServer((req, res) => {
      try {
        if (req.headers.origin === "devtools://devtools")
          res.setHeader("Access-Control-Allow-Origin", "devtools://devtools");
        const u = new URL(req.url!, origin || "http://localhost");
        if (u.pathname === "/") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(shellHTML);
          return;
        }
        if (/^\/page\/\d+$/.test(u.pathname)) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="/"><title>WxappRunner</title></head><body><div></div><script src="/view.js"></script></body></html>',
          );
          return;
        }
        let base = cfg.packageDir,
          rel = decodeURIComponent(u.pathname.slice(1));
        if (u.pathname.startsWith("/package/"))
          rel = decodeURIComponent(u.pathname.slice(9));
        else if (u.pathname.startsWith("/baselib/")) {
          base = cfg.baselibDir;
          rel = u.pathname.slice(9);
        } else if (
          ["/view.js", "/shell.js", "/view.js.map", "/shell.js.map"].includes(
            u.pathname,
          )
        ) {
          base = root;
          rel = u.pathname.slice(1);
        }
        const file = safePath(base, rel);
        serveFile(req, res, file);
      } catch {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = "http://127.0.0.1:" + (server.address() as any).port;
    ipcMain.on("config", (e) => {
      const v = bySender.get(e.sender.id);
      e.returnValue = v
        ? {
            map: cfg.map || {},
            wxConfig: {
              ...wxConfig(cfg),
              windowWidth: win.isDestroyed() ? systemInfo.windowWidth : win.getContentSize()[0],
            },
            route: v.route,
            preloadOnly: !!v.preloadOnly,
            loaderAdapter: cfg.loaderAdapter,
            initialFailure: v.failure || (win.isDestroyed() ? diagnostic(
              "PAGE_CLOSED", "view", "Host window closed before page configuration",
              "The pending page was cancelled; it will not execute business scripts.",
            ) : undefined),
            viewId: v.id,
            viewFiles: v.plan.files,
            scriptAliases: cfg.plan.scriptAliases,
            availableFiles: fs.readdirSync(cfg.packageDir, { recursive: true }),
            nativeContractCalls: !!cfg.debug?.nativeContractCalls,
            availableLibraries: fs.readdirSync(cfg.baselibDir, { recursive: true }),
          }
        : { shell: true, tabBar: cfg.app.tabBar };
    });
    const nativeLibraries = new NativeLibraries(cfg.baselibDir);
    ipcMain.handle("native-request", async (e, name, a) => {
      if (name === "__shareMenu") {
        if (e.sender !== win.webContents) throw Error("Shell required");
        const v = current();
        if (!v || v.id !== a.pageId) throw Error("PAGE_CLOSED: stale menu");
        const share = ensurePageUi(v).snapshot(v)!.share;
        const items = [
          { label: "分享内容预览", enabled: share.showShareMenu, event: "onShareAppMessage" },
          { label: "朋友圈内容预览", enabled: share.showShareTimelineMenu, event: "onShareTimeline" },
        ].filter(item => item.enabled).map(item => ({ label: item.label, click: () => {
          if (current() !== v || !views.has(v.id)) return;
          const latest = ensurePageUi(v).snapshot(v)!.share;
          if (item.event === "onShareAppMessage" ? !latest.showShareMenu : !latest.showShareTimelineMenu) return;
          logic.postMessage({ type: "native-event", name: item.event, viewId: v.id,
            context: { pageId: v.id }, data: {
              title: cfg.app.accountInfo?.nickname || "", desc: "", path: v.route,
              mode: latest.withShareTicket ? "withShareTicket" : "common", dynamic: false, origin: "menu",
            } });
        } }));
        if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
        return {};
      }
      const v = bySender.get(e.sender.id);
      if (!v) throw Error("Page closed");
      if (name === "loadWAFile")
        return new Promise(resolve => { nativeLibraries.invoke(name, a, resolve); });
      if (["authorize", "getLocation"].includes(name))
        return debugContext.run({ pageId: v.id }, () => rpc(name, a));
      if (name === "__cameraAccess") {
        if (locationService.getSetting().authSetting["scope.camera"] !== true)
          throw Error("Camera permission denied");
        if (
          process.platform === "darwin" &&
          !(await systemPreferences.askForMediaAccess("camera"))
        )
          throw Error("macOS camera permission denied");
        return {};
      }
      if (name === "__cameraInitialized") {
        logic.postMessage({
          type: "camera-initialized",
          viewId: v.id,
          cameraId: a.cameraId,
        });
        return {};
      }
      if (name === "__cameraPick") {
        const r: any = await dialogs.request("chooseImage", { count: 1 }, v.id);
        const f = r.tempFilePaths[0];
        if (fs.statSync(f).size > 16 * 1024 * 1024)
          throw Error("Image exceeds 16 MiB");
        const ext = path.extname(f).slice(1).replace("jpg", "jpeg");
        return {
          dataUrl:
            `data:image/${ext};base64,` + fs.readFileSync(f).toString("base64"),
        };
      }
      if (name === "__cameraSave") {
        if (locationService.getSetting().authSetting["scope.camera"] !== true)
          throw Error("Camera permission denied");
        if (
          typeof a.dataUrl !== "string" ||
          a.dataUrl.length > 24 * 1024 * 1024 ||
          !a.dataUrl.startsWith("data:image/jpeg;base64,")
        )
          throw Error("Invalid camera image");
        const id = randomUUID() + ".jpg",
          dir = path.join(cfg.dataDir, "tmp");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, id),
          Buffer.from(a.dataUrl.split(",")[1], "base64"),
          { mode: 0o600 },
        );
        return { tempImagePath: "wxfile://tmp/" + id };
      }
      throw Error("Unsupported native request");
    });
    ipcMain.on("camera-frame", (e, cameraId, data) => {
      const v = bySender.get(e.sender.id);
      if (
        v &&
        Number.isFinite(cameraId) &&
        data instanceof ArrayBuffer &&
        data.byteLength <= 8 * 1024 * 1024 &&
        locationService.getSetting().authSetting["scope.camera"]
      )
        logic.postMessage({
          type: "camera-frame",
          viewId: v.id,
          cameraId,
          data,
        });
    });
    ipcMain.on("invoke", (e, n, a) => {
      let data: any = {};
      if (n === "loadWAFileSync") {
        const parent = bySender.get(e.sender.id);
        e.returnValue = parent ? nativeLibraries.invoke(n, JSON.parse(a || "{}"), () => {}) :
          JSON.stringify({errMsg: n + ":fail page closed"});
        return;
      }
      if (n === "systemLog") {
        try {
          const rows = JSON.parse(a || "{}").dataArray;
          if (!Array.isArray(rows)) throw Error("dataArray must be an array");
          const captured = copyDebug(["[native.systemLog]", rows.map((row: any) => row?.message || "")], 32000);
          mcp?.log("view", captured.value as any[], {
            level: "info", pageId: bySender.get(e.sender.id)?.id, truncated: captured.truncated,
          });
          e.returnValue = JSON.stringify({ errMsg: "systemLog:ok" });
        } catch (error: any) {
          e.returnValue = JSON.stringify({ errMsg: "systemLog:fail " + error.message });
        }
        return;
      }
      if (/^(insert|update|remove|operate)HTMLWebView$/.test(n)) {
        try {
          const parent = bySender.get(e.sender.id);
          if (!parent) throw Error("Unknown parent page");
          data = htmlViews!.invoke(parent.id, n, JSON.parse(a || "{}"));
          e.returnValue = JSON.stringify({ errMsg: n + ":ok", ...data });
        } catch (error: any) {
          e.returnValue = JSON.stringify({
            errMsg: n + ":fail " + error.message,
          });
        }
        return;
      }
      if (
        /^(insert|update|remove|operate)(Map|Camera|LivePlayer|LivePusher|VoIP|HTMLWebView|Ad|NativeAd|Canvas|WebGLCanvas)$/.test(
          n,
        )
      ) {
        console.log("UNIMPLEMENTED: view native." + n);
        observeNativeBoundary({ api: n, layer: "view", disposition: "unsupported",
          context: { pageId: bySender.get(e.sender.id)?.id } });
        e.returnValue = JSON.stringify({
          errMsg: n + ":fail native backend unavailable",
          runnerCode: "NATIVE_BACKEND_UNAVAILABLE",
        });
        return;
      }
      if (n === "getCurrentRoute") data = currentRouteResult();
      else if (n === "getSystemInfo") data = systemInfo;
      else if (n === "getNetworkType") data = { networkType: "wifi" };
      else if (n === "initReady") {
        const v = bySender.get(e.sender.id);
        if (v) {
          v.initialized = true;
          if (officialPages) officialPages.acknowledge(v.id, "readyed");
          else setTimeout(() => routeDone(v), 0);
        }
      } else if (n === "initRenderDone") {
        // Original PC lifecycle.ts InitRenderDoneJsApiImpl only logs and
        // returns {}. It is NOT initReady or a second route acknowledgement.
        mcp?.log("view", [{ type: "initRenderDone", pageId: bySender.get(e.sender.id)?.id }], { level: "debug" });
      } else {
        data = nativeFallback(n);
        observeNativeBoundary({ api: n, layer: "view", disposition: data.runnerDisposition,
          context: { pageId: bySender.get(e.sender.id)?.id } });
      }
      e.returnValue = JSON.stringify({ errMsg: n + ":ok", ...data });
    });
    ipcMain.on("canvas-save", (e, data) => {
      const v = bySender.get(e.sender.id);
      if (!v || !Number.isSafeInteger(data?.canvasNumber) || !Number.isFinite(data.width) || !Number.isFinite(data.height)) return;
      logic.postMessage({ type: "canvas-save", pageId: v.id, canvasNumber: data.canvasNumber, width: data.width, height: data.height });
    });
    ipcMain.on("publish", (e, n, a, _ids, context) => {
      const v = bySender.get(e.sender.id);
      if (v)
        try {
          logic.postMessage({
            type: "publish",
            name: n,
            data: JSON.parse(a || "{}"),
            viewId: v.id,
            context: { ...context, pageId: v.id },
          });
        } catch (error: any) {
          mcp?.log(
            "bridge",
            [
              {
                name: error.name,
                message: error.message,
                stack: error.stack,
                event: n,
              },
            ],
            { level: "error", route: v.route },
          );
        }
    });
    ipcMain.on("debug-observation", (e, observation) => {
      const v = bySender.get(e.sender.id);
      if (!v) return;
      const record = {
        ...observation,
        source: "view",
        pageId: v.id,
        route: v.route,
      };
      if (observation.type === "native-contract-call" && cfg.debug?.nativeContractCalls) {
        nativeContracts.record({...observation,layer:"view",context:{...contractContext(observation.context),pageId:v.id}});
        boundaryStatusTimer ||= setTimeout(()=>{boundaryStatusTimer=undefined;publishStatus();},50);
      }
      if (observation.type === "human-input") emitController(record);
      else
        mcp?.log("view", [record], {
          context: observation.context,
          type: observation.type,
          route: v.route,
        });
    });
    ipcMain.on("log", (e, ...a) => {
      console.log(...a);
      mcp?.log("view", a, {
        route: bySender.get(e.sender.id)?.route,
        level: /ERROR|REJECTION|FAILED/.test(a[0]) ? "error" : "info",
      });
    });
    ipcMain.on("diagnostic", (e, issue: Diagnostic) => {
      const v = bySender.get(e.sender.id);
      if (v) failView(v, { ...issue, route: v.route });
    });
    ipcMain.on("ready", (e) => {
      const v = bySender.get(e.sender.id);
      if (!v || v.failed) return;
      v.ready = true;
      for (const m of v.queue) v.view.webContents.send("message", m);
      v.queue.length = 0;
      routeReady(v);
    });
    ipcMain.on("view-preloaded", (e) => {
      const v = bySender.get(e.sender.id);
      if (!v || v.failed || !v.preloadOnly || v.preloaded) return;
      v.preloaded = true;
      clearTimeout(v.preloadTimer);
      mcp?.log("loader", [{ type: "page-preload-ready", pageId: v.id }], { type: "page-preload-ready" });
      v.preloadResolve?.();
      v.preloadResolve = v.preloadReject = undefined;
      publishStatus();
    });
    ipcMain.on("view-viewport", (event, data) => {
      const v = bySender.get(event.sender.id);
      if (!v || v !== current() || !v.ready || !v.routed || v.failed || win.isDestroyed()) return;
      const { width, height } = v.view.getBounds();
      if (data?.size?.windowWidth !== width || data?.size?.windowHeight !== height) return;
      const signature = `${width}:${height}`;
      if (v.viewportSignature === signature) return;
      v.viewportSignature = signature;
      logic?.postMessage({ type: "native-event", name: "onViewDidResize", data: {
        size: { windowWidth: width, windowHeight: height },
        deviceOrientation: width > height ? "landscape" : "portrait",
        changedWebviewIds: [v.id],
      } });
      mcp?.log("loader", [{ type: "page-viewport-changed", pageId: v.id, width, height }], {type:"page-viewport-changed", route:v.route});
    });
    ipcMain.handle("shell-nav", async (_e, name, a) => {
      try {
        await navigate(name, a);
        return {};
      } catch (e: any) {
        return { error: e.message };
      }
    });
    win = new BrowserWindow({
      width: 406,
      height: 890,
      title: runtimeTitle(cfg),
      webPreferences: {
        backgroundThrottling: false,
        devTools: false,
        preload: path.join(root, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.on("page-title-updated", (event) => event.preventDefault());
    installDevToolsMenu(
      () => current()?.view.webContents,
      () => logicDevTools.toggle(),
    );
    bindDevToolsShortcut(
      win.webContents,
      () => current()?.view.webContents,
      () => logicDevTools.toggle(),
    );
    win.on("resize", layout);
    win.on("hide", () => visibility.update({ hidden: true }));
    win.on("show", () => visibility.update({ hidden: false }));
    win.on("minimize", () => visibility.update({ minimized: true }));
    win.on("restore", () => visibility.update({ minimized: false }));
    win.on("closed", () => {
      logicDevTools.close();
      void officialPages?.close().catch(error => console.error("PAGE CLEANUP", error));
    });
    dialogs = new DialogController(
      () => win,
      (event) => {
        mcp?.log("dialog", [event]);
        publishStatus();
      },
    );
    locationService = new LocationService(
      new MacLocationProvider(
        path.join(
          root,
          "native/WxappRunner Location.app/Contents/MacOS/wxapp-location",
        ),
      ),
      path.join(path.dirname(cfg.storageFile), "permissions.json"),
      (name, args, viewId) => dialogs.request(name, args, viewId),
      cfg.appid,
      cfg.app.permission?.["scope.userLocation"]?.desc || "",
      (event) => {
        if (
          event.type === "permission-change" &&
          event.scope === "scope.camera" &&
          event.value === false
        )
          for (const v of views.values())
            if (!v.view.webContents.isDestroyed())
              void v.view.webContents
                .executeJavaScript("window.__runnerCamera?.revoke()")
                .catch(() => {});
        mcp?.log(
          event.type.startsWith("location-") ? "location" : "permission",
          [event],
          { context: debugContext.getStore() },
        );
      },
      ["scope.camera"],
    );
    win.setTitle(runtimeTitle(cfg, locationService.debugLocation().simulated));
    htmlViews = new HtmlWebviews({
      window: () => win,
      page: (id) => views.get(id),
      active: () => current()?.id,
      preload: path.join(root, "h5-preload.cjs"),
      partition: "persist:h5-" + cfg.appid,
      observe: async (wc, targetId, parent) => {
        await observeWebContents(wc, targetId, parent);
        bindDevToolsShortcut(
          wc,
          () => wc,
          () => emitController({ type: "open-devtools", targetId }),
        );
      },
      event: (pageId, name, data, toLogic) => {
        if (toLogic)
          logic.postMessage({ type: "publish", name, data, viewId: pageId });
        else {
          const page = views.get(pageId);
          if (page) sendToView(page, { type: "publish", name, data });
        }
      },
      closed: (targetId) => emitController({ type: "target-closed", targetId }),
      changed: publishStatus,
    });
    ipcMain.handle("h5-bridge", (event, name, arg) => {
      if (event.senderFrame !== event.sender.mainFrame)
        throw Error("H5 bridge requires main frame");
      return htmlViews!.bridge(event.sender.id, name, arg);
    });
    await win.loadURL(origin + "/");
    {
      mcp = new RuntimeMcp({
        window: () => win,
        target: (target, targetId) => {
          if (targetId?.startsWith("h5:")) {
            const wc = htmlViews?.target(targetId);
            if (!wc || wc.isDestroyed())
              throw Error("H5 target closed or unknown");
            return wc;
          }
          if (targetId) {
            if (target === "shell" || !/^page:\d+$/.test(targetId))
              throw Error("Target is not a page in this runtime");
            const view = views.get(Number(targetId.slice(5)));
            if (!view || view.view.webContents.isDestroyed())
              throw Error("Target page was closed");
            return view.view.webContents;
          }
          return target === "shell"
            ? win.webContents
            : current()?.view.webContents;
        },
        navigate,
        dialogs,
        location: (value, persist) => {
          const state = locationService.debugLocation(value, persist);
          if (value !== undefined)
            win.setTitle(runtimeTitle(cfg, state.simulated));
          return state;
        },
        status: () => ({
          appid: cfg.appid,
          location: locationService.debugLocation(),
          packageDir: cfg.packageDir,
          serviceReady,
          logicFailure,
          pendingDialogs: dialogs.list().map(d => ({
            id: d.id, name: d.name, viewId: d.viewId, createdAt: d.createdAt,
            status: "awaiting-response", responseTool: "runner_dialog",
          })),
          loader: { ...loaderStatus, nativeBoundary: nativeBoundary.snapshot(), nativeContracts: { enabled: !!cfg.debug?.nativeContractCalls, ...nativeContracts.snapshot() }, visibility: visibility.snapshot(), pageFrames: [...views.values()].map(v => ({
            pageId: v.id, role: v.preloadOnly ? "preload" : "page", route: v.route || undefined,
            preloaded: !!v.preloaded, configured: !v.preloadOnly, ready: v.ready, routed: v.routed, failed: !!v.failed,
          })) },
          h5: htmlViews?.list() || [],
          pageUiModules: pageUi?.provenance || [],
          tabUi: { modules: tabUi?.provenance || [], hidden: tabUi?.hidden || false },
          current: current()
            ? {
                id: current().id,
                route: current().route,
                pageUi: ensurePageUi(current()).snapshot(current()),
                ready: current().ready,
                routed: !!current().routed,
                initialized: !!current().initialized,
                failed: !!current().failed,
                declaredRenderer: current().plan.renderer,
                effectiveRenderer: current().plan.effectiveRenderer,
                rendererFallback: current().plan.rendererFallback,
              }
            : null,
          stack: stack.map((id) => ({
            id,
            route: views.get(id)?.route,
            pageUi: pageUi?.snapshot(views.get(id)),
            declaredRenderer: views.get(id)?.plan.renderer,
            effectiveRenderer: views.get(id)?.plan.effectiveRenderer,
            rendererFallback: views.get(id)?.plan.rendererFallback,
          })),
          routes: Object.keys(cfg.plan.pages),
        }),
      });
      if (cfg.mcp)
        await mcp.start(
          cfg.mcpFile ||
            path.join(app.getPath("userData"), `mcp-${cfg.appid}.json`),
        );
    }
    ipcMain.handle("wxapp-debug-call", (e, name, args) => {
      if (!logicDevTools.owns(e.sender))
        throw Error("Debugger window required");
      return mcp!.dispatch(name, args);
    });
    const cancellations = new Map<string, AbortController>();
    process.on("message", async (message: any) => {
      if (message.type === "runtime-stop") {
        app.quit();
        return;
      }
      if (message.type === "worker-continue") {
        logic.postMessage(message);
        return;
      }
      if (message.type === "boot-continue") {
        logic.postMessage({ type: "boot-continue" });
        return;
      }
      if (message.type === "runtime-cancel") {
        cancellations.get(message.id)?.abort();
        return;
      }
      if (message.type !== "runtime-call") return;
      if (message.name === "__replay") {
        logic.postMessage({
          type: "debug-replay",
          id: message.id,
          args: message.args,
        });
        return;
      }
      const cancel = new AbortController();
      cancellations.set(message.id, cancel);
      try {
        const result = await mcp!.dispatch(
          message.name,
          message.args,
          cancel.signal,
        );
        process.connected &&
          process.send?.({ type: "runtime-result", id: message.id, result });
      } catch (e: any) {
        process.connected &&
          process.send?.({
            type: "runtime-result",
            id: message.id,
            error: e.message,
            code: e.code,
          });
      } finally {
        cancellations.delete(message.id);
      }
    });
    cfg.managedBoot = managed;
    emitController({ type: "status", status: { commandReady: true } });
    const statusTimer = setInterval(() => {
      void mcp!
        .dispatch("runner_status", {})
        .then((status) => emitController({ type: "status", status }));
    }, 250);
    statusTimer.unref();
    logic = new Worker(path.join(root, "logic.cjs"), {
      workerData: cfg,
      execArgv: ["--experimental-network-inspection"],
    });
    logic.on("message", (m) => {
      if (m.type === "canvas-frame") {
        const v = views.get(m.pageId);
        if (v) sendToView(v, { ...m, png: Buffer.from(m.png).toString("base64") });
        return;
      }

      if (m.type === "debug-replay-result") {
        process.connected &&
          process.send?.({
            type: "runtime-result",
            id: m.id,
            result: m.result,
            error: m.error,
          });
      } else if (m.type === "worker-inspector") {
        if (managed) emitController(m);
      } else if (m.type === "inspector-ready") {
        logicDevTools.setEndpoint(m.url);
        mcp?.inspector.connect(m.url);
        if (managed) emitController({ type: "inspector", url: m.url });
        if (cfg.devtools) logicDevTools.open();
      } else if (m.type === "mcp-network") mcp?.network(m.record);
      else if (m.type === "structured-log") {
        console.log(
          ...m.args.map((a: any) =>
            typeof a === "string" ? a : JSON.stringify(a),
          ),
        );
        mcp?.log("logic", m.args, {
          level: m.level,
          context: m.context,
          truncated: m.truncated,
        });
      } else if (m.type === "debug-event") {
        mcp?.log("state", [m.event], {
          level: m.event.type === "exception" ? "error" : "debug",
          context: m.event.context,
        });
      } else if (m.type === "log") {
        console.log(...m.args);
        mcp?.log("logic", m.args);
      } else if (m.type === "route-prepared") {
        const p = pendingPreparations.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          pendingPreparations.delete(m.id);
          m.error
            ? p.reject(
                m.diagnostic ? new RunnerError(m.diagnostic) : Error(m.error),
              )
            : p.resolve();
        }
      } else if (m.type === "native-contract") {
        nativeContracts.record(m.event);
        mcp?.log("loader",[m.event],{...m.event,level:"debug",context:m.event.context});
        boundaryStatusTimer ||= setTimeout(() => {boundaryStatusTimer=undefined;publishStatus();},50);
      } else if (m.type === "native-boundary") {
        observeNativeBoundary(m);
      } else if (m.type === "loader-event") {
        if (m.event.type === "worker-destroyed") emitController(m.event);
        loaderStatus = { ...loaderStatus, ...m.status };
        loaderStatus.logicStage = m.status.stage;
        if (
          serviceReady &&
          current()?.routed &&
          !current()?.failed &&
          m.status.stage !== "failed"
        )
          loaderStatus.stage = "page-ready";
        mcp?.log("loader", [m.event], {
          level:
            m.event.stage === "failed" || /(?:failed|error)$/.test(m.event.type)
              ? "error"
              : "debug",
        });
        publishStatus();
      } else if (m.type === "ready") {
        serviceReady = true;
        for (const v of views.values()) routeReady(v);
      } else if (m.type === "publish") {
        const callback = m.data?.data || m.data;
        if (m.name === "custom_event_callbackAppServiceMethod")
          mcp?.log(
            "bridge",
            [
              {
                type: "app-service-method-result",
                data: m.data,
                viewIds: m.ids,
              },
            ],
            { level: "debug", context: m.context },
          );
        if (
          m.name === "custom_event_callbackAppServiceMethod" &&
          (callback?.isSuccess === false ||
            /:fail/.test(callback?.res?.errMsg || ""))
        )
          mcp?.log(
            "bridge",
            [
              {
                type: "app-service-method-failed",
                callbackId: callback.callbackId,
                errMsg:
                  callback.res?.errMsg || "Base library rejected the method",
                viewIds: m.ids,
              },
            ],
            { level: "error", context: m.context },
          );
        for (const v of views.values())
          if (!m.ids?.length || m.ids.includes(v.id)) sendToView(v, m);
      } else if (m.type === "rpc") {
        debugContext
          .run(m.context || {}, () => rpc(m.name, m.args))
          .then(
            (result) =>
              logic.postMessage({ type: "rpc-result", id: m.id, result }),
            (error) =>
              logic.postMessage({
                type: "rpc-result",
                id: m.id,
                error: error.message,
                runnerCode: error.runnerCode,
              }),
          );
      } else if (m.type === "fatal") {
        serviceReady = false;
        logicFailure = {
          diagnostic:
            m.diagnostic ||
            diagnostic(
              "LOGIC_BOOT_FAILED",
              "logic",
              m.message,
              "Inspect the boot error and restart the analysis instance.",
            ),
          error: m.error || { message: m.message },
          time: new Date().toISOString(),
        };
        mcp?.log("logic", [logicFailure], { level: "error" });
        publishStatus();
        rejectPreparations(Error(m.message));
        for (const v of views.values())
          failView(
            v,
            m.diagnostic ||
              diagnostic(
                "LOGIC_BOOT_FAILED",
                "logic",
                m.message,
                "Check the original logic bundle and native bridge.",
              ),
          );
      } else console.log("LOGIC", m);
    });
    logic.on("error", (e) => {
      serviceReady = false;
      logicFailure = {
        diagnostic: diagnostic(
          "LOGIC_WORKER_FAILED",
          "logic",
          e.message,
          "Inspect the worker error and restart the instance.",
        ),
        error: { name: e.name, message: e.message, stack: e.stack },
        time: new Date().toISOString(),
      };
      publishStatus();
      rejectPreparations(e);
      console.error("WORKER", e);
      mcp?.log(
        "logic",
        [{ name: e.name, message: e.message, stack: e.stack }],
        { level: "error" },
      );
      for (const v of views.values())
        failView(
          v,
          diagnostic(
            "LOGIC_WORKER_FAILED",
            "logic",
            e.message,
            "Check worker and base library compatibility.",
          ),
        );
    });
    logic.on("exit", (code) => {
      serviceReady = false;
      logicFailure ||= {
        diagnostic: diagnostic(
          "LOGIC_WORKER_EXITED",
          "logic",
          `Logic worker exited (${code})`,
          "Restart the instance explicitly.",
        ),
        code,
        time: new Date().toISOString(),
      };
      publishStatus();
      rejectPreparations(
        Error("Logic worker exited before loading dependencies"),
      );
      emitController({ source: "logic", type: "worker-exit", code });
    });
    app.on("before-quit", () => {
      clearInterval(statusTimer);
      dialogs.close();
      locationService.close();
      mcp?.close();
      logic.terminate();
      server.close();
    });
    await navigate("appLaunch", { url: cfg.launchTarget?.url || cfg.app.entryPagePath });
  })
  .catch((e: any) => {
    console.error("STARTUP FAILED", e.message);
  });
app.on("window-all-closed", () => app.quit());
if (managed) process.once("disconnect", () => app.quit());
import { serveFile } from "./http-file";
