import { contextBridge, ipcRenderer } from "electron";
const invoke = (name: string, data: any, callback?: Function) => {
  if (name !== "invokeMiniProgramAPI") {
    callback?.({ errMsg: name + ":fail unsupported H5 bridge method" });
    return;
  }
  const { success, fail, complete, ...arg } = data?.arg || {};
  ipcRenderer.invoke("h5-bridge", data?.name, arg).then(
    (result) => callback?.(result),
    (error) => callback?.({ errMsg: name + ":fail " + error.message }),
  );
};
contextBridge.exposeInMainWorld("__wxjs_environment", "miniprogram");
contextBridge.exposeInMainWorld("WeixinJSBridge", { invoke, on() {} });
// WAPCAdapterWebViewChannel only adapts WeixinJSBridge. The webpage owns
// its wx/jWeixin SDK. A premature, frozen partial wx makes cross-platform
// libraries select their mini-program implementation (e.g. wx.setStorage).
window.addEventListener("DOMContentLoaded", () =>
  document.dispatchEvent(new Event("WeixinJSBridgeReady")),
);
