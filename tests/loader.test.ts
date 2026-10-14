import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectPackage, pagePlan, readPackageConfig } from "../src/loader";
import { resolveAppid, wxConfig, readConfig } from "../src/config";
import { localSubpackage } from "../src/loader/subpackages";
function fixture(t: any, files: Record<string, string> = {}, overrides: any = {}) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-fixture-"));
  t.after(() => fs.rmSync(packageDir, {
    recursive: true,
    force: true
  }));
  const app = {
    pages: ["pages/home", "pages/other"],
    entryPagePath: "pages/home.html",
    renderer: {
      default: "webview"
    },
    componentFramework: {
      default: "glass-easel"
    },
    ...overrides
  };
  for (const [name, text] of Object.entries({
    "app-config.json": JSON.stringify(app),
    "app-service.js": "throw new Error('inspection must never execute this');",
    "webview.app.js": "",
    "pages/home.html": "",
    "pages/other.html": "",
    ...files
  })) {
    fs.mkdirSync(path.dirname(path.join(packageDir, name)), {
      recursive: true
    });
    fs.writeFileSync(path.join(packageDir, name), text);
  }
  return {
    packageDir,
    app
  };
}
test("loader selection defaults to official and rejects unknown settings before startup", t => {
  const c = fixture(t);
  const args = ["--package", c.packageDir, "--appid", "wx" + "0000000000000001", "--config", path.join(c.packageDir, "no-config.json")];
  assert.equal(readConfig(args).loaderAdapter, "official");
  assert.equal(readConfig([...args, "--loader-adapter", "legacy"]).loaderAdapter, "legacy");
  assert.throws(() => readConfig([...args, "--loader-adapter", "typo"]), /LOADER_ADAPTER_INVALID/);
});
test("static plans accept whitespace/single quotes and ignore misleading comments", t => {
  const c = fixture(t, {
    "common.app.js": `// initializeCodeChunk("wrong", ["pages/home"])
    engine.initializeCodeChunk(
      'chunk_7', ['pages/home', 'components/card']
    );`,
    "chunk_7.webview.js": ""
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.deepEqual(plan.pages["pages/home"].files, ["common.app.js", "webview.app.js", "chunk_7.webview.js"]);
});
test("entry dependency blocks startup; a missing later page remains a route-specific error", t => {
  const c = fixture(t, {
    "common.app.js": `initializeCodeChunk('missing', ['pages/other']);`
  });
  let plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.equal(plan.warnings[0].code, "VIEW_DEPENDENCY_MISSING");
  assert.throws(() => pagePlan({
    ...c,
    plan
  }, "pages/other"), /VIEW_DEPENDENCY_MISSING.*pages\/other/);
  fs.writeFileSync(path.join(c.packageDir, "common.app.js"), `initializeCodeChunk('missing', ['pages/home']);`);
  plan = inspectPackage(c);
  assert.equal(plan.startupReady, false);
  assert.equal(plan.errors[0].file, "missing.webview.js");
});
test("component dependency closure handles relative paths, cycles and shared chunks", t => {
  const c = fixture(t, {
    "common.app.js": `initializeCodeChunk('home', ['pages/home']); initializeCodeChunk('shared', ['components/card', 'components/label']);`,
    "home.webview.js": "",
    "shared.webview.js": ""
  }, {
    page: {
      "pages/home.html": {
        window: {
          usingComponents: {
            card: "../components/card"
          }
        }
      },
      "components/card.html": {
        usingComponents: {
          label: "./label"
        }
      },
      "components/label.html": {
        usingComponents: {
          card: "./card"
        }
      }
    }
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.deepEqual(plan.pages["pages/home"].dependencies, ["components/card", "components/label"]);
  assert.equal(plan.pages["pages/home"].files.filter(f => f === "shared.webview.js").length, 1);
});
test("subpackage manifests resolve both local and already rooted routes", t => {
  const c = fixture(t, {
    "pkg/common.app.js": `initializeCodeChunk('chunk_2', ['pages/child', 'pkg/pages/other']);`,
    "pkg/webview.app.js": "",
    "pkg/appservice.app.js": "",
    "pkg/chunk_2.appservice.js": "",
    "pkg/chunk_2.webview.js": "",
    "pkg/pages/child.html": "",
    "pkg/pages/other.html": ""
  }, {
    pages: ["pages/home", "pkg/pages/child", "pkg/pages/other"],
    subPackages: [{
      root: "pkg"
    }]
  });
  const plan = inspectPackage(c);
  for (const route of ["pkg/pages/child", "pkg/pages/other"]) assert.ok(plan.pages[route].files.includes("pkg/chunk_2.webview.js"));
  assert.equal(plan.warnings.length, 0);
});
test("subpackage chunk names may already contain the package root", t => {
  const c = fixture(t, {
    "extra/common.app.js": "initializeCodeChunk('/extra/chunk_1', ['/extra/page']);",
    "extra/appservice.app.js": "",
    "extra/webview.app.js": "",
    "extra/chunk_1.webview.js": "",
    "extra/chunk_1.appservice.js": "",
    "extra/page.html": ""
  }, {
    pages: ["pages/home", "extra/page"],
    subPackages: [{
      root: "extra/"
    }]
  });
  const plan = inspectPackage(c),
    p = plan.pages["extra/page"];
  assert.deepEqual(p.issues, []);
  assert.ok(p.files.includes("extra/chunk_1.webview.js"));
  assert.deepEqual(p.logicFiles, ["extra/common.app.js", "extra/appservice.app.js"]);
  assert.equal(p.packageRoot, "extra/");
  fs.unlinkSync(path.join(c.packageDir, "extra/appservice.app.js"));
  assert.equal(inspectPackage(c).startupReady, true);
  assert.throws(() => pagePlan(c, "extra/page"), /SUBPACKAGE_LOGIC_MISSING/);
});
test("subpackage settings inherit between app defaults and page overrides", t => {
  const c = fixture(t, {
    "pkg/app-service.js": "",
    "pkg/page.html": "",
    "pkg/other.html": ""
  }, {
    pages: ["pages/home", "pkg/page", "pkg/other"],
    componentFramework: {
      default: "exparser"
    },
    subPackages: [{
      root: "pkg/",
      renderer: "skyline",
      componentFramework: "glass-easel"
    }],
    page: {
      "pkg/other.html": {
        window: {
          renderer: "webview",
          componentFramework: "exparser"
        }
      }
    }
  });
  const plan = inspectPackage(c);
  assert.equal(plan.pages["pkg/page"].renderer, "skyline");
  assert.equal(plan.pages["pkg/page"].framework, "glass-easel");
  assert.equal(plan.pages["pkg/page"].effectiveRenderer, "webview");
  assert.equal(plan.pages["pkg/other"].framework, "exparser");
  assert.equal(plan.pages["pkg/other"].rendererFallback, null);
});
test("local subpackage resolution accepts declared aliases and rejects missing entries before execution", t => {
  const c = fixture(t, {
    "extra/common.app.js": "throw Error('never execute in preflight')",
    "extra/appservice.app.js": ""
  }, {
    subPackages: [{
      root: "extra/",
      name: "feature"
    }, {
      root: "missing/"
    }]
  });
  for (const name of ["extra", "/extra/", "feature"]) assert.deepEqual(localSubpackage(c.packageDir, c.app, name), {
    moduleName: "/extra/",
    files: ["extra/common.app.js", "extra/appservice.app.js"]
  });
  assert.throws(() => localSubpackage(c.packageDir, c.app, "missing"), /SUBPACKAGE_LOGIC_MISSING/);
  assert.throws(() => localSubpackage(c.packageDir, c.app, "unknown"), /not registered/);
  assert.throws(() => localSubpackage(c.packageDir, c.app, "../extra"), /Invalid/);
});
test("split compiled layouts enable native lazy injection without mutating package config", t => {
  const c = fixture(t, {
    "common.app.js": "",
    "appservice.app.js": ""
  });
  assert.equal(wxConfig({
    ...c,
    plan: inspectPackage(c)
  }).isLazyLoad, true);
  assert.equal(c.app.isLazyLoad, undefined);
  fs.unlinkSync(path.join(c.packageDir, "appservice.app.js"));
  assert.equal(wxConfig({
    ...c,
    plan: inspectPackage(c)
  }).isLazyLoad, false);
});
test("split entries and shared chunk aliases come from package metadata, never app identity", t => {
  const c = fixture(t, {
    "appservice.app.js": "",
    "common.app.js": "initializeCodeChunk('group_a',['pages/home']);",
    "group_a.appservice.js": "",
    "group_a.webview.js": ""
  });
  let plan = inspectPackage(c);
  assert.deepEqual(plan.logicFiles, ["common.app.js", "appservice.app.js"]);
  assert.equal(plan.scriptAliases["group_a.common.js"], "common.app.js");
  assert.equal(plan.scriptAliases["unknown.common.js"], undefined);
  fs.writeFileSync(path.join(c.packageDir, "group_a.common.js"), "");
  assert.equal(inspectPackage(c).scriptAliases["group_a.common.js"], undefined);
  fs.unlinkSync(path.join(c.packageDir, "group_a.appservice.js"));
  plan = inspectPackage(c);
  assert.equal(plan.startupReady, false);
  assert.ok(plan.errors.some(e => e.code === "LOGIC_DEPENDENCY_MISSING"));
});
test("Skyline declarations use the host WebView backend without changing package configuration", t => {
  const c = fixture(t, {}, {
    page: {
      "pages/other.html": {
        renderer: "skyline"
      }
    }
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.deepEqual(plan.pages["pages/other"].issues, []);
  assert.equal(plan.pages["pages/other"].renderer, "skyline");
  assert.equal(plan.pages["pages/other"].effectiveRenderer, "webview");
  assert.equal(plan.pages["pages/other"].rendererFallback, "host-skyline-unavailable");
  assert.ok(plan.warnings.some(e => e.code === "RENDERER_FALLBACK" && e.route === "pages/other"));
  assert.equal(c.app.page["pages/other.html"].renderer, "skyline");
  assert.equal(readPackageConfig(c.packageDir).page["pages/other.html"].renderer, "skyline");
  assert.equal(plan.pages["pages/home"].renderer, "webview");
  assert.equal(plan.pages["pages/home"].rendererFallback, null);
});
test("renderer fallback does not hide missing view files or unsupported backends", t => {
  const c = fixture(t, {}, {
    page: {
      "pages/home.html": {
        window: {
          renderer: "skyline"
        }
      },
      "pages/other.html": {
        window: {
          renderer: "xr-frame"
        }
      }
    }
  });
  fs.unlinkSync(path.join(c.packageDir, "pages/home.html"));
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, false);
  assert.ok(plan.errors.some(e => e.code === "PAGE_FILE_MISSING"));
  assert.equal(plan.pages["pages/other"].issues[0].code, "RENDERER_UNSUPPORTED");
  assert.throws(() => pagePlan({
    ...c,
    plan
  }, "pages/other"), /RENDERER_UNSUPPORTED/);
});
test("global Skyline declarations and explicit WebView overrides remain distinct", t => {
  const c = fixture(t, {}, {
    renderer: {
      default: "skyline"
    },
    page: {
      "pages/other.html": {
        window: {
          renderer: "webview"
        }
      }
    }
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.equal(plan.pages["pages/home"].renderer, "skyline");
  assert.equal(plan.pages["pages/home"].effectiveRenderer, "webview");
  assert.equal(plan.pages["pages/other"].rendererFallback, null);
  c.app.componentFramework.default = "exparser";
  assert.equal(inspectPackage(c).pages["pages/home"].effectiveRenderer, "webview");
  assert.equal(inspectPackage(c).pages["pages/home"].framework, "exparser");
});
test("script frames load shared app-wxss and subpackage templates without HTML wrappers", t => {
  const c = fixture(t, {
    "page-frame.js": "",
    "app-wxss.js": "",
    "extra/page-frame.js": "",
    "extra/app-service.js": "",
    "extra/page.html": ""
  }, {
    pages: ["pages/home", "extra/page"],
    subPackages: [{
      root: "extra/"
    }]
  });
  fs.unlinkSync(path.join(c.packageDir, "webview.app.js"));
  let plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.equal(plan.format, "page-frame-script");
  assert.deepEqual(plan.pages["extra/page"].files, ["page-frame.js", "app-wxss.js", "extra/page-frame.js"]);
  assert.deepEqual(plan.pages["extra/page"].issues, []);
  fs.unlinkSync(path.join(c.packageDir, "app-wxss.js"));
  plan = inspectPackage(c);
  assert.deepEqual(plan.pages["pages/home"].files, ["page-frame.js"]);
});
test("unknown view layouts and dynamic chunk manifests are diagnosed, never guessed", t => {
  const c = fixture(t);
  fs.unlinkSync(path.join(c.packageDir, "webview.app.js"));
  assert.ok(inspectPackage(c).errors.some(e => e.code === "VIEW_FORMAT_UNSUPPORTED"));
  fs.writeFileSync(path.join(c.packageDir, "webview.app.js"), "");
  fs.writeFileSync(path.join(c.packageDir, "common.app.js"), `initializeCodeChunk(getName(), ['pages/home']);`);
  assert.ok(inspectPackage(c).errors.some(e => e.code === "CHUNK_MANIFEST_INVALID"));
});
test("missing base files and unverified versions are reported without executing them", t => {
  const c = fixture(t, {
    "WAVersion.json": '{"version":"0.0.0"}'
  });
  const plan = inspectPackage({
    ...c,
    baselibDir: c.packageDir
  });
  assert.equal(plan.errors.filter(e => e.code === "BASELIB_FILE_MISSING").length, 3);
  assert.ok(plan.warnings.some(e => e.code === "BASELIB_VERSION_UNTESTED"));
});
test("a cached page plan is reused rather than rescanning files on every IPC config request", t => {
  const c = fixture(t);
  const plan = inspectPackage(c);
  fs.unlinkSync(path.join(c.packageDir, "app-config.json"));
  assert.equal(pagePlan({
    ...c,
    plan
  }, "pages/home"), plan.pages["pages/home"]);
});
test("invalid configuration and unregistered entry return actionable diagnostics", t => {
  const c = fixture(t);
  fs.writeFileSync(path.join(c.packageDir, "app-config.json"), "{bad");
  assert.throws(() => readPackageConfig(c.packageDir), /PACKAGE_CONFIG_INVALID/);
  assert.ok(inspectPackage({
    ...c,
    app: {
      ...c.app,
      entryPagePath: "missing.html"
    }
  }).errors.some(e => e.code === "ENTRY_NOT_REGISTERED"));
});
test("application identity comes from explicit config or metadata, never the previous sample", t => {
  const c = fixture(t);
  assert.throws(() => resolveAppid(c.packageDir), /APPID_REQUIRED/);
  fs.writeFileSync(path.join(c.packageDir, "project.config.json"), "{\"appid\":\"" + ("wx" + "0000000000000006") + "\"}");
  assert.equal(resolveAppid(c.packageDir), "wx" + "0000000000000006");
  assert.equal(resolveAppid(c.packageDir, "wx" + "000000000000000a"), "wx" + "000000000000000a");
  assert.throws(() => resolveAppid(c.packageDir, "invalid"), /APPID_REQUIRED/);
});
test("shared webview frames without a chunk registry load adjacent page templates and styles", t => {
  const c = fixture(t, {
    "app-wxss.js": 'throw Error("inspection must not execute templates")',
    "common.app.js": ""
  });
  assert.deepEqual(inspectPackage(c).pages["pages/home"].files, ["common.app.js", "webview.app.js", "app-wxss.js"]);
  fs.writeFileSync(path.join(c.packageDir, "common.app.js"), "initializeCodeChunk('home', ['pages/home']);");
  fs.writeFileSync(path.join(c.packageDir, "home.webview.js"), "");
  assert.deepEqual(inspectPackage(c).pages["pages/home"].files, ["common.app.js", "webview.app.js", "home.webview.js"]);
});
test("exparser literal lazy chunk tables resolve page and shared files without executing callbacks", t => {
  const c = fixture(t, {
    "common.app.js": `[['__COMMON__',['components/shared']],['chunk_9',['pages/home']]].forEach(function(a){a[1].forEach(function(b){__LAZY_CODE_LOADING_CHUNK_MAP__[b]=__LAZY_CODE_LOADING_CHUNK_MAP__[b]||a[0]||''});throw Error('never execute')});`,
    "appservice.app.js": "",
    "chunk_9.appservice.js": "",
    "chunk_9.webview.js": "",
    "app-wxss.js": ""
  }, {
    page: {
      "pages/home.html": {
        usingComponents: {
          shared: "/components/shared"
        }
      }
    }
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.deepEqual(plan.pages["pages/home"].files, ["common.app.js", "webview.app.js", "chunk_9.webview.js"]);
  assert.equal(plan.scriptAliases["__COMMON__.appservice.js"], "appservice.app.js");
  assert.equal(plan.scriptAliases["chunk_9.common.js"], "common.app.js");
});
test("compiled component metadata contributes transitive chunks and preserves deferred placeholders", t => {
  const c = fixture(t, {
    "common.app.js": `initializeCodeChunk('home',['pages/home']);initializeCodeChunk('card',['components/card']);__wxAppCode__['pages/home.json']={usingComponents:{card:'/components/card',later:'/deferred/later'},componentPlaceholder:{later:'view'}};__wxAppCode__['components/card.json']={usingComponents:{}};`,
    "home.webview.js": "",
    "card.webview.js": ""
  }, {
    subPackages: [{
      root: "deferred/"
    }]
  });
  const plan = inspectPackage(c);
  assert.equal(plan.startupReady, true);
  assert.deepEqual(plan.pages["pages/home"].dependencies, ["components/card"]);
  assert.ok(plan.pages["pages/home"].files.includes("card.webview.js"));
  fs.unlinkSync(path.join(c.packageDir, "card.webview.js"));
  assert.equal(inspectPackage(c).startupReady, false);
});
