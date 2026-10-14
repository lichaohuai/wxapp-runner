import { app, BrowserWindow, ipcMain, Menu } from "electron";
import path from "node:path";
import fs from "node:fs";
import { readConfig } from "./config";
import { LogicDevTools } from "./logic-devtools";
import { DebugService } from "./controller/service";

const config = readConfig();
const persistent = config.userDataDir || app.getPath("userData");
fs.mkdirSync(path.join(persistent, "controller"), { recursive: true });
const controllerData = fs.mkdtempSync(
  path.join(persistent, "controller", "session-"),
);
app.setPath("userData", controllerData);
const windows = new Map<string, LogicDevTools>();
let controllerWindow: BrowserWindow | undefined;
const service = new DebugService({
  root: __dirname,
  userData: persistent,
  debug: config.debug,
  openDevtools: (id, url, targetId = "logic") => {
    const key = id + ":" + targetId;
    let devtools = windows.get(key);
    if (!devtools) {
      devtools = new LogicDevTools(
        service.runtimes.get(id)!.config.appid,
        targetId === "logic" || targetId.startsWith("worker:") ? "logic" : "view",
      );
      windows.set(key, devtools);
    }
    devtools.setEndpoint(url);
    devtools.open();
  },
  updateDevtools: (id, url, targetId) =>
    windows.get(id + ":" + targetId)?.setEndpoint(url),
  removeNativeBreakpoint: async (id, targetId, record) => {
    const view = windows.get(id + ":" + targetId);
    if (!view) throw Error("Native Sources editor is no longer open");
    return view.removeBreakpoint(record);
  },
});
ipcMain.handle("wxapp-debug-call", (e, name, args) => {
  const owner = [...windows].find(([, w]) => w.owns(e.sender));
  if (!owner) throw Error("Debugger window required");
  return service.dispatch(
    name,
    { ...args, runtimeId: args.runtimeId || owner[0].split(":")[0] },
    "human",
  );
});
ipcMain.on("wxapp-debug-manual", (e, type) => {
  const owner = [...windows].find(([, w]) => w.owns(e.sender));
  if (owner)
    service.manual(owner[0].split(":")[0], {
      type: "native-devtools-input",
      input: type,
    });
});
function showDebugger() {
  const runtime = service.runtimes.values().next().value;
  if (!runtime?.status.devtoolsUrl) return;
  const key = runtime.id + ":logic";
  let window = windows.get(key);
  if (!window) {
    window = new LogicDevTools(runtime.config.appid);
    windows.set(key, window);
  }
  window.setEndpoint(runtime.status.devtoolsUrl);
  window.open();
}
app.on("activate", showDebugger);
app.on("quit", () =>
  fs.rmSync(controllerData, { recursive: true, force: true }),
);
app
  .whenReady()
  .then(async () => {
    // Keep a Chromium target alive even when every user-facing window belongs
    // to a child process. The controller's CDP endpoint must be ready without
    // waiting for a user to open DevTools (including in external UI clients).
    controllerWindow = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    await controllerWindow.loadURL("about:blank");
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "WxappRunner",
          submenu: [
            { label: "打开实例与调试", click: showDebugger },
            { type: "separator" },
            { role: "quit", label: "退出调试工具" },
          ],
        },
      ]),
    );
    await service.start(config);
    await service.listen(
      config.mcp
        ? config.mcpFile || path.join(persistent, `mcp-${config.appid}.json`)
        : undefined,
    );
  })
  .catch((e) => {
    console.error("CONTROLLER STARTUP FAILED", e);
    app.exit(1);
  });
// Closing a runtime is not the same as closing the debugger service.
app.on("window-all-closed", () => {});
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  controllerWindow?.destroy();
  for (const win of windows.values()) win.close();
  void service.close().finally(() => app.quit());
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => app.quit());
