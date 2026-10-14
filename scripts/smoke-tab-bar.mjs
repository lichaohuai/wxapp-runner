import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tab-badge-"));
fs.mkdirSync(".local/loader-alignment", { recursive: true });
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const p = path.join(pkg, "app-config.json");
const cfg = JSON.parse(fs.readFileSync(p));
cfg.tabBar = {
  color: "#666666",
  selectedColor: "#000000",
  list: [
    { pagePath: "home.html", text: "Home" },
    { pagePath: "next.html", text: "Messages" },
  ],
};
fs.writeFileSync(p, JSON.stringify(cfg));
const icon = new PNG({ width: 2, height: 2 });
icon.data.fill(255);
fs.writeFileSync(path.join(pkg, "tab-fixture.png"), PNG.sync.write(icon));
const js = path.join(pkg, "app-service.js");
fs.writeFileSync(
  js,
  fs
    .readFileSync(js, "utf8")
    .replace(
      "Page({data:{result:'Next page'}})",
      "Page({data:{result:'Next page'},onShow(){wx.setTabBarBadge({index:1,text:'2'}).catch(()=>{});getApp().messageShows=(getApp().messageShows||0)+1;}})",
    ),
);
let t;
const report = { date: new Date().toISOString(), platform: process.platform };
try {
  t = await managedFixture({ packageDir: pkg });
  const evalApi = (expression) =>
    t.call("runner_evaluate", { expression, awaitPromise: true });
  await evalApi(
    `getApp().badgeTimer=setInterval(()=>wx.setTabBarBadge({index:1,text:'2'}).catch(()=>{}),50);void 0`,
  );
  for (let i = 1; i <= 3; i++) {
    await t.call("runner_click", {
      target: "shell",
      selector: "nav button:nth-child(2)",
    });
    await until(
      async () => (await evalApi("getApp().messageShows")).result?.value === i,
    );
    const snap = await t.call("runner_snapshot", { target: "shell" });
    assert.match(snap.text, /2/);
    await t.call("runner_navigate", { method: "switchTab", url: "/home" });
  }
  await evalApi("clearInterval(getApp().badgeTimer);void 0");
  const api = async (name, args = {}) => {
    const r = await evalApi(
      `new Promise((resolve,reject)=>wx[${JSON.stringify(name)}]({...${JSON.stringify(args)},success:resolve,fail:reject}))`,
    );
    assert.ok(!r.exceptionDetails, JSON.stringify(r));
    return r.result.value;
  };
  const shellDOM = (selector, computedStyles) =>
    t.call("runner_dom", { target: "shell", selector, computedStyles });
  const height = async () =>
    (
      await t.call("runner_evaluate", {
        targetId: "page:" + (await t.call("runner_status")).current.id,
        expression: "innerHeight",
      })
    ).result.value;
  const originalHeight = await height();
  await api("hideTabBar");
  await until(async () => (await height()) === originalHeight + 58);
  assert.equal(
    (
      await t.call("runner_wait", {
        target: "shell",
        kind: "hidden",
        selector: "nav",
      })
    ).status,
    "matched",
  );
  await t.call("runner_navigate", { method: "switchTab", url: "/next" });
  assert.equal(
    (
      await t.call("runner_wait", {
        target: "shell",
        kind: "hidden",
        selector: "nav",
      })
    ).status,
    "matched",
  );
  await api("showTabBar");
  await until(async () => (await height()) === originalHeight);
  await api("setTabBarStyle", {
    backgroundColor: "#123456",
    color: "#abcdef",
    selectedColor: "#ffffff",
    borderStyle: "white",
  });
  await until(
    async () =>
      (await shellDOM("nav", ["background-color"])).styles[
        "background-color"
      ] === "rgb(18, 52, 86)",
  );
  await api("setTabBarItem", {
    index: 1,
    text: "Updated",
    iconPath: "/tab-fixture.png",
    selectedIconPath: "/tab-fixture.png",
  });
  await t.call("runner_wait", {
    target: "shell",
    kind: "text",
    text: "Updated",
  });
  const image = await shellDOM("nav button:nth-child(2) img", []);
  assert.equal(image.attributes.src, "/tab-fixture.png");
  await until(async () => {
    const shot = await t.client.callTool({
      name: "runner_screenshot",
      arguments: { target: "shell" },
    });
    const png = PNG.sync.read(
      Buffer.from(shot.content.find((c) => c.type === "image").data, "base64"),
    );
    const root = await shellDOM("html", []);
    const scale = png.width / root.rect.width;
    const offset =
      (Math.floor((image.rect.y + image.rect.height / 2) * scale) * png.width +
        Math.floor((image.rect.x + image.rect.width / 2) * scale)) *
      4;
    return Array.from(png.data.subarray(offset, offset + 3)).every(
      (v) => v === 255,
    );
  });
  Object.assign(report, {
    originalTabUi: true,
    hideChangesViewport: true,
    hideSurvivesSwitchTab: true,
    styleApplied: true,
    textAndIconApplied: true,
  });

  const sequence = await evalApi(
    `(async()=>{const log=[];await wx.setTabBarBadge({index:1,text:'7',success:r=>log.push(r.errMsg),complete:r=>log.push('complete')});await wx.removeTabBarBadge({index:1});await wx.showTabBarRedDot({index:0});return log;})()`,
  );
  assert.deepEqual(sequence.result.value, ["setTabBarBadge:ok", "complete"]);
  const dom = await t.call("runner_dom", {
    target: "shell",
    selector: ".tab-badge",
    action: "inspect",
  });
  fs.writeFileSync(".local/loader-alignment/tab-dom.json", JSON.stringify(dom));
  const invalid = await evalApi(
    `wx.setTabBarBadge({index:99,text:'9'}).then(()=>({success:true}),e=>({failed:e.errMsg.includes(':fail')}))`,
  );
  assert.deepEqual(invalid.result.value, { failed: true });
  await evalApi("wx.hideTabBarRedDot({index:0})");
  const gone = await t.call("runner_wait", {
    target: "shell",
    kind: "hidden",
    selector: ".tab-badge",
  });
  assert.equal(gone.status, "matched");
  const shot = await t.client.callTool({
    name: "runner_screenshot",
    arguments: { target: "shell" },
  });
  assert.ok(shot.content.some((c) => c.type === "image"));
  Object.assign(report, {
    status: "验收通过",
    repeatedEntry: 3,
    originalPromiseCatch: true,
    callbackOrder: true,
    removeAndRedDot: true,
    invalidIndexRejected: true,
    originalBaselib: true,
    clicksDuringBadgeUpdates: true,
  });
} catch (e) {
  report.status = "失败";
  report.error = e.message;
  fs.writeFileSync(
    ".local/loader-alignment/tab-process.log",
    t?.logs.join("") || "",
  );
  throw e;
} finally {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(
    "docs/tab-bar-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(report);
