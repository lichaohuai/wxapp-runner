import type { HostApis } from "../wx-shim/host";
import { debugContext, emitDebug } from "../debug/context";

type Kind = "Upload" | "Download";
type Task = {
  ownerContextId?: number;
  kind: Kind;
  id: number;
  aborted: boolean;
  states: Set<string>;
  io?: ReturnType<HostApis["nativeFiles"]["api"]["downloadFile"]>;
};

/** Task envelopes from the supplied PC adapter and WAServiceMainContext.
 * SDK/plugin realms retain their own queues and callbacks. File access and
 * transport policy remain shared with the public wx shim. */
export class NativeTransfers {
  private sequence = 0;
  private tasks = new Map<number, Task>();
  constructor(
    private host: HostApis,
    private log: (...args: any[]) => void,
    private publish: (name: string, event: any) => void,
  ) {}

  get pendingCount() {
    return this.tasks.size;
  }

  close() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) {
      task.aborted = true;
      task.io?.abort();
    }
  }

  closeContext(contextId: number) {
    for (const [id, task] of this.tasks)
      if (task.ownerContextId === contextId) {
        this.tasks.delete(id);
        task.aborted = true;
        task.io?.abort();
      }
  }

  invoke(
    name: string,
    args: any,
    reply: (value: any) => void,
  ): string | undefined {
    const match =
      /^(create|operate|listen)(Upload|Download)Task(Async|StateChange)?$/.exec(
        name,
      );
    if (!match) return;
    const [, action, type, suffix] = match;
    if (
      action === "create"
        ? suffix && suffix !== "Async"
        : action === "listen"
          ? suffix !== "StateChange"
          : suffix
    )
      return;
    const kind = type as Kind,
      idKey = kind.toLowerCase() + "TaskId";
    try {
      if (action === "create") {
        this.host.nativeFiles.validateTransfer(kind, args);
        if (this.tasks.size >= 256)
          throw Error("native transfer task capacity reached");
        const id = ++this.sequence;
        const task: Task = {
          kind,
          id,
          aborted: false,
          states: new Set(),
          ownerContextId: debugContext.getStore()?.contextId,
        };
        this.tasks.set(id, task);
        const context = {
          ...debugContext.getStore(),
          nativeApi: name,
          nativeTaskId: id,
          nativeTaskType: kind,
          nativeContextId: args.contextId ?? null,
          nativeCallStack: new Error("Native transfer call site").stack,
        };
        const start = () =>
          debugContext.run(context, () => this.start(task, args));
        const result = { errMsg: name + ":ok", [idKey]: id };
        if (suffix === "Async") {
          queueMicrotask(() => {
            reply(result);
            queueMicrotask(start);
          });
          return "";
        }
        queueMicrotask(start);
        return JSON.stringify(result);
      }
      const task = this.tasks.get(
        action === "listen" ? args.taskId : args[idKey],
      );
      if (!task || task.kind !== kind) throw Error("invalid " + idKey);
      if (action === "listen") {
        if (
          !Array.isArray(args.states) ||
          args.states.some(
            (s: any) => !["progressUpdate", "headersReceived"].includes(s),
          )
        )
          throw Error("unsupported transfer task state");
        task.states = new Set(args.states);
      } else {
        if (args.operationType !== "abort")
          throw Error("invalid operationType");
        task.aborted = true;
        task.io?.abort();
      }
      return JSON.stringify({ errMsg: name + ":ok" });
    } catch (error: any) {
      const result = {
        errMsg: name + ":fail " + error.message,
        runnerCode: "NATIVE_TRANSFER_FAILED",
      };
      emitDebug("native-api-error", { api: name, ...result });
      if (suffix === "Async") {
        queueMicrotask(() => reply(result));
        return "";
      }
      return JSON.stringify(result);
    }
  }

  private event(task: Task, state: string, value: any = {}) {
    if (!this.tasks.has(task.id)) return;
    if (state === "success" || state === "fail") this.tasks.delete(task.id);
    try {
      this.publish(`on${task.kind}TaskStateChange`, {
        [task.kind.toLowerCase() + "TaskId"]: task.id,
        state,
        ...value,
      });
    } catch (error) {
      this.log("NATIVE TRANSFER CALLBACK ERROR", error);
      emitDebug("native-api-error", {
        api: `on${task.kind}TaskStateChange`,
        error,
      });
    }
  }

  private start(task: Task, args: any) {
    if (!this.tasks.has(task.id)) return;
    if (task.aborted) return this.event(task, "fail", { errMsg: "abort" });
    const api = task.kind === "Upload" ? "uploadFile" : "downloadFile";
    task.io = this.host.nativeFiles.api[api]({
      ...args,
      success: ({ errMsg, ...value }: any) =>
        this.event(task, "success", value),
      fail: (error: any) =>
        this.event(task, "fail", {
          errMsg: task.aborted
            ? "abort"
            : error.errMsg.replace(/^(uploadFile|downloadFile):fail\s*/, ""),
        }),
    });
    task.io.onHeadersReceived((value) => {
      if (task.states.has("headersReceived"))
        this.event(task, "headersReceived", value);
    });
    task.io.onProgressUpdate((value) => {
      if (task.states.has("progressUpdate"))
        this.event(task, "progressUpdate", value);
    });
  }
}
