import { contextBridge, ipcRenderer } from "electron";
// Protocol initialization also sends debugger mutations. Only real UI input is
// evidence of human takeover; opening DevTools must not revoke an AI lease.
for (const type of ["pointerdown", "keydown", "wheel"]) {
  window.addEventListener(
    type,
    (event) => {
      // Wxapp controls use the service's typed read/mutation classification.
      // Treating every report-read click as a takeover cancels its own jobs.
      // Other native DevTools surfaces retain immediate human priority.
      const inWxapp = event
        .composedPath()
        .some(
          (node) => node instanceof Element && node.classList.contains("wxapp"),
        );
      if (event.isTrusted && !inWxapp)
        ipcRenderer.send("wxapp-debug-manual", type);
    },
    { capture: true, passive: true },
  );
}
contextBridge.exposeInMainWorld("wxappDebugger", {
  call: (name: string, args: any = {}) =>
    ipcRenderer.invoke("wxapp-debug-call", name, args),
});
