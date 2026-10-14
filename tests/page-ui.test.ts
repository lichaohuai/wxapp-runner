import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { OfficialPageUi } from "../src/loader/page-ui";
function fixture() {
  const live = new Set<any>(),
    changes: number[] = [];
  const ui = new OfficialPageUi(path.resolve("../baselib"), {
    alive: (p) => live.has(p),
    changed: (p) => changes.push(p.id),
    log() {},
  });
  const make = (id: number, window = {}) => {
    const p = { id };
    live.add(p);
    ui.ensure(p, window);
    return p;
  };
  return { ui, make, live, changes };
}
test("official navbar updates and restores page-owned color, empty title and loading", async () => {
  const { ui, make } = fixture(),
    a = make(1),
    b = make(2, { navigationBarBackgroundColor: "#abcdef" });
  await ui.invoke(a, "setNavigationBarTitle", { title: "" });
  await ui.invoke(a, "setNavigationBarColor", {
    frontColor: "#ffffff",
    backgroundColor: "#123456",
  });
  await ui.invoke(a, "showNavigationBarLoading");
  assert.equal(ui.snapshot(a)!.navigationBar.navigationBarTitleText, "");
  assert.equal(ui.snapshot(a)!.navigationBar.navigationBarTextStyle, "white");
  assert.equal(
    ui.snapshot(a)!.navigationBar.navigationBarBackgroundColor,
    "#123456",
  );
  assert.equal(
    ui.snapshot(b)!.navigationBar.navigationBarBackgroundColor,
    "#abcdef",
  );
  assert.equal(ui.snapshot(b)!.navigationBar.showLoading, false);
  await ui.invoke(a, "hideNavigationBarLoading");
  assert.equal(ui.snapshot(a)!.navigationBar.showLoading, false);
});
test("official async share transitions retain originating page during interleaved calls", async () => {
  const { ui, make } = fixture(),
    a = make(1),
    b = make(2);
  await Promise.all([
    ui.invoke(a, "hideShareMenu"),
    ui.invoke(b, "showShareMenuWithShareTicket", { withShareTicket: true }),
    ui.invoke(a, "showShareTimelineMenu"),
  ]);
  assert.deepEqual(ui.snapshot(a)!.share, {
    showShareMenu: false,
    showShareTimelineMenu: true,
    withShareTicket: false,
  });
  assert.deepEqual(ui.snapshot(b)!.share, {
    showShareMenu: true,
    showShareTimelineMenu: false,
    withShareTicket: true,
  });
  await ui.invoke(b, "updateShareMenuShareTicket", { withShareTicket: false });
  assert.equal(ui.snapshot(b)!.share.withShareTicket, false);
  assert.equal(ui.provenance.length, 4);
});
test("destroying a page before the official asynchronous acknowledgement rejects without mutating another page", async () => {
  const { ui, make, live, changes } = fixture(),
    a = make(1),
    b = make(2);
  const pending = ui.invoke(a, "hideShareMenu");
  live.delete(a);
  await assert.rejects(pending, /PAGE_CLOSED/);
  await assert.rejects(
    ui.invoke(a, "setNavigationBarTitle", { title: "stale" }),
    /PAGE_CLOSED/,
  );
  assert.equal(ui.snapshot(b)!.share.showShareMenu, true);
  assert.equal(changes.length, 0);
});
