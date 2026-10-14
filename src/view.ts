import { installComponentInspection } from "./debug/component-dom";
import { installViewContext } from "./debug/view-context";
import { createViewNative } from "./view-native";
import { installNativeInspection } from "./native-components/inspection";
import { diagnostic, type Diagnostic } from "./diagnostics";
import { ScriptBatch } from "./loader/script-batch";
import { viewLibraryURL } from "./loader/view-library";
const w = window as any;
const native = w.runner;
const config = native.config();
const boundCanvases = new Map<number, { canvas: HTMLCanvasElement; sequence: number }>();
// Original WAWebview calls this PC port before publishing canvasInserted.
// IPC preserves that ordering; business JS remains in the service worker.
w.transferControlToOffscreen = (canvas: HTMLCanvasElement, id: number) => {
  if (!(canvas instanceof HTMLCanvasElement)) throw Error("Invalid canvas surface");
  boundCanvases.set(id, { canvas, sequence: 0 });
  native.saveCanvas(id, canvas.width, canvas.height);
};
const debugScope = installViewContext(native, config.viewId);
if (!config.preloadOnly)
  installComponentInspection(config.viewId, config.route);
installNativeInspection(w, native);
let booting = true;
let bootFailure: Diagnostic | undefined;
let activeFile = "WAWebview.js";
const loaded = new Map<string, Promise<void>>();
const globalEval = w.eval;
const batches = new ScriptBatch(
  loaded,
  async (src) => {
    const response = await fetch(src);
    if (!response.ok)
      throw Error(`Failed to load ${src}: HTTP ${response.status}`);
    return response.text();
  },
  (src, source) => {
    activeFile = src;
    // Capture eval before base-library protection; the source stays unchanged
    // and retains its real package URL in native Sources and exception stacks.
    globalEval(source + "\n//# sourceURL=" + new URL(src, location.href).href);
  },
);
let bindPage: (() => void) | undefined;
const binding = config.preloadOnly
  ? new Promise<void>((resolve) => {
      bindPage = resolve;
    })
  : Promise.resolve();
function displayFailure(issue: Diagnostic) {
  bootFailure = issue;
  const box = document.createElement("pre");
  box.style.cssText =
    "white-space:pre-wrap;padding:20px;font:14px/1.6 sans-serif;color:#9b1c1c";
  box.textContent = `页面加载失败 [${issue.code}]\n${issue.message}\n页面：${config.route}\n文件：${issue.file || activeFile}\n${issue.hint}`;
  document.body.replaceChildren(box);
}
function reportFailure(issue: Diagnostic) {
  if (bootFailure) return;
  displayFailure(issue);
  native.diagnostic(issue);
}
function script(src: string) {
  src = new URL(src, location.href).href;
  if (loaded.has(src)) return loaded.get(src)!;
  const promise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    let executionError: Error | undefined;
    const onError = (event: ErrorEvent) => {
      if (event.filename === s.src)
        executionError = event.error || Error(event.message);
    };
    window.addEventListener("error", onError);
    s.onload = () => {
      window.removeEventListener("error", onError);
      executionError ? reject(executionError) : resolve();
    };
    s.onerror = () => {
      window.removeEventListener("error", onError);
      reject(Error("Failed to load " + src));
    };
    document.head.appendChild(s);
  });
  loaded.set(src, promise);
  return promise;
}
function resolveViewScript(f: string) {
  f = f.replace(/^\//, "");
  const requested = f;
  f = config.scriptAliases?.[f] || f;
  if (f !== requested) native.log("VIEW LOAD ALIAS", requested, f);
  if (!config.availableFiles.includes(f)) {
    const error = Error("Requested script is absent: " + f);
    native.log(
      "DIAGNOSTIC",
      JSON.stringify(
        diagnostic(
          "DYNAMIC_SCRIPT_MISSING",
          "view",
          "Requested script is absent",
          "Check the package/subpackage files.",
          { file: f, route: config.route },
        ),
      ),
    );
    throw error;
  }
  // HTML script tags resolve to absolute URLs. Native package paths must
  // share that cache identity or an embedded plugin executes twice.
  return new URL("/package/" + f, location.href).href;
}
const host = {
  ...native,
  contractObservation: config.nativeContractCalls ? (event:any)=>native.debug(event) : undefined,
  loadScript: (f: string) => batches.load([resolveViewScript(f)]),
  loadScripts: (files: string[]) => batches.load(files.map(resolveViewScript)),
  loadLibraries: (files: string[]) => batches.load(files.map(file =>
    viewLibraryURL(file, config.availableLibraries || [], location.href))),
};
w.__wxConfig =
  config.loaderAdapter === "official"
    ? { ...config.wxConfig, path: config.route, preload: true, isReady: false }
    : config.wxConfig;
w.__webviewId__ = config.viewId;
w.__wxWebviewId__ = config.viewId;
w.__wxAppData = {};
w.__wxAppCode__ = {};
w.__wxRoute = config.route;
w.__vd_version_info__ = {};
w.WeixinJSCore = {
  invokeHandler: createViewNative(w, host),
  publishHandler: (n: string, a: string, ids: string) => {
    if (n === "canvasRemoved") { const data = JSON.parse(a || "{}"); boundCanvases.delete((data.data || data).canvasNumber); }
    native.publish(n, a, ids, debugScope.current());
  },
};
w.__transformRpx__ = (n: number) => (n * innerWidth) / 750;
// Report the embedded page viewport, not the host monitor's landscape dimensions.
Object.defineProperty(screen, "width", { get: () => innerWidth });
Object.defineProperty(screen, "height", { get: () => innerHeight });
Object.defineProperty(screen.orientation, "type", {
  get: () =>
    innerWidth > innerHeight ? "landscape-primary" : "portrait-primary",
});
// Use the supplied library's own stylesheet recalculation, including detached
// tab pages. Do not cache the zero-sized viewport of a newly allocated surface.
window.addEventListener("resize", () => {
  w.__checkDeviceWidth__?.(true);
  if (!ready || bootFailure) return;
  const data = {
    size: { windowWidth: innerWidth, windowHeight: innerHeight },
    deviceOrientation: innerWidth > innerHeight ? "landscape" : "portrait",
  };
  // The original resize event also updates inline rpx and component resizers;
  // checking device width alone only refreshes compiled stylesheet callbacks.
  w.WeixinJSBridge.subscribeHandler("onViewDidResize", data, 0);
  native.viewport(data);
});
const style = document.createElement("style");
style.textContent =
  'html,body{font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;margin:0}';
document.head.appendChild(style);
window.addEventListener("error", (e) => {
  native.log("VIEW ERROR", {
    name: e.error?.name || "Error",
    message: e.message,
    stack: e.error?.stack,
    url: e.filename,
    line: e.lineno,
    column: e.colno,
  });
  if (booting && e.message)
    reportFailure(
      diagnostic(
        "VIEW_SCRIPT_EXECUTION_FAILED",
        "view",
        e.message,
        "Check the compiled script and required native globals.",
        { file: activeFile, route: config.route },
      ),
    );
});
window.addEventListener("unhandledrejection", (e) => {
  native.log("VIEW REJECTION", {
    name: e.reason?.name,
    message: e.reason?.message || String(e.reason),
    stack: e.reason?.stack,
  });
  if (booting)
    reportFailure(
      diagnostic(
        "VIEW_BOOT_REJECTION",
        "view",
        String(e.reason),
        "Check view startup dependencies.",
        { file: activeFile, route: config.route },
      ),
    );
});
let ready = false;
const pending: any[] = [];
native.onMessage((m: any) => {
  if (m.type === "fatal") {
    displayFailure(m.diagnostic);
    pending.length = 0;
    return;
  }
  if (bootFailure) return;
  if (m.type === "bind-page") {
    if (!bindPage) return; // A page frame is bound once; never replay scripts.
    Object.assign(config, native.config());
    w.__wxRoute = config.route;
    installComponentInspection(config.viewId, config.route);
    const resolve = bindPage;
    bindPage = undefined;
    resolve();
    return;
  }
  if (!ready) {
    pending.push(m);
    return;
  }
  dispatch(m);
});
function dispatch(m: any) {
  if (m.type === "canvas-frame") {
    const entry = boundCanvases.get(m.canvasNumber);
    if (!entry || m.sequence <= entry.sequence) return;
    entry.sequence = m.sequence;
    const img = new Image();
    img.onload = () => {
      if (boundCanvases.get(m.canvasNumber) !== entry || entry.sequence !== m.sequence || !entry.canvas.isConnected) return;
      const canvas = entry.canvas;
      canvas.width = m.width; canvas.height = m.height;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      native.debug({ type: "canvas-frame-presented", canvasNumber: m.canvasNumber, sequence: m.sequence });
    };
    img.onerror = () => native.log("CANVAS_FRAME_DECODE_FAILED", m.canvasNumber);
    img.src = "data:image/png;base64," + m.png;
    return;
  }
  if (m.type === "publish") {
    debugScope.run(m.context || null, () => {
      w.__runnerVideo?.published(m.name, m.data);
      w.WeixinJSBridge.subscribeHandler(m.name, m.data, 0);
    });
    native.debug({
      type: "view-message-applied",
      name: m.name,
      context: m.context || null,
    });
  }
  if (m.type === "ui") showUI(m);
}
let overlay: HTMLElement | undefined;
let overlayMask: HTMLElement | undefined;
let toastTimer: any;
function showUI(m: any) {
  const a = m.args || {};
  if (["showToast", "showLoading"].includes(m.name)) {
    overlay?.remove();
    overlayMask?.remove();
    clearTimeout(toastTimer);
    overlay = document.createElement("div");
    overlay.setAttribute("role", "status");
    overlay.textContent = a.title || "加载中";
    Object.assign(overlay.style, {
      position: "fixed",
      left: "50%",
      top: "45%",
      transform: "translate(-50%,-50%)",
      padding: "16px 22px",
      borderRadius: "10px",
      background: "#000c",
      color: "white",
      zIndex: "2147483647",
      fontSize: "15px",
      textAlign: "center",
      maxWidth: "80%",
      // Only the explicitly requested mask owns input. The visual toast or
      // loading indicator must not intercept taps when mask is false.
      pointerEvents: "none",
    });
    if (a.mask) {
      overlayMask = document.createElement("div");
      overlayMask.setAttribute("data-runner-mask", "");
      Object.assign(overlayMask.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
      });
      document.body.append(overlayMask);
    }
    document.body.appendChild(overlay);
    if (m.name === "showToast")
      toastTimer = setTimeout(() => {
        overlay?.remove();
        overlayMask?.remove();
      }, a.duration || 1500);
  }
  if (m.name === "hideLoading" || m.name === "hideToast") {
    overlay?.remove();
    overlayMask?.remove();
  }
}
async function executeHTML(file: string) {
  activeFile = file;
  const response = await fetch("/package/" + file);
  if (!response.ok)
    throw Error("Failed to load " + file + ": " + response.status);
  const html = await response.text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const original of parsed.querySelectorAll("script")) {
    if (original.src) {
      const url = new URL(
        original.getAttribute("src")!,
        new URL("/package/" + file, location.href),
      );
      activeFile = url.pathname;
      await script(url.href);
      activeFile = file;
    } else {
      const s = document.createElement("script");
      s.textContent = original.textContent;
      document.head.appendChild(s);
    }
    if (bootFailure) throw Error(bootFailure.message);
  }
}
async function executeViewProgram(files: string[]) {
  // Official Page.load resolves the package's complete code list before a
  // single PageFrame eval(codes) call. Fetching between evaluations would let
  // initialization microtasks run against a partially registered program.
  const sources = new Map<string, string>();
  const checkFailure = () => {
    if (bootFailure) throw Error(bootFailure.message);
  };
  native.debug({ type: "view-program-stage", stage: "reading", files });
  const read = async (src: string) => {
    if (sources.has(src)) return sources.get(src)!;
    try {
      const response = await fetch(src);
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error: any) {
      throw Object.assign(Error(`Failed to load ${src}: ${error.message}`), { file: src });
    }
  };
  const inputs = await Promise.all(files.map(async (file) => {
    const src = new URL("/package/" + file, location.href).href;
    return { file, src, code: await read(src) };
  }));
  const order: string[] = [];
  for (const { file, src, code } of inputs) {
    if (!file.endsWith(".html")) {
      sources.set(src, code);
      order.push(src);
      continue;
    }
    const parsed = new DOMParser().parseFromString(code, "text/html");
    for (const [index, original] of [...parsed.querySelectorAll("script")].entries()) {
      const external = original.getAttribute("src");
      const id = external ? new URL(external, src).href : `${src}#inline-${index}`;
      if (!external) sources.set(id, original.textContent || "");
      order.push(id);
    }
  }
  const program = new ScriptBatch(loaded, read, (src, code) => {
    checkFailure();
    activeFile = src;
    // Inline classic scripts execute synchronously here, with the same global
    // lexical environment as file scripts (indirect eval would lose let/const
    // bindings between files). Keep real source URLs for Sources and errors.
    const s = document.createElement("script");
    s.textContent = code + "\n//# sourceURL=" + src;
    let executionError: Error | undefined;
    const onError = (event: ErrorEvent) => {
      executionError = event.error || Error(event.message);
    };
    window.addEventListener("error", onError);
    try {
      document.head.appendChild(s);
    } finally {
      window.removeEventListener("error", onError);
    }
    if (executionError) throw executionError;
    checkFailure();
  });
  await program.load(order);
  native.debug({ type: "view-program-stage", stage: "executed", files, scriptCount: order.length });
}
(async () => {
  if (config.initialFailure) {
    displayFailure(config.initialFailure);
    return;
  }
  try {
    await script("/baselib/WAWebview.js");
    if (config.preloadOnly) {
      // The SDK's page preloaded acknowledgement precedes route configuration
      // and user code. Keep this document/realm when the manager consumes it.
      native.preloaded();
      await binding;
      if (bootFailure) return;
    }
    if (config.loaderAdapter === "official") {
      Object.assign(w.__wxConfig, config.wxConfig, {
        path: config.route,
        preload: false,
      });
      w.__checkDeviceWidth__?.(true);
      w.WeixinJSBridge.subscribeHandler("onWxConfigReady", {}, 0);
      w.WeixinJSBridge.subscribeHandler(
        "onInitialRenderingCacheReady",
        { content: "", path: config.route },
        0,
      );
    }
    // Desktop host policy: no WeChat-owned-domain gate. Browser origin isolation remains enabled.
    w.WeixinJSBridge.subscribeHandler(
      "custom_event_returnWebviewBizDomainList",
      {
        data: {
          bizDomainList: [],
          needCheckBizDomain: false,
          isFetchBizDomainListError: false,
        },
      },
      0,
    );
    if (config.loaderAdapter === "official") {
      await executeViewProgram(config.viewFiles);
    } else {
      for (const f of config.viewFiles) {
        if (bootFailure) throw Error(bootFailure.message);
        activeFile = f;
        if (f.endsWith(".html")) await executeHTML(f);
        else await script("/package/" + f);
      }
      await executeHTML(config.route + ".html");
    }
    if (bootFailure) return;
    booting = false;
    ready = true;
    for (const m of pending) dispatch(m);
    pending.length = 0;
    native.ready();
  } catch (e: any) {
    native.log("VIEW BOOT FAILED", e.message);
    reportFailure(
      diagnostic(
        "VIEW_BOOT_FAILED",
        "view",
        e.message,
        "Check the compiled view dependencies and base library version.",
        { file: e.file || activeFile, route: config.route },
      ),
    );
  } finally {
    booting = false;
  }
})();
