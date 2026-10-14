import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const dir = fs.mkdtempSync(
  path.join(os.tmpdir(), "wxapp-loader-dependencies-"),
);
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const config = JSON.parse(
  fs.readFileSync(path.join(pkg, "app-config.json"), "utf8"),
);
config.pages.push("feature/a", "feature/b", "feature/bounce", "broken/page");
config.subPackages = [{ root: "feature/" }, { root: "broken/" }];
fs.writeFileSync(path.join(pkg, "app-config.json"), JSON.stringify(config));
for (const root of ["feature", "broken"]) fs.mkdirSync(path.join(pkg, root));
fs.writeFileSync(
  path.join(pkg, "feature/app-service.js"),
  `
globalThis.featureLoads=(globalThis.featureLoads||0)+1;
define('feature/helper.js', function(require,module,exports){module.exports={value:'local-module'};});
for(const name of ['a','b','bounce']){
 __wxRoute='feature/'+name;__wxRouteBegin=true;__wxAppCurrentFile__=__wxRoute+'.js';
 Page({data:{result:'feature '+name},onLoad(){if(name==='bounce')wx.redirectTo({url:'/next'})},onInput(e){this.setData({result:'edited:'+e.detail.value})}});
}
`,
);
fs.writeFileSync(
  path.join(pkg, "broken/app-service.js"),
  "globalThis.failedLoads=(globalThis.failedLoads||0)+1;throw new Error('fixture partial bootstrap failure');",
);
for (const route of config.pages.slice(2)) {
  fs.writeFileSync(
    path.join(pkg, route + ".html"),
    `<script>document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:$gwx('${route}.wxml')}}));</script>`,
  );
}
const t = await managedFixture({ packageDir: pkg });
try {
  const { call } = t;
  assert.equal(
    (await call("runner_evaluate", { expression: "typeof featureLoads" }))
      .result.value,
    "undefined",
  );
  const preload = await call("runner_evaluate", {
    expression: `define('loader-probe.js',function(require,module,exports){exports.load=name=>require.async(name)}); require('loader-probe.js').load('./feature/helper.js').then(m=>({value:m.value,loads:globalThis.featureLoads}))`,
    awaitPromise: true,
  });
  assert.deepEqual(preload.result.value, {
    value: "local-module",
    loads: 1,
  });
  await call("runner_navigate", { method: "navigateTo", url: "/feature/a" });
  await call("runner_wait", { kind: "text", text: "feature a" });
  await call("runner_input", { selector: "textarea", text: "real subpackage" });
  assert.equal(
    (
      await call("runner_wait", {
        kind: "text",
        text: "edited:real subpackage",
      })
    ).status,
    "matched",
  );
  await call("runner_navigate", { method: "redirectTo", url: "/feature/b" });
  assert.equal(
    (await call("runner_wait", { kind: "text", text: "feature b" })).status,
    "matched",
  );
  assert.equal(
    (await call("runner_evaluate", { expression: "featureLoads" })).result
      .value,
    1,
  );
  const before = await call("runner_status");
  const failedPreload = await call("runner_evaluate", {
    expression: `require('loader-probe.js').load('./broken/helper.js').then(()=>({unexpectedSuccess:true}),()=>({failed:true,loads:globalThis.failedLoads}))`,
    awaitPromise: true,
  });
  assert.deepEqual(failedPreload.result.value, {
    failed: true,
    loads: 1,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await t.client.callTool({
      name: "runner_navigate",
      arguments: { method: "navigateTo", url: "/broken/page" },
    });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /fixture partial bootstrap failure/);
    assert.equal((await call("runner_status")).current.id, before.current.id);
  }
  assert.equal(
    (await call("runner_evaluate", { expression: "failedLoads" })).result.value,
    1,
  );
  await call("runner_navigate", { method: "reLaunch", url: "/feature/bounce" });
  await until(
    async () => (await call("runner_status")).current?.route === "next",
  );
  assert.equal(
    (await call("runner_wait", { kind: "text", text: "Next page" })).status,
    "matched",
  );
  await call("runner_navigate", { method: "reLaunch", url: "/home" });
  assert.equal(
    (await call("runner_wait", { kind: "element", selector: "textarea" }))
      .status,
    "matched",
  );
  assert.ok(!t.logs.join("").includes("ERR_FAILED (-2) loading"));
  const report = {
    passed: true,
    platform: process.platform,
    onDemandSubpackage: true,
    nativeSubpackageTaskCallbacks: true,
    failedPreloadNotReplayedByNavigation: true,
    originalHandlerAndSetData: true,
    bootstrapOncePerContext: true,
    failedBootstrapNotReplayed: true,
    failurePreservesPageStack: true,
    businessAndExternalNavigationSerialized: true,
  };
  fs.writeFileSync(
    "docs/loader-dependencies-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
