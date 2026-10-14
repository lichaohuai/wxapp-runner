import test from "node:test";
import assert from "node:assert/strict";
import { gatewayURL } from "../src/gateway-url";
import { WxbotClient } from "../src/wxbot";
import { PackageSource } from "../src/packages/client";
test("gateway URLs retain scoped BFF paths and reject ambiguous bases", () => {
  assert.equal(gatewayURL("https://bot.example", "/miniprogram/jslogin").href, "https://bot.example/miniprogram/jslogin");
  assert.equal(gatewayURL("http://127.0.0.1:4300/api/miniapps/bridge/", "/v1/miniprogram/downloadpackage").pathname, "/api/miniapps/bridge/v1/miniprogram/downloadpackage");
  for (const base of ["file:///tmp/bridge", "https://user:password@example.test/", "https://example.test/?token=a", "https://example.test/#fragment"]) assert.throws(() => gatewayURL(base, "/miniprogram/jslogin"));
  for (const endpoint of ["https://outside.test", "//outside.test", "/../outside", "/path?token=a"]) assert.throws(() => gatewayURL("https://example.test", endpoint));
});
test("package and runtime requests use the scoped proxy and never follow credential redirects", async t => {
  const requests: {
    url: string;
    options: any;
  }[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, options: any) => {
    requests.push({
      url: String(url),
      options
    });
    return new Response(JSON.stringify(String(url).includes("/mp/wxa/search") ? {
      accounts: []
    } : {
      ret: 0,
      data: {
        code: "fixture-code"
      }
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  });
  const base = "http://127.0.0.1:4300/api/miniapps/bridge/";
  await new PackageSource({
    base,
    appKey: "temporary-key",
    appSecret: "temporary-secret",
    deviceId: "bridge-device"
  }).search("fixture");
  await new WxbotClient({
    wxbot: base,
    appKey: "temporary-key",
    appSecret: "temporary-secret",
    deviceId: "bridge-device",
    appid: "wx" + "0000000000000006"
  }).call("jslogin");
  assert.equal(requests[0].url, base + "mp/wxa/search");
  assert.equal(requests[1].url, base + "miniprogram/jslogin");
  for (const request of requests) {
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.headers["X-App-Key"], "temporary-key");
    assert.equal(JSON.parse(request.options.body).device_id, "bridge-device");
  }
});
