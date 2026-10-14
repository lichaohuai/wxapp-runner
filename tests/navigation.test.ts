import test from "node:test";
import assert from "node:assert/strict";
import { navigationTarget, serviceRouteQuery } from "../src/loader/navigation";

test("business page options survive native routing without form decoding", () => {
  const item = {
    title: "中奖率40% 中文😀",
    url: "https://example.test/a?q=a+b%25&x=1=2",
  };
  const encoded = encodeURIComponent(JSON.stringify(item));
  const target = navigationTarget(
    "../detail?pageData=" +
      encoded +
      "&literal=a+b&equals=a=b&empty=&flag#anchor",
    "pages/list/index",
  );
  assert.equal(target.pathname, "/pages/detail");
  for (const type of ["navigateTo", "redirectTo", "reLaunch", "navigateBack"]) {
    const native = serviceRouteQuery(target.query, type);
    const options = Object.fromEntries(
      Object.entries(native).map(([k, v]) => [k, decodeURIComponent(v)]),
    );
    assert.equal(options.pageData, encoded);
    assert.deepEqual(JSON.parse(decodeURIComponent(options.pageData)), item);
    assert.equal(options.literal, "a+b");
    assert.equal(options.equals, "a=b");
    assert.equal(options.flag, "");
  }
  assert.deepEqual(serviceRouteQuery(target.query, "appLaunch"), {
    ...target.query,
  });
});

test("base-library native navigation removes just its own encoding layer", () => {
  const value = encodeURIComponent('{"description":"40% 中文"}');
  const native = navigationTarget(
    "/detail?data=" + encodeURIComponent(value),
    "",
    true,
  );
  assert.equal(native.query.data, value);
  assert.equal(
    decodeURIComponent(serviceRouteQuery(native.query, "navigateTo").data),
    value,
  );
  assert.equal(navigationTarget("/detail?q=%broken").query.q, "%broken");
  const query = navigationTarget("/detail?x=1&x=2&__proto__=safe").query;
  assert.equal(query.x, "2");
  assert.equal(query.__proto__, "safe");
  assert.equal(Object.getPrototypeOf(query), null);
});

test("native package-root routes are not resolved twice while direct business paths stay relative", () => {
  const current="main/components/index";
  assert.equal(navigationTarget("tools/detail.html?x=1",current,true).pathname,"/tools/detail.html");
  assert.equal(navigationTarget("tools/detail.html?x=1",current,false).pathname,"/main/components/tools/detail.html");
  assert.equal(navigationTarget("../detail",current,false).pathname,"/main/detail");
  assert.equal(navigationTarget("main/detail",current,true).pathname,"/main/detail");
});
