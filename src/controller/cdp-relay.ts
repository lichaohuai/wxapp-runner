import type http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { redact } from "../mcp/redact";
import { scheduledEvaluate } from "../mcp/scheduled-evaluate";
// CDP Headers values are strings. Node handshake headers can be numbers or
// string arrays; forwarding those verbatim crashes DevTools' header parser.
const cdpHeaders = (headers: Record<string, any> = {}) => Object.fromEntries(
  Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : String(value)]),
);
type Client = {
  id: string;
  runtimeId: string;
  sessionId: string;
  target: string;
  socket: WebSocket;
  upstream?: WebSocket;
  network: boolean;
  seen: Map<string, string>;
  paused?: any;
  commands: Map<number, any>;
  nextCommand: number;
  breakpoints: Map<string, any>;
  objects: Set<string>;
};
type Host = {
  records: (runtimeId: string) => any[];
  body: (
    runtimeId: string,
    id: string,
    request: boolean,
    sessionId: string,
  ) => any;
  network: (
    runtimeId: string,
    method: string,
    args: any,
    target: string,
  ) => Promise<any>;
  sourceMap?: (
    runtimeId: string,
    script: string,
    map: string,
  ) => string | undefined;
  human: (runtimeId: string, method: string, args: any) => void;
  observed?: (runtimeId: string, event: any) => void;
};
/** Keep native panels. Only Network is backed by the debugger's shared, repeatable record store. */
export class CdpRelay {
  private targets = new Map<string, { url: string; sessionId: string }>();
  private clients = new Set<Client>();
  private server = new WebSocketServer({ noServer: true });
  private endpoint = "";
  constructor(private host: Host) {}
  attach(server: http.Server, endpoint: string, token: string) {
    this.endpoint = endpoint.replace("http:", "ws:") + "/cdp/" + token + "/";
    server.on("upgrade", (req, socket, head) => {
      const prefix = "/cdp/" + token + "/";
      if (
        (req.headers.origin &&
          !String(req.headers.origin).startsWith("devtools://")) ||
        !req.url?.startsWith(prefix)
      ) {
        socket.destroy();
        return;
      }
      const [runtimeId, target] = req.url.slice(prefix.length).split("?");
      const name = target
        ? new URLSearchParams(target).get("target") || "logic"
        : "logic";
      const upstream = this.targets.get(runtimeId + ":" + name);
      const requestedSession = new URLSearchParams(target || "").get("session");
      if (
        !upstream ||
        (requestedSession && requestedSession !== upstream.sessionId)
      ) {
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(req, socket, head, (ws) =>
        this.connect(runtimeId, name, upstream.url, upstream.sessionId, ws),
      );
    });
  }
  register(
    runtimeId: string,
    target: string,
    upstream: string,
    sessionId: string,
  ) {
    this.targets.set(runtimeId + ":" + target, { url: upstream, sessionId });
    if (!this.endpoint) throw Error("CDP relay is not listening");
    return (
      this.endpoint +
      runtimeId +
      "?target=" +
      encodeURIComponent(target) +
      "&session=" +
      sessionId
    );
  }
  unregister(runtimeId: string, target: string) {
    this.targets.delete(runtimeId + ":" + target);
    for (const client of this.clients)
      if (client.runtimeId === runtimeId && client.target === target) {
        client.network = false;
        client.paused = undefined;
        client.upstream?.close();
      }
  }
  private connect(
    runtimeId: string,
    target: string,
    url: string,
    sessionId: string,
    socket: WebSocket,
  ) {
    const upstream = new WebSocket(url);
    const client: Client = {
      id: randomUUID(),
      runtimeId,
      sessionId,
      target,
      socket,
      upstream,
      network: false,
      seen: new Map(),
      commands: new Map(),
      nextCommand: 0,
      breakpoints: new Map(),
      objects: new Set(),
    };
    this.clients.add(client);
    const queued: any[] = [];
    const businessContexts = new Set<number>();
    const businessUniqueContexts = new Map<number, string>();
    const mutations = new Map<number, any>();
    const send = (value: any) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(value));
    };
    upstream.on("open", () => {
      for (const data of queued) upstream.send(data);
      queued.length = 0;
    });
    upstream.on("message", (data) => {
      let text = data.toString();
      try {
        const event = JSON.parse(text);
        if (client.commands.has(event.id)) {
          const pending = client.commands.get(event.id);
          client.commands.delete(event.id);
          clearTimeout(pending.timer);
          if (event.result?.result?.objectId)
            client.objects.add(event.result.result.objectId);
          if (Array.isArray(event.result?.result))
            for (const property of event.result.result)
              if (property.value?.objectId)
                client.objects.add(property.value.objectId);
          event.error
            ? pending.reject(Error(event.error.message))
            : pending.resolve(
                pending.rawResponse
                  ? event.result
                  : this.references(client, event.result),
              );
          return;
        }
        if (event.method === "Debugger.paused") client.paused = event.params;
        if (
          event.method === "Debugger.resumed" ||
          event.method === "Inspector.detached"
        )
          client.paused = undefined;
        if (["Debugger.paused", "Debugger.resumed"].includes(event.method))
          this.host.observed?.(runtimeId, {
            type: event.method,
            targetId: target,
            sessionId,
            ...event.params,
          });
        if (event.id && mutations.has(event.id)) {
          const command = mutations.get(event.id);
          mutations.delete(event.id);
          if (event.result?.breakpointId)
            client.breakpoints.set(event.result.breakpointId, {
              ...command.params,
              ...event.result,
              scope: "native-devtools",
              editable: false,
            });
          if (command.method === "Debugger.removeBreakpoint" && !event.error)
            client.breakpoints.delete(command.params.breakpointId);
          this.host.observed?.(runtimeId, {
            type: command.method,
            targetId: target,
            sessionId,
            params: command.params,
            result: event.result,
            error: event.error,
          });
        }
        if (
          target === "logic" &&
          event.method === "Runtime.executionContextCreated" &&
          (event.params.context.name.startsWith("Mini-program business") || event.params.context.name.startsWith("Mini-program worker"))
        ) {
          businessContexts.add(event.params.context.id);
          if (event.params.context.uniqueId)
            businessUniqueContexts.set(
              event.params.context.id,
              event.params.context.uniqueId,
            );
          // Node vm auxiliary flags describe V8 contexts, not browser worlds.
          // Omit the browser-only flag in this frontend connection so it does
          // not blackbox the entire business context as an extension world.
          delete event.params.context.auxData;
          text = JSON.stringify(event);
        }
        if (event.method === "Runtime.executionContextDestroyed") {
          businessContexts.delete(event.params.executionContextId);
          businessUniqueContexts.delete(event.params.executionContextId);
        }
        if (event.method === "Runtime.executionContextsCleared") {
          businessContexts.clear();
          businessUniqueContexts.clear();
        }
        if (event.method === "Debugger.scriptParsed") {
          // V8's non-default vm context is not a Chromium extension content script.
          // The frontend otherwise silently ignore-lists all business source maps.
          if (
            target === "logic" &&
            businessContexts.has(event.params.executionContextId) &&
            event.params.executionContextAuxData
          ) {
            const { isDefault, ...aux } = event.params.executionContextAuxData;
            event.params.executionContextAuxData = aux;
          }
          if (event.params.sourceMapURL) {
            const map = this.host.sourceMap?.(
              runtimeId,
              event.params.url,
              event.params.sourceMapURL,
            );
            if (map) event.params.sourceMapURL = map;
          }
          text = JSON.stringify(event);
        }
      } catch {}
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    });
    upstream.on("error", () =>
      send({
        method: "Inspector.detached",
        params: { reason: "target_disconnected" },
      }),
    );
    upstream.on("close", () => {
      client.paused = undefined;
      client.network = false;
      client.breakpoints.clear();
      client.objects.clear();
      for (const pending of client.commands.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          Error("Native debug target disconnected; operation was not repeated"),
        );
      }
      client.commands.clear();
      send({
        method: "Inspector.detached",
        params: { reason: "target_exited" },
      });
    });
    socket.on("close", () => {
      client.network = false;
      this.clients.delete(client);
      upstream.close();
    });
    socket.on("message", async (data) => {
      let m: any;
      try {
        m = JSON.parse(data.toString());
        if (
          [
            "Debugger.setBreakpoint",
            "Debugger.setBreakpointByUrl",
            "Debugger.removeBreakpoint",
          ].includes(m.method)
        )
          mutations.set(m.id, m);
        if (m.method.startsWith("Network.")) {
          let result: any = {};
          if (m.method === "Network.enable") {
            client.network = true;
            send({ id: m.id, result });
            for (const record of this.host.records(runtimeId))
              if (record.sessionId === client.sessionId)
                this.record(client, record, true);
            return;
          } else if (m.method === "Network.disable") client.network = false;
          else if (
            m.method === "Network.getResponseBody" ||
            m.method === "Network.getRequestPostData"
          ) {
            const id = this.originalId(m.params.requestId);
            result = await this.host.body(
              runtimeId,
              id,
              m.method === "Network.getRequestPostData",
              m.params.requestId.slice(0, m.params.requestId.indexOf(":")),
            );
          } else {
            if (
              this.targets.get(runtimeId + ":" + target)?.sessionId !==
              sessionId
            )
              throw Error("SESSION_CHANGED: select the current debug target");
            result = await this.host.network(
              runtimeId,
              m.method,
              m.params || {},
              target,
            );
          }
          send({ id: m.id, result });
          return;
        }
        if (
          target === "logic" &&
          m.method === "Runtime.evaluate" &&
          (businessContexts.has(m.params?.contextId) ||
            [...businessUniqueContexts.values()].includes(
              m.params?.uniqueContextId,
            )) &&
          !client.paused &&
          !m.params?.throwOnSideEffect
        ) {
          const result = await scheduledEvaluate(
            (method, params) =>
              this.upstreamCommand(client, method, params, true),
            m.params,
          );
          send({ id: m.id, result });
          return;
        }
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data.toString());
        else if (upstream.readyState === WebSocket.CONNECTING)
          queued.push(data.toString());
        else
          throw Error(
            "Debug target disconnected; restart or select a live target",
          );
      } catch (e: any) {
        send({ id: m?.id, error: { code: -32000, message: e.message } });
      }
    });
  }
  private protocolId(r: any) {
    return r.sessionId + ":" + r.id;
  }
  private references(c: Client, value: any): any {
    if (Array.isArray(value)) return value.map((v) => this.references(c, v));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (
          ["objectId", "callFrameId", "breakpointId"].includes(key) &&
          typeof item === "string"
        ) {
          if (key === "objectId") {
            c.objects.add(item);
            if (c.objects.size > 10000)
              c.objects.delete(c.objects.values().next().value!);
          }
          return [key, "native:" + c.id + ":" + item];
        }
        if (key === "hitBreakpoints" && Array.isArray(item))
          return [key, item.map((id) => "native:" + c.id + ":" + id)];
        return [key, this.references(c, item)];
      }),
    );
  }
  paused(runtimeId: string, target: string) {
    const c = [...this.clients].find(
      (c) => c.runtimeId === runtimeId && c.target === target && c.paused,
    );
    return c && this.references(c, c.paused);
  }
  clearPaused(runtimeId: string, target: string) {
    for (const client of this.clients)
      if (client.runtimeId === runtimeId && client.target === target)
        client.paused = undefined;
  }
  breakpoints(runtimeId: string, target: string) {
    return [...this.clients]
      .filter((c) => c.runtimeId === runtimeId && c.target === target)
      .flatMap((c) =>
        [...c.breakpoints.values()].map((bp) => this.references(c, bp)),
      );
  }
  ownsObject(runtimeId: string, target: string, objectId: string) {
    return [...this.clients].some(
      (c) =>
        c.runtimeId === runtimeId &&
        c.target === target &&
        objectId.startsWith("native:" + c.id + ":") &&
        c.objects.has(objectId.slice(c.id.length + 8)),
    );
  }
  command(runtimeId: string, target: string, method: string, params: any = {}) {
    const reference = params.objectId || params.callFrameId;
    const client = [...this.clients].find(
      (c) =>
        c.runtimeId === runtimeId &&
        c.target === target &&
        (reference ? reference.startsWith("native:" + c.id + ":") : c.paused),
    );
    if (!client || client.upstream?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        Error(
          "Native pause/remote object is no longer available; refresh debugger state",
        ),
      );
    const raw = { ...params };
    for (const key of ["objectId", "callFrameId"])
      if (raw[key]) raw[key] = raw[key].slice(client.id.length + 8);
    return this.upstreamCommand(client, method, raw);
  }
  private upstreamCommand(
    client: Client,
    method: string,
    params: any,
    rawResponse = false,
  ) {
    if (client.upstream?.readyState !== WebSocket.OPEN)
      return Promise.reject(Error("Native debug target disconnected"));
    return new Promise<any>((resolve, reject) => {
      const id = --client.nextCommand;
      const timer = rawResponse
        ? undefined
        : setTimeout(() => {
            client.commands.delete(id);
            reject(
              Error("Native debugger command timed out; it was not repeated"),
            );
          }, 10000);
      client.commands.set(id, { resolve, reject, timer, rawResponse });
      client.upstream!.send(JSON.stringify({ id, method, params }));
    });
  }
  private originalId(id: string) {
    return id.slice(id.indexOf(":") + 1);
  }
  update(runtimeId: string, record: any) {
    for (const client of this.clients)
      if (
        client.runtimeId === runtimeId &&
        client.sessionId === record.sessionId &&
        client.network
      )
        this.record(client, record, false);
  }
  private record(client: Client, r: any, historical: boolean) {
    if (client.seen.size > 5000) {
      const retain = new Set(
        this.host
          .records(client.runtimeId)
          .map((record) => this.protocolId(record)),
      );
      for (const key of client.seen.keys())
        if (!retain.has(key.replace(/:(frame|encoded|decoded|closed)$/, "")))
          client.seen.delete(key);
    }
    r = redact(r);
    const id = this.protocolId(r),
      previous = client.seen.get(id);
    const send = (method: string, params: any) => {
      if (client.socket.readyState === WebSocket.OPEN)
        client.socket.send(JSON.stringify({ method, params }));
    };
    const timestamp = Date.parse(r.startedAt) / 1000;
    const type = r.resourceType || (r.source === "view" ? "Other" : "Fetch");
    if (type === "WebSocket") {
      if (!previous)
        send("Network.webSocketCreated", {
          requestId: id,
          url: r.url,
          initiator: { type: "other" },
        });
      if (r.status && (!previous || previous === "pending")) {
        send("Network.webSocketWillSendHandshakeRequest", {
          requestId: id,
          timestamp,
          wallTime: timestamp,
          request: { headers: cdpHeaders(r.requestHeaders) },
        });
        send("Network.webSocketHandshakeResponseReceived", {
          requestId: id,
          timestamp,
          response: {
            status: r.status,
            statusText: "",
            headers: cdpHeaders(r.responseHeaders),
          },
        });
      }
      const last = Number(client.seen.get(id + ":frame") || 0);
      for (const frame of r.frames || [])
        if (frame.id > last)
          send(
            frame.direction === "sent"
              ? "Network.webSocketFrameSent"
              : "Network.webSocketFrameReceived",
            {
              requestId: id,
              timestamp: Date.parse(frame.time) / 1000,
              response: {
                opcode: frame.opcode,
                mask: frame.direction === "sent",
                payloadData: frame.payload,
              },
            },
          );
      client.seen.set(id + ":frame", String(r.frameCount || 0));
      if (r.error && previous !== "failed")
        send("Network.webSocketFrameError", {
          requestId: id,
          timestamp,
          errorMessage: r.error,
        });
      if (r.endedAt && !client.seen.has(id + ":closed")) {
        send("Network.webSocketClosed", {
          requestId: id,
          timestamp: Date.parse(r.endedAt) / 1000,
        });
        client.seen.set(id + ":closed", "true");
      }
      client.seen.set(id, r.state);
      return;
    }

    if (!previous)
      send("Network.requestWillBeSent", {
        requestId: id,
        loaderId: "",
        documentURL: r.url,
        request: {
          url: r.url,
          method: r.method,
          headers: cdpHeaders(r.requestHeaders),
          hasPostData: !!r.hasRequestBody || !!r.requestBody,
          initialPriority: "Medium",
          referrerPolicy: "no-referrer",
          ...(r.requestBodyEncoding !== "base64" && r.requestBody
            ? { postData: r.requestBody, hasPostData: true }
            : {}),
        },
        timestamp,
        wallTime: timestamp,
        type,
        initiator: r.initiator || { type: "other" },
        _wxapp: {
          source: r.source,
          historical,
          runtimeId: r.runtimeId,
          sessionId: r.sessionId,
          context: r.context,
        },
      });
    if (r.status && (!previous || previous === "pending")) {
      const headers = cdpHeaders(r.responseHeaders);
      const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
      send("Network.responseReceived", {
        requestId: id,
        loaderId: "",
        timestamp: timestamp + (r.headersMs || 0) / 1000,
        type,
        response: {
          url: r.url,
          status: r.status,
          statusText: "",
          headers,
          mimeType: r.mimeType || contentType.split(";")[0].trim() || "application/octet-stream",
          charset: r.charset || /charset=["']?([^;"']+)/i.exec(contentType)?.[1]?.trim() || "",
          connectionReused: false,
          connectionId: 0,
          encodedDataLength: r.encodedBytes || 0,
          securityState: "unknown",
          fromDiskCache: r.fromDiskCache || false,
        },
      });
    }
    const previousEncoded = Number(client.seen.get(id + ":encoded") || 0),
      previousDecoded = Number(client.seen.get(id + ":decoded") || 0);
    const encoded = r.encodedBytes || 0,
      decoded = r.decodedBytesSoFar || r.decodedBytes || 0;
    if (r.status && (encoded > previousEncoded || decoded > previousDecoded))
      send("Network.dataReceived", {
        requestId: id,
        timestamp: Date.now() / 1000,
        dataLength: Math.max(0, decoded - previousDecoded),
        encodedDataLength: Math.max(0, encoded - previousEncoded),
      });
    client.seen.set(id + ":encoded", String(encoded));
    client.seen.set(id + ":decoded", String(decoded));
    if (!["complete", "failed", "capture-error"].includes(previous || "")) {
      const end = Date.parse(r.endedAt || r.startedAt) / 1000;
      if (r.state === "complete")
        send("Network.loadingFinished", {
          requestId: id,
          timestamp: end,
          encodedDataLength: r.encodedBytes || 0,
        });
      if (r.state === "failed" || r.state === "capture-error")
        send("Network.loadingFailed", {
          requestId: id,
          timestamp: end,
          type,
          errorText: r.error || r.captureError || "Capture failed",
          canceled: r.errorName === "AbortError",
        });
    }
    client.seen.set(id, r.state);
  }
  close() {
    for (const c of this.clients) {
      c.socket.close();
      c.upstream?.close();
    }
    this.server.close();
  }
}
