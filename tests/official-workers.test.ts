import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OfficialWorkers } from "../src/loader/workers";

// This fixture exercises the unchanged official manager over a real thread.
// The window smoke separately runs WAWorker and real compiled business modules.
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-worker-contract-"));
  const bootstrap = path.join(dir, "port.cjs");
  fs.writeFileSync(
    bootstrap,
    `const {parentPort:p}=require('node:worker_threads');
    p.postMessage({kind:'inspector',url:'fixture://inspector'});
    p.on('message',m=>{
      if(m.kind==='continue')p.postMessage({kind:'ready'});
      if(m.kind==='message'&&m.data.cmd==='msg')p.postMessage({kind:'message',data:{cmd:'msg',data:m.data.data}});
    });`,
  );
  fs.writeFileSync(path.join(dir, "business.js"), "");
  const messages: any[] = [],
    events: any[] = [],
    inspectors = new Set<number>();
  const callbacks = {
    workerMsgHandler(id: number, message: any) {
      messages.push({ id, message });
    },
    errorHandler(error: any) {
      events.push({ name: "api-error", error });
    },
  };
  const workers = new OfficialWorkers({
    baselibDir: path.resolve("../baselib"),
    packageDir: dir,
    bootstrap,
    config: {},
    systemInfo: {},
    global: () => ({ WeixinWorker: callbacks }),
    native: () => ({ invoke: () => undefined, close() {} }),
    inspector: (id) => {
      inspectors.add(id);
    },
    event: (name, data) => events.push({ name, ...data }),
    log() {},
  });
  t.after(() => {
    workers.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const until = async (predicate: () => boolean) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 3000)
        throw Error("Worker acknowledgement missing");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { workers, messages, events, inspectors, until, callbacks };
}

test("Worker snapshots queued messages at send time and rejects uncloneable values immediately", async (t) => {
  const f = fixture(t);
  f.workers.bind("test-app", {});
  const id = f.workers.api.create("business.js", { APIList: [] });
  const buffer = new Uint8Array([1, 2, 3]);
  const value = { list: ["original"], buffer };
  f.workers.api.postMsgToWorker(id, value);
  value.list[0] = "mutated";
  buffer[0] = 99;
  assert.throws(() => f.workers.api.postMsgToWorker(id, { fn() {} }), {
    name: "DataCloneError",
  });
  await f.until(() => f.inspectors.has(id));
  f.workers.continue(id);
  await f.until(() => f.messages.length === 1);
  assert.deepEqual(f.messages[0].message.list, ["original"]);
  assert.deepEqual([...f.messages[0].message.buffer], [1, 2, 3]);
});

test("terminating an unbound library Worker cannot poison other bind waiters", async (t) => {
  const f = fixture(t);
  const a = f.workers.api.createWXLibWorker("WAWorker.js", '{"APIList":[]}');
  const b = f.workers.api.createWXLibWorker("WAWorker.js", '{"APIList":[]}');
  f.workers.api.terminate(a);
  assert.doesNotThrow(() => f.workers.bind("test-app", {}));
  await f.until(() => f.inspectors.has(b));
  f.workers.continue(b);
  f.workers.api.postMsgToWorker(b, { message: "survivor" });
  await f.until(() => f.messages.length === 1);
  assert.equal(f.messages[0].id, b);
  assert.equal(f.messages[0].message.message, "survivor");
  assert.equal(
    f.events.filter((e) => e.name === "worker-destroyed" && e.workerId === a)
      .length,
    1,
  );
});

test("invalid Worker API lists are rejected before allocating a thread or native backend", (t) => {
  const f = fixture(t);
  f.workers.bind("test-app", {});
  assert.throws(
    () => f.workers.api.create("business.js", { APIList: {} }),
    /APIList/,
  );
  assert.throws(
    () => f.workers.api.createWXLibWorker("WAWorker.js", '{"APIList":[1]}'),
    /APIList/,
  );
  assert.equal(f.workers.snapshot().length, 0);
  assert.equal(f.events.filter((e) => e.name === "worker-created").length, 0);
});

test("a throwing Worker message/error callback is reported without killing sibling dispatch", async (t) => {
  const f = fixture(t);
  f.workers.bind("test-app", {});
  const a = f.workers.api.create("business.js", { APIList: [] });
  const b = f.workers.api.create("business.js", { APIList: [] });
  const original = f.callbacks.workerMsgHandler;
  f.callbacks.workerMsgHandler = (id, value) => {
    if (id === a) throw Error("message callback failed");
    original(id, value);
  };
  f.callbacks.errorHandler = () => {
    throw Error("error callback failed");
  };
  await f.until(() => f.inspectors.size === 2);
  f.workers.continue(a);
  f.workers.continue(b);
  f.workers.api.postMsgToWorker(a, "trigger");
  await f.until(() => f.events.some((e) => e.name === "worker-callback-error"));
  f.workers.api.postMsgToWorker(b, { intact: true });
  await f.until(() => f.messages.length === 1);
  assert.equal(f.messages[0].id, b);
  assert.equal(f.messages[0].message.intact, true);
  assert.equal(
    f.events.filter((e) => e.name === "worker-callback-error").length,
    1,
  );
  assert.match(
    f.events.find((e) => e.name === "worker-callback-error").error.stack,
    /message callback failed/,
  );
});
