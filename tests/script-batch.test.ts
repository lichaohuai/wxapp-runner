import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { ScriptBatch } from "../src/loader/script-batch";

test("a native script batch registers all factories before queued microtasks run", async () => {
  const context = vm.createContext({}),
    cache = new Map<string, Promise<void>>();
  const batch = new ScriptBatch(
    cache,
    async (file) =>
      file === "first.js"
        ? "globalThis.factories={};Promise.resolve().then(()=>globalThis.observed=Object.keys(factories));factories.first=1"
        : "factories.second=2",
    (_, source) => {
      vm.runInContext(source, context);
    },
  );
  await batch.load(["first.js", "second.js"]);
  assert.deepEqual(Array.from(context.observed), ["first", "second"]);
});

test("overlapping requests share executed files and preserve each batch's order", async () => {
  const cache = new Map<string, Promise<void>>(),
    executed: string[] = [];
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  const batch = new ScriptBatch(
    cache,
    async (file) => {
      if (file === "a") await gate;
      return file;
    },
    (file) => {
      executed.push(file);
    },
  );
  const a = batch.load(["a", "shared"]),
    b = batch.load(["shared", "b"]);
  resolve();
  await Promise.all([a, b]);
  assert.deepEqual(executed, ["a", "shared", "b"]);
});

test("read failure executes none of its fresh batch and execution failure never replays a prefix", async () => {
  const cache = new Map<string, Promise<void>>(),
    executed: string[] = [];
  const batch = new ScriptBatch(
    cache,
    async (file) => {
      if (file === "missing") throw Error("missing");
      return file;
    },
    (file) => {
      executed.push(file);
      if (file === "throws") throw Error("script failure");
    },
  );
  await assert.rejects(batch.load(["unread", "missing"]), /missing/);
  assert.deepEqual(executed, []);
  await assert.rejects(
    batch.load(["prefix", "throws", "later"]),
    /script failure/,
  );
  await assert.rejects(
    batch.load(["prefix", "throws", "later"]),
    /script failure/,
  );
  assert.deepEqual(executed, ["prefix", "throws"]);
  await batch.load(["other"]);
  assert.deepEqual(executed, ["prefix", "throws", "other"]);
});
