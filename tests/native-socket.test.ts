import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import vm from "node:vm";
import { NativeSocket } from "../src/native-components/socket";
import { socketApis } from "../src/wx-shim/socket";
import { debugContext } from "../src/debug/context";
import { NetworkRules } from "../src/controller/rules";

async function until<T>(fn: () => T, timeout = 4000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("condition timeout");
}
async function fixture(config: any = {}) {
  const events: any[] = [],
    records = new Map<string, any>(),
    requests: any[] = [],
    frames: Buffer[] = [],
    buffers = new Map<number, ArrayBuffer>(),
    artifacts = new Map<string, Buffer>();
  const connections = new Set<any>(),
    rawSockets = new Set<any>();
  const httpServer = http.createServer(),
    server = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  httpServer.on("connection", (s) => {
    rawSockets.add(s);
    s.on("close", () => rawSockets.delete(s));
  });
  httpServer.on("upgrade", (req, socket, head) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === "/reject") {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nX-Rejected: yes\r\n\r\n",
      );
      return;
    }
    if (req.url === "/timeout") return;
    server.handleUpgrade(req, socket, head, (ws) =>
      server.emit("connection", ws, req),
    );
  });
  server.on("connection", (ws, req) => {
    connections.add(ws);
    ws.on("close", () => connections.delete(ws));
    ws.send("ready:" + req.url);
    ws.on("message", (data, binary) => {
      frames.push(Buffer.from(data as any));
      ws.send(data, { binary });
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(httpServer.address() as any).port}`;
  const native = new NativeSocket(
    {
      ...config,
      emitNetwork: (r: any) => records.set(r.id, r),
      captureSocketFrame: async (bytes: Buffer) => {
        const id = "frame-" + artifacts.size;
        artifacts.set(id, Buffer.from(bytes));
        return id;
      },
    },
    (id) => {
      const b = buffers.get(id);
      buffers.delete(id);
      return b;
    },
    (name, e) => events.push({ name, ...e, context: debugContext.getStore() }),
  );
  const invoke = (name: string, args: any) =>
    JSON.parse(
      native.invoke(name, args, () => {
        throw Error("expected sync");
      })!,
    );
  const operate = (args: any) =>
    new Promise<any>((resolve) => {
      const result = native.invoke("operateSocketTask", args, resolve);
      if (result) resolve(JSON.parse(result));
    });
  const forTask = (id: number) => events.filter((e) => e.socketTaskId === id);
  return {
    native,
    events,
    records,
    requests,
    frames,
    buffers,
    artifacts,
    url,
    invoke,
    operate,
    forTask,
    async close() {
      native.close();
      for (const s of rawSockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

test("native SocketTask: ID precedes events, protocol/headers and text/native buffers preserve wire bytes", async () => {
  const t = await fixture();
  try {
    const r = debugContext.run(
      { operationId: "connect-op", handler: "originalConnect" },
      () =>
        t.invoke("createSocketTask", {
          url: t.url + "/echo",
          header: { "x-fixture": "header-value" },
          protocols: ["wx-fixture"],
        }),
    );
    const id = r.socketTaskId;
    assert.equal(t.events.length, 0);
    await until(() => t.forTask(id).find((e) => e.state === "message"));
    const opened = t.forTask(id).find((e) => e.state === "open");
    assert.equal(opened.statusCode, 101);
    assert.equal(opened.protocol, "wx-fixture");
    assert.equal(opened.context.handler, "originalConnect");
    let result = await debugContext.run(
      { operationId: "send-op", handler: "originalSend" },
      () =>
        t.operate({ socketTaskId: id, operationType: "send", data: "中文🙂" }),
    );
    assert.equal(result.errMsg, "operateSocketTask:ok");
    t.buffers.set(
      1,
      vm.runInNewContext("new Uint8Array([0,255,128,1]).buffer"),
    );
    result = await t.operate({
      socketTaskId: id,
      operationType: "send",
      __nativeBuffers__: [{ key: "data", id: 1 }],
    });
    assert.equal(result.errMsg, "operateSocketTask:ok");
    await until(
      () => t.forTask(id).filter((e) => e.state === "message").length === 3,
    );
    assert.equal(t.forTask(id)[2].data, "中文🙂");
    assert.deepEqual(
      [...Buffer.from(t.forTask(id)[3].__nativeBuffers__[0].base64, "base64")],
      [0, 255, 128, 1],
    );
    assert.equal(t.buffers.size, 0);
    assert.equal(t.frames[0].toString(), "中文🙂");
    const record = [...t.records.values()][0];
    assert.equal(record.requestHeadersObserved, true);
    assert.equal(record.requestHeaders["sec-websocket-protocol"], "wx-fixture");
    assert.equal(
      record.requestHeaders["sec-websocket-key"],
      t.requests[0].headers["sec-websocket-key"],
    );
    assert.equal(record.context.nativeApi, "createSocketTask");
    assert.equal(
      record.frames.find((e: any) => e.direction === "sent").context.handler,
      "originalSend",
    );
    const message = t.forTask(id).find((e) => e.state === "message");
    assert.equal(message.context.handler, undefined);
    assert.equal(message.context.connectionOperationId, "connect-op");
    const close = await t.operate({
      socketTaskId: id,
      operationType: "close",
      code: 3001,
      reason: "正常结束",
    });
    assert.equal(close.errMsg, "operateSocketTask:ok");
    await until(() => t.forTask(id).find((e) => e.state === "close"));
    assert.equal(t.forTask(id).at(-1).code, 3001);
    assert.equal(t.forTask(id).at(-1).reason, "正常结束");
    assert.equal(t.native.pendingCount, 0);
    assert.match(
      (
        await t.operate({
          socketTaskId: id,
          operationType: "send",
          data: "late",
        })
      ).errMsg,
      /invalid socketTaskId/,
    );
  } finally {
    await t.close();
  }
});

test("invalid socket parameters cannot open a connection or alter a live task; immediate close does not connect", async () => {
  const t = await fixture();
  try {
    for (const args of [
      { url: "https://example.org" },
      { url: t.url + "/#fragment" },
      { url: t.url, timeout: -1 },
      { url: t.url, protocols: ["a", "a"] },
      { url: t.url, header: { bad: "value\r\nx: bad" } },
    ])
      assert.match(t.invoke("createSocketTask", args).errMsg, /:fail /);
    assert.equal(t.native.pendingCount, 0);
    assert.equal(t.requests.length, 0);
    const id = t.invoke("createSocketTask", { url: t.url }).socketTaskId;
    assert.match(
      (
        await t.operate({
          socketTaskId: id,
          operationType: "send",
          data: "early",
        })
      ).errMsg,
      /not open/,
    );
    assert.match(
      (
        await t.operate({
          socketTaskId: id,
          operationType: "close",
          code: 1004,
        })
      ).errMsg,
      /Invalid WebSocket close code/,
    );
    assert.match(
      (
        await t.operate({
          socketTaskId: id,
          operationType: "close",
          reason: "中".repeat(42),
        })
      ).errMsg,
      /123/,
    );
    assert.match(
      (await t.operate({ socketTaskId: id, operationType: "retry" })).errMsg,
      /invalid operationType/,
    );
    await t.operate({ socketTaskId: id, operationType: "close" });
    await until(() => t.forTask(id).find((e) => e.state === "close"));
    // An asynchronous operating call allows the connect microtask to run. The
    // server may see a handshake, but no send or automatic retry is permitted.
    assert.equal(t.frames.length, 0);
    assert.ok(t.requests.length <= 1);
    const before = t.requests.length,
      id2 = t.invoke("createSocketTask", { url: t.url }).socketTaskId;
    const closed = t.operate({ socketTaskId: id2, operationType: "close" });
    await closed;
    await until(() => t.forTask(id2).find((e) => e.state === "close"));
    assert.equal(t.requests.length, before);
  } finally {
    await t.close();
  }
});

test("handshake failure and timeout emit error then close exactly once, release tasks and retain diagnostics", async () => {
  const t = await fixture();
  try {
    for (const endpoint of ["/reject", "/timeout"]) {
      const id = t.invoke("createSocketTask", {
        url: t.url + endpoint,
        timeout: 100,
      }).socketTaskId;
      await until(() => t.forTask(id).find((e) => e.state === "close"));
      const events = t.forTask(id);
      assert.deepEqual(
        events.map((e) => e.state),
        ["error", "close"],
      );
      assert.equal(t.native.pendingCount, 0);
      if (endpoint === "/timeout") {
        assert.equal(events[0].code, 1004);
        assert.match(events[0].errMsg, /timed out/);
      } else {
        assert.match(events[0].errMsg, /403/);
        const r = [...t.records.values()].find((r) => r.url.endsWith(endpoint));
        assert.equal(r.status, 403);
        assert.equal(r.responseHeaders["x-rejected"], "yes");
      }
    }
    assert.equal(t.requests.length, 2);
  } finally {
    await t.close();
  }
});

test("public listeners survive callback exceptions; large frames have repeatable artifacts and bounded previews", async () => {
  const t = await fixture();
  const records: any[] = [];
  const api = socketApis((r) => records.push(r));
  try {
    const task = api.api.connectSocket({ url: t.url });
    task.onMessage(() => {
      throw Error("test listener");
    });
    const greeting = await new Promise<any>((r) => task.onMessage(r));
    assert.equal(greeting.data, "ready:/");
    const next = new Promise<any>((r) => task.onMessage(r));
    let success = 0,
      complete = 0;
    task.send({
      data: "public中文",
      success() {
        success++;
        throw Error("test success");
      },
      complete() {
        complete++;
      },
    });
    assert.equal((await next).data, "public中文");
    assert.equal(success, 1);
    assert.equal(complete, 1);
    const id = t.invoke("createSocketTask", { url: t.url }).socketTaskId;
    await until(() => t.forTask(id).find((e) => e.state === "open"));
    await t.operate({
      socketTaskId: id,
      operationType: "send",
      data: "🙂".repeat(1000),
    });
    await until(() =>
      [...t.records.values()].some((r) =>
        r.frames.some(
          (f: any) =>
            f.bytes === 4000 && f.direction === "received" && f.artifactId,
        ),
      ),
    );
    const record = [...t.records.values()][0],
      frame = record.frames.find(
        (f: any) => f.bytes === 4000 && f.direction === "received",
      );
    assert.equal(frame.truncated, true);
    assert.ok(Buffer.byteLength(frame.payload) <= 2048);
    assert.equal(
      t.artifacts.get(frame.artifactId)!.toString(),
      "🙂".repeat(1000),
    );
    assert.deepEqual(
      t.artifacts.get(frame.artifactId),
      t.artifacts.get(frame.artifactId),
    );
  } finally {
    api.close();
    await t.close();
  }
});

test("socket policy honors analysis local-only and offline before handshake; disposal prevents late connection", async () => {
  const rules = new NetworkRules();
  rules.experimentMode = "local-only";
  assert.equal(rules.socketPolicy("wss://example.org").allowed, false);
  assert.equal(rules.socketPolicy("ws://localhost:80").allowed, false);
  assert.equal(rules.socketPolicy("ws://127.0.0.1:80").allowed, true);
  rules.conditions.offline = true;
  const t = await fixture({
    checkSocketURL: async (url: string) => rules.socketPolicy(url),
  });
  try {
    const id = t.invoke("createSocketTask", { url: t.url }).socketTaskId;
    await until(() => t.forTask(id).find((e) => e.state === "close"));
    assert.match(t.forTask(id)[0].errMsg, /offline/);
    assert.equal(t.requests.length, 0);
    let release: any;
    const backend = socketApis(() => {}, {
      checkURL: () => new Promise((r) => (release = r)),
    });
    const socket = backend.api.connectSocket({ url: t.url });
    const closed = new Promise<any>((r) => socket.onClose(r));
    await until(() => release);
    backend.close();
    release({ allowed: true });
    await closed;
    assert.equal(t.requests.length, 0);
  } finally {
    await t.close();
  }
});

test("native F12 relay sends socket close after error once and replays completed history without duplicate frames", async () => {
  const { CdpRelay } = await import("../src/controller/cdp-relay");
  const sent: any[] = [];
  const relay: any = new CdpRelay({
    records: () => [],
    body: () => ({}),
    network: async () => ({}),
    human: () => {},
  });
  const client: any = {
    seen: new Map(),
    socket: {
      readyState: 1,
      send: (json: string) => sent.push(JSON.parse(json)),
    },
  };
  const base: any = {
    id: "s",
    sessionId: "session",
    runtimeId: "r",
    resourceType: "WebSocket",
    source: "logic",
    url: "ws://127.0.0.1",
    startedAt: new Date().toISOString(),
    frameCount: 0,
  };
  relay.record(client, { ...base, state: "pending" }, false);
  relay.record(
    client,
    { ...base, state: "failed", error: "Handshake failed" },
    false,
  );
  const closed = {
    ...base,
    state: "failed",
    error: "Handshake failed",
    endedAt: new Date().toISOString(),
  };
  relay.record(client, closed, false);
  relay.record(client, closed, false);
  assert.equal(
    sent.filter((e) => e.method === "Network.webSocketFrameError").length,
    1,
  );
  assert.equal(
    sent.filter((e) => e.method === "Network.webSocketClosed").length,
    1,
  );
  const historical: any = { seen: new Map(), socket: client.socket };
  const record = {
    ...base,
    state: "complete",
    status: 101,
    requestHeaders: {
      "X-WECHAT-HOSTSIGN": "local-test-secret",
      "sec-websocket-version": 13,
    },
    responseHeaders: {
      "x-multi": ["one", "two"],
      "set-cookie": ["one=1", "two=2"],
    },
    endedAt: new Date().toISOString(),
    frameCount: 1,
    frames: [
      {
        id: 1,
        direction: "received",
        opcode: 1,
        payload: "中文🙂",
        time: base.startedAt,
      },
    ],
  };
  relay.record(historical, record, true);
  relay.record(historical, record, false);
  assert.equal(
    sent.filter((e) => e.method === "Network.webSocketFrameReceived").length,
    1,
  );
  assert.equal(
    sent.filter((e) => e.method === "Network.webSocketClosed").length,
    2,
  );
  assert.equal(
    sent.find((e) => e.method === "Network.webSocketWillSendHandshakeRequest")
      .params.request.headers["X-WECHAT-HOSTSIGN"],
    "[REDACTED]",
  );
  assert.equal(
    sent.find((e) => e.method === "Network.webSocketWillSendHandshakeRequest")
      .params.request.headers["sec-websocket-version"],
    "13",
  );
  assert.equal(
    sent.find((e) => e.method === "Network.webSocketHandshakeResponseReceived")
      .params.response.headers["x-multi"],
    "one\ntwo",
  );
  await relay.close();
});
