import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { NativeNetwork, checkNetworkAPIURL } from "../src/native-components/network";
import { debugContext } from "../src/debug/context";
async function server(handler: http.RequestListener) {
  const s = http.createServer(handler).listen(0, "127.0.0.1");
  await once(s, "listening");
  return {
    url: `http://127.0.0.1:${(s.address() as any).port}`,
    close: () => {
      s.closeAllConnections();
      s.close();
    }
  };
}
function fixture() {
  const events: any[] = [],
    buffers = new Map<number, ArrayBuffer>();
  let changed = () => {};
  const native = new NativeNetwork({
    appid: "wx" + "0000000000000001",
    appVersion: 2
  }, () => {}, id => {
    const b = buffers.get(id);
    buffers.delete(id);
    return b;
  }, (name, event) => {
    events.push({
      name,
      ...event,
      context: debugContext.getStore()
    });
    changed();
  });
  const invoke = (name: string, args: any) => JSON.parse(native.invoke(name, args, () => {
    throw Error("unexpected async reply");
  })!);
  const wait = async (id: number) => {
    const deadline = Date.now() + 3000;
    while (!events.some(e => e.requestTaskId === id && ["success", "fail"].includes(e.state))) {
      if (Date.now() > deadline) throw Error("request terminal event timeout");
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 30);
        changed = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return events.filter(e => e.requestTaskId === id);
  };
  return {
    native,
    events,
    buffers,
    invoke,
    wait
  };
}
test("native request: serialized Unicode, compressed response, exact callbacks and invocation context", async () => {
  let count = 0,
    received: any;
  const s = await server(async (req, res) => {
    count++;
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    received = {
      body: Buffer.concat(chunks).toString(),
      headers: req.headers
    };
    res.writeHead(201, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "set-cookie": ["a=1; Path=/", "b=2; Path=/"]
    });
    res.end(gzipSync(JSON.stringify({
      text: "插件中文🙂"
    })));
  });
  try {
    const t = fixture();
    const result = debugContext.run({
      operationId: "input-1",
      rootOperationId: "input-1",
      handler: "originalHandler"
    }, () => t.invoke("createRequestTask", {
      url: s.url,
      method: "POST",
      header: {
        "content-type": "application/json",
        referer: "https://wrong.example"
      },
      data: '{"input":"中文🙂"}',
      responseType: "text"
    }));
    t.invoke("listenRequestTaskStateChange", {
      taskId: result.requestTaskId,
      states: ["headersReceived"]
    });
    const events = await t.wait(result.requestTaskId);
    assert.deepEqual(events.map(e => e.state), ["headersReceived", "success"]);
    assert.equal(events[1].data, '{"text":"插件中文🙂"}');
    assert.equal(events[1].statusCode, 201);
    assert.equal(events[1].context.handler, "originalHandler");
    assert.equal(events[1].context.rootOperationId, "input-1");
    assert.equal(received.body, '{"input":"中文🙂"}');
    assert.equal(received.headers.referer, "https://servicewechat.com/" + ("wx" + "0000000000000001") + "/2/page-frame.html");
    assert.deepEqual(events[1].cookies, ["a=1; Path=/", "b=2; Path=/"]);
    assert.equal(count, 1);
    assert.equal(t.native.pendingCount, 0);
  } finally {
    s.close();
  }
});
test("native task async ID precedes binary/chunk events; no JSON corruption across VM realms", async () => {
  let received: Buffer | undefined;
  const s = await server(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    received = Buffer.concat(chunks);
    res.writeHead(200, {
      "content-type": "application/octet-stream"
    });
    res.end(Buffer.from([0, 255, 128, 1]));
  });
  try {
    const t = fixture();
    t.buffers.set(7, vm.runInNewContext("new Uint8Array([1,0,255]).buffer"));
    let id = 0;
    assert.equal(t.native.invoke("createRequestTaskAsync", {
      url: s.url,
      method: "POST",
      __nativeBuffers__: [{
        key: "data",
        id: 7
      }],
      responseType: "arraybuffer"
    }, r => {
      id = r.requestTaskId;
      assert.equal(t.events.length, 0);
    }), "");
    await new Promise<void>(queueMicrotask);
    const events = await t.wait(id);
    assert.deepEqual([...received!], [1, 0, 255]);
    assert.deepEqual([...Buffer.from(events.at(-1).__nativeBuffers__[0].base64, "base64")], [0, 255, 128, 1]);
    assert.equal(t.buffers.size, 0);
    const next = t.invoke("createRequestTask", {
      url: s.url,
      responseType: "text",
      enableChunked: true
    });
    t.invoke("listenRequestTaskStateChange", {
      taskId: next.requestTaskId,
      states: ["headersReceived", "chunked"]
    });
    const stream = await t.wait(next.requestTaskId);
    assert.equal(stream[0].state, "headersReceived");
    assert.equal(stream.at(-1).state, "success");
    assert.equal(stream.at(-1).data, undefined);
    assert.deepEqual([...Buffer.concat(stream.filter(e => e.state === "chunked").map(e => Buffer.from(e.__nativeBuffers__[0].base64, "base64")))], [0, 255, 128, 1]);
  } finally {
    s.close();
  }
});
test("abort/timeout end once, invalid tasks and arguments do not send requests", async () => {
  let count = 0;
  const s = await server(() => {
    count++;
  });
  try {
    const t = fixture();
    for (const args of [{
      url: "file:///tmp/a"
    }, {
      url: s.url,
      method: "BAD"
    }, {
      url: s.url,
      data: {
        raw: "must serialize"
      }
    }, {
      url: s.url,
      timeout: -1
    }]) assert.match(t.invoke("createRequestTask", args).errMsg, /:fail /);
    assert.equal(t.native.pendingCount, 0);
    assert.equal(count, 0);
    assert.match(t.invoke("operateRequestTask", {
      requestTaskId: 99,
      operationType: "abort"
    }).errMsg, /invalid requestTaskId/);
    const a = t.invoke("createRequestTask", {
      url: s.url
    });
    t.invoke("operateRequestTask", {
      requestTaskId: a.requestTaskId,
      operationType: "abort"
    });
    assert.deepEqual((await t.wait(a.requestTaskId)).map(e => [e.state, e.errMsg]), [["fail", "abort"]]);
    assert.equal(count, 0);
    const b = t.invoke("createRequestTask", {
      url: s.url,
      timeout: 100
    });
    assert.match(t.invoke("operateRequestTask", {
      requestTaskId: b.requestTaskId,
      operationType: "retry"
    }).errMsg, /invalid operationType/);
    const events = await t.wait(b.requestTaskId);
    assert.equal(events.length, 1);
    assert.match(events[0].errMsg, /timeout/);
    assert.equal(count, 1);
    assert.equal(t.native.pendingCount, 0);
  } finally {
    s.close();
  }
});
test("checkNetworkAPIURL reports the explicit Runner policy and PC localhost flags without DNS or authorization", () => {
  const normal = checkNetworkAPIURL({
    api: "request",
    url: "https://example.org/path"
  });
  assert.equal(normal.runnerDomainPolicy, "unrestricted-runtime");
  assert.equal(normal.isInLAN, false);
  assert.equal(normal.isLocalHost, false);
  for (const url of ["http://127.0.0.1", "http://127.2.3.4", "http://[::1]"]) assert.equal(checkNetworkAPIURL({
    api: "request",
    url
  }).isLocalHost, true);
  assert.equal(checkNetworkAPIURL({
    api: "request",
    url: "http://[::ffff:127.0.0.1]"
  }).isLocalHost, false);
  assert.equal(checkNetworkAPIURL({
    api: "request",
    url: "http://192.168.0.2"
  }).isInLAN, false);
  for (const args of [{
    api: "request",
    url: "file:///a"
  }, {
    api: "wrong",
    url: "https://example.org"
  }, {
    api: "request",
    url: "https://name:secret@example.org"
  }, {
    api: "request",
    url: "wss://example.org"
  }]) assert.throws(() => checkNetworkAPIURL(args));
});
test('context teardown drops only owned queued network work without affecting another context', async () => {
  let calls = 0;
  const s = await server((_req, res) => {
    calls++;
    res.end('alive');
  });
  const t = fixture();
  try {
    const first = debugContext.run({
      contextId: 12
    }, () => t.invoke('createRequestTask', {
      url: s.url
    }));
    const second = debugContext.run({
      contextId: 13
    }, () => t.invoke('createRequestTask', {
      url: s.url
    }));
    t.native.closeContext(12);
    const result = await t.wait(second.requestTaskId);
    assert.equal(result.at(-1)?.state, 'success');
    assert.equal(calls, 1);
    assert.equal(t.events.some(e => e.requestTaskId === first.requestTaskId), false);
  } finally {
    t.native.close();
    s.close();
  }
});
