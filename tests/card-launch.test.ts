import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig, wxConfig } from "../src/config";
import { inspectPackage } from "../src/loader";
import { resolveLaunchTarget } from "../src/loader/launch-target";
import { callLaunch, launchArguments, launchSchema } from "../src/launch";
import { parseTool } from "../src/mcp/tools";
import { OfficialPages } from "../src/loader/pages";
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wx-card-launch-"));
  const pkg = path.join(root, "package");
  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));
  const appid = "wx" + "0000000000000006";
  const app = {
    pages: ["pages/home", "pages/detail", "part/detail"],
    entryPagePath: "pages/home.html",
    renderer: "webview",
    componentFramework: "glass-easel",
    subPackages: [{
      root: "part",
      pages: ["detail"]
    }]
  };
  const files: Record<string, string> = {
    "app-config.json": JSON.stringify(app),
    "app-service.js": "throw Error('static test must not run business code')",
    "webview.app.js": "",
    "pages/home.html": "",
    "pages/detail.html": "",
    "part/detail.html": "",
    "part/app-service.js": "",
    "part/webview.app.js": ""
  };
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(pkg, name);
    fs.mkdirSync(path.dirname(file), {
      recursive: true
    });
    fs.writeFileSync(file, value);
  }
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    format: 1,
    complete: true,
    appid,
    version: 83
  }));
  const args = ["--package", pkg, "--appid", appid, "--config", path.join(root, "none.json")];
  return {
    app,
    appid,
    pkg,
    root,
    args
  };
}
test("default launch stays on the package entry, card launch preserves query and package identity", t => {
  const f = fixture(t),
    original = fs.readFileSync(path.join(f.pkg, "app-config.json"), "utf8");
  const basic = readConfig(f.args);
  assert.deepEqual(wxConfig(basic).appLaunchInfo, {
    path: "pages/home",
    query: {},
    scene: 1001
  });
  const card = "/pages/detail.html?data=%7B%22name%22%3A%22%E4%B8%AD%E6%96%87%25%22%7D&literal=a+b&raw=%broken&eq=a=b&x=1&x=2&__proto__=safe";
  const config = readConfig([...f.args, "--page-path", card, "--user-data", path.join(f.root, "account-a")]);
  const launch = wxConfig(config).appLaunchInfo;
  assert.equal(launch.path, "pages/detail");
  assert.equal(launch.query.data, "%7B%22name%22%3A%22%E4%B8%AD%E6%96%87%25%22%7D");
  assert.equal(launch.query.literal, "a+b");
  assert.equal(launch.query.raw, "%broken");
  assert.equal(launch.query.eq, "a=b");
  assert.equal(launch.query.x, "2");
  assert.equal(launch.query.__proto__, "safe");
  assert.equal(config.launchTarget.url, card.slice(1).replace(".html?", "?"));
  assert.equal(config.app.entryPagePath, "pages/home.html");
  assert.equal(config.userDataDir, path.join(f.root, "account-a"));
  assert.equal(wxConfig(config).accountInfo.appVersion, 83);
  assert.equal(fs.readFileSync(path.join(f.pkg, "app-config.json"), "utf8"), original);
  assert.equal(readConfig([...f.args, "--page-path", "/part/detail"]).launchTarget.path, "part/detail");
  assert.throws(() => readConfig([...f.args, "--page-path", card, "--app-version", "bad"]), /PACKAGE_VERSION_INVALID/);
});
test("external card paths reject URLs, traversal, empty paths and undeclared pages before startup", t => {
  const {
    app
  } = fixture(t);
  for (const target of ["", "https://outside.test/pages/detail", "//outside.test/detail", "../pages/detail", "pages/../pages/detail", "/pages/%2e%2e/detail", "/pages%2fdetail", "pages/\\detail", "pages/detail#fragment", "pages/detail\n", "?id=1", "pages//detail"]) assert.throws(() => resolveLaunchTarget(app, target), /LAUNCH_PATH_INVALID/, target);
  assert.throws(() => resolveLaunchTarget(app, "pages/missing?id=1"), /LAUNCH_PAGE_NOT_REGISTERED/);
});
test("startup preflight checks the requested card page's missing dependencies", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.pkg, "common.app.js"), "initializeCodeChunk('missing', ['pages/detail']);");
  assert.equal(inspectPackage(readConfig(f.args)).startupReady, true);
  const plan = inspectPackage(readConfig([...f.args, "--page-path", "pages/detail?x=1"]));
  assert.equal(plan.entry, "pages/detail");
  assert.equal(plan.startupReady, false);
  assert.ok(plan.errors.some(e => e.code === "VIEW_DEPENDENCY_MISSING"));
});
test("launcher and runtime tool carry card route and explicit storage identity as separate arguments", () => {
  const pagePath = 'pages/detail?value=$(not-a-command)&literal=a+b';
  const launch = launchSchema.parse({
    appid: "wx" + "0000000000000006",
    version: 83,
    pagePath,
    userDataDir: "/tmp/account-a"
  });
  const args = launchArguments(launch, "/tmp/package", "/tmp/connection.json", "/tmp/private.json");
  assert.equal(args[args.indexOf("--page-path") + 1], pagePath);
  assert.equal(args[args.indexOf("--user-data") + 1], "/tmp/account-a");
  assert.equal((parseTool("runner_runtime", {
    action: "start",
    packageDir: "/tmp/package",
    pagePath
  }) as any).pagePath, pagePath);
  assert.throws(() => launchSchema.parse({
    appid: launch.appid,
    version: -1
  }));
  assert.throws(() => launchSchema.parse({
    appid: launch.appid
  }));
});
test("original official navigator cold-launches the card page with unchanged business encoding", async t => {
  const f = fixture(t),
    query = "data=%7B%22n%22%3A%2240%25%22%7D&literal=a+b";
  const config = readConfig([...f.args, "--page-path", "pages/detail?" + query]);
  const events: any[] = [];
  let id = 0;
  const pages = new OfficialPages(path.resolve("../baselib"), wxConfig(config), {
    async create() {
      return {
        id: ++id,
        evalPreloadCode: async () => {}
      };
    },
    async prepare() {},
    load(page) {
      queueMicrotask(() => {
        pages.acknowledge(page.id, "loaded");
        pages.acknowledge(page.id, "readyed");
      });
    },
    remove() {},
    show() {},
    changed() {},
    event(name, data) {
      events.push([name, data]);
    },
    back(_page, delta) {
      return delta;
    },
    async modal() {
      return {
        confirm: true
      };
    },
    log() {}
  });
  try {
    await pages.navigate("appLaunch");
    const route = events.find(([name]) => name === "onAppRoute")[1];
    assert.equal(route.path, "pages/detail.html");
    assert.equal(route.openType, "appLaunch");
    assert.equal(route.query.data, config.launchTarget.query.data);
    assert.equal(route.query.literal, "a+b");
    assert.equal(id, 1);
  } finally {
    await pages.close();
  }
});
test("launcher unwraps supervisor HTTP results before reporting or comparing the running version", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wx-launch-status-"));
  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));
  const connectionFile = path.join(root, "connection.json"),
    appid = "wx" + "0000000000000006";
  fs.writeFileSync(connectionFile, JSON.stringify({
    endpoint: "http://127.0.0.1:1",
    token: "fixture",
    appid,
    runtimeId: "fixture-runtime"
  }));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    result: {
      appid,
      appVersion: 83,
      serviceReady: true
    }
  }), {
    status: 200
  }));
  const status: any = await callLaunch({
    action: "status"
  }, {
    connectionFile,
    repoRoot: root
  });
  assert.equal(status.runtime.appVersion, 83);
  assert.equal(((await callLaunch({
    appid,
    version: 83
  }, {
    connectionFile,
    repoRoot: root
  })) as any).reused, true);
  await assert.rejects(callLaunch({
    appid,
    version: 84
  }, {
    connectionFile,
    repoRoot: root
  }), /different or unknown package version/);
  await assert.rejects(callLaunch({
    appid,
    version: 83,
    pagePath: "next?a=b"
  }, {
    connectionFile,
    repoRoot: root
  }), /fresh connection file/);
  await assert.rejects(callLaunch({
    appid,
    version: 83,
    userDataDir: "/tmp/another-account"
  }, {
    connectionFile,
    repoRoot: root
  }), /fresh connection file/);
});
