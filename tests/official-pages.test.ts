import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { OfficialPages } from "../src/loader/pages";
function fixture() {
  const events: any[] = [],
    surfaces: any[] = [];
  let next = 0,
    failPrepare = false,
    failLoad = false;
  const p = new OfficialPages(
    path.resolve("../baselib"),
    {
      entryPagePath: "home.html",
      pages: ["home", "tab", "detail"],
      page: { "home.html": {}, "tab.html": {}, "detail.html": {} },
      tabBar: { list: [{ pagePath: "home.html" }, { pagePath: "tab.html" }] },
    },
    {
      async create() {
        const page = {
          id: ++next,
          evalPreloadCode: async () => events.push(["host-ready", next]),
        };
        surfaces.push(page);
        return page;
      },
      async prepare() {
        if (failPrepare) throw Error("missing package");
      },
      load(page) {
        if (failLoad) {
          p.fail(page.id, Error("bad renderer"));
          return;
        }
        queueMicrotask(() => {
          p.acknowledge(page.id, "loaded");
          p.acknowledge(page.id, "readyed");
        });
      },
      remove(page) {
        events.push(["destroy", page.id]);
      },
      show(page, visible) {
        events.push(["show", page.id, visible]);
      },
      changed(stack) {
        events.push(["stack", stack.map((p) => p.id)]);
      },
      event(name, data) {
        events.push([name, data]);
      },
      back(_p, delta) {
        return delta;
      },
      async modal() {
        return { confirm: true };
      },
      log() {},
    },
  );
  return {
    p,
    events,
    surfaces,
    setPrepareFailure(v: boolean) {
      failPrepare = v;
    },
    setLoadFailure(v: boolean) {
      failLoad = v;
    },
  };
}
test("official page stack preserves tab instances and emits one ordered route pair per navigation", async () => {
  const { p, events } = fixture();
  await p.navigate("appLaunch");
  const first = p.navigator.currentPage.id;
  await p.navigate("navigateTo", "detail.html?x=a%2Bb");
  await p.navigate("navigateBack");
  assert.equal(p.navigator.currentPage.id, first);
  assert.equal(p.manager.getAllActivePage().length, 1);
  await p.navigate("switchTab", "tab.html");
  await p.navigate("switchTab", "home.html");
  assert.equal(p.navigator.currentPage.id, first);
  assert.equal(p.manager.getAllActivePage().length, 2);
  const routes = events.filter((e) =>
    ["onAppRoute", "onAppRouteDone"].includes(e[0]),
  );
  assert.equal(routes.length, 10);
  for (let i = 0; i < 10; i += 2) {
    assert.equal(routes[i][0], "onAppRoute");
    assert.equal(routes[i + 1][0], "onAppRouteDone");
    assert.equal(routes[i][1].webviewId, routes[i + 1][1].webviewId);
  }
  assert.equal(routes[2][1].query.x, "a%2Bb");
  assert.equal(p.provenance.length, 6);
  await p.close();
});
test("preflight and renderer failures preserve the previous stack, release navigation, and never replay failed pages", async () => {
  const f = fixture();
  await f.p.navigate("appLaunch");
  const id = f.p.navigator.currentPage.id;
  f.setPrepareFailure(true);
  await assert.rejects(
    f.p.navigate("navigateTo", "detail.html"),
    /missing package/,
  );
  assert.equal(f.surfaces.length, 1);
  f.setPrepareFailure(false);
  f.setLoadFailure(true);
  await assert.rejects(
    f.p.navigate("redirectTo", "detail.html"),
    /bad renderer/,
  );
  assert.equal(f.p.navigator.currentPage.id, id);
  assert.equal(f.surfaces.length, 2);
  f.setLoadFailure(false);
  await f.p.navigate("navigateTo", "detail.html");
  assert.equal(f.surfaces.length, 3);
  await f.p.close();
});
test("reserved page renderer is consumed once and is not an active business page until bound", async () => {
  const f = fixture();
  await f.p.preload();
  assert.equal(f.surfaces.length, 1);
  assert.equal(f.p.manager.getAllActivePage().length, 0);
  await f.p.navigate("appLaunch");
  assert.equal(f.surfaces.length, 1);
  assert.equal(f.p.navigator.currentPage.id, 1);
  await f.p.navigate("navigateTo", "detail.html");
  assert.equal(f.surfaces.length, 2);
  await f.p.close();
});
test("concurrent preloads allocate once; failed warmup is destroyed before any business route", async () => {
  const f = fixture();
  await Promise.all([f.p.preload(true), f.p.preload(true), f.p.preload(true)]);
  assert.equal(f.surfaces.length, 1);
  assert.equal(f.p.manager.getAllPreloadPage().length, 1);
  await f.p.close();
  const g = fixture();
  await g.p.preload();
  g.surfaces[0].evalPreloadCode = async () => {
    throw Error("base library failure");
  };
  await assert.rejects(g.p.navigate("appLaunch"), /base library failure/);
  assert.equal(g.events.filter((e) => e[0] === "onAppRoute").length, 0);
  // The rejected renderer must never become an active page.
  assert.equal(g.p.navigator.pageStack.length, 0);
  assert.deepEqual(
    g.events.filter((e) => e[0] === "destroy"),
    [["destroy", 1]],
  );
  await g.p.close();
});

import { ApplicationVisibility } from "../src/loader/visibility";
test("window visibility emits transitions once, holds startup events, and restore respects hidden state", () => {
  const events: boolean[] = [];
  const v = new ApplicationVisibility((b) => events.push(b));
  v.update({ hidden: true });
  assert.deepEqual(events, []);
  v.start();
  assert.deepEqual(events, [true]);
  v.update({ minimized: true });
  v.update({ hidden: false });
  assert.deepEqual(events, [true]);
  v.update({ minimized: false });
  v.update({ minimized: false });
  assert.deepEqual(events, [true, false]);
});
