import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gzipSync,
  deflateSync,
  deflateRawSync,
  brotliCompressSync,
} from "node:zlib";
import { installInspectorCompatibility } from "../src/inspector-compat";

function fixture() {
  const events: { name: string; params: any }[] = [];
  const network: any = Object.fromEntries(
    [
      "requestWillBeSent",
      "responseReceived",
      "dataReceived",
      "loadingFinished",
      "loadingFailed",
    ].map((name) => [name, (params: any) => events.push({ name, params })]),
  );
  const restore = installInspectorCompatibility(network);
  const response = (requestId: string, headers: any) =>
    network.responseReceived({
      requestId,
      timestamp: 1,
      type: "Fetch",
      response: { headers, status: 200 },
    });
  const chunk = (requestId: string, data: Buffer) =>
    network.dataReceived({
      requestId,
      timestamp: 2,
      data,
      dataLength: data.length,
      encodedDataLength: data.length,
    });
  const finish = (requestId: string) =>
    network.loadingFinished({ requestId, timestamp: 3 });
  const body = (id: string) =>
    Buffer.concat(
      events
        .filter(
          (e) =>
            e.name === "dataReceived" &&
            e.params.requestId === id &&
            e.params.data,
        )
        .map((e) => e.params.data),
    );
  const done = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const event = events.find(
        (e) =>
          /loadingFinished|loadingFailed/.test(e.name) &&
          e.params.requestId === id,
      );
      if (event) return event;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error("inspector terminal event missing");
  };
  return { network, events, restore, response, chunk, finish, body, done };
}

test("native inspector normalizes textual UTF-8 metadata without mutating wire headers", () => {
  const f = fixture();
  try {
    for (const type of [
      "application/json",
      "application/problem+json",
      "application/x-www-form-urlencoded",
      "text/plain; charset=UTF8",
      "application/json; charset=UTF-8",
    ]) {
      const headers = Object.freeze({ "Content-Type": type });
      const params = Object.freeze({
        requestId: type,
        request: Object.freeze({ headers }),
      });
      f.network.requestWillBeSent(params);
      assert.equal(f.events.at(-1)?.params.charset, "utf-8");
      assert.equal(f.events.at(-1)?.params.request, params.request);
      f.response(type, headers);
      assert.equal(f.events.at(-1)?.params.response.charset, "utf-8");
      assert.equal(f.events.at(-1)?.params.response.headers, headers);
    }
    for (const type of [
      "application/octet-stream",
      "multipart/form-data; boundary=test",
      "text/plain; charset=unknown-charset",
    ]) {
      f.network.requestWillBeSent({
        request: { headers: { "content-type": type } },
      });
      assert.equal(f.events.at(-1)?.params.charset, undefined);
    }
  } finally {
    f.restore();
  }
});

test("concurrent chunked gzip, deflate, raw-deflate, br and stacked responses decode before native completion", async () => {
  const f = fixture();
  const text = Buffer.from('{"message":"中文响应😀 café"}');
  const cases = [
    ["gzip", gzipSync(text)],
    ["deflate", deflateSync(text)],
    ["deflate", deflateRawSync(text)],
    ["br", brotliCompressSync(text)],
    ["gzip, br", brotliCompressSync(gzipSync(text))],
  ] as const;
  try {
    for (const [i, [encoding, bytes]] of cases.entries()) {
      const id = String(i);
      f.response(id, {
        "content-type": "application/json",
        "content-encoding": encoding,
      });
      for (let start = 0; start < bytes.length; start += 3)
        f.chunk(id, bytes.subarray(start, start + 3));
      f.finish(id);
    }
    for (const [i, [, bytes]] of cases.entries()) {
      const id = String(i);
      assert.equal((await f.done(id)).name, "loadingFinished");
      assert.deepEqual(f.body(id), text);
      const events = f.events.filter((e) => e.params.requestId === id);
      assert.equal(events.at(-1)?.name, "loadingFinished");
      assert.equal(
        events
          .filter((e) => e.name === "dataReceived")
          .reduce((n, e) => n + e.params.encodedDataLength, 0),
        bytes.length,
      );
    }
  } finally {
    f.restore();
  }
});

test("binary response bytes remain binary; explicit legacy text charset is transcoded only for inspector", async () => {
  const f = fixture();
  try {
    const binary = Buffer.from([0, 255, 128, 193, 0]);
    f.response("binary", {
      "content-type": "application/octet-stream",
      "content-encoding": "gzip",
    });
    f.chunk("binary", gzipSync(binary));
    f.finish("binary");
    await f.done("binary");
    assert.deepEqual(f.body("binary"), binary);
    assert.equal(
      f.events.find((e) => e.name === "responseReceived")?.params.response
        .charset,
      undefined,
    );
    f.response("gbk", { "content-type": "text/plain; charset=GBK" });
    const original = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    f.chunk("gbk", original.subarray(0, 1));
    f.chunk("gbk", original.subarray(1));
    f.finish("gbk");
    await f.done("gbk");
    assert.equal(f.body("gbk").toString(), "中文");
    assert.equal(original.toString("hex"), "d6d0cec4");
  } finally {
    f.restore();
  }
});

test("empty compressed response is valid; damaged/oversized data fails debugging explicitly; abort cancels delayed completion", async () => {
  const f = fixture();
  try {
    f.response("empty", { "content-encoding": "gzip" });
    f.finish("empty");
    assert.equal((await f.done("empty")).name, "loadingFinished");
    assert.equal(f.body("empty").length, 0);
    for (const [id, bytes] of [
      ["damaged", Buffer.from("not gzip")],
      ["large", gzipSync(Buffer.alloc(33 * 1024 * 1024))],
    ] as const) {
      f.response(id, { "content-encoding": "gzip" });
      f.chunk(id, bytes);
      f.finish(id);
      const event = await f.done(id);
      assert.equal(event.name, "loadingFailed");
      assert.match(event.params.errorText, /business request unchanged/);
      assert.equal(f.body(id).length, 0);
    }
    f.response("abort", { "content-encoding": "gzip" });
    f.chunk("abort", gzipSync(Buffer.from("discard me")));
    f.finish("abort");
    f.network.loadingFailed({
      requestId: "abort",
      type: "Fetch",
      errorText: "aborted",
      timestamp: 4,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      f.events.filter(
        (e) => /loading/.test(e.name) && e.params.requestId === "abort",
      ).length,
      1,
    );
    assert.equal(f.body("abort").length, 0);
  } finally {
    f.restore();
  }
});
