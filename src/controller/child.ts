import { randomUUID } from "node:crypto";
/** Private inherited IPC: no public port or credentials in renderer contexts. */
export const managed = !!process.env.WXAPP_RUNTIME_CHILD;
export function emitController(event: any) {
  if (managed && process.connected)
    process.send?.({ type: "runtime-event", event });
}
const pending = new Map<
  string,
  { resolve: Function; reject: Function; timer: NodeJS.Timeout }
>();
export function controllerCall(name: string, args: any = {}) {
  const id = randomUUID();
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        Error("Controller response timed out; operation was not repeated"),
      );
    }, 65000);
    pending.set(id, { resolve, reject, timer });
    process.send?.({ type: "controller-call", id, name, args });
  });
}
process.on("message", (message: any) => {
  if (message.type !== "controller-result") return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  clearTimeout(item.timer);
  message.error
    ? item.reject(Error(message.error))
    : item.resolve(message.result);
});
process.on("disconnect", () => {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(Error("Controller disconnected"));
  }
  pending.clear();
});
