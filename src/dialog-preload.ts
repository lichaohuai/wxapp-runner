import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("wxDialog", {
  config: () => ipcRenderer.invoke("wx-dialog-config"),
  respond: (args: any) => ipcRenderer.invoke("wx-dialog-respond", args),
  pick: () => ipcRenderer.invoke("wx-dialog-pick"),
  fit: (height: number) => ipcRenderer.invoke("wx-dialog-fit", height),
});
