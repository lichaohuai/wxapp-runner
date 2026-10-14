import {
  socketApis,
  validateSocketOptions,
  validateSocketClose,
} from "../wx-shim/socket";
import { debugContext, emitDebug } from "../debug/context";

/** Original SDK native envelopes; no replacement of its public SocketTask. */
export class NativeSocket {
  private sequence = 0;
  private tasks = new Map<number, any>();
  private backend;
  constructor(
    config: any,
    private takeBuffer: (id: number) => ArrayBuffer | undefined,
    private publish: (name: string, event: any) => void,
  ) {
    this.backend = socketApis(config.emitNetwork, {
      previewBytes: config.debug?.previewBytes,
      captureFrame: config.captureSocketFrame,
      checkURL: config.checkSocketURL,
    });
  }
  get pendingCount() {
    return this.tasks.size;
  }
  close() {
    this.tasks.clear();
    this.backend.close();
  }
  closeContext(contextId: number) {
    for (const [id, task] of this.tasks)
      if (task.__runnerOwnerContextId === contextId) {
        this.tasks.delete(id);
        task.close({ code: 1000, reason: "Context closed" });
      }
  }
  invoke(name: string, args: any, reply: (r: any) => void): string | undefined {
    if (!["createSocketTask", "operateSocketTask"].includes(name)) return;
    try {
      if (name === "createSocketTask") {
        validateSocketOptions(args);
        if (this.tasks.size >= 256)
          throw Error("native socket capacity reached");
        const id = ++this.sequence;
        const context = {
          ...debugContext.getStore(),
          nativeApi: name,
          nativeTaskId: id,
          nativeContextId: args.contextId ?? null,
          nativeCallStack: new Error("Native socket call site").stack,
        };
        const task = debugContext.run(context, () =>
          this.backend.api.connectSocket({
            ...args,
            success: undefined,
            fail: undefined,
            complete: undefined,
          }),
        );
        Object.defineProperty(task, "__runnerOwnerContextId", {
          value: debugContext.getStore()?.contextId,
        });
        this.tasks.set(id, task);
        const event = (state: string, data: any) => {
          if (!this.tasks.has(id)) return;
          if (state === "close") this.tasks.delete(id);
          try {
            this.publish("onSocketTaskStateChange", {
              socketTaskId: id,
              state,
              ...data,
            });
          } catch (error) {
            emitDebug("native-api-error", {
              api: "onSocketTaskStateChange",
              error,
            });
          }
        };
        task.onOpen((r: any) => event("open", r));
        task.onMessage((r: any) =>
          event(
            "message",
            typeof r.data === "string"
              ? r
              : {
                  __nativeBuffers__: [
                    {
                      key: "data",
                      base64: Buffer.from(r.data).toString("base64"),
                    },
                  ],
                },
          ),
        );
        task.onError((r: any) => event("error", r));
        task.onClose((r: any) => event("close", r));
        return JSON.stringify({ errMsg: name + ":ok", socketTaskId: id });
      }
      const task = this.tasks.get(args.socketTaskId);
      if (!task) throw Error("invalid socketTaskId");
      const operation = args.operationType;
      if (!["send", "close"].includes(operation))
        throw Error("invalid operationType");
      let data = args.data;
      if (operation === "close") validateSocketClose(args);
      else {
        if (task.readyState !== 1) throw Error("Socket is not open");
        const b = args.__nativeBuffers__?.find((v: any) => v.key === "data");
        if (b)
          data =
            b.id !== undefined
              ? this.takeBuffer(b.id)
              : typeof b.base64 === "string"
                ? Buffer.from(b.base64, "base64")
                : undefined;
        if (
          typeof data !== "string" &&
          !ArrayBuffer.isView(data) &&
          Object.prototype.toString.call(data) !== "[object ArrayBuffer]"
        )
          throw Error("socket data must be a string or native buffer");
      }
      // Native invoke supports async completion. Report send success only when
      // ws confirms the write, not just because a buffer was accepted locally.
      let replied = false;
      const done = (r: any) => {
        if (replied) return;
        replied = true;
        reply({
          ...r,
          errMsg: r.errMsg.replace(/^(sendSocketMessage|closeSocket)/, name),
        });
      };
      task[operation]({
        ...args,
        data,
        success: done,
        fail: done,
        complete: undefined,
      });
      return "";
    } catch (error: any) {
      const result = {
        errMsg: name + ":fail " + error.message,
        runnerCode: "NATIVE_SOCKET_FAILED",
      };
      emitDebug("native-api-error", { api: name, ...result });
      return JSON.stringify(result);
    }
  }
}
