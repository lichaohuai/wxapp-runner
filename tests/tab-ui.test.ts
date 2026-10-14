import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { OfficialTabUi } from "../src/loader/tab-ui";
import { pageChrome } from "../src/shell-layout";
const base = path.resolve("../baselib");
const config = () => ({
  color: "#111111",
  selectedColor: "#222222",
  list: [
    { pagePath: "home.html", text: "Home", iconData: "old" },
    { pagePath: "next.html", text: "Next" },
  ],
});
test("original PC tab UI preserves forceHide, route membership and original state isolation", async () => {
  const tabBar = config();
  let alive = true,
    changes = 0;
  const ui = new OfficialTabUi(base, tabBar, {
    alive: () => alive,
    changed: () => changes++,
  });
  await ui.invoke("hideTabBar");
  assert.equal(pageChrome({ tabBar }, "home", ui.hidden).tabBarHeight, 0);
  assert.equal(pageChrome({ tabBar }, "next", ui.hidden).showTabBar, false);
  await ui.invoke("showTabBar");
  assert.equal(pageChrome({ tabBar }, "home", ui.hidden).tabBarHeight, 58);
  assert.equal(pageChrome({ tabBar }, "detail", ui.hidden).showTabBar, false);
  await ui.invoke("setTabBarItem", { index: 0, text: "", iconPath: "new.png" });
  await ui.invoke("setTabBarStyle", {
    backgroundColor: "#123456",
    color: "#abcdef",
  });
  assert.equal(ui.snapshot().list[0].text, "");
  assert.equal(ui.snapshot().list[0].iconPath, "new.png");
  assert.equal(tabBar.list[0].text, "Home");
  assert.equal(ui.snapshot().backgroundColor, "#123456");
  const before = ui.snapshot();
  const bad = await ui.invoke("setTabBarItem", { index: 99, text: "bad" });
  assert.match(bad.errMsg, /:fail/);
  assert.deepEqual(ui.snapshot(), before);
  const pending = ui.invoke("setTabBarItem", { index: 1, text: "late" });
  alive = false;
  await assert.rejects(pending, /TARGET_CLOSED/);
  assert.deepEqual(ui.snapshot(), before);
  assert.equal(changes, 4);
  assert.equal(ui.provenance.length, 2);
});
test("missing standard tab config follows original PC failure envelope without creating one", async () => {
  const ui = new OfficialTabUi(base, undefined, {
    alive: () => true,
    changed: () => assert.fail("unexpected mutation"),
  });
  for (const name of ["setTabBarItem", "setTabBarStyle"])
    assert.match(
      (await ui.invoke(name, { index: 0 })).errMsg,
      /:fail no tabbar config/,
    );
  await ui.invoke("showTabBar");
  assert.deepEqual(ui.snapshot(), {});
});
