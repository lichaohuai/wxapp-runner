import { isolatedRuntime } from "./test-runtime.mjs";
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const isolated = isolatedRuntime();
const app = await electron.launch({
  args: [".", "--package", "../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()), "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), ...isolated.args],
  env: isolated.env,
  cwd: process.cwd()
});
const output = [];
app.process().stdout.on("data", b => output.push(String(b)));
app.process().stderr.on("data", b => output.push(String(b)));
async function wait(fn) {
  for (let n = 0; n < 150; n++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error("Timed out");
}
try {
  await wait(() => app.windows().some(p => p.url().includes("/page/")));
  const home = app.windows().find(p => p.url().includes("/page/"));
  const shell = app.windows().find(p => new URL(p.url()).pathname === "/");
  await home.getByText("常用工具", {
    exact: true
  }).waitFor();
  await home.locator("textarea").waitFor();
  // PC WAWebview may retain maxlength="-1"; the actual unlimited input
  // contract is the DOM property and accepted text, not attribute spelling.
  assert.equal(await home.locator("textarea").evaluate(e => e.maxLength), -1);
  assert.ok(await home.evaluate(() => document.body.scrollHeight < innerHeight * 2), "rpx must use the page viewport rather than the desktop monitor");
  const input = "Runtime exparser 中文🙂 ".repeat(30);
  await home.locator("textarea").fill(input);
  assert.equal(await home.locator("textarea").inputValue(), input);
  await home.locator("textarea").blur();
  await home.getByText("清空", {
    exact: true
  }).click();
  await wait(async () => (await home.locator("textarea").inputValue()) === "");
  const rewrite = home.getByText("文案改写", {
    exact: true
  });
  await rewrite.scrollIntoViewIfNeeded();
  // The native input overlay updates bounds on animation frames after scrolling.
  // Wait for an unobstructed target across frames before sending the one click.
  await rewrite.evaluate(element => new Promise((resolve, reject) => {
    let stableFrames = 0,
      previous = "",
      ended = false;
    const timeout = setTimeout(() => {
      ended = true;
      reject(Error("Native input overlay did not settle"));
    }, 3000);
    const check = () => {
      if (ended) return;
      const r = element.getBoundingClientRect(),
        key = [r.x, r.y, r.width, r.height, scrollY].join(",");
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      stableFrames = document.hasFocus() && element.isConnected && element.contains(hit) && key === previous ? stableFrames + 1 : 0;
      previous = key;
      if (stableFrames >= 3) {
        clearTimeout(timeout);
        resolve();
      } else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  await rewrite.click();
  await wait(() => app.windows().length === 3);
  const tool = app.windows().find(p => p !== home && p !== shell);
  await tool.locator("wx-view").first().waitFor();
  await tool.screenshot({
    path: "docs/" + (process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })()) + "-tool.png",
    fullPage: true
  });
  await shell.locator("#back").click();
  await wait(() => app.windows().length === 2);
  await home.getByText("常用工具", {
    exact: true
  }).waitFor();
  await home.screenshot({
    path: "docs/" + (process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })()) + "-home.png",
    fullPage: true
  });
  await wait(() => output.join("").includes("HANDLER pages/index/index"));
  const logs = output.join("");
  assert.doesNotMatch(logs, /BOOT ERROR|VIEW BOOT FAILED|BRIDGE ERROR|IndexSizeError|ReferenceError|TypeError/);
  assert.equal(await home.evaluate(() => !!globalThis.exparser), true);
  const result = {
    date: new Date().toISOString(),
    appid: process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(),
    framework: "exparser",
    entry: "pages/index/index",
    registeredPages: (logs.match(/REGISTER Page /g) || []).length,
    passed: ["page-frame templates and styles loaded", "homepage visible with viewport rpx", "maxlength -1 supported", "real text input and clear handler", "real tool button navigation", "return to homepage"],
    network: logs.split("\n").filter(l => l.startsWith("NETWORK ")),
    handlerNames: [...new Set([...logs.matchAll(/HANDLER \S+ (\S+) /g)].map(m => m[1]))],
    accountTested: false
  };
  fs.writeFileSync("docs/" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()) + "-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  fs.writeFileSync(".local/exparser-smoke.log", output.join(""));
  await app.close();
  isolated.cleanup();
}
