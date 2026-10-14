import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import {
  NativeRealtimeData,
  captureRealtimeData,
  realtimeContentLimit,
} from "../src/native-components/realtime-data";
import { debugContext } from "../src/debug/context";
import { EventStore } from "../src/controller/events";
import { ArtifactStore } from "../src/controller/artifacts";

const envelope = (id = 7) => ({
  id,
  type: 1001,
  priority: "low",
  content: '{"message":"实时中文🙂"}',
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

test("realtime receipt follows retention; response is separate and preserves original context", async () => {
  const saved = deferred<{ eventId: number }>();
  const records: any[] = [],
    calls: any[] = [];
  const n = new NativeRealtimeData(
    async (r) => {
      records.push(r);
      return saved.promise;
    },
    (name, value) =>
      calls.push({ name, value, context: debugContext.getStore() }),
  );
  debugContext.run(
    { contextId: 3, operationId: "tap-a", handler: "submit" },
    () => {
      assert.equal(
        n.invoke("other", {}, () => {}),
        undefined,
      );
      assert.equal(
        n.invoke("operateRealtimeData", envelope(), (value) =>
          calls.push({ name: "reply", value }),
        ),
        "",
      );
      assert.equal(calls.length, 0);
    },
  );
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(records[0].contentBytes, Buffer.byteLength(envelope().content));
  assert.equal(records[0].uploaded, false);
  saved.resolve({ eventId: 91 });
  await tick();
  await tick();
  assert.deepEqual(
    calls.map((c) => c.name),
    ["reply", "onRealtimeDataResponse"],
  );
  assert.equal(calls[0].value.errMsg, "operateRealtimeData:ok");
  assert.deepEqual(calls[1].value, {
    errcode: 0,
    idList: [7],
    runnerDisposition: "local-only",
    uploaded: false,
    runnerEventId: 91,
  });
  assert.equal(calls[1].context.operationId, "tap-a");
  assert.equal(n.pendingCount, 0);
});

test("invalid envelopes and queue overflow produce no recording side effects", async () => {
  let writes = 0;
  const n = new NativeRealtimeData(
    async () => {
      writes++;
      return new Promise(() => {});
    },
    () => {},
    1000,
    1,
  );
  for (const bad of [
    null,
    {},
    { ...envelope(), id: -1 },
    { ...envelope(), type: 1.2 },
    { ...envelope(), content: {} },
    { ...envelope(), priority: "urgent" },
    {
      ...envelope(),
      content: "中".repeat(Math.ceil(realtimeContentLimit / 3)),
    },
  ]) {
    const result = JSON.parse(
      n.invoke("operateRealtimeData", bad, () =>
        assert.fail("async callback"),
      )!,
    );
    assert.match(result.errMsg, /:fail/);
  }
  assert.equal(writes, 0);
  n.invoke("operateRealtimeData", envelope(), () => {});
  assert.equal(
    JSON.parse(n.invoke("operateRealtimeData", envelope(8), () => {})!)
      .runnerCode,
    "REALTIME_CAPACITY",
  );
  await tick();
  assert.equal(writes, 1);
  n.close();
  assert.equal(n.pendingCount, 0);
});

test("recorder failure has one failure callback and no success event", async () => {
  const calls: any[] = [];
  const n = new NativeRealtimeData(
    async () => {
      throw Error("disk full");
    },
    () => calls.push("event"),
  );
  n.invoke("operateRealtimeData", envelope(), (value) => calls.push(value));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runnerCode, "REALTIME_RECORD_FAILED");
  assert.equal(n.pendingCount, 0);
});

test("late sink receipt after timeout is not replayed or delivered", async () => {
  const saved = deferred<{ eventId: number }>(),
    replied = deferred<any>();
  let writes = 0,
    replies = 0,
    events = 0;
  const n = new NativeRealtimeData(
    async () => {
      writes++;
      return saved.promise;
    },
    () => {
      events++;
    },
    20,
  );
  n.invoke("operateRealtimeData", envelope(), (value) => {
    replies++;
    replied.resolve(value);
  });
  assert.equal((await replied.promise).runnerCode, "REALTIME_TIMEOUT");
  saved.resolve({ eventId: 1 });
  await tick();
  await tick();
  assert.deepEqual(
    { writes, replies, events, pending: n.pendingCount },
    { writes: 1, replies: 1, events: 0, pending: 0 },
  );
});

test("closing a context suppresses only its own callbacks, even for duplicate SDK ids", async () => {
  const receipts = [
    deferred<{ eventId: number }>(),
    deferred<{ eventId: number }>(),
  ];
  const replies: number[] = [],
    events: any[] = [];
  let seq = 0;
  const n = new NativeRealtimeData(
    () => receipts[seq++].promise,
    (name, value) => events.push(value),
  );
  for (const contextId of [1, 2])
    debugContext.run({ contextId }, () =>
      n.invoke("operateRealtimeData", envelope(), () =>
        replies.push(contextId),
      ),
    );
  await tick();
  n.closeContext(1);
  receipts[0].resolve({ eventId: 1 });
  receipts[1].resolve({ eventId: 2 });
  await tick();
  await tick();
  assert.deepEqual(replies, [2]);
  assert.equal(events.length, 1);
  assert.equal(events[0].runnerEventId, 2);
  n.close();
  assert.equal(
    JSON.parse(n.invoke("operateRealtimeData", envelope(), () => {})!)
      .runnerCode,
    "REALTIME_CLOSED",
  );
});

test("callback close or throw never causes a duplicate callback or late event", async () => {
  for (const throws of [true, false]) {
    let replies = 0,
      events = 0;
    const n = new NativeRealtimeData(
      async () => ({ eventId: 1 }),
      () => {
        events++;
      },
    );
    n.invoke("operateRealtimeData", envelope(), () => {
      replies++;
      if (throws) throw Error("callback throws");
      n.close();
    });
    await tick();
    await tick();
    assert.deepEqual(
      { replies, events, pending: n.pendingCount },
      { replies: 1, events: 0, pending: 0 },
    );
  }
});

test("all confirmed native telemetry types retain opaque contents and priority", async () => {
  const rows: any[] = [];
  const n = new NativeRealtimeData(
    async (r) => {
      rows.push(r);
      return { eventId: rows.length };
    },
    () => {},
  );
  for (const type of [1000, 1001, 1002, 1004, 1005, 9999])
    for (const priority of ["low", "high", "immediate"])
      n.invoke(
        "operateRealtimeData",
        { ...envelope(type), type, priority, content: "non-json" },
        () => {},
      );
  await tick();
  await tick();
  assert.equal(rows.length, 18);
  assert.equal(rows.filter((r) => r.realtimeType === 1005).length, 3);
  assert.ok(
    rows.every(
      (r) => r.content === "non-json" && r.runnerDisposition === "local-only",
    ),
  );
});

test("shared event/artifact cache preserves IDs, Unicode, repeatable redaction and eviction gaps", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realtime-data-"));
  const artifacts = new ArtifactStore(dir),
    events = new EventStore(2);
  const bodies: string[] = [],
    recorded: any[] = [];
  try {
    const n = new NativeRealtimeData(
      async (record) =>
        captureRealtimeData(
          record,
          (content) => {
            const id = artifacts.put(
              {
                runtimeId: "r",
                sessionId: "s",
                kind: "body",
                mimeType: "text/plain",
                representation: "realtime-data",
              },
              Buffer.from(content),
            );
            bodies.push(id);
            return id;
          },
          (detail) => {
            recorded.push(detail);
            return events.push("r", "s", "realtime", detail);
          },
        ),
      () => {},
    );
    n.invoke(
      "operateRealtimeData",
      {
        ...envelope(),
        content: JSON.stringify({
          token: "private-fixture",
          message: "中文🙂".repeat(2500),
        }),
      },
      () => {},
    );
    await tick();
    await tick();
    assert.equal(recorded[0].contentOmitted, true);
    assert.equal(recorded[0].content, undefined);
    assert.equal(recorded[0].contentArtifactId, bodies[0]);
    const a = artifacts.read(bodies[0]),
      b = artifacts.read(bodies[0]);
    assert.deepEqual(a, b);
    assert.ok("data" in a);
    assert.equal(
      JSON.parse(Buffer.from(a.data, "base64").toString()).token,
      "[REDACTED]",
    );
    const raw = artifacts.read(bodies[0], 0, 262144, true);
    assert.ok("data" in raw);
    assert.equal(
      JSON.parse(Buffer.from(raw.data, "base64").toString()).token,
      "private-fixture",
    );
    for (let id = 8; id <= 10; id++)
      n.invoke(
        "operateRealtimeData",
        { ...envelope(id), content: '{"token":"private-fixture"}' },
        () => {},
      );
    await tick();
    await tick();
    const page = events.page({ source: "realtime" });
    assert.equal(page.gap, true);
    assert.deepEqual(
      page.entries.map((e) => e.realtimeId),
      [9, 10],
    );
    assert.equal(JSON.parse(page.entries[0].content).token, "[REDACTED]");
  } finally {
    artifacts.closeSession("s");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
