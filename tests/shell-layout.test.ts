import { test } from "node:test";
import assert from "node:assert/strict";
import { pageChrome } from "../src/shell-layout";

test("custom tabs preserve route identity without reserving or rendering a second host bar", () => {
  const tabBar = { custom: true, list: [{ pagePath: "pages/home.html" }] };
  assert.deepEqual(pageChrome({ tabBar }, "pages/home"), {
    isTab: true,
    showTabBar: false,
    tabBarHeight: 0,
    showNavigationBar: true,
    navigationBarHeight: 36,
  });
  assert.deepEqual(
    pageChrome({ tabBar: { ...tabBar, custom: false } }, "pages/home"),
    {
      isTab: true,
      showTabBar: true,
      tabBarHeight: 58,
      showNavigationBar: true,
      navigationBarHeight: 36,
    },
  );
  assert.deepEqual(pageChrome({ tabBar }, "pages/detail"), {
    isTab: false,
    showTabBar: false,
    tabBarHeight: 0,
    showNavigationBar: true,
    navigationBarHeight: 36,
  });
});

test("page navigationStyle overrides app navigationStyle without a host header or top inset", () => {
  const app = {
    global: { window: { navigationStyle: "custom" } },
    page: { "pages/detail.html": { window: { navigationStyle: "default" } } },
  };
  assert.equal(pageChrome(app, "pages/home").navigationBarHeight, 0);
  assert.equal(pageChrome(app, "pages/detail").navigationBarHeight, 36);
  assert.equal(
    pageChrome(
      {
        page: { "pages/home.html": { window: { navigationStyle: "custom" } } },
      },
      "pages/home",
    ).showNavigationBar,
    false,
  );
});
