import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { LogicInspector } from "../src/mcp/inspector";
test("CDP fragmented Unicode responses survive control frames and preserve close diagnostics", {timeout:10000}, async () => {
  const {WebSocketServer} = await import("ws");
  const server = new WebSocketServer({port:0,host:"127.0.0.1"});
  await once(server,"listening");
  const value = "中文🙂".repeat(150000);
  let invocations = 0;
  server.on("connection", socket => socket.on("message", data => {
    const call = JSON.parse(String(data));
    if (call.method !== "Runtime.evaluate") {
      socket.send(JSON.stringify({id:call.id,result:{}})); return;
    }
    invocations++;
    const bytes = Buffer.from(JSON.stringify({id:call.id,result:{result:{type:"string",value}}}));
    for(let start=0;start<bytes.length;start+=16381) {
      socket.send(bytes.subarray(start,start+16381), {binary:false,fin:start+16381>=bytes.length});
      if(start===0) socket.ping("observation");
    }
  }));
  const client = new LogicInspector();
  try {
    await client.connect(`ws://127.0.0.1:${(server.address() as any).port}`);
    const result = await client.raw("Runtime.evaluate",{expression:"fixtureInvocation()"});
    assert.equal(result.result.value,value);
    assert.equal(invocations,1);
    const closed = new Promise<any>(resolve => client.subscribe((method,p) => {
      if(method === "Inspector.detached") resolve(p);
    }));
    for(const socket of server.clients) socket.close(1012,"fixture restart");
    const event = await closed;
    assert.equal(event.closeCode,1012);
    assert.equal(event.closeReason,"fixture restart");
    assert.equal(client.isConnected,false);
    assert.equal(invocations,1);
  } finally {
    client.close();
    for(const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
test(
  "observer reconnect restores inspection without replaying evaluation",
  { timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const i=require('node:inspector');const vm=require('node:vm');globalThis.ctx=vm.createContext({}, {name:'Mini-program business 1'});vm.runInContext('globalThis.count=0',ctx);i.open(0,'127.0.0.1');console.log(i.url());setInterval(()=>{},10000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const client = new LogicInspector();
    try {
      const [data] = await once(child.stdout, "data");
      await client.connect(String(data).trim(), { reconnect: true });
      await client.command("evaluate", {
        expression:
          'eval("1\\n//# sourceURL=inline-map.js\\n//# sourceMappingURL=data:application/json;base64,"+"A".repeat(200000))',
      });
      const metadata = await client.command("state", {});
      const mapped = metadata.scripts.find(
        (s: any) => s.url === "inline-map.js",
      );
      assert.ok(mapped.sourceMapOmitted);
      assert.equal(mapped.sourceMapURL, undefined);
      assert.ok(mapped.sourceMapBytes > 200000);
      const full = await client.command("state", {
        scriptId: mapped.scriptId,
        includeSourceMaps: true,
      });
      assert.equal(full.scripts.length, 1);
      assert.ok(full.scripts[0].sourceMapURL.startsWith("data:"));
      await client.command("evaluate", { expression: "++count" });
      const restored = new Promise<void>((resolve) => {
        const off = client.subscribe((method) => {
          if (method === "Inspector.reconnected") {
            off();
            resolve();
          }
        });
      });
      (client as any).socket.close();
      await restored;
      assert.equal(
        (await client.command("evaluate", { expression: "count" })).result
          .value,
        1,
      );
      assert.equal(client.isConnected, true);
    } finally {
      client.close();
      child.kill("SIGKILL");
    }
  },
);
test(
  "inspector disconnect rejects pending operations and subsequent calls promptly",
  { timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const inspector=require('node:inspector');const vm=require('node:vm');globalThis.ctx=vm.createContext({}, {name:'Mini-program business 1'});vm.runInContext('globalThis.ready=true',ctx);inspector.open(0,'127.0.0.1');console.log(inspector.url());setInterval(()=>{},10000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const client = new LogicInspector();
    try {
      const [data] = await once(child.stdout, "data");
      client.connect(String(data).trim());
      await client.command("state", {});
      const evaluation = client.command("evaluate", {
        expression: "new Promise(()=>{})",
        awaitPromise: true,
      });
      const failed = assert.rejects(evaluation, /disconnected/);
      child.kill("SIGKILL");
      await failed;
      const start = performance.now();
      await assert.rejects(client.command("state", {}), /disconnected/);
      assert.ok(performance.now() - start < 500);
    } finally {
      client.close();
      child.kill("SIGKILL");
    }
  },
);

test("frames waitMs blocks for a late Debugger.paused event instead of racing it to paused:false", { timeout: 10000 }, async () => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const call = JSON.parse(String(data));
      socket.send(JSON.stringify({ id: call.id, result: {} }));
      if (call.method === "Debugger.pause") {
        // Simulate the real async gap: the paused event lands well after the
        // command's own reply, which is exactly what raced frames to false.
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({
                method: "Debugger.paused",
                params: {
                  reason: "other",
                  hitBreakpoints: ["bp1"],
                  callFrames: [
                    {
                      callFrameId: "cf-0",
                      functionName: "e",
                      location: { scriptId: "42", lineNumber: 814 },
                    },
                  ],
                },
              }),
            ),
          200,
        );
      }
    }),
  );
  const client = new LogicInspector();
  try {
    await client.connect(`ws://127.0.0.1:${(server.address() as any).port}`);
    // Before any pause: frames returns immediately as not-paused.
    assert.deepEqual(await client.command("frames", {}), { paused: false });
    // Trigger a pause whose event is delivered ~200ms later; do NOT await it.
    void client.raw("Debugger.pause");
    // Without waitMs a frames issued now would still race to false...
    assert.equal((await client.command("frames", {})).paused, false);
    // ...with waitMs it blocks for the event and reports the real pause.
    const waited = await client.command("frames", { waitMs: 3000 });
    assert.equal(waited.paused, true);
    assert.equal(waited.frames[0].callFrameId, "cf-0");
    assert.equal(waited.frames[0].functionName, "e");
    assert.deepEqual(waited.hitBreakpoints, ["bp1"]);
    // state also honors waitMs (already paused here, returns immediately).
    assert.ok((await client.command("state", { waitMs: 100 })).paused);
  } finally {
    client.close();
    for (const s of server.clients) s.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("source windowing returns only lines around a target line instead of the whole script", { timeout: 10000 }, async () => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const scriptSource = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const call = JSON.parse(String(data));
      socket.send(
        JSON.stringify({
          id: call.id,
          result: call.method === "Debugger.getScriptSource" ? { scriptSource } : {},
        }),
      );
    }),
  );
  const client = new LogicInspector();
  try {
    await client.connect(`ws://127.0.0.1:${(server.address() as any).port}`);
    const win = await client.command("source", { scriptId: "1", line: 5, around: 2 });
    assert.equal(win.from, 3);
    assert.equal(win.to, 7);
    assert.equal(win.totalLines, 20);
    assert.equal(win.windowed, true);
    assert.equal(win.source, "line3\nline4\nline5\nline6\nline7");
    // No line/around → whole-script behavior is unchanged (raw getScriptSource).
    const full = await client.command("source", { scriptId: "1" });
    assert.equal(full.scriptSource, scriptSource);
  } finally {
    client.close();
    for (const s of server.clients) s.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("one-shot breakpoint auto-removes on first hit so a hot-loop breakpoint pauses only once", { timeout: 10000 }, async () => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const removed: string[] = [];
  const removeSeen = new Promise<void>((resolve) => {
    server.on("connection", (socket) =>
      socket.on("message", (data) => {
        const call = JSON.parse(String(data));
        if (call.method === "Debugger.setBreakpointByUrl") {
          socket.send(
            JSON.stringify({
              id: call.id,
              result: { breakpointId: "bp-1", locations: [{ scriptId: "1", lineNumber: 0 }] },
            }),
          );
          // Fire the pause that hits it, right after the set reply.
          setTimeout(
            () =>
              socket.send(
                JSON.stringify({
                  method: "Debugger.paused",
                  params: { reason: "other", hitBreakpoints: ["bp-1"], callFrames: [{ callFrameId: "c", location: { scriptId: "1" } }] },
                }),
              ),
            30,
          );
          return;
        }
        if (call.method === "Debugger.removeBreakpoint") {
          removed.push(call.params.breakpointId);
          socket.send(JSON.stringify({ id: call.id, result: {} }));
          resolve();
          return;
        }
        socket.send(JSON.stringify({ id: call.id, result: {} }));
      }),
    );
  });
  const client = new LogicInspector();
  try {
    await client.connect(`ws://127.0.0.1:${(server.address() as any).port}`);
    await client.command("setBreakpoint", { url: "u", line: 1, once: true });
    assert.ok(client.breakpoints.has("bp-1"));
    await removeSeen; // client removed it in response to the hit
    assert.deepEqual(removed, ["bp-1"]);
    assert.equal(client.breakpoints.has("bp-1"), false);
  } finally {
    client.close();
    for (const s of server.clients) s.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("view evaluation selects the main frame by unique identity and never replays a navigation race", async () => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const calls: any[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const call = JSON.parse(String(data));
      calls.push(call);
      if (call.method === "Runtime.enable") {
        for (const [id, frameId] of [
          [1, "child"],
          [2, "main"],
        ] as const)
          socket.send(
            JSON.stringify({
              method: "Runtime.executionContextCreated",
              params: {
                context: {
                  id,
                  name: "",
                  uniqueId: "unique-" + frameId,
                  auxData: { isDefault: true, frameId },
                },
              },
            }),
          );
      }
      socket.send(
        JSON.stringify(
          call.method === "Runtime.evaluate"
            ? {
                id: call.id,
                error: { message: "Cannot find context with specified id" },
              }
            : {
                id: call.id,
                result:
                  call.method === "Page.getFrameTree"
                    ? { frameTree: { frame: { id: "main" } } }
                    : {},
              },
        ),
      );
    }),
  );
  const client = new LogicInspector();
  try {
    await client.connect(`ws://127.0.0.1:${(server.address() as any).port}`);
    await assert.rejects(
      client.command("evaluate", { viewTarget: true, expression: "++counter" }),
      (e: any) => e.code === "CONTEXT_CHANGED",
    );
    const evaluations = calls.filter((c) => c.method === "Runtime.evaluate");
    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0].params.uniqueContextId, "unique-main");
    assert.equal(evaluations[0].params.contextId, undefined);
    await assert.rejects(
      client.command("evaluate", {
        viewTarget: true,
        contextId: 999,
        expression: "++counter",
      }),
      (e: any) => e.code === "CONTEXT_CHANGED",
    );
    assert.equal(
      calls.filter((c) => c.method === "Runtime.evaluate").length,
      1,
    );
  } finally {
    client.close();
    for (const s of server.clients) s.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
