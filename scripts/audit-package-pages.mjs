import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { managedFixture } from "./managed-test-runtime.mjs";

// Page loading audit only. The initial network barrier applies before any app bundle runs.
const packageDir = path.resolve(process.argv[2]);
const appid = process.argv[3];
const out = path.resolve(process.argv[4] || ".local/page-audit");
fs.mkdirSync(out, { recursive: true });
const config = JSON.parse(
  fs.readFileSync(path.join(packageDir, "app-config.json")),
);
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  appid,
  networkMode: "local-only",
  level:
    "route-registration-rendering; no supplied business query or cloud results",
  appConfigSha256: createHash("sha256")
    .update(fs.readFileSync(path.join(packageDir, "app-config.json")))
    .digest("hex"),
  total: config.pages.length,
  completed: 0,
  rows: [],
};
const save = () =>
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(report, null, 2),
  );
const t = await managedFixture({
  packageDir,
  appid,
  config: {
    loaderAdapter: "official",
    analysis: { enabled: false, networkMode: "local-only" },
  },
});
try {
  const catalog = await t.call("runner_suite", {
    action: "catalog",
    limit: 500,
  });
  fs.writeFileSync(
    path.join(out, "catalog.json"),
    JSON.stringify(catalog, null, 2),
  );
  for (const [i, route] of config.pages.entries()) {
    const row = { route, status: "失败", businessFlowTested: false };
    const before = await t.call("runner_status");
    try {
      for (const d of await t.call("runner_dialog"))
        await t.call("runner_dialog", {
          action: "respond",
          id: d.id,
          cancel: true,
        });
      await t.call("runner_navigate", { method: "reLaunch", url: "/" + route });
      const ready = await t.call("runner_wait", {
        kind: "route",
        route,
        timeoutMs: 5000,
      });
      row.routeWait = ready.status;
      const visible = await t.call("runner_wait", {
        kind: "element",
        selector:
          "wx-view,wx-text,wx-image,wx-scroll-view,wx-web-view,wx-video,wx-button,input,textarea,canvas",
        timeoutMs: 1500,
        stableMs: 0,
      });
      row.elementWait = visible.status;
      const state = await t.call("runner_status");
      row.current = state.current;
      row.serviceReady = state.serviceReady;
      const dom = await t.call("runner_evaluate", {
        targetId: `page:${state.current.id}`,
        expression: `(()=>({
        text:document.body.innerText.slice(0,1500),
        nodes:[...document.querySelectorAll('*')].filter(e=>e.tagName.startsWith('WX-')).length,
        webviews:document.querySelectorAll('wx-web-view').length
      }))()`,
      });
      if (dom.exceptionDetails)
        throw Error(
          "View inspection failed: " + JSON.stringify(dom.exceptionDetails),
        );
      row.dom = dom.result?.value ?? dom.result;
      row.registered = (
        await t.call("runner_evaluate", {
          targetId: "logic",
          expression:
            "getCurrentPages().map(p=>({route:p.route, dataKeys:Object.keys(p.data||{}).length}))",
        })
      ).result?.value;
      const screen = await t.client.callTool({
        name: "runner_screenshot",
        arguments: {},
      });
      const image = screen.content?.find((x) => x.type === "image");
      if (image) {
        row.screenshot = `${String(i + 1).padStart(2, "0")}.png`;
        fs.writeFileSync(
          path.join(out, row.screenshot),
          Buffer.from(image.data, "base64"),
        );
      }
      const matched =
        row.current?.route === route &&
        row.current.ready &&
        !row.current.failed;
      row.status =
        matched && row.elementWait === "matched" ? "验收通过" : "失败";
      row.businessFlowTested = false;
    } catch (error) {
      row.error = String(error.message).slice(0, 3000);
      try {
        const state = await t.call("runner_status");
        row.current = state.current;
        row.serviceReady = state.serviceReady;
      } catch (e) {
        row.statusReadError = e.message;
      }
    }
    try {
      const logs = await t.call("runner_logs", {
        after: before.logCursor || 0,
        level: "error",
        limit: 100,
      });
      // Retain original context: an old page's async error can arrive during a
      // later route. Do not assign causality from the polling interval.
      row.observedErrors = logs.entries || logs.logs || [];
    } catch (error) {
      row.logReadError = error.message;
    }
    report.rows.push(row);
    report.completed++;
    save();
    console.log(
      JSON.stringify({
        completed: report.completed,
        total: report.total,
        route,
        status: row.status,
        current: row.current?.route,
        nodes: row.dom?.nodes,
        error: row.error?.slice(0, 300),
      }),
    );
  }
  report.finishedAt = new Date().toISOString();
  report.loaded = report.rows.filter((x) => x.status === "验收通过").length;
  report.failed = report.total - report.loaded;
  report.network = await t.call("runner_network", {
    fields: ["id", "state", "status", "source", "error"],
    limit: 100,
  });
  save();
} finally {
  fs.writeFileSync(path.join(out, "process.log"), t.logs.join(""), {
    mode: 0o600,
  });
  save();
  await t.close();
}
