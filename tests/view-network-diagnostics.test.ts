import test from "node:test";
import assert from "node:assert/strict";
import { ViewNetwork } from "../src/controller/view-network";
import { NetworkRules } from "../src/controller/rules";
import { networkProjection } from "../src/analysis/network";
import { runtimeTitle } from "../src/runtime-title";
import { viewResourceHeaders } from "../src/wx-shim/network-context";
test("a blocked image records the actual rule before Chromium reports its failure", async () => {
  const rules = new NetworkRules();
  rules.experimentMode = "local-only";
  const published: any[] = [];
  const view = new ViewNetwork("runtime", "session", "page:1", {} as any, rules, r => published.push(r), () => {}, async r => rules.evaluate(r));
  (view.client as any).raw = async (method: string) => {
    assert.equal(method, "Fetch.failRequest");
    assert.equal(published.at(-1).blockedReason, "ANALYSIS_LOCAL_ONLY");
    await (view as any).message("Network.loadingFailed", {
      requestId: "image",
      errorText: "net::ERR_BLOCKED_BY_CLIENT.Inspector"
    });
    return {};
  };
  await (view as any).message("Network.requestWillBeSent", {
    requestId: "image",
    type: "Image",
    timestamp: 1,
    request: {
      url: "https://cdn.example/image.png",
      method: "GET",
      headers: {}
    }
  });
  await (view as any).message("Fetch.requestPaused", {
    networkId: "image",
    requestId: "fetch-image",
    request: {
      url: "https://cdn.example/image.png",
      method: "GET",
      headers: {}
    }
  });
  const summary = networkProjection(published.at(-1), {
    summary: true
  });
  assert.equal(summary.resourceType, "Image");
  assert.equal(summary.state, "failed");
  assert.equal(summary.blockedReason, "ANALYSIS_LOCAL_ONLY");
  assert.deepEqual(summary.ruleIds, ["analysis:local-only"]);
  assert.match(summary.error, /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(summary.requestHeaders, undefined);
});
test("analysis window identity keeps its offline indication when location changes", () => {
  const cfg = {
    appid: "wx" + "0000000000000001",
    profile: "analysis-check",
    analysis: {
      enabled: true,
      networkMode: "local-only"
    }
  };
  for (const simulated of [false, true]) assert.match(runtimeTitle(cfg, simulated), /仅本机网络 · 外网图片已拦截/);
  assert.doesNotMatch(runtimeTitle({
    appid: cfg.appid,
    analysis: {
      enabled: false,
      networkMode: "normal"
    }
  }), /已拦截|分析实例/);
});
test("a detached view's unfinished image has an explicit capture gap in compact MCP output", async () => {
  const rules = new NetworkRules(),
    published: any[] = [];
  const view = new ViewNetwork("r", "s", "page:1", {} as any, rules, r => published.push(r), () => {}, async r => rules.evaluate(r));
  await (view as any).message("Network.requestWillBeSent", {
    requestId: "closing-image",
    type: "Image",
    timestamp: 1,
    request: {
      url: "https://example.test/image.png",
      method: "GET",
      headers: {}
    }
  });
  await (view as any).message("Inspector.detached", {});
  const summary = networkProjection(published.at(-1), {
    summary: true
  });
  assert.equal(summary.state, "capture-error");
  assert.match(summary.captureError, /request may still execute/);
  assert.ok(summary.endedAt);
  assert.equal(summary.status, undefined);
  assert.equal(summary.error, undefined);
});
test("Fetch decisions survive request/ExtraInfo ordering without reverting the applied Referer", async () => {
  const rules = new NetworkRules(),
    published: any[] = [];
  const documentURL = "http://127.0.0.1:4321/page/1",
    url = "https://cdn.example/image.png";
  const view = new ViewNetwork("r", "s", "page:1", {} as any, rules, r => published.push(r), () => {}, async r => rules.evaluate(r), {
    documentURL,
    appid: "wx" + "0000000000000001",
    appVersion: 2
  });
  (view.client as any).raw = async (method: string, args: any) => {
    assert.equal(method, "Fetch.continueRequest");
    assert.equal(args.headers.find((h: any) => h.name === "referer").value, "https://servicewechat.com/" + ("wx" + "0000000000000001") + "/2/page-frame.html");
    return {};
  };
  const request = {
    url,
    method: "GET",
    headers: {
      Referer: documentURL
    }
  };
  await (view as any).message("Fetch.requestPaused", {
    networkId: "1",
    requestId: "fetch-1",
    request
  });
  await (view as any).message("Network.requestWillBeSent", {
    requestId: "1",
    type: "Image",
    timestamp: 1,
    request
  });
  await (view as any).message("Network.requestWillBeSentExtraInfo", {
    requestId: "1",
    headers: {
      Referer: documentURL,
      Host: "cdn.example"
    }
  });
  assert.equal(published.at(-1).requestHeaders.referer, "https://servicewechat.com/" + ("wx" + "0000000000000001") + "/2/page-frame.html");
  assert.equal(published.at(-1).requestHeaders.Host, "cdn.example");
  assert.equal(published.at(-1).browserRequestHeaders.Referer, documentURL);
});
test("view identity preserves absent/referrer-policy-reduced headers and independent H5 origins", () => {
  const id = {
      appid: "wx" + "0000000000000001",
      appVersion: 12
    },
    doc = "http://127.0.0.1:4321/page/1",
    dest = "https://cdn.example/image.png";
  assert.equal(viewResourceHeaders({
    Referer: doc
  }, dest, doc, id).Referer, "https://servicewechat.com/" + ("wx" + "0000000000000001") + "/12/page-frame.html");
  assert.equal(viewResourceHeaders({
    referer: "http://127.0.0.1:4321/"
  }, dest, doc, id).referer, "https://servicewechat.com/");
  for (const headers of [{}, {
    referer: "https://independent.example/private"
  }] as Record<string, string>[]) assert.equal(viewResourceHeaders(headers, dest, doc, id), headers);
  const headers = {
    referer: doc
  };
  assert.equal(viewResourceHeaders(headers, doc, doc, id), headers);
  assert.equal(viewResourceHeaders(headers, dest, undefined, id), headers);
});
test("H5 console errors and exceptions survive level filtering with their structured stack", async () => {
  const {
    EventStore
  } = await import("../src/controller/events");
  const events = new EventStore(),
    rules = new NetworkRules();
  const view = new ViewNetwork("r", "s", "h5:1:1", {} as any, rules, () => {}, e => events.push("r", "s", "view", e), async r => rules.evaluate(r));
  const stackTrace = {
    callFrames: [{
      functionName: "render",
      url: "https://example.test/app.js",
      lineNumber: 7,
      columnNumber: 8
    }]
  };
  await (view as any).message("Runtime.consoleAPICalled", {
    type: "error",
    args: [{
      type: "object",
      preview: {
        type: "object",
        properties: [{
          name: "code",
          value: "E_TEST"
        }]
      }
    }],
    stackTrace
  });
  await (view as any).message("Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "Uncaught",
      exception: {
        description: "TypeError: missing method"
      },
      stackTrace
    }
  });
  const page = events.page({
    source: "view",
    level: "error",
    revealSensitive: true
  });
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[0].cdpMethod, "Runtime.consoleAPICalled");
  assert.equal(page.entries[0].args[0].preview.properties[0].value, "E_TEST");
  assert.deepEqual(page.entries[1].stackTrace, stackTrace);
  assert.equal(page.entries[1].message, "TypeError: missing method");
});
