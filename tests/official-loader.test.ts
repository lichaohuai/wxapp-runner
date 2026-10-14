import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OfficialPackageAdapter } from "../src/loader/official";
function fixture(t: any, prepare?: (name: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-loader-"));
  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));
  for (const dir of ["", "sub", "independent"]) for (const file of ["app-wxss.js", "common.app.js", "webview.app.js", "page.html"]) {
    const f = path.join(root, dir, file);
    fs.mkdirSync(path.dirname(f), {
      recursive: true
    });
    fs.writeFileSync(f, "throw Error('Business code must never execute in scheduler');");
  }
  const requested: string[] = [],
    ready: string[] = [];
  const adapter = new OfficialPackageAdapter({
    packageDir: root,
    baselibDir: path.resolve("../baselib"),
    wxConfig: {
      isLazyLoad: true,
      subPackages: [{
        root: "sub/"
      }, {
        root: "independent/",
        independent: true
      }]
    }
  }, {
    async preparePackage(name) {
      requested.push(name);
      await prepare?.(name);
    },
    publish(name, data) {
      assert.equal(name, "onSubPackageReady");
      ready.push(data.moduleName);
    },
    log() {}
  });
  return {
    root,
    adapter,
    requested,
    ready
  };
}
test("original scheduler preserves lazy bootstrap ordering and prepares ordinary packages once", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.adapter.pageFiles("sub/page"), ["app-wxss.js", "common.app.js", "webview.app.js", "sub/app-wxss.js", "sub/common.app.js", "sub/webview.app.js"]);
  assert.deepEqual(f.requested, ["__APP__", "/sub/"]);
  assert.deepEqual(f.ready, f.requested);
  await f.adapter.pageFiles("sub/page");
  assert.equal(f.requested.length, 2);
  assert.match(f.adapter.provenance.sha256, /^[a-f0-9]{64}$/);
});
test("original scheduler distinguishes cold independent pages from warm main-package navigation", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.adapter.pageFiles("independent/page"), ["independent/app-wxss.js", "independent/common.app.js", "independent/webview.app.js"]);
  assert.deepEqual(f.requested, ["/independent/"]);
  await f.adapter.pageFiles("page");
  assert.equal((await f.adapter.pageFiles("independent/page"))[0], "app-wxss.js");
});
test("native preparation failure cannot publish readiness or poison future package readiness", async t => {
  let fail = true;
  const f = fixture(t, async name => {
    if (name === "/sub/" && fail) throw Error("missing subpackage");
  });
  await assert.rejects(f.adapter.pageFiles("sub/page"), /missing subpackage/);
  assert.deepEqual(f.ready, ["__APP__"]);
  fail = false;
  await f.adapter.pageFiles("sub/page");
  assert.deepEqual(f.ready, ["__APP__", "/sub/"]);
  assert.deepEqual(f.requested, ["__APP__", "/sub/", "/sub/"]);
});
test("concurrent loads are rejected without corrupting the active page read", async t => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {
    release = resolve;
  });
  const f = fixture(t, () => barrier);
  const first = f.adapter.pageFiles("page");
  await assert.rejects(f.adapter.pageFiles("sub/page"), /serialized/);
  release();
  assert.equal((await first)[0], "app-wxss.js");
});
test("official service module applies preload before the full configuration event", async () => {
  const {
    OfficialServiceAdapter
  } = await import("../src/loader/service");
  const vm = await import("node:vm");
  const context = vm.createContext({
    events: [] as any[]
  });
  const adapter = new OfficialServiceAdapter(path.resolve("../baselib"), {
    appId: "wx" + "0000000000000001",
    platform: "android",
    marker: "full"
  }, {
    read: () => 'events.push({kind:"lib",preload:__wxConfig.preload,marker:__wxConfig.marker});',
    evaluate: source => vm.runInContext(source, context),
    publish: name => context.events.push({
      kind: name,
      marker: context.__wxConfig.marker
    }),
    log() {}
  });
  await adapter.preload();
  await adapter.configure();
  assert.deepEqual(JSON.parse(JSON.stringify(context.events)), [{
    kind: "lib",
    preload: true
  }, {
    kind: "onWxConfigReady",
    marker: "full"
  }]);
  assert.match(adapter.provenance.factorySha256, /^[a-f0-9]{64}$/);
});
