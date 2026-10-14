import { isIP } from "node:net";
import { createRequest } from "../wx-shim/network";
import { debugContext, emitDebug } from "../debug/context";

const protocols: Record<string, string[]> = {
  request: ["http:", "https:"],
  downloadFile: ["http:", "https:"],
  uploadFile: ["http:", "https:"],
  websocket: ["ws:", "wss:"],
  biz: ["http:", "https:"],
  tcp: ["tcp:"],
  udp: ["udp:"],
};

/** Runner's existing unrestricted network policy, not WeChat certification.
 * Plugin SDK still checks its own verifyPlugin domains/hostSign afterwards.
 * PC 4.1.9 CheckNetworkAPIURL explicitly returns isInLAN=false. */
export function checkNetworkAPIURL(args: any) {
  if (typeof args.api !== "string" || !Object.hasOwn(protocols, args.api))
    throw Error("unknown network api");
  if (typeof args.url !== "string") throw Error("url must be a string");
  const url = new URL(args.url);
  if (
    !protocols[args.api].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw Error("invalid network url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ipv4 = isIP(host) === 4 && host.split(".")[0] === "127";
  // The supplied PC build tests 127/8 or the 16-byte ::1 value only;
  // IPv4-mapped IPv6 is not treated as loopback by that helper.
  const ipv6 = host === "::1";
  return {
    isInDomainList: true,
    isLocalHost: ipv4 || ipv6,
    isInLAN: false,
    runnerDomainPolicy: "unrestricted-runtime",
  };
}

type Task = {
  ownerContextId?: number;
  task?: ReturnType<ReturnType<typeof createRequest>>;
  aborted: boolean;
  states: Set<string>;
};

/** Native RequestTask envelopes consumed by unmodified WAServiceMainContext.
 * The library owns queueing, JSON parsing and user callbacks; this host owns
 * I/O and task events. No synthetic verifyPlugin credentials are supplied. */
export class NativeNetwork {
  private sequence = 0;
  private tasks = new Map<number, Task>();
  private request;

  constructor(
    config: any,
    private log: (...args: any[]) => void,
    private takeBuffer: (id: number) => ArrayBuffer | undefined,
    private publish: (name: string, value: any) => void,
  ) {
    this.request = createRequest(
      log,
      config.app?.networkTimeout?.request,
      config,
      { serialized: true, chunkOnly: true },
    );
  }

  get pendingCount() {
    return this.tasks.size;
  }

  close() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const entry of tasks) {
      entry.aborted = true;
      entry.task?.abort();
    }
  }

  closeContext(contextId: number) {
    for (const [id, entry] of this.tasks)
      if (entry.ownerContextId === contextId) {
        this.tasks.delete(id);
        entry.aborted = true;
        entry.task?.abort();
      }
  }

  invoke(
    name: string,
    args: any,
    reply: (result: any) => void,
  ): string | undefined {
    if (
      ![
        "checkNetworkAPIURL",
        "createRequestTask",
        "createRequestTaskAsync",
        "operateRequestTask",
        "listenRequestTaskStateChange",
      ].includes(name)
    )
      return;
    const fail = (error: any) => {
      const result = {
        errMsg: name + ":fail " + error.message,
        runnerCode: "NATIVE_NETWORK_FAILED",
      };
      emitDebug("native-api-error", { api: name, ...result });
      return result;
    };
    try {
      if (name === "checkNetworkAPIURL") {
        const result = { errMsg: name + ":ok", ...checkNetworkAPIURL(args) };
        queueMicrotask(() => reply(result));
        return "";
      }
      if (name.startsWith("createRequestTask")) {
        // Validate before allocating an ID, consuming buffers or starting I/O.
        checkNetworkAPIURL({ api: "request", url: args.url });
        if (this.tasks.size >= 256)
          throw Error("native request task capacity reached");
        const method = String(args.method || "GET").toUpperCase();
        if (
          !/^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS|TRACE|CONNECT)$/.test(
            method,
          )
        )
          throw Error("invalid request method");
        if (
          args.timeout !== undefined &&
          (!Number.isFinite(args.timeout) || args.timeout < 0)
        )
          throw Error("invalid timeout");
        if (
          args.responseType !== undefined &&
          !["text", "arraybuffer"].includes(args.responseType)
        )
          throw Error("invalid responseType");
        let data = args.data;
        const buffer = args.__nativeBuffers__?.find(
          (b: any) => b.key === "data",
        );
        if (buffer) {
          data =
            buffer.id !== undefined
              ? this.takeBuffer(buffer.id)
              : typeof buffer.base64 === "string"
                ? Buffer.from(buffer.base64, "base64")
                : undefined;
          if (data === undefined)
            throw Error("native request buffer is unavailable");
        }
        if (
          data != null &&
          typeof data !== "string" &&
          !ArrayBuffer.isView(data) &&
          Object.prototype.toString.call(data) !== "[object ArrayBuffer]"
        )
          throw Error("native request data must already be serialized");
        const id = ++this.sequence;
        const entry: Task = {
          aborted: false,
          states: new Set(),
          ownerContextId: debugContext.getStore()?.contextId,
        };
        this.tasks.set(id, entry);
        const context = {
          ...debugContext.getStore(),
          nativeApi: name,
          nativeTaskId: id,
          nativeContextId: args.contextId ?? null,
          nativeCallStack: new Error("Native request call site").stack,
        };
        const result = { errMsg: name + ":ok", requestTaskId: id };
        const start = () =>
          debugContext.run(context, () =>
            this.start(id, entry, { ...args, method, data }),
          );
        if (name.endsWith("Async")) {
          queueMicrotask(() => {
            reply(result);
            queueMicrotask(start);
          });
          return "";
        }
        queueMicrotask(start);
        return JSON.stringify(result);
      }
      const id =
        name === "listenRequestTaskStateChange"
          ? args.taskId
          : args.requestTaskId;
      const entry = this.tasks.get(id);
      if (!entry) throw Error("invalid requestTaskId");
      if (name === "listenRequestTaskStateChange") {
        if (
          !Array.isArray(args.states) ||
          args.states.some(
            (s: any) => !["headersReceived", "chunked"].includes(s),
          )
        )
          throw Error("unsupported request task state");
        entry.states = new Set(args.states);
      } else {
        if (args.operationType !== "abort")
          throw Error("invalid operationType");
        entry.aborted = true;
        entry.task?.abort();
      }
      return JSON.stringify({ errMsg: name + ":ok" });
    } catch (error) {
      const result = fail(error);
      if (name === "checkNetworkAPIURL" || name.endsWith("Async")) {
        queueMicrotask(() => reply(result));
        return "";
      }
      return JSON.stringify(result);
    }
  }

  private event(id: number, state: string, value: any = {}) {
    if (!this.tasks.has(id)) return;
    if (state === "success" || state === "fail") this.tasks.delete(id);
    try {
      this.publish("onRequestTaskStateChange", {
        requestTaskId: id,
        state,
        ...value,
      });
    } catch (error) {
      // A thrown business callback must not turn success into a second failure.
      this.log("NATIVE NETWORK CALLBACK ERROR", error);
      emitDebug("native-api-error", { api: "onRequestTaskStateChange", error });
    }
  }

  private bytes(data: ArrayBuffer) {
    return {
      __nativeBuffers__: [
        { key: "data", base64: Buffer.from(data).toString("base64") },
      ],
    };
  }

  private start(id: number, entry: Task, args: any) {
    if (!this.tasks.has(id)) return;
    if (entry.aborted) return this.event(id, "fail", { errMsg: "abort" });
    try {
      entry.task = this.request({
        ...args,
        dataType: "text",
        success: (res: any) => {
          const { data, errMsg, ...rest } = res;
          this.event(id, "success", {
            ...rest,
            ...(args.enableChunked
              ? {}
              : typeof data === "string"
                ? { data }
                : this.bytes(data)),
          });
        },
        fail: (error: any) =>
          this.event(id, "fail", {
            errMsg: entry.aborted
              ? "abort"
              : error.errMsg.replace(/^request:fail\s*/, ""),
          }),
      });
      entry.task?.onHeadersReceived?.((value: any) => {
        if (entry.states.has("headersReceived"))
          this.event(id, "headersReceived", value);
      });
      entry.task?.onChunkReceived?.((value: any) => {
        if (entry.states.has("chunked"))
          this.event(id, "chunked", this.bytes(value.data));
      });
    } catch (error: any) {
      this.event(id, "fail", { errMsg: error.message });
    }
  }
}
