import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ViewNetwork } from "../src/controller/view-network";
import { ArtifactStore } from "../src/controller/artifacts";
import { NetworkRules } from "../src/controller/rules";
import { CdpRelay } from "../src/controller/cdp-relay";

function fixture(command: (method: string) => Promise<any>, limit = 65536) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-capture-"));
  const artifacts = new ArtifactStore(dir, limit),
    rows: any[] = [],
    methods: string[] = [];
  const view: any = new ViewNetwork(
    "runtime",
    "session",
    "page:1",
    artifacts,
    new NetworkRules(),
    (row) => rows.push(row),
    () => {},
    async (r) => r,
  );
  view.client.raw = async (method: string) => {
    methods.push(method);
    return command(method);
  };
  return {
    view,
    artifacts,
    rows,
    methods,
    message: (method: string, params: any = {}) =>
      view.message("Network." + method, {
        requestId: "request",
        timestamp: 2,
        ...params,
      }),
    async start(method = "GET", status = 200) {
      await this.message("requestWillBeSent", {
        timestamp: 1,
        type: "Image",
        request: { url: "https://example.test/image.png", method, headers: {} },
      });
      await this.message("responseReceived", {
        response: {
          status,
          headers: { "Content-Type": "image/png" },
          mimeType: "image/png",
          fromDiskCache: true,
        },
      });
    },
    close() {
      view.close();
      artifacts.closeSession("session");
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("empty successful stream reads Chromium retained image without a URL fetch", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 1]);
  const t = fixture(async (method) =>
    method === "Network.streamResourceContent"
      ? { bufferedData: "" }
      : { body: bytes.toString("base64"), base64Encoded: true },
  );
  try {
    await t.start();
    await t.message("dataReceived", {
      dataLength: bytes.length,
      encodedDataLength: 0,
    });
    await t.message("loadingFinished", { encodedDataLength: 0 });
    const row = t.rows.at(-1);
    assert.equal(row.mimeType, "image/png");
    assert.equal(row.state, "complete");
    assert.equal(row.responseBodyCaptureSource, "cdp-retained-response");
    assert.deepEqual(t.artifacts.bytes(row.responseArtifactId), bytes);
    assert.deepEqual(t.methods, [
      "Network.streamResourceContent",
      "Network.getResponseBody",
    ]);
    assert.deepEqual(t.artifacts.bytes(row.responseArtifactId), bytes);
  } finally {
    t.close();
  }
});

test("partial stream is replaced, never duplicated by appending the full response", async () => {
  const bytes = Buffer.from("完整图片🙂"),
    partial = bytes.subarray(0, 4);
  const t = fixture(async (method) =>
    method === "Network.streamResourceContent"
      ? { bufferedData: partial.toString("base64") }
      : { body: bytes.toString("base64"), base64Encoded: true },
  );
  try {
    await t.start();
    await t.message("dataReceived", { dataLength: bytes.length });
    const original = (t.view as any).streams.get("request").id;
    await t.message("loadingFinished");
    const row = t.rows.at(-1);
    assert.notEqual(row.responseArtifactId, original);
    assert.match(t.artifacts.info(original).error!, /superseded/);
    assert.deepEqual(t.artifacts.bytes(row.responseArtifactId), bytes);
  } finally {
    t.close();
  }
});

test("failed retained-body read marks a capture gap without retrying the resource", async () => {
  const t = fixture(async (method) => {
    if (method === "Network.streamResourceContent") return {};
    throw Error("Resource evicted");
  });
  try {
    await t.start();
    await t.message("dataReceived", { dataLength: 70 });
    await t.message("loadingFinished");
    const row = t.rows.at(-1);
    assert.equal(row.state, "complete");
    assert.equal(row.status, 200);
    assert.match(row.responseBodyUnavailable, /Resource evicted/);
    assert.match(
      t.artifacts.info(row.responseArtifactId).error!,
      /Resource evicted/,
    );
    assert.equal(t.methods.length, 2);
  } finally {
    t.close();
  }
});

test("no-content responses stay empty; complete or capture-limited streams need no fallback", async () => {
  for (const [method, status] of [
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 205],
  ] as const) {
    const t = fixture(async (method) => {
      assert.equal(method, "Network.streamResourceContent");
      return {};
    });
    try {
      await t.start(method, status);
      await t.message("loadingFinished");
      assert.equal(t.methods.length, 1);
      assert.equal(t.artifacts.info(t.rows.at(-1).responseArtifactId).bytes, 0);
    } finally {
      t.close();
    }
  }
  const bytes = Buffer.alloc(256, 7);
  const t = fixture(async (method) => {
    assert.equal(method, "Network.streamResourceContent");
    return { bufferedData: bytes.toString("base64") };
  }, 64);
  try {
    await t.start();
    await t.message("dataReceived", { dataLength: 256 });
    await t.message("loadingFinished");
    assert.equal(t.methods.length, 1);
    assert.equal(
      t.artifacts.info(t.rows.at(-1).responseArtifactId).truncated,
      true,
    );
  } finally {
    t.close();
  }
});

test("stream refusal falls back, while an inconsistent retained body is not declared complete", async () => {
  const t = fixture(async (method) => {
    if (method === "Network.streamResourceContent")
      throw Error("not supported");
    return { body: "", base64Encoded: true };
  });
  try {
    await t.start();
    await t.message("dataReceived", { dataLength: 50 });
    await t.message("loadingFinished");
    const row = t.rows.at(-1);
    assert.equal(row.streamingCaptureUnavailable, true);
    assert.match(row.responseBodyUnavailable, /fewer response bytes/);
  } finally {
    t.close();
  }
});

test("closing the observer while retained-body read is pending cannot append or publish success", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const t = fixture(async (method) =>
    method === "Network.streamResourceContent" ? {} : pending,
  );
  try {
    await t.start();
    const completion = t.message("loadingFinished");
    await new Promise((r) => setImmediate(r));
    t.view.close();
    resolve({ body: "AAAA", base64Encoded: true });
    await completion;
    assert.equal(t.rows.at(-1).state, "headers");
    assert.ok(
      t.artifacts.list().every((a) => a.complete && a.error && a.bytes === 0),
    );
  } finally {
    t.close();
  }
});

test("native F12 HTTP relay respects header casing and Chromium's resolved MIME", () => {
  const relay: any = new CdpRelay({
    records: () => [],
    body: () => ({}),
    network: async () => ({}),
    human: () => {},
  });
  for (const headers of [
    { "Content-Type": "image/png" },
    { "CONTENT-TYPE": "image/png" },
    { "content-type": "image/png" },
  ]) {
    const events: any[] = [];
    const client = {
      seen: new Map(),
      socket: {
        readyState: 1,
        send: (s: string) => events.push(JSON.parse(s)),
      },
    };
    const r = {
      id: "one",
      sessionId: "s",
      runtimeId: "r",
      source: "view",
      resourceType: "Image",
      url: "https://example.test/image",
      method: "GET",
      status: 200,
      state: "complete",
      startedAt: new Date().toISOString(),
      responseHeaders: headers,
    };
    relay.record(client, r, true);
    assert.equal(
      events.find((e) => e.method === "Network.responseReceived").params
        .response.mimeType,
      "image/png",
    );
  }
  const events: any[] = [];
  relay.record(
    {
      seen: new Map(),
      socket: {
        readyState: 1,
        send: (s: string) => events.push(JSON.parse(s)),
      },
    },
    {
      id: "two",
      sessionId: "s",
      status: 200,
      state: "complete",
      startedAt: new Date().toISOString(),
      responseHeaders: { "Content-Type": "application/octet-stream" },
      mimeType: "image/webp",
      charset: "utf-8",
    },
    true,
  );
  assert.equal(
    events.find((e) => e.method === "Network.responseReceived").params.response
      .mimeType,
    "image/webp",
  );
});
