import test from "node:test";
import assert from "node:assert/strict";
import { ControlQueue } from "../src/controller/control";
import { EventStore } from "../src/controller/events";
test("human takeover rejects queued writes without replaying the active operation", async () => {
  const queue = new ControlQueue();
  const actions: string[] = [];
  let release!: () => void;
  const active = queue.run("a", async () => {
    actions.push("active");
    await new Promise<void>((r) => (release = r));
  });
  await Promise.resolve();
  const waiting = queue.run("a", async () => {
    actions.push("queued");
  });
  const rejected = assert.rejects(waiting, /Manual control changed/);
  queue.manual();
  release();
  await active;
  await rejected;
  assert.deepEqual(actions, ["active"]);
  await queue.run("b", async () => {
    actions.push("new");
  });
  assert.deepEqual(actions, ["active", "new"]);
});
test("lease ownership, disconnect and expiration are enforced before writes", async () => {
  const queue = new ControlQueue();
  queue.acquire("a");
  assert.throws(() => queue.run("b", async () => {}), /Another client/);
  assert.throws(() => queue.release("b"), /Another client/);
  queue.disconnect("a");
  await queue.run("b", async () => {});
  queue.acquire("b", -1);
  assert.equal(queue.state().lease, null);
});
test("filtered event pages advance over other runtimes and report evicted cursors", () => {
  const store = new EventStore(3);
  store.push("a", "s", "logic", {});
  store.push("b", "s2", "view", {});
  store.push("a", "s", "network", {});
  store.push("b", "s2", "logic", {});
  const page = store.page({ runtimeId: "a", after: 0, limit: 1 });
  assert.equal(page.gap, true);
  assert.equal(page.nextCursor, 2);
  assert.deepEqual(page.entries, []);
  const next = store.page({ runtimeId: "a", after: page.nextCursor, limit: 1 });
  assert.equal(next.entries[0].id, 3);
  assert.equal(next.hasMore, true);
});

import { NetworkRules } from "../src/controller/rules";
test("invalid network rules fail atomically before they can affect transport", () => {
  const rules = new NetworkRules();
  for (const change of [
    { headers: { "invalid header": "x" } },
    { headers: { test: "injected\r\nx: y" } },
    { url: "file:///tmp/private" },
    { body: "%%%", bodyEncoding: "base64" },
  ]) {
    assert.throws(() =>
      rules.set(
        {
          enabled: true,
          match: { urlIncludes: "test" },
          action: "modify",
          change,
        },
        "a",
      ),
    );
    assert.equal(rules.list().rules.length, 0);
  }
  assert.throws(() =>
    rules.set(
      {
        match: { urlIncludes: "test" },
        action: "mock",
        response: { body: "%", bodyEncoding: "base64" },
      },
      "a",
    ),
  );
  assert.equal(rules.list().rules.length, 0);
});
