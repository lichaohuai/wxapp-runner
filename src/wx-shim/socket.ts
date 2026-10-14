import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { debugContext, emitDebug } from "../debug/context";
import { success, failure, type Options } from "./common";
import { validateHeaderName, validateHeaderValue } from "node:http";

export function validateSocketOptions(o: Options) {
  if (typeof o.url !== "string") throw Error("socket url required");
  const url = new URL(o.url);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error(
      "connectSocket requires ws:// or wss:// without credentials or fragment",
    );
  if (o.timeout !== undefined && (!Number.isFinite(o.timeout) || o.timeout < 0))
    throw Error("invalid socket timeout");
  if (o.method !== undefined && o.method !== "GET")
    throw Error("WebSocket handshake only supports GET");
  const protocols = o.protocols ?? [];
  if (
    !Array.isArray(protocols) ||
    new Set(protocols).size !== protocols.length ||
    protocols.some(
      (p) => typeof p !== "string" || !/^[!#$%&'*+\-.^_`|~\da-zA-Z]+$/.test(p),
    )
  )
    throw Error("invalid or duplicate WebSocket protocols");
  if (
    o.header != null &&
    (typeof o.header !== "object" || Array.isArray(o.header))
  )
    throw Error("socket header must be an object");
  for (const [name, value] of Object.entries(o.header || {})) {
    validateHeaderName(name);
    validateHeaderValue(name, String(value));
  }
  if (
    o.perMessageDeflate !== undefined &&
    typeof o.perMessageDeflate !== "boolean"
  )
    throw Error("perMessageDeflate must be boolean");
}

export function validateSocketClose(o: Options) {
  const code = o.code ?? 1000;
  if (
    !Number.isInteger(code) ||
    (code !== 1000 && (code < 3000 || code > 4999))
  )
    throw Error("Invalid WebSocket close code");
  if (o.reason !== undefined && typeof o.reason !== "string")
    throw Error("Close reason must be a string");
  if (Buffer.byteLength(o.reason || "") > 123)
    throw Error("Close reason exceeds 123 bytes");
}

export function socketApis(
  emit: (record: any) => void = () => {},
  options: {
    previewBytes?: number;
    captureFrame?: (bytes: Buffer, binary: boolean) => Promise<string>;
    checkURL?: (url: string) => Promise<{ allowed: boolean; reason?: string }>;
  } = {},
) {
  const sockets = new Set<WebSocket>();
  let disposed = false;
  const legacy = {
    open: new Set<Function>(),
    message: new Set<Function>(),
    error: new Set<Function>(),
    close: new Set<Function>(),
  };
  let latest: any;
  function connectSocket(o: Options) {
    let validationError: unknown;
    try {
      validateSocketOptions(o);
    } catch (error) {
      validationError = error;
    }
    const listeners = {
      open: new Set<Function>(),
      message: new Set<Function>(),
      error: new Set<Function>(),
      close: new Set<Function>(),
    };
    const parent = debugContext.getStore();
    const id = "socket-" + randomUUID();
    const record: any = {
      id,
      source: "logic",
      resourceType: "WebSocket",
      url: o.url,
      method: "GET",
      requestHeaders: o.header || {},
      startedAt: new Date().toISOString(),
      state: "pending",
      context: parent || null,
      callStack: new Error("connectSocket call site").stack,
      frames: [],
      frameCount: 0,
    };
    let socket: WebSocket | undefined;
    let closing: Options | undefined;
    let finished = false;
    const callback = (ok: boolean, api: string, args: Options, error?: any) => {
      try {
        ok ? success(api, args) : failure(api, args, error);
      } catch (error) {
        emitDebug("callback-error", { api, error });
      }
    };
    const publish = () => {
      try {
        emit(structuredClone(record));
      } catch {}
    };
    const fire = (name: keyof typeof listeners, data: any) => {
      const context =
        name === "message"
          ? {
              operationId: randomUUID(),
              kind: "socket-message",
              socketId: id,
              connectionOperationId:
                parent?.rootOperationId || parent?.operationId,
              nativeTaskId: parent?.nativeTaskId,
              nativeContextId: parent?.nativeContextId,
            }
          : { ...parent, socketId: id };
      debugContext.run(context, () => {
        for (const fn of [...listeners[name], ...legacy[name]]) {
          try {
            fn(data);
          } catch (error) {
            emitDebug("callback-error", { api: "SocketTask.on" + name, error });
          }
        }
      });
    };
    let pendingCaptures = 0;
    const frame = (direction: string, bytes: Buffer, binary: boolean) => {
      const data = bytes.subarray(
        0,
        Math.min(options.previewBytes || 262144, 2048),
      );
      const entry: any = {
        id: ++record.frameCount,
        direction,
        time: new Date().toISOString(),
        opcode: binary ? 2 : 1,
        payload: binary
          ? data.toString("base64")
          : new TextDecoder().decode(data, {
              stream: bytes.length > data.length,
            }),
        encoding: binary ? "base64" : "text",
        bytes: bytes.length,
        truncated: bytes.length > data.length,
        context: direction === "sent" ? debugContext.getStore() || null : null,
      };
      record.frames.push(entry);
      if (record.frames.length > 100) {
        record.frames.shift();
        record.framesEvicted = record.frameCount - record.frames.length;
      }
      if (options.captureFrame && pendingCaptures < 4) {
        pendingCaptures++;
        entry.captureState = "pending";
        void options
          .captureFrame(bytes, binary)
          .then((artifactId) => {
            entry.artifactId = artifactId;
            entry.captureState = "complete";
          })
          .catch((e) => {
            entry.captureState = "failed";
            entry.captureError = e.message;
          })
          .finally(() => {
            pendingCaptures--;
            publish();
          });
      } else
        entry.captureState = options.captureFrame
          ? "skipped-capture-backpressure"
          : "preview-only";
      emitDebug("websocket-frame", { socketId: id, ...entry });
      publish();
    };
    const task: any = {
      get readyState() {
        return finished
          ? WebSocket.CLOSED
          : closing
            ? WebSocket.CLOSING
            : (socket?.readyState ?? WebSocket.CONNECTING);
      },
      send(a: Options) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          queueMicrotask(() =>
            callback(
              false,
              "sendSocketMessage",
              a,
              Error("Socket is not open"),
            ),
          );
          return;
        }
        let bytes: Buffer;
        const binary = typeof a.data !== "string";
        try {
          if (typeof a.data === "string") bytes = Buffer.from(a.data);
          else if (
            Object.prototype.toString.call(a.data) === "[object ArrayBuffer]"
          )
            bytes = Buffer.from(a.data);
          else if (ArrayBuffer.isView(a.data))
            bytes = Buffer.from(
              a.data.buffer,
              a.data.byteOffset,
              a.data.byteLength,
            );
          else throw Error("data must be a string or ArrayBuffer");
        } catch (e) {
          queueMicrotask(() => callback(false, "sendSocketMessage", a, e));
          return;
        }
        const context = debugContext.getStore();
        socket.send(bytes, { binary }, (error) =>
          debugContext.run(context || {}, () => {
            if (error) callback(false, "sendSocketMessage", a, error);
            else {
              frame("sent", bytes, binary);
              callback(true, "sendSocketMessage", a);
            }
          }),
        );
      },
      close(a: Options = {}) {
        try {
          validateSocketClose(a);
          if (finished || closing)
            throw Error("Socket is already closing or closed");
          closing = a;
          const code = a.code ?? 1000;
          socket?.close(code, a.reason || "");
          queueMicrotask(() => callback(true, "closeSocket", a));
        } catch (e) {
          queueMicrotask(() => callback(false, "closeSocket", a, e));
        }
      },
    };
    for (const name of Object.keys(listeners) as (keyof typeof listeners)[]) {
      const suffix = name[0].toUpperCase() + name.slice(1);
      task["on" + suffix] = (fn: Function) => {
        if (typeof fn !== "function")
          throw Error("Listener must be a function");
        listeners[name].add(fn);
      };
      task["off" + suffix] = (fn?: Function) =>
        fn ? listeners[name].delete(fn) : listeners[name].clear();
    }
    publish();
    const start = async () => {
      validateSocketOptions(o);
      if (options.checkURL) {
        const policy = await options.checkURL(o.url);
        if (!policy.allowed)
          throw Error(policy.reason || "Socket destination blocked");
      }
      if (disposed) throw Error("Socket host closed");
      if (closing) {
        finished = true;
        Object.assign(record, {
          state: "complete",
          endedAt: new Date().toISOString(),
          closeCode: closing.code ?? 1000,
          closeReason: closing.reason || "",
          cancelledBeforeConnect: true,
        });
        publish();
        fire("close", { code: record.closeCode, reason: record.closeReason });
        return;
      }
      socket = new WebSocket(o.url, o.protocols || [], {
        headers: o.header,
        handshakeTimeout: o.timeout || 60000,
        perMessageDeflate: o.perMessageDeflate ?? true,
        finishRequest(request) {
          record.requestHeaders = request.getHeaders();
          record.requestHeadersObserved = true;
          publish();
          request.end();
        },
      });
      sockets.add(socket);
      socket.on("upgrade", (response) => {
        record.status = response.statusCode;
        record.responseHeaders = response.headers;
      });
      socket.on("unexpected-response", (_request, response) => {
        record.status = response.statusCode;
        record.responseHeaders = response.headers;
        record.handshakeRejected = true;
        response.resume();
        socket!.terminate();
      });
      socket.on("open", () => {
        record.state = "headers";
        publish();
        fire("open", {
          header: record.responseHeaders,
          statusCode: record.status,
          protocol: socket!.protocol,
        });
      });
      socket.on("message", (data, binary) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        frame("received", bytes, binary);
        fire("message", {
          data: binary
            ? bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              )
            : bytes.toString(),
        });
      });
      socket.on("error", (error) => {
        if (record.error) return;
        record.error = record.handshakeRejected
          ? `Unexpected server response: ${record.status}`
          : error.message;
        record.errorStack = error.stack;
        record.state = "failed";
        publish();
        fire("error", {
          errMsg: record.error,
          ...(error.message === "Opening handshake has timed out"
            ? { code: 1004 }
            : {}),
        });
      });
      socket.on("close", (code, reason) => {
        sockets.delete(socket!);
        finished = true;
        Object.assign(record, {
          state: record.error ? "failed" : "complete",
          closeCode: code,
          closeReason: reason.toString(),
          endedAt: new Date().toISOString(),
        });
        publish();
        fire("close", { code, reason: reason.toString() });
        for (const set of Object.values(listeners)) set.clear();
      });
    };
    // Creation acknowledgement and listeners precede any connection events.
    queueMicrotask(() =>
      callback(!validationError, "connectSocket", o, validationError),
    );
    Promise.resolve()
      .then(start)
      .catch((error) => {
        finished = true;
        Object.assign(record, {
          state: "failed",
          error: error.message,
          errorStack: error.stack,
          endedAt: new Date().toISOString(),
        });
        publish();
        fire("error", { errMsg: error.message });
        fire("close", { code: 1006, reason: error.message });
        for (const set of Object.values(listeners)) set.clear();
      });
    latest = task;
    return task;
  }
  const api: any = {
    connectSocket,
    sendSocketMessage: (o: Options) =>
      latest
        ? latest.send(o)
        : failure("sendSocketMessage", o, Error("No socket")),
    closeSocket: (o: Options) =>
      latest ? latest.close(o) : failure("closeSocket", o, Error("No socket")),
  };
  for (const name of Object.keys(legacy) as (keyof typeof legacy)[]) {
    const suffix = name[0].toUpperCase() + name.slice(1);
    api["onSocket" + suffix] = (fn: Function) => legacy[name].add(fn);
    api["offSocket" + suffix] = (fn?: Function) =>
      fn ? legacy[name].delete(fn) : legacy[name].clear();
  }
  return {
    api,
    close: () => {
      disposed = true;
      for (const socket of sockets) socket.terminate();
    },
  };
}
