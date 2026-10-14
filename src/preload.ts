import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("runner", {
  navigate: (name: string, args: any) =>
    ipcRenderer.invoke("shell-nav", name, args),
  config: () => ipcRenderer.sendSync("config"),
  nativeRequest: (name: string, args: any) =>
    ipcRenderer.invoke("native-request", name, args),
  saveCanvas: (canvasNumber: number, width: number, height: number) => ipcRenderer.send("canvas-save", { canvasNumber, width, height }),
  cameraFrame: (id: number, data: ArrayBuffer) =>
    ipcRenderer.send("camera-frame", id, data),
  invoke: (n: string, a: string, id: number) =>
    ipcRenderer.sendSync("invoke", n, a, id),
  publish: (n: string, a: string, ids: string, context: any) =>
    ipcRenderer.send("publish", n, a, ids, context),
  debug: (event: any) => ipcRenderer.send("debug-observation", event),
  diagnostic: (issue: any) => ipcRenderer.send("diagnostic", issue),
  ready: () => ipcRenderer.send("ready"),
  preloaded: () => ipcRenderer.send("view-preloaded"),
  viewport: (data: any) => ipcRenderer.send("view-viewport", data),
  onMessage: (fn: Function) => ipcRenderer.on("message", (_e, m) => fn(m)),
  log: (...args: any[]) => ipcRenderer.send("log", ...args),
});
