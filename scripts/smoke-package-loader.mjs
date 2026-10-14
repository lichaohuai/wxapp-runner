// Parameterized acceptance: test code does not know this application's handlers,
// URLs or UI text. The real base library must register and render each route.
import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const { values } = parseArgs({
  options: {
    package: { type: "string" },
    appid: { type: "string" },
    output: { type: "string" },
    "isolate-pages": { type: "boolean", default: false },
  },
});
if (!values.package || !values.appid)
  throw Error(
    "Pass --package <directory> --appid <appid>; no app-specific defaults",
  );
const packageDir = path.resolve(values.package);
const config = JSON.parse(
  fs.readFileSync(path.join(packageDir, "app-config.json"), "utf8"),
);
const fingerprint = () => {
  const hash = createHash("sha256");
  let count = 0;
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else {
        hash.update(path.relative(packageDir, p));
        hash.update(fs.readFileSync(p));
        count++;
      }
    }
  }
  walk(packageDir);
  return { files: count, sha256: hash.digest("hex") };
};
const input = fingerprint(),
  rows = [];
const t = await managedFixture({ packageDir, appid: values.appid });
const entry = config.entryPagePath.replace(/\.html$/, "");
const subroots = (config.subPackages || []).map((s) =>
  s.root.replace(/^\//, "").replace(/\/?$/, "/"),
);
let lazyBeforeEntry = false;
try {
  await until(async () =>
    (await t.call("runner_state")).pages.some((p) => p.route === entry),
  );
  lazyBeforeEntry = subroots
    .filter((r) => !entry.startsWith(r))
    .every(
      (root) => !t.logs.join("").includes("LOAD " + root + "common.app.js"),
    );
  assert.ok(lazyBeforeEntry, "unvisited subpackages must not run at startup");
  for (const route of config.pages) {
    try {
      if (values["isolate-pages"]) {
        // Result pages may schedule business redirects after unload. Use a
        // fresh runtime to inspect each page without changing those semantics.
        await t.call("runner_runtime", { action: "restart" });
        await until(async () => {
          const s = await t.call("runner_status");
          return s.serviceReady && s.current?.ready;
        });
        t.logs.length = 0;
      }
      for (const d of await t.call("runner_dialog"))
        await t.call("runner_dialog", {
          action: "respond",
          id: d.id,
          cancel: true,
        });
      await t.call("runner_navigate", { method: "reLaunch", url: "/" + route });
      const state = await until(async () => {
        const s = await t.call("runner_state");
        return s.pages.some((p) => p.route === route) && s;
      }, 10000);
      const page = state.pages.find((p) => p.route === route);
      assert.ok(
        page.instanceId,
        "Page must be a real registered business instance",
      );
      const result = await t.call("runner_wait", {
        kind: "element",
        selector:
          "wx-view,wx-text,wx-scroll-view,wx-button,textarea,input,canvas",
        timeoutMs: 5000,
      });
      assert.equal(result.status, "matched");
      const snapshot = await t.call("runner_snapshot");
      rows.push({
        route,
        registered: true,
        rendered: true,
        visibleText: !!snapshot.text.trim(),
        businessFlowTested: false,
      });
    } catch (e) {
      rows.push({
        route,
        registered: false,
        rendered: false,
        error: e.message,
      });
    }
    console.log(JSON.stringify(rows.at(-1)));
  }
  // Return to an already loaded subpackage, proving its bootstrap is not replayed.
  const revisit = [...config.pages]
    .reverse()
    .find((p) => subroots.some((r) => p.startsWith(r)));
  if (revisit) {
    await t.call("runner_navigate", { method: "reLaunch", url: "/" + revisit });
    await until(async () =>
      (await t.call("runner_state")).pages.some((p) => p.route === revisit),
    );
  }
  const log = t.logs.join("");
  const bootstrapCounts = Object.fromEntries(
    subroots.map((root) => [
      root,
      (
        log.match(
          new RegExp(
            "^LOAD " +
              root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "(?:app-service|appservice\\.app)\\.js$",
            "gm",
          ),
        ) || []
      ).length,
    ]),
  );
  for (const count of Object.values(bootstrapCounts))
    assert.ok(
      count <= 1,
      "Subpackage bootstrap must execute at most once in the current context",
    );
  if (revisit)
    assert.equal(
      bootstrapCounts[subroots.find((r) => revisit.startsWith(r))],
      1,
    );
  const after = fingerprint();
  const report = {
    date: new Date().toISOString(),
    appid: values.appid,
    platform: process.platform,
    input,
    inputsUnchanged: input.sha256 === after.sha256,
    pages: rows.length,
    rendered: rows.filter((r) => r.rendered).length,
    registered: rows.filter((r) => r.registered).length,
    lazyBeforeEntry,
    pageIsolation: values["isolate-pages"],
    bootstrapCounts,
    rows,
    accountConfigurationUsed: false,
  };
  report.passed = report.inputsUnchanged && report.rendered === report.pages;
  fs.writeFileSync(
    values.output || ".local/package-loader-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  assert.ok(report.passed, JSON.stringify(rows.filter((r) => !r.rendered)));
} finally {
  fs.writeFileSync(".local/package-loader-runtime.log", t.logs.join(""));
  await t.close();
}
