import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectPackage } from "../src/loader";
import { componentPath, readCompiledPlugins } from "../src/loader/plugins";
import { readCompiledManifest } from "../src/loader/formats";
const provider = "wx" + "0000000000000006";
const privateRoot = `plugin-private://${provider}/`;
const viewFactory = `publishDomainComponents({'plugin://${provider}/public':'${privateRoot}card'});__wxAppCode__['${privateRoot}card.wxml']=function(){throw Error('preflight must never execute templates')};`;
const factory = `definePlugin('plugin://${provider}',function(define,require,module,exports,global){
 throw Error('NEVER execute during preflight');
 global.__wxAppCode__['${privateRoot}card.json']={usingComponents:{label:'./nested/label'}};
 __wxCodeSpace__.addComponentStaticConfig('nested/label',{usingComponents:{card:'../card'}});
 global.publishDomainComponents({'plugin://${provider}/public':'${privateRoot}card'});
});`;
function fixture(t: any, overrides: any = {}, files: Record<string, string> = {}) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-plugin-plan-"));
  t.after(() => fs.rmSync(packageDir, {
    recursive: true,
    force: true
  }));
  const app = {
    pages: ["home"],
    entryPagePath: "home",
    plugins: {
      example: {
        provider,
        version: "1.0.0"
      }
    },
    ...overrides
  };
  for (const [name, text] of Object.entries({
    "app-config.json": JSON.stringify(app),
    "home.html": "",
    "webview.app.js": "",
    "appservice.app.js": factory,
    "common.app.js": `__wxAppCode__['home.json']={usingComponents:{card:'plugin://example/public'}};`,
    ...files
  })) {
    const file = path.join(packageDir, name);
    fs.mkdirSync(path.dirname(file), {
      recursive: true
    });
    fs.writeFileSync(file, text);
  }
  return {
    packageDir,
    app
  };
}
test("bundled plugin aliases and nested code-space dependencies use real static registrations", t => {
  const c = fixture(t),
    plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.deepEqual(plan.pages.home.dependencies, [privateRoot + "card", privateRoot + "nested/label"]);
  assert.deepEqual(plan.pages.home.deferredComponents, []);
  assert.equal(readCompiledPlugins(c.packageDir).factories[provider], "appservice.app.js");
});
test("embedded plugin files resolve to actual parent factories in their package scope", t => {
  const c = fixture(t, {
    subPackages: [{
      root: "feature/"
    }]
  }, {
    "webview.app.js": viewFactory,
    "feature/appservice.app.js": factory,
    "feature/webview.app.js": viewFactory
  });
  const {
    scriptAliases
  } = inspectPackage(c);
  for (const prefix of ["", "feature/"]) {
    assert.equal(scriptAliases[`${prefix}__plugin__/${provider}/appservice.js`], prefix + "appservice.app.js");
    assert.equal(scriptAliases[`${prefix}__plugin__/${provider}/pageframe.js`], prefix + "webview.app.js");
  }
  assert.equal(scriptAliases[`unrelated/__plugin__/${provider}/pageframe.js`], undefined);
});
test("embedded plugin aliases preserve standalone files and require real view registrations", t => {
  const c = fixture(t, {}, {
    "webview.app.js": viewFactory,
    [`__plugin__/${provider}/pageframe.js`]: "standalone view",
    [`__plugin__/${provider}/appservice.js`]: "standalone service"
  });
  assert.equal(inspectPackage(c).scriptAliases[`__plugin__/${provider}/pageframe.js`], undefined);
  assert.equal(inspectPackage(c).scriptAliases[`__plugin__/${provider}/appservice.js`], undefined);
  fs.unlinkSync(path.join(c.packageDir, `__plugin__/${provider}/pageframe.js`));
  for (const source of ["// " + viewFactory, `const data=${JSON.stringify(viewFactory)};`, `publishDomainComponents({'plugin://${provider}/public':'${privateRoot}card'});`]) {
    fs.writeFileSync(path.join(c.packageDir, "webview.app.js"), source);
    assert.equal(inspectPackage(c).scriptAliases[`__plugin__/${provider}/pageframe.js`], undefined);
  }
});
test("JS API plugins with private templates do not require public component exports", t => {
  const c = fixture(t, {
    subPackages: [{
      root: "feature/"
    }]
  }, {
    "feature/appservice.app.js": factory,
    "feature/webview.app.js": `__wxAppCode__['${privateRoot}internal.wxml']=function(){throw Error('preflight must not execute')};`
  });
  const alias = `feature/__plugin__/${provider}/pageframe.js`;
  assert.equal(inspectPackage(c).scriptAliases[alias], "feature/webview.app.js");
  fs.writeFileSync(path.join(c.packageDir, "feature/appservice.app.js"), "App({});");
  assert.equal(inspectPackage(c).scriptAliases[alias], undefined);
});
test("declarations and plugin.json resources never substitute for a compiled plugin factory", t => {
  const c = fixture(t, {}, {
    "appservice.app.js": "App({});",
    [`__plugin__/${provider}/plugin.json`]: "{}"
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, false);
  assert.match(plan.errors[0].message, /factory is missing/);
  assert.equal(plan.errors[0].code, "PLUGIN_DEPENDENCY_UNRESOLVED");
});
test("unknown exports and undeclared providers remain errors even when other plugin code is present", t => {
  const c = fixture(t, {}, {
    "common.app.js": `__wxAppCode__['home.json']={usingComponents:{card:'plugin://example/absent'}};`
  });
  assert.match(inspectPackage(c).errors[0].message, /export is not registered/);
  c.app.plugins = {};
  assert.match(inspectPackage(c).errors[0].message, /not declared/);
});
test("deferred plugins report their fallback and still validate the fallback's real chunk", t => {
  const c = fixture(t, {}, {
    "appservice.app.js": "App({});",
    "common.app.js": `__wxAppCode__['home.json']={usingComponents:{card:'plugin://example/public',fallback:'/fallback'},componentPlaceholder:{card:'fallback'}}; initializeCodeChunk('fallback-chunk',['fallback']);`,
    "fallback-chunk.appservice.js": "",
    "fallback-chunk.webview.js": ""
  });
  let plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.equal(plan.pages.home.deferredComponents?.length, 1);
  assert.deepEqual(plan.pages.home.dependencies, ["fallback"]);
  fs.unlinkSync(path.join(c.packageDir, "fallback-chunk.webview.js"));
  assert.ok(inspectPackage(c).errors.some(e => e.code === "VIEW_DEPENDENCY_MISSING"));
  fs.writeFileSync(path.join(c.packageDir, "common.app.js"), `__wxAppCode__['home.json']={usingComponents:{card:'plugin://example/public'},componentPlaceholder:{card:'typo'}};`);
  assert.equal(inspectPackage(c).startupReady, false);
});
test("plugin code spaces do not inherit host global component dependencies", t => {
  const c = fixture(t, {
    usingComponents: {
      host: "/host"
    }
  }, {
    "common.app.js": `__wxAppCode__['home.json']={usingComponents:{card:'plugin://example/public'}};__wxAppCode__['host.json']={usingComponents:{}};`
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.ok(!plan.pages.home.dependencies.some(d => d.startsWith(privateRoot) && d.endsWith("/host")));
});
test("subpackage plugin factory belongs to that scope and is not eagerly available to main", t => {
  const c = fixture(t, {
    pages: ["home", "feature/page"],
    subPackages: [{
      root: "feature/",
      plugins: {
        example: {
          provider,
          version: "1"
        }
      }
    }]
  }, {
    "appservice.app.js": "App({});",
    "feature/appservice.app.js": factory,
    "feature/webview.app.js": "",
    "feature/page.html": "",
    "feature/common.app.js": `__wxAppCode__['feature/page.json']={usingComponents:{card:'plugin://example/public'}};`
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, false);
  assert.match(plan.errors[0].message, /factory is missing/);
  assert.deepEqual(plan.pages["feature/page"].issues, []);
});
test("protocol names survive manifest normalization and cannot escape their plugin code space", t => {
  const c = fixture(t, {}, {
    "feature/common.app.js": `initializeCodeChunk('chunk', ['${privateRoot}card']);__wxAppCode__['${privateRoot}card.json']={usingComponents:{}};`
  });
  const m = readCompiledManifest(c.packageDir, "feature/");
  assert.equal(m.chunks[privateRoot + "card"], "feature/chunk");
  assert.ok(m.components[privateRoot + "card"]);
  assert.equal(componentPath("../card", privateRoot + "nested/label"), privateRoot + "card");
  for (const value of [`${privateRoot}../escape`, "plugin://example", "https://remote/component"]) assert.throws(() => componentPath(value));
  assert.throws(() => componentPath("../../escape", privateRoot + "nested/label"));
});
