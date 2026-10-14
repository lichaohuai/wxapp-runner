import fs from "node:fs";
import { devtoolsContract as frontend } from "./devtools-contract";
import path from "node:path";
import { BrowserWindow } from "electron";

/** Native DevTools panels, with a version-pinned Wxapp registration and shared CDP relay. */
export class LogicDevTools {
  private endpoint?: string;
  private win?: BrowserWindow;
  private pendingOpen = false;
  constructor(
    private appid: string,
    private kind: "logic" | "view" = "logic",
  ) {
    if (process.versions.electron !== frontend.electron)
      throw Error(
        `DevTools adapter requires Electron ${frontend.electron}; found ${process.versions.electron}`,
      );
  }
  private frontend() {
    return frontend.root + frontend[this.kind];
  }
  setEndpoint(endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1")
      throw Error("Logic inspector must be bound to loopback");
    const changed = this.endpoint && this.endpoint !== endpoint;
    this.endpoint = endpoint;
    if (changed && this.win && !this.win.isDestroyed()) {
      void this.win.loadURL(
        this.frontend() + encodeURIComponent(endpoint.slice(5)),
      );
    }
    if (this.pendingOpen) {
      this.pendingOpen = false;
      this.open();
    }
  }
  toggle() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isVisible()) this.win.hide();
      else {
        this.win.show();
        this.win.focus();
      }
    } else this.open();
  }
  open() {
    if (!this.endpoint) {
      this.pendingOpen = true;
      return;
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 1150,
      height: 800,
      title: `${this.kind === "logic" ? "逻辑" : "视图"}调试 — ${this.appid}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        // Keep Sources updates and CDP-driven UI responsive when the user is
        // working in the page window or an AI client observes in background.
        backgroundThrottling: false,
        preload: path.join(__dirname, "devtools-preload.cjs"),
      },
    });
    this.win.webContents.on("did-finish-load", () => {
      void this.win?.webContents
        .executeJavaScript(
          `(async()=>{
            const UI=await import(${JSON.stringify(frontend.ui)});
            const registry=UI.ActionRegistry.ActionRegistry.instance();
            const id="sources.add-folder-to-workspace";
            // Chromium's remote frontend omits the filesystem-host action but
            // still creates its toolbar. Keep the unsupported action disabled
            // so opening Sources/Workspace does not throw during source reveal.
            if(!registry.hasAction(id)){
              UI.ActionRegistration.maybeRemoveActionExtension(id);
              UI.ActionRegistration.registerActionExtension({actionId:id,category:"SOURCES",iconClass:"plus",title:()=>"Workspace folder binding is unavailable for this remote target"});
              registry.registerActions();
            }
          })().catch(console.error);` +
            (this.kind === "view"
              ? `(async()=>{const C=await import(${JSON.stringify(frontend.common)});C.Settings.Settings.instance().createSetting("screencast-enabled",false).set(false)})().catch(console.error);`
              : "") +
            fs.readFileSync(path.join(__dirname, "devtools-media.js"), "utf8") +
            fs.readFileSync(path.join(__dirname, "wxapp-panel.js"), "utf8"),
        )
        .catch((e) => console.error("Wxapp panel injection failed", e));
    });
    this.win.on("page-title-updated", (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("before-input-event", (e, input) => {
      if (input.key === "F12") {
        e.preventDefault();
        if (input.type === "keyDown" && !input.isAutoRepeat) this.win?.hide();
      }
    });
    // js_app is Chromium's Node/V8 frontend: native Console, Sources and Network.
    void this.win.loadURL(
      this.frontend() + encodeURIComponent(this.endpoint.slice(5)),
    );
  }
  owns(sender: any) {
    return this.win?.webContents === sender;
  }
  async removeBreakpoint(record: any) {
    if (!this.win || this.win.isDestroyed())
      throw Error("Native DevTools was closed; refresh breakpoints");
    return this.win.webContents.executeJavaScript(`(async()=>{
      const B=await import(${JSON.stringify(frontend.breakpoints)});
      const expected=${JSON.stringify({ url: record.url, lineNumber: record.lineNumber, columnNumber: record.columnNumber || 0 })};
      const manager=B.BreakpointManager.BreakpointManager.instance();
      const candidates=[...new Set(manager.allBreakpointLocations().map(x=>x.breakpoint))].filter(bp=>bp.getLastResolvedState()?.some(p=>p.url===expected.url&&p.lineNumber===expected.lineNumber&&(p.columnNumber||0)===expected.columnNumber));
      if(candidates.length!==1)throw Error("Native breakpoint is stale or ambiguous; refresh Sources");
      await candidates[0].remove(false);return {removed:true};
    })()`);
  }
  close() {
    this.pendingOpen = false;
    this.win?.destroy();
  }
}
