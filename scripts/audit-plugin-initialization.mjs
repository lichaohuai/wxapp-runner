// Read-only plugin initialization audit. No real bot credentials or successful
// verification responses; external requests are blocked in an isolated profile.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";

const [packageDir, appid, output, entryText] = process.argv.slice(2);
if (!packageDir || !appid || !output)
  throw Error("packageDir appid outputDir [plugin-entry-button-text] required");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name, data) => fs.writeFileSync(path.join(output, name),
  JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const b of req) raw += b;
  let data;
  try { const body = JSON.parse(raw); data = typeof body.data === "string" ? JSON.parse(body.data) : body.data; } catch { /* Not verification JSON. */ }
  requests.push({ time: new Date().toISOString(), path: req.url,
    ...(req.url.endsWith("/verifyplugin") ? { plugins: data?.plugins } : {}) });
  // Deliberately fail: this audit must not invent domains, signatures or consent.
  res.writeHead(404, { "content-type": "application/json" }).end('{"ok":false,"error":"audit endpoint unavailable"}');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let t;
const report = {
  date: new Date().toISOString(), appid, isolated: true,
  networkMode: "local-only", realAccountUsed: false, verificationResponse: "local HTTP 404",
  packageHashes: Object.fromEntries(["app-config.json", "app-service.js"].map(file => [file, hash(path.join(packageDir, file))])),
  baselibHash: hash(path.resolve("../baselib/WAServiceMainContext.js")),
};
const readLogs = async () => {
  let after = 0;
  const entries = [];
  for (let page = 0; page < 100; page++) {
    const r = await t.call("runner_logs", { after, limit: 200 });
    assert.ok(!r.gap, "Audit logs were evicted");
    entries.push(...r.entries); after = r.nextCursor;
    if (!r.hasMore) return entries;
  }
  throw Error("Audit log budget exceeded");
};
const oldError = console.error;
console.error = (...args) => fs.appendFileSync(path.join(output, "startup.log"), args.map(String).join(" ") + "\n", { mode: 0o600 });
try {
  t = await managedFixture({ packageDir: path.resolve(packageDir), appid,
    config: { loaderAdapter: "official", analysis: { enabled: false, networkMode: "local-only" },
      wxbot: `http://127.0.0.1:${server.address().port}`, deviceId: "local-audit-only" } });
  await until(() => requests.some(r => r.path.endsWith("/verifyplugin")));
  const status = await t.call("runner_status");
  report.boot = { serviceReady: status.serviceReady, route: status.current?.route, pageReady: status.current?.ready,
    pluginContacts: status.loader?.pluginContacts };
  report.beforeInteraction = requests.slice();
  const debuggerState = await t.call("runner_debugger", { action: "state", limit: 1 });
  report.contexts = [];
  for (const c of debuggerState.contexts || []) {
    if (!/wechat|wxapp/i.test(c.name)) continue;
    const value = await t.call("runner_evaluate", { contextId: c.id,
      expression: `(()=>{if(typeof __wxConfig==='undefined')return null;const c=__wxConfig;return {plugins:c.plugins||null,hasAppContactInfo:!!c.appContactInfo,callPluginInfo:c.appContactInfo?.call_plugin_info?.map(p=>({plugin_id:p.plugin_id,inner_version:p.inner_version,plugin_version:p.plugin_version}))||null}})()` });
    report.contexts.push({ id: c.id, name: c.name, config: value.result?.value, exception: !!value.exceptionDetails });
  }
  save("before-logs.json", await readLogs());
  if (entryText) {
    // The original app may redirect from its home to its login page. Re-read
    // observations across that switch; no click or other input is retried.
    await until(async () => {
      const snap = await t.call("runner_snapshot");
      return snap.elements?.some(e => e.text === entryText);
    });
    const oldRoute = (await t.call("runner_status")).current?.route;
    report.entry = await t.call("runner_click", { text: entryText, exact: true });
    const pluginStatus = await until(async () => {
      const s = await t.call("runner_status");
      return s.current?.route !== oldRoute && s.current?.route.startsWith("__plugin__/") && s.current?.ready && s.current?.routed && s;
    });
    report.pluginPage = { route: pluginStatus.current.route, ready: pluginStatus.current.ready };
    const snap = await until(async () => {
      const s = await t.call("runner_snapshot");
      return s.text?.trim() && s;
    });
    report.pluginPage.text = snap.text;
    // Capture the owned window: the app can replace its page target again on
    // failed account initialization. That is separate from plugin rendering.
    const shot = await t.client.callTool({ name: "runner_screenshot", arguments: { target: "shell" } });
    assert.ok(!shot.isError, JSON.stringify(shot));
    const image = shot.content.find(c => c.type === "image");
    assert.ok(image, "Screenshot did not return image data");
    fs.writeFileSync(path.join(output, "plugin-page.png"), Buffer.from(image.data, "base64"), { mode: 0o600 });
    report.pluginPage.screenshot = "plugin-page.png";
    report.pluginPage.screenshotTarget = "shell";
  }
  const logs = await readLogs();
  save("logs.json", logs);
  report.pluginLogs = logs.filter(e => ["logic", "loader"].includes(e.source) &&
    /batchGetContact|PLUGIN_VERIFICATION_FAILED/.test(JSON.stringify(e.args))).map(e => ({ id:e.id, time:e.time, level:e.level, args:e.args }));
  report.requests = requests;
  report.verificationAlreadyRequestedBeforeInteraction = report.beforeInteraction.some(r => r.path.endsWith("/verifyplugin"));
  report.smsSent = false;
  report.status = "observed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.requests = requests;
  if (t) await t.close();
  await new Promise(resolve => server.close(resolve));
  console.error = oldError;
  save("report.json", report);
  console.log(JSON.stringify(report, null, 2));
}
