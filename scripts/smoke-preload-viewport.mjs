import { managedFixture, until } from "./managed-test-runtime.mjs";
import { componentFixture } from "./component-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const report = { platform: process.platform, passed: false, frameworks: [] };
for (const framework of ["exparser", "glass-easel"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-preload-viewport-"));
  let t;
  try {
    const pkg = componentFixture(dir, framework, {
      leafTemplate:
        '<button id="leaf-button" style="width:375rpx" bindtap="increase">nested:{{label}}:{{count}}</button>',
    });
    if (framework === "exparser") {
      const f = path.join(pkg, "page-frame.html");
      fs.writeFileSync(
        f,
        fs
          .readFileSync(f, "utf8")
          .replace(
            "id:'leaf-button',bindtap",
            "id:'leaf-button',style:'width:375rpx',bindtap",
          ),
      );
    }
    const f = path.join(pkg, "app-config.json");
    const config = JSON.parse(fs.readFileSync(f));
    config.tabBar = {
      list: [
        { pagePath: "home", text: "Home" },
        { pagePath: "next", text: "Next" },
      ],
    };
    fs.writeFileSync(f, JSON.stringify(config));
    const serviceFile = path.join(pkg, "app-service.js");
    const resizeMethod =
      "onResize(e){this.setData({lastResize:e.size,resizeCount:(this.data.resizeCount||0)+1});},";
    fs.writeFileSync(
      serviceFile,
      fs
        .readFileSync(serviceFile, "utf8")
        .replace("onInput(e)", resizeMethod + "onInput(e)")
        .replace(
          "Page({data:{result:'Next page'}})",
          "Page({" + resizeMethod + "data:{result:'Next page'}})",
        ),
    );
    t = await managedFixture({ packageDir: pkg, standalone: true });
    await t.call("runner_wait", { kind: "text", text: "nested:child:1" });
    const first = (await t.call("runner_status")).current.id;
    const evaluate = async (id, expression) => {
      return t.app.evaluate(
        async ({ webContents }, { id, expression }) => {
          const wc = webContents
            .getAllWebContents()
            .find((w) => w.getURL().endsWith("/page/" + id));
          if (!wc) throw Error("Fixture view missing");
          return wc.executeJavaScript(expression);
        },
        { id, expression },
      );
    };
    const rejected = await t.client.callTool({
      name: "runner_evaluate",
      arguments: {
        targetId: `page:${first}`,
        expression: "globalThis.wrongTargetSideEffect=true",
      },
    });
    assert.ok(rejected.isError);
    assert.match(rejected.content[0].text, /only exposes the logic debugger/);
    assert.equal(
      (
        await t.call("runner_evaluate", {
          expression: "typeof wrongTargetSideEffect",
        })
      ).result.value,
      "undefined",
    );
    const metrics = (id) =>
      evaluate(
        id,
        `({width:innerWidth, rpx:__transformRpx__(750), vw:!!window.__convertRpxToVw__, libraries:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname==='/baselib/WAWebview.js').length})`,
      );
    const correctRpx = (m) => Math.abs(m.rpx - (m.vw ? 100 : m.width)) <= 1;
    const sized = async (id, width) => {
      const m = await metrics(id);
      return m.width === width && correctRpx(m);
    };
    const check = async () => {
      const m = await metrics(first);
      assert.ok(m.width > 300);
      assert.ok(correctRpx(m), JSON.stringify(m));
      assert.equal(m.libraries, 1);
      const dom = await until(async () => {
        const d = await t.call("runner_dom", {
          selector: '[id="leaf-button"],[id$="--leaf-button"]',
        });
        return Math.abs(d.rect.width - Math.floor(m.width / 2)) <= 1 && d;
      });
      assert.ok(
        Math.abs(dom.rect.width - Math.floor(m.width / 2)) <= 1,
        JSON.stringify({ rect: dom.rect, m }),
      );
      return m;
    };
    const initial = await check();
    await t.call("runner_click", { text: "nested:child:1" });
    await t.call("runner_wait", { kind: "text", text: "nested:child:2" });
    await t.call("runner_navigate", { method: "switchTab", url: "/next" });
    await t.call("runner_wait", { kind: "text", text: "Next page" });
    const second = (await t.call("runner_status")).current.id;
    assert.equal((await metrics(second)).rpx, initial.rpx);
    await t.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.getTitle().startsWith("WxappRunner"),
      );
      if (!win) throw Error("Fixture window missing");
      win.setContentSize(520, 900);
    });
    // Chromium defers visual-property updates while a native view is detached.
    // The cached page must recalculate when reattached, without reexecuting it.
    await until(() => sized(second, 520));
    await until(
      async () =>
        (
          await t.call("runner_evaluate", {
            expression: "getCurrentPages().at(-1).data.lastResize?.windowWidth",
          })
        ).result.value === 520,
    );
    await t.call("runner_navigate", { method: "switchTab", url: "/home" });
    await t.call("runner_wait", { kind: "text", text: "nested:child:2" });
    assert.equal((await t.call("runner_status")).current.id, first);
    await until(() => sized(first, 520));
    await check();
    await t.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle().startsWith("WxappRunner"))
        .setContentSize(406, 858),
    );
    await until(() => sized(first, 406));
    await check();
    assert.ok(!t.logs.join("").includes("FLOW_"));
    report.frameworks.push({
      framework,
      firstViewport: initial.width,
      resizedViewport: 520,
      cachedTabReflowOnRestore: true,
      originalStateRetained: true,
      baseLibraryLoadedOnce: true,
      compiledRpxRendered: true,
      originalPageOnResize: true,
      standaloneWrongTargetRejected: true,
    });
  } catch (error) {
    report.error = error.message;
    console.error(t?.logs.join("").slice(-3500));
    throw error;
  } finally {
    await t?.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(
      "docs/preload-viewport-result.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}
report.passed = true;
fs.writeFileSync(
  "docs/preload-viewport-result.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
