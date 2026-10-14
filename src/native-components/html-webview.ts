import { BrowserWindow, WebContentsView, type WebContents } from "electron";
import { H5History } from "./h5-history";

export function htmlURL(value: unknown) {
  if (typeof value !== "string")
    throw Error("HTMLWebView src must be a string");
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("HTMLWebView requires HTTP(S)");
  return u.href;
}
export class HtmlWebviews {
  private items = new Map<string, any>();
  constructor(
    private host: {
      window(): BrowserWindow;
      page(id: number): any;
      active(): number | undefined;
      preload: string;
      partition: string;
      observe(wc: WebContents, targetId: string, page: any): Promise<void>;
      event(pageId: number, name: string, data: any, logic?: boolean): void;
      closed(targetId: string): void;
      changed(): void;
    },
  ) {}
  private key(pageId: number, htmlId: unknown) {
    if (!(
      (typeof htmlId === "string" &&
        htmlId.length > 0 &&
        htmlId.length <= 200) ||
      (typeof htmlId === "number" && Number.isFinite(htmlId))
    ))
      throw Error("Invalid htmlId");
    return pageId + ":" + htmlId;
  }
  invoke(pageId: number, method: string, a: any) {
    const key = this.key(pageId, a.htmlId),
      targetId = "h5:" + key;
    let item = this.items.get(key);
    if (method === "insertHTMLWebView") {
      if (item) throw Error("HTMLWebView already exists");
      if (!this.host.page(pageId))
        throw Error("HTMLWebView parent page closed");
      if (a.src) htmlURL(a.src);
      const view = new WebContentsView({
        webPreferences: {
          preload: this.host.preload,
          partition: this.host.partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      item = {
        key,
        targetId,
        pageId,
        htmlId: a.htmlId,
        view,
        position: a.position,
        src: "",
        state: "initializing",
        visible: false,
        history: new H5History(),
      };
      this.items.set(key, item);
      const wc = view.webContents;
      const live = () => this.items.get(key) === item && !wc.isDestroyed();
      const send = (name: string, data: any, logic = false) => {
        if (live())
          this.host.event(
            pageId,
            name,
            { htmlId: item.htmlId, ...data },
            logic,
          );
      };
      wc.setWindowOpenHandler(({ url }) => {
        try {
          this.load(item, htmlURL(url));
        } catch {}
        return { action: "deny" };
      });
      wc.on("will-navigate", (event, url) => {
        try {
          htmlURL(url);
        } catch {
          event.preventDefault();
        }
      });
      wc.on("will-redirect", (event, url) => {
        try {
          htmlURL(url);
        } catch {
          event.preventDefault();
        }
      });
      wc.on("did-start-navigation", (_e, url, inPlace, isMainFrame) => {
        if (!live() || !isMainFrame) return;
        item.src = url;
        if (inPlace) {
          this.host.changed();
          return;
        }
        item.state = "loading";
        item.error = undefined;
        item.httpCode = null;
        if (url !== "about:blank")
          send("onWebviewStartLoad", { src: url, isMainFrame: true });
        this.host.changed();
      });
      wc.on("did-navigate", (_e, url, httpResponseCode) => {
        if (live()) {
          item.src = url;
          if (url !== "about:blank")
            item.history.discardBootstrap(wc.navigationHistory);
          item.httpCode = httpResponseCode >= 100 ? httpResponseCode : null;
          this.host.changed();
        }
      });
      wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
        if (!live() || !isMainFrame) return;
        item.src = url;
        item.history.discardBootstrap(wc.navigationHistory);
        this.host.changed();
      });
      wc.on("render-process-gone", (_e, details) => {
        if (live()) {
          item.state = "failed";
          item.error = { code: "H5_PROCESS_EXITED", ...details };
          this.host.closed(targetId);
          this.host.changed();
        }
      });
      wc.on("did-finish-load", () => {
        if (!live()) return;
        item.src = wc.getURL();
        if (item.src === "about:blank") {
          item.state = "blank";
          this.host.changed();
          return;
        }
        item.history.discardBootstrap(wc.navigationHistory);
        item.state = item.error ? "failed" : "loaded";
        send("onWebviewFinishLoad", { src: item.src });
        this.host.changed();
      });
      wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
        if (!live() || !isMainFrame || code === -3) return;
        item.state = "failed";
        item.error = { code, description };
        send("onWebviewError", {
          src: url,
          errorCode: code,
          description,
          httpCode: 0,
        });
        send(
          "onWebViewError",
          { src: url, errorCode: code, description, httpCode: 0 },
          true,
        );
        send("onWebviewFinishLoad", { src: url });
        this.host.changed();
      });
      item.ready = wc.loadURL("about:blank").then(async () => {
        if (!live()) return;
        await this.host.observe(wc, targetId, this.host.page(pageId));
        if (live()) {
          item.state = "ready";
          this.host.changed();
        } else this.host.closed(targetId);
      });
      item.ready.catch((error: Error) => {
        if (live()) {
          item.state = "failed";
          item.error = { message: error.message };
          this.host.changed();
        }
      });
      this.layout();
    } else {
      if (!item) throw Error("HTMLWebView target closed or unknown");
      if (method === "removeHTMLWebView") {
        this.remove(item);
        return {};
      }
      if (method === "operateHTMLWebView") {
        if (a.type === "get_webview_info") return this.describe(item);
        if (a.type === "try_webview_goback")
          return { delta: this.back(pageId, a.delta || 1) };
        throw Error("Unsupported HTMLWebView operation");
      }
      if (method !== "updateHTMLWebView")
        throw Error("Unsupported HTMLWebView method");
      if (a.position) item.position = a.position;
    }
    if (a.backgroundColor) item.view.setBackgroundColor(a.backgroundColor);
    if (a.src) this.load(item, htmlURL(a.src));
    this.layout();
    this.host.changed();
    return { webviewId: item.view.webContents.id, targetId };
  }
  private load(item: any, url: string) {
    // Geometry updates can repeat src. They must not restart a redirected page.
    if (item.requestedSrc === url) return;
    item.requestedSrc = url;
    // Updates serialize behind observer readiness. They are never retried.
    item.ready = item.ready
      .then(async () => {
        if (this.items.get(item.key) !== item) return;
        try {
          await item.view.webContents.loadURL(url);
        } catch (error: any) {
          const wc = item.view.webContents;
          // A client-side redirect may abort loadURL's first navigation while
          // the replacement is loading. Its own events determine the outcome.
          if (error.code === "ERR_ABORTED" || error.errno === -3) {
            if (
              wc.isDestroyed() ||
              wc.isLoadingMainFrame() ||
              item.src !== url ||
              item.state === "loaded"
            )
              return;
          }
          throw error;
        }
      })
      .catch((error: any) => {
        if (this.items.get(item.key) !== item) return;
        item.state = "failed";
        item.error = {
          code: error.code,
          errno: error.errno,
          message: error.message,
        };
        this.host.changed();
      });
  }
  private describe(i: any) {
    return {
      targetId: i.targetId,
      parentTargetId: "page:" + i.pageId,
      pageId: i.pageId,
      htmlId: i.htmlId,
      src: i.src,
      state: i.state,
      visible: i.visible,
      error: i.error,
      httpCode: i.httpCode ?? null,
      history: i.history.snapshot(i.view.webContents.navigationHistory),
    };
  }
  list() {
    return [...this.items.values()].map((i) => this.describe(i));
  }
  target(id: string) {
    return [...this.items.values()].find((i) => i.targetId === id)?.view
      .webContents;
  }
  sender(id: number) {
    return [...this.items.values()].find((i) => i.view.webContents.id === id);
  }
  bridge(id: number, name: string, arg: any) {
    const item = this.sender(id);
    if (!item || item.pageId !== this.host.active())
      throw Error("Inactive HTMLWebView");
    if (
      ![
        "postMessage",
        "navigateTo",
        "navigateBack",
        "switchTab",
        "reLaunch",
        "redirectTo",
      ].includes(name)
    )
      throw Error("Unsupported mini-program web bridge method");
    this.host.event(
      item.pageId,
      "onWebInvokeAppService",
      { htmlId: item.htmlId, webviewId: item.view.webContents.id, name, arg },
      true,
    );
    return {
      errMsg: "invokeMiniProgramAPI:ok",
      status: "input-sent",
      businessCompleted: false,
    };
  }
  back(pageId: number, delta: number) {
    const i = [...this.items.values()].find((i) => i.pageId === pageId);
    if (!i) return delta;
    const history = i.view.webContents.navigationHistory;
    const steps = i.history.backSteps(history, delta);
    if (steps > 0) history.goToOffset(-steps);
    return delta - steps;
  }
  layout() {
    const win = this.host.window();
    for (const i of this.items.values()) {
      const page = this.host.page(i.pageId),
        visible =
          !!page &&
          this.host.active() === i.pageId &&
          win.isVisible() &&
          !win.isMinimized();
      if (!visible) {
        if (i.visible)
          void i.view.webContents
            .executeJavaScript(
              "document.querySelectorAll('video,audio').forEach(e=>e.pause())",
            )
            .catch(() => {});
        if (win.contentView.children.includes(i.view))
          win.contentView.removeChildView(i.view);
      } else {
        const bounds = page.view.getBounds(),
          p = i.position || {};
        const n = (v: any, f: number) =>
          Number.isFinite(v) ? Math.round(v) : f;
        i.view.setBounds({
          x: bounds.x + n(p.left, 0),
          y: bounds.y + n(p.top, 0),
          width: Math.max(0, Math.min(bounds.width, n(p.width, bounds.width))),
          height: Math.max(
            0,
            Math.min(bounds.height, n(p.height, bounds.height)),
          ),
        });
        if (!win.contentView.children.includes(i.view))
          win.contentView.addChildView(i.view);
      }
      i.visible = visible;
    }
  }
  private remove(i: any) {
    this.items.delete(i.key);
    const win = this.host.window();
    if (win.contentView.children.includes(i.view))
      win.contentView.removeChildView(i.view);
    this.host.closed(i.targetId);
    if (!i.view.webContents.isDestroyed()) i.view.webContents.close();
    this.host.changed();
  }
  closePage(id: number) {
    for (const i of [...this.items.values()])
      if (i.pageId === id) this.remove(i);
  }
}
