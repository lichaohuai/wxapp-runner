import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedRuntime } from "./test-runtime.mjs";
const results = [];
for (const phase of ["logic", "view", "view-read", "preload"]) {
  const isolated = isolatedRuntime();
  const packageDir = path.join(isolated.directory, "package");
  fs.mkdirSync(path.join(packageDir, "pages"), {
    recursive: true
  });
  fs.writeFileSync(path.join(packageDir, "app-config.json"), JSON.stringify({
    pages: ["pages/home"],
    entryPagePath: "pages/home.html",
    componentFramework: {
      default: "exparser"
    },
    renderer: {
      default: "webview"
    }
  }));
  fs.writeFileSync(path.join(packageDir, "app-service.js"), phase === "logic" ? `throw new Error("fixture-logic-failure");` : `App({});`);
  fs.writeFileSync(path.join(packageDir, "page-frame.html"), "<script>/* fixture: no business dependencies */</script>");
  fs.writeFileSync(path.join(packageDir, "pages/home.html"), phase === "view" ? `<script>throw new Error("fixture-view-failure")</script>` : phase === "view-read" ? '<script src="../fixture-view-read-failure.js"></script>' : "");
  if (phase === "view-read") fs.writeFileSync(path.join(packageDir, "page-frame.js"), "window.failurePrefixExecuted=true;");
  const extraArgs = [];
  if (phase === "preload") {
    const baselibDir = path.join(isolated.directory, "baselib");
    fs.cpSync(path.resolve("../baselib"), baselibDir, {
      recursive: true
    });
    fs.writeFileSync(path.join(baselibDir, "WAWebview.js"), 'throw Error("fixture-preload-failure");');
    extraArgs.push("--baselib", baselibDir);
  }
  const app = await electron.launch({
    args: [".", "--package", packageDir, "--appid", process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(), ...isolated.args, ...extraArgs],
    cwd: process.cwd(),
    env: isolated.env
  });
  let output = "";
  const capture = b => {
    output += b;
    if (String(b).includes("HOST_UNCAUGHT")) console.error(String(b));
  };
  app.process().stdout.on("data", capture);
  app.process().stderr.on("data", capture);
  try {
    await app.waitForEvent("window", {
      predicate: p => p.url().includes("/page/"),
      timeout: 15000
    }).catch(() => {});
    const page = app.windows().find(p => p.url().includes("/page/"));
    assert.ok(page, "The host opens a diagnostic view");
    await page.getByText(`fixture-${phase}-failure`, {
      exact: false
    }).waitFor({
      timeout: 15000
    });
    const text = await page.locator("body").innerText();
    assert.match(text, phase === "logic" ? /SCRIPT_EXECUTION_FAILED/ : phase === "view-read" ? /VIEW_BOOT_FAILED/ : /VIEW_SCRIPT_EXECUTION_FAILED/);
    assert.match(text, phase === "preload" ? /WAWebview.js/ : phase === "view-read" ? /fixture-view-read-failure.js/ : phase === "view" ? /pages\/home.html/ : /app-service.js/);
    if (phase === "view-read") {
      assert.match(text, /HTTP 404/);
      assert.equal(await page.evaluate(() => window.failurePrefixExecuted), undefined, "An unreadable member must prevent all fresh program scripts from executing");
    }
    assert.match(output, /DIAGNOSTIC/);
    assert.doesNotMatch(output, /WXBOT OUT|NETWORK OUT/);
    results.push({
      phase,
      passed: true,
      assertion: "Original script failure reaches visible diagnostic with file and error code; navigation does not wait indefinitely"
    });
  } finally {
    let timeout;
    try {
      await Promise.race([app.close(), new Promise((_, reject) => {
        timeout = setTimeout(() => {
          app.process().kill("SIGKILL");
          reject(Error("Host failed to close after startup error: " + output.slice(-1800)));
        }, 10000);
      })]);
    } finally {
      clearTimeout(timeout);
    }
    isolated.cleanup();
  }
  assert.doesNotMatch(output, /HOST_UNCAUGHT/, "Late configuration after window close must not enter Electron's native crash dialog");
  results.at(-1).closesWithoutNativeException = true;
}
fs.writeFileSync("docs/failure-smoke-result.json", JSON.stringify({
  date: new Date().toISOString(),
  results
}, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
