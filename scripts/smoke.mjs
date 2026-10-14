import { isolatedRuntime } from "./test-runtime.mjs";
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const directory = path.resolve(import.meta.dirname, "..");
const isolated = isolatedRuntime();
const application = await electron.launch({
  args: [".", "--package", path.resolve(directory, "../package"), "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--mcp", "--mcp-file", path.join(isolated.directory, "mcp.json"), ...isolated.args],
  env: isolated.env,
  cwd: directory,
  timeout: 30000
});
const output = [];
application.process().stdout.on("data", data => output.push(String(data)));
application.process().stderr.on("data", data => output.push(String(data)));
async function wait(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error("Timed out waiting for runtime");
}
async function debugCall(name, args = {}) {
  const connection = JSON.parse(fs.readFileSync(path.join(isolated.directory, "mcp.json"), "utf8"));
  const r = await fetch(connection.endpoint + "/call", {
    method: "POST",
    headers: {
      authorization: "Bearer " + connection.token,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name,
      arguments: args
    })
  });
  const result = await r.json();
  assert.ok(!result.error, result.error);
  return result.result;
}
try {
  await wait(() => application.windows().length >= 2);
  const shell = application.windows().find(p => new URL(p.url()).pathname === "/");
  let home = application.windows().find(p => p.url().includes("/page/"));
  await home.getByText("一键提取视频", {
    exact: true
  }).waitFor();
  const blockedPage = JSON.parse(fs.readFileSync(path.resolve(directory, "../package/app-config.json"), "utf8")).pages.find(p => !fs.existsSync(path.resolve(directory, "../package", p + ".html")));
  const missingResult = await shell.evaluate(route => window.runner.navigate("navigateTo", {
    url: "/" + route
  }), blockedPage);
  assert.match(missingResult.error, /PAGE_FILE_MISSING/);
  assert.equal(application.windows().length, 2, "Missing pages must fail before changing the page stack");
  const category = (await debugCall("runner_snapshot")).elements.find(e => e.text === "智能创作");
  assert.ok(category, "Original category button must be visible");
  assert.equal((await debugCall("runner_wait", {
    kind: "element",
    nodeId: category.nodeId,
    stableMs: 200
  })).status, "matched");
  await debugCall("runner_click", {
    nodeId: category.nodeId
  });
  await home.getByText("文生视频", {
    exact: true
  }).waitFor();
  await home.locator("textarea").fill("WxappRunner state retention check");
  await home.locator("textarea").blur();
  await wait(() => output.join("").includes("onInputUrl"));
  await home.getByText("热门工具", {
    exact: true
  }).click();
  await home.getByText("一键抠图", {
    exact: true
  }).click();
  await wait(() => application.windows().length >= 3);
  const tool = application.windows().find(p => p !== home && p !== shell);
  await tool.getByText("点击选择要抠图的图片", {
    exact: true
  }).waitFor();
  assert.equal(await shell.locator("header").evaluate(e => getComputedStyle(e).display), "none", "Custom navigation is owned by the business page");
  await debugCall("runner_navigate", {
    method: "navigateBack"
  });
  await wait(() => application.windows().length === 2);
  assert.equal(await home.locator("textarea").inputValue(), "WxappRunner state retention check");
  await shell.getByRole("button", {
    name: "AI视频",
    exact: true
  }).click();
  await wait(() => application.windows().length >= 3);
  const video = application.windows().find(p => p !== home && p !== shell);
  await video.locator("wx-view").first().waitFor();
  await shell.getByRole("button", {
    name: "去水印",
    exact: true
  }).click();
  await home.getByText("一键提取视频", {
    exact: true
  }).waitFor();
  assert.equal(await home.locator("textarea").inputValue(), "WxappRunner state retention check");
  await home.locator("textarea").fill("");
  await home.locator("textarea").blur();
  await home.getByText("一键提取视频", {
    exact: true
  }).click();
  await home.getByRole("status").waitFor();
  assert.match(await home.getByRole("status").innerText(), /登录|链接/);
  await wait(() => output.join("").includes("selectToolCategory"));
  await wait(() => output.join("").includes(" onParse "));
  await home.waitForTimeout(1800);
  fs.mkdirSync(path.join(directory, "docs"), {
    recursive: true
  });
  await home.screenshot({
    path: path.join(directory, "docs/home.png"),
    fullPage: true
  });
  const connection = JSON.parse(fs.readFileSync(path.join(isolated.directory, "mcp.json"), "utf8"));
  const call = async (name, args = {}) => {
    const r = await fetch(connection.endpoint + "/call", {
      method: "POST",
      headers: {
        authorization: "Bearer " + connection.token,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name,
        arguments: args
      })
    });
    const data = await r.json();
    assert.ok(!data.error, data.error);
    return data.result;
  };
  const state = await call("runner_state");
  assert.ok(state.pages.some(p => p.route === "pages/zy/zy"));
  let after = 0,
    observed = [];
  while (true) {
    const result = await call("runner_state", {
      action: "events",
      after,
      limit: 200
    });
    observed.push(...result.entries);
    after = result.nextCursor;
    if (!result.hasMore) break;
  }
  assert.ok(observed.some(e => e.type === "setData" && e.context?.rootHandler === "selectToolCategory" && e.context?.handler === "switchToolCategory"));
  assert.ok(observed.some(e => e.type === "handler" && e.name === "onInputUrl"));
  assert.ok((await call("runner_dom", {
    selector: "textarea"
  })).tag === "textarea");
  const text = output.join("");
  assert.match(text, /M1 APP LOADED/);
  assert.doesNotMatch(text, /BOOT ERROR|VIEW BOOT FAILED|BRIDGE ERROR/);
  const report = {
    date: new Date().toISOString(),
    package: "../package",
    baselib: "3.17.3",
    assertions: ["App and Page register in DOM-free worker", "Original homepage renders", "Real tap -> selectToolCategory -> setData -> changed tool list", "Native textarea -> onInputUrl", "Original tool button -> navigation -> original tool page", "navigateBack preserves DOM and business state", "switchTab restores original page state", "Parse button -> onParse -> login-required toast", "Missing subpackage returns PAGE_FILE_MISSING without changing the page stack"],
    accountTested: false,
    network: text.split("\n").filter(l => l.startsWith("NETWORK ")),
    handlerNames: [...new Set([...text.matchAll(/HANDLER \S+ (\S+) /g)].map(m => m[1]))]
  };
  fs.writeFileSync(path.join(directory, "docs/smoke-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.mkdirSync(path.join(directory, ".local"), {
    recursive: true
  });
  fs.writeFileSync(path.join(directory, ".local/smoke.log"), output.join(""));
  await application.close();
  isolated.cleanup();
}
