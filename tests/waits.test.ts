import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitRegistry } from "../src/mcp/waits";
import { parseTool } from "../src/mcp/tools";
import { keyChord } from "../src/mcp/gestures";
test("wait IDs are scoped to both client and runtime session", async () => {
  const registry = new WaitRegistry();
  const pending = registry.run(
    {
      waitId: "scoped",
      kind: "log",
      timeoutMs: 1000,
      _clientId: "a",
      scope: "runtime:session",
    },
    async () => ({ matched: false }),
  );
  assert.equal(registry.list("b", "runtime:session").length, 0);
  assert.equal(registry.list("a", "other:session").length, 0);
  assert.throws(() => registry.cancel("scoped", "a", "other:session"));
  registry.cancel("scoped", "a", "runtime:session");
  assert.equal((await pending).status, "cancelled");
});
test("waits match existing results, time out, cancel and release hung probes without replay", async () => {
  const registry = new WaitRegistry();
  let count = 0;
  const immediate = await registry.run(
    { kind: "network", timeoutMs: 100 },
    async () => ({ matched: true, value: ++count }),
  );
  assert.equal(immediate.status, "matched");
  assert.equal(count, 1);
  const timed = await registry.run(
    { kind: "state", timeoutMs: 20 },
    () => new Promise(() => {}),
  );
  assert.equal(timed.status, "timeout");
  const promise = registry.run(
    { kind: "text", timeoutMs: 1000, waitId: "cancel-me" },
    async () => ({ matched: false }),
  );
  assert.equal(registry.list().length, 1);
  registry.cancel("cancel-me");
  assert.equal((await promise).status, "cancelled");
  assert.equal(registry.list().length, 0);
  const controller = new AbortController();
  const wait = registry.run(
    { kind: "element", timeoutMs: 1000 },
    () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  assert.equal((await wait).status, "cancelled");
});
test("gesture and wait schemas reject invalid mixtures before dispatch", () => {
  for (const args of [
    { action: "drag", x: 1, y: 1 },
    { action: "longpress", x: 1 },
    { action: "keys" },
    { action: "scroll", deltaY: 0 },
    { action: "doubleclick", x: 1, y: 1, keys: ["A"] },
    { action: "drag", nodeId: "old", x: 1, y: 1, endX: 20, endY: 20 },
  ])
    assert.throws(() => parseTool("runner_gesture", args));
  assert.throws(() =>
    parseTool("runner_wait", { kind: "network", timeoutMs: 60001 }),
  );
  assert.throws(() => parseTool("runner_wait", { action: "cancel" }));
  assert.throws(() =>
    parseTool("runner_wait", {
      kind: "element",
      nodeId: "old",
      selector: "button",
    }),
  );
  assert.deepEqual(keyChord(["Cmd", "Shift", "A"]), {
    keyCode: "A",
    modifiers: ["meta", "shift"],
  });
  assert.throws(() => keyChord(["A", "B"]));
  assert.throws(() => keyChord(["Ctrl", "Ctrl", "A"]));
});
