import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const out = path.resolve(".local/h5-back-20260912");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-h5-back-"));
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/one" });
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  res.end(
    `<html><body><h1 id="title">H5 ${req.url}</h1><a id="two" href="/two">two</a><button id="hash" onclick="location.hash='hash'">hash</button>${req.url === "/spa" ? `<script>history.pushState({},'', '/spa-state')</script>` : ""}${req.url === "/client-redirect" ? `<script>location.replace('/one')</script>` : ""}</body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const pkg = interactionFixture(dir, origin);
const cases = {
  next: "/one",
  redirect: "/redirect",
  replace: "/client-redirect",
  spa: "/spa",
};
// Give each case a literal src so the history test does not depend on a
// synthetic template implementing compiled WXML data-binding semantics.
const configPath = path.join(pkg, "app-config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.pages = ["home", ...Object.keys(cases)];
fs.writeFileSync(configPath, JSON.stringify(config));
for (const route of Object.keys(cases))
  fs.writeFileSync(
    path.join(pkg, route + ".html"),
    `<script>__wxAppCode__['${route}.wxss']();document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:$gwx('${route}.wxml')}}));</script>`,
  );
const fp = path.join(pkg, "page-frame.html");
fs.writeFileSync(
  fp,
  fs
    .readFileSync(fp, "utf8")
    .replace(
      "if(path==='next.wxml')return {tag:'wx-page',children:[n('text',{},['Next page'])]};",
      Object.entries(cases)
        .map(
          ([route, endpoint]) =>
            `if(path==='${route}.wxml')return {tag:'wx-page',children:value(env.h5Hidden)?[]:[n('web-view',{src:value(env.h5Src)||${JSON.stringify(origin + endpoint)}})]};`,
        )
        .join("\n"),
    )
    .replace(
      "$gwx=function(path)",
      Object.keys(cases)
        .map((route) => `__wxAppCode__['${route}.wxss']=function(){};`)
        .join("\n") + "$gwx=function(path)",
    ),
);
const sp = path.join(pkg, "app-service.js");
fs.writeFileSync(
  sp,
  fs.readFileSync(sp, "utf8").replace(
    "__wxRoute='next';__wxRouteBegin=true;__wxAppCurrentFile__='next.js';Page({data:{result:'Next page'}});",
    Object.keys(cases)
      .map(
        (route) =>
          `__wxRoute='${route}';__wxRouteBegin=true;__wxAppCurrentFile__='${route}.js';Page({data:{},onUnload(){getApp().unloads=(getApp().unloads||0)+1}});`,
      )
      .join("\n"),
  ),
);
let t;
const result = {
  date: new Date().toISOString(),
  platform: process.platform,
  scenarios: [],
};
try {
  t = await managedFixture({
    packageDir: pkg,
    debug: {nativeContractCalls:true},
    config: {
      loaderAdapter: process.argv.includes("--legacy") ? "legacy" : "official",
    },
  });
  const evaluate = async (id, expression) => {
    const r = await t.call("runner_evaluate", { targetId: id, expression });
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result?.value;
  };
  const enter = async (route = "/one") => {
    await t.call("runner_navigate", {
      method: "navigateTo",
      url: "/" + Object.keys(cases).find((key) => cases[key] === route),
    });
    return until(async () => {
      const s = await t.call("runner_status");
      const h = s.h5?.find(
        (i) => i.pageId === s.current?.id && i.state === "loaded" && i.visible,
      );
      const expected =
        route === "/spa"
          ? "/spa-state"
          : ["/redirect", "/client-redirect"].includes(route)
            ? "/one"
            : route;
      return (
        h && (await evaluate(h.targetId, "location.pathname")) === expected && h
      );
    });
  };
  const clickBack = () =>
    t.call("runner_click", { target: "shell", selector: "#back" });
  const root = async () =>
    until(async () => {
      const s = await t.call("runner_status");
      return s.current?.route === "home" && s.h5?.length === 0 && s;
    });
  const homeId=(await t.call("runner_status")).current.id;
  const routeFrom=async targetId=>{
    const bridge=targetId==='logic'?'internals.WeixinJSBridge':'WeixinJSBridge';
    const r=await t.call('runner_evaluate',{targetId,expression:`new Promise(resolve=>${bridge}.invoke('getCurrentRoute',{},resolve))`,awaitPromise:true});
    assert.ok(!r.exceptionDetails,JSON.stringify(r));return r.result.value;
  };
  assert.deepEqual(await routeFrom('logic'),{errMsg:'getCurrentRoute:ok',route:'home.html',currentRoute:'home.html'});
  const h = await enter();
  for(const target of ['logic',`page:${homeId}`,`page:${h.pageId}`])
    assert.deepEqual(await routeFrom(target),{errMsg:'getCurrentRoute:ok',route:'next.html',currentRoute:'next.html'});

  await clickBack();
  const outcome = await until(async () => {
    const s = await t.call("runner_status");
    if (s.current?.route === "home")
      return { route: s.current.route, stack: s.stack.length, h5: s.h5.length };
    const url = await evaluate(h.targetId, "location.href");
    return (
      url === "about:blank" && {
        route: s.current.route,
        stack: s.stack.length,
        url,
        reportedSrc: s.h5[0]?.src,
      }
    );
  });
  fs.writeFileSync(
    path.join(
      out,
      process.argv.includes("--baseline") ? "baseline.json" : "first-back.json",
    ),
    JSON.stringify(outcome, null, 2),
  );
  assert.equal(
    outcome.route,
    "home",
    "one back must leave first H5 document; bootstrap blank must never consume a back step",
  );
  assert.equal(outcome.stack, 1);
  assert.equal(outcome.h5, 0);
  assert.deepEqual(await routeFrom('logic'),{errMsg:'getCurrentRoute:ok',route:'home.html',currentRoute:'home.html'});
  result.scenarios.push("initial document: one shell back exits");
  for (const route of ["/redirect", "/client-redirect"]) {
    await enter(route);
    await clickBack();
    await root();
    result.scenarios.push(route + ": one back exits");
  }
  const multi = await enter();
  await t.call("runner_click", { targetId: multi.targetId, selector: "#two" });
  await t.call("runner_wait", {
    targetId: multi.targetId,
    kind: "text",
    text: "H5 /two",
  });
  await clickBack();
  await t.call("runner_wait", {
    targetId: multi.targetId,
    kind: "text",
    text: "H5 /one",
  });
  assert.equal((await t.call("runner_status")).current.route, "next");
  await clickBack();
  await root();
  result.scenarios.push("real H5 history: /two to /one then mini page");
  const spa = await enter("/spa");
  assert.equal(await evaluate(spa.targetId, "location.pathname"), "/spa-state");
  const described = await until(async () => {
    const h = (await t.call("runner_status")).h5[0];
    return h?.src.endsWith("/spa-state") && h;
  });
  assert.equal(described.state, "loaded");
  await clickBack();
  await until(
    async () => (await evaluate(spa.targetId, "location.pathname")) === "/spa",
  );
  assert.equal((await t.call("runner_status")).current.route, "spa");
  await clickBack();
  await root();
  result.scenarios.push(
    "startup pushState preserved and status tracks same-document navigation",
  );
  const fragment = await enter();
  await t.call("runner_click", {
    targetId: fragment.targetId,
    selector: "#hash",
  });
  await until(
    async () =>
      (await evaluate(fragment.targetId, "location.hash")) === "#hash",
  );
  await clickBack();
  await until(
    async () => (await evaluate(fragment.targetId, "location.hash")) === "",
  );
  await clickBack();
  await root();
  result.scenarios.push("hash entry preserved");
  // Page teardown can destroy the entire renderer without invoking the native
  // remove API. Test component removal separately, through original setData.
  const dynamic=await enter();
  await evaluate("logic",`getCurrentPages().at(-1).setData({h5Src:${JSON.stringify(origin + '/two')}});true`);
  await t.call("runner_wait",{kind:"text",text:"H5 /two",targetId:dynamic.targetId});
  await evaluate("logic",'getCurrentPages().at(-1).setData({h5Hidden:true});true');
  await until(async()=>(await t.call('runner_status')).h5.length===0);
  assert.equal((await t.call('runner_status')).current.route,'next');
  await clickBack();await root();
  const unloads = await evaluate("logic", "getApp().unloads");
  assert.equal(unloads, 7);
  result.scenarios.push("original setData updates and removes a web-view while its page remains alive");
  for (const endpoint of Object.values(cases))
    assert.ok(requests.includes(endpoint), "server received " + endpoint);
  const observations=await until(async()=>{
    const entries=(await t.call('runner_status')).loader.nativeContracts.entries;
    return entries.some(e=>e.api==='removeHTMLWebView'&&e.phases.invoked)&&entries;
  });
  Object.assign(result,{observedNativeIds:[...new Set(observations.map(e=>e.contractId))],
    initialDocumentBackExits:true,redirectBackExits:true,realHistoryPreserved:true,sameDocumentHistoryPreserved:true,destroyedOnce:true,
    componentSourceUpdated:true,componentRemovedWithoutPageClose:true,currentRouteAliases:true,hiddenPageReadsCurrentRoute:true,routeRestoredAfterBack:true});
  result.passed = true;
  result.unloads = unloads;
  result.requests = requests;
  result.adapter = process.argv.includes("--legacy") ? "legacy" : "official";
  fs.writeFileSync(
    path.join(out, "result-" + result.adapter + ".json"),
    JSON.stringify(result, null, 2),
  );
  fs.writeFileSync("docs/h5-history-contract-result.json",JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result));
} catch (e) {
  fs.writeFileSync(path.join(out, "failure.log"), t?.logs.join("") || "");
  if (t) {
    const status = await t
      .call("runner_status")
      .catch((error) => ({ error: String(error) }));
    fs.writeFileSync(
      path.join(out, "failed-state.json"),
      JSON.stringify({ status, requests, result }, null, 2),
      { mode: 0o600 },
    );
  }
  throw e;
} finally {
  await t?.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
