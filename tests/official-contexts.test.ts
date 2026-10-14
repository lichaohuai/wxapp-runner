import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { OfficialContexts } from "../src/loader/contexts";
import { RealmTimers } from "../src/loader/realm-timers";
import { wxConfig, hostPlatform } from "../src/config";
function fixture(ready?: (id: number) => void | Promise<void>, configured = true) {
  const realms = new Map<number, any>(),
    events: any[] = [];
  const adapter = new OfficialContexts(path.resolve("../baselib"), {
    appLaunchInfo: {
      scene: 1001
    }
  }, {
    create(id, options) {
      const realm = vm.createContext({});
      realms.set(id, realm);
      events.push(["create", id, options.name]);
      return realm;
    },
    ready,
    read(file) {
      return file === "WASubContext.js" ? "globalThis.baseLoaded = true;" : "globalThis.runs = (globalThis.runs || 0) + 1;";
    },
    evaluate(id, source) {
      events.push(["eval", id, source.src]);
      return vm.runInContext(source.code, realms.get(id));
    },
    dispose(id) {
      events.push(["dispose", id]);
      realms.delete(id);
    },
    publish(name, value) {
      events.push([name, value?.message]);
    },
    log() {},
    event(name, value) {
      events.push([name, value.message]);
    }
  });
  if (configured) adapter.configurationReady();
  return {
    adapter,
    events,
    realms
  };
}
test("official allocation returns identity before ready/init/library/callback and main is separate", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(r => {
    release = r;
  });
  const f = fixture(() => barrier);
  const main = f.adapter.createMain();
  const callbacks: number[] = [];
  const id = f.adapter.api.alloc("business", () => callbacks.push(id));
  assert.equal(main.id, 1);
  assert.equal(id, 2);
  assert.equal(f.adapter.api.async, true);
  assert.deepEqual(callbacks, []);
  assert.equal(f.realms.get(id).baseLoaded, undefined);
  release();
  await f.adapter.idle();
  assert.deepEqual(callbacks, [id]);
  assert.equal(f.realms.get(id).baseLoaded, true);
  assert.equal(f.realms.get(id).isMainContext, false);
  assert.equal(f.adapter.provenance.length, 2);
  f.adapter.close();
});
test("official preloaded context is consumed once; empty auxiliary context gets no business library", async () => {
  const f = fixture();
  await f.adapter.manager.init({
    preloadContexts: [{
      name: "reserved"
    }]
  });
  const before = f.events.filter(e => e[0] === "create").length;
  const id = f.adapter.api.allocEmpty("reserved");
  await f.adapter.idle();
  assert.equal(f.events.filter(e => e[0] === "create").length, before);
  assert.equal(f.realms.get(id).baseLoaded, undefined);
  const other = f.adapter.api.allocEmpty("reserved");
  await f.adapter.idle();
  assert.notEqual(other, id);
  f.adapter.close();
});
test("official startup reserves main and app without executing business code; consumption retains asynchronous callback", async () => {
  const f = fixture();
  await f.adapter.manager.init({
    preloadContexts: [{
      name: "main",
      needBridgeContext: true
    }, {
      name: "app"
    }]
  });
  assert.equal(f.events.filter(e => e[0] === "eval").length, 0);
  assert.equal(f.adapter.createMain().id, 1);
  let callback = false;
  assert.equal(f.adapter.api.alloc("app", () => {
    callback = true;
  }), 2);
  assert.equal(callback, false);
  await f.adapter.idle();
  assert.equal(callback, true);
  assert.deepEqual(f.events.filter(e => e[0] === "create"), [["create", 1, "main"], ["create", 2, "app"]]);
  assert.equal(f.realms.get(1).baseLoaded, undefined);
  assert.equal(f.realms.get(2).baseLoaded, true);
  f.adapter.close();
});
test("destroying an allocating context suppresses its callback and rejects further evaluation", async () => {
  const f = fixture();
  let calls = 0;
  const id = f.adapter.api.alloc("cancelled", () => calls++);
  f.adapter.api.destroy(id);
  await assert.rejects(f.adapter.idle(), /CONTEXT_CLOSED/);
  assert.equal(calls, 0);
  assert.equal(f.realms.has(id), false);
  assert.equal(f.adapter.api.evaluateScriptFile(id, "later.js"), 0);
  assert.equal(f.events.filter(e => e[0] === "dispose").length, 1);
  f.adapter.close();
});
test("initialization failure settles allocation without a false ready callback", async () => {
  const f = fixture(async () => {
    throw Error("host context failed");
  });
  let calls = 0;
  f.adapter.api.alloc("failure", () => calls++);
  await assert.rejects(f.adapter.idle(), /host context failed/);
  assert.equal(calls, 0);
  assert.equal(f.realms.size, 0);
  f.adapter.close();
});
test("closing during a pending host initialization settles idle and suppresses late ready", async () => {
  let rejectReady!: (e: Error) => void;
  const barrier = new Promise<void>((_, reject) => {
    rejectReady = reject;
  });
  const f = fixture(() => barrier);
  let calls = 0;
  f.adapter.api.alloc("pending", () => calls++);
  await Promise.resolve();
  f.adapter.close();
  await assert.rejects(Promise.race([f.adapter.idle(), new Promise((_, reject) => {
    const t = setTimeout(() => reject(Error("idle hung after close")), 100);
    t.unref();
  })]), /CONTEXT_CLOSED/);
  rejectReady(Error("late initialization failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(f.realms.size, 0);
  assert.equal(f.events.filter(e => e[0] === "dispose").length, 1);
});
test("a failed preloaded context is evicted before the next allocation", async () => {
  const f = fixture(id => {
    if (id === 1) throw Error("preload failure");
  });
  await assert.rejects(f.adapter.manager.init({
    preloadContexts: [{
      name: "app"
    }]
  }), /preload failure/);
  await assert.rejects(f.adapter.idle(), /preload failure/);
  const id = f.adapter.api.alloc("app", () => {});
  assert.equal(id, 2);
  // idle also drains diagnostic failures already observed by init.
  try {
    await f.adapter.idle();
  } catch (e) {
    assert.match(String(e), /preload failure/);
  }
  assert.equal(f.realms.get(id)?.baseLoaded, true);
  f.adapter.close();
});
test("closing before configuration cancels the official SDK injection continuation", async () => {
  const f = fixture(undefined, false);
  let allocated!: () => void;
  const allocatedPromise = new Promise<void>(r => {
    allocated = r;
  });
  f.adapter.api.alloc("app", allocated);
  await allocatedPromise;
  f.adapter.close();
  await assert.rejects(f.adapter.idle(), /CONTEXT_CLOSED: configuration cancelled/);
  f.adapter.configurationReady();
  await f.adapter.idle();
  assert.equal(f.realms.size, 0);
});
test("realm destruction clears pending/repeating timers and cannot clear another realm's timer", async () => {
  const a = new RealmTimers(),
    b = new RealmTimers();
  let calls = 0;
  const done = new Promise<void>(resolve => {
    const other = b.globals.setTimeout(() => {
      calls++;
      resolve();
    }, 10);
    a.globals.clearTimeout(other);
  });
  a.globals.setTimeout(() => calls += 100, 1);
  a.globals.setInterval(() => calls += 100, 1);
  a.close();
  await done;
  b.close();
  assert.equal(calls, 1);
  assert.throws(() => a.globals.setTimeout(() => {}, 0), /CONTEXT_CLOSED/);
});
test("official SDK selects PC bridge branches independently of the legacy mobile baseline", () => {
  const cfg = {
    app: {
      entryPagePath: "home.html"
    },
    appid: "wx" + "0000000000000001"
  };
  assert.equal(wxConfig({
    ...cfg,
    loaderAdapter: "official"
  }).platform, hostPlatform);
  assert.equal(wxConfig({
    ...cfg,
    loaderAdapter: "legacy"
  }).platform, "android");
});
