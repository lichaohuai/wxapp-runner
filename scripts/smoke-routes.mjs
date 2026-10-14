import { _electron as electron } from "playwright";
import { isolatedRuntime } from "./test-runtime.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const isolated = isolatedRuntime(),
  connection = path.join(isolated.directory, "mcp.json");
const config = JSON.parse(fs.readFileSync("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
  throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
})()) + "/app-config.json", "utf8"));
const app = await electron.launch({
  args: [".", "--package", "../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()), "--appid", process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(), "--mcp", "--mcp-file", connection, ...isolated.args],
  env: {
    ...isolated.env,
    WXAPP_STANDALONE: ""
  },
  cwd: process.cwd()
});
const client = new Client({
  name: "route-acceptance",
  version: "1"
});
const rows = [],
  logs = [];
app.process().stdout.on("data", b => logs.push(String(b)));
app.process().stderr.on("data", b => logs.push(String(b)));
async function call(name, args = {}) {
  const r = await client.callTool({
    name,
    arguments: args
  }, undefined, {
    timeout: 65000
  });
  if (r.isError) throw Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}
try {
  for (let n = 0; n < 200 && !fs.existsSync(connection); n++) await new Promise(r => setTimeout(r, 25));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--connection", connection],
    stderr: "pipe"
  }));
  const entry = config.entryPagePath.replace(/\.html$/, "");
  await call("runner_wait", {
    kind: "element",
    selector: "wx-view,wx-text,wx-scroll-view,wx-button,textarea,input,canvas",
    stableMs: 0
  });
  for (const route of config.pages) {
    try {
      for (const d of await call("runner_dialog")) await call("runner_dialog", {
        action: "respond",
        id: d.id,
        cancel: true
      });
      await call("runner_navigate", {
        method: "reLaunch",
        url: "/" + route
      });
      const s = await call("runner_status");
      assert.equal(s.current.route, route);
      assert.ok(!s.current.failed);
      const boot = await call("runner_wait", {
        kind: "element",
        selector: "wx-view,wx-text,wx-scroll-view,wx-button,textarea,input,canvas",
        // The tutorial page keeps its UI hidden while two sequential requests
        // finish (each has a 10s business timeout). Wait for that original
        // success/failure UI; never retry its requests or manufacture content.
        timeoutMs: 30000,
        // This is a page-presence check, not an input target. Animated banners
        // can keep some of the hundreds of matched rectangles moving forever.
        stableMs: 0
      });
      assert.equal(boot.status, "matched");
      const snapshot = await call("runner_snapshot");
      rows.push({
        route,
        loaded: true,
        visibleText: !!snapshot.text.trim(),
        businessFlowTested: false
      });
    } catch (e) {
      rows.push({
        route,
        loaded: false,
        error: e.message
      });
    }
    console.log(JSON.stringify(rows.at(-1)));
  }
  const report = {
    date: new Date().toISOString(),
    appid: process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })(),
    routeCount: rows.length,
    loaded: rows.filter(r => r.loaded).length,
    rows,
    notes: "No account configuration; tests page loading and routing, not query-dependent or authenticated business results."
  };
  fs.writeFileSync("docs/routes-result.json", JSON.stringify(report, null, 2) + "\n");
  assert.equal(report.loaded, 39);
} finally {
  fs.writeFileSync(".local/routes-smoke.log", logs.join(""));
  await client.close();
  await app.close();
  isolated.cleanup();
}
