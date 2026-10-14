// Anonymous, read-only entry probe. Artifacts stay private; this does not
// consent to app terms or treat a visible entry as full business acceptance.
import fs from "node:fs";
import path from "node:path";
import { managedFixture, until } from "./managed-test-runtime.mjs";
const [packageDir, appid, output, scenarioFile, accountConfigFile] = process.argv.slice(2);
if (!packageDir || !appid || !output)
  throw Error("packageDir appid outputDir required");
// Validate the scenario before starting any business instance. A malformed
// test file must not execute the app and only then fail JSON.parse.
const scenario = scenarioFile ? JSON.parse(fs.readFileSync(scenarioFile, "utf8")) : [];
if (!Array.isArray(scenario) || scenario.some(step => !step || typeof step !== "object" || Array.isArray(step)))
  throw Error("scenario must be an array of step objects");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const accountConfig = accountConfigFile
  ? JSON.parse(fs.readFileSync(path.resolve(accountConfigFile), "utf8")) : {};
// Explicit opt-in: preserve anonymous regression as the default; copy only the
// account connection, never an existing instance's storage/profile/analysis.
const connection = Object.fromEntries(["wxbot", "deviceId", "appKey", "appSecret"]
  .filter(key => accountConfig[key] !== undefined).map(key => [key, accountConfig[key]]));
let t;
const report = {
  date: new Date().toISOString(),
  appid,
  isolated: true,
  accountConfigured: !!(connection.wxbot && connection.deviceId),
};
const save = (name, value) =>
  fs.writeFileSync(
    path.join(output, name),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
const originalError = console.error;
const screenshot = async (client, file, targetId) => {
  const result = await client.callTool({ name: "runner_screenshot", arguments: targetId ? {targetId} : {} });
  const image = result.content.find(x => x.type === "image");
  if (!image) {
    save(file + "-error.json", result);
    (report.screenshotErrors ||= []).push({file, error: result.content});
    return;
  }
  fs.writeFileSync(path.join(output, file + ".png"), Buffer.from(image.data, "base64"), {mode: 0o600});
};
console.error = (...args) =>
  fs.appendFileSync(
    path.join(output, "startup.log"),
    args.map(String).join(" ") + "\n",
    { mode: 0o600 },
  );
try {
  t = await managedFixture({
    packageDir: path.resolve(packageDir),
    appid,
    config: {
      ...connection,
      loaderAdapter: "official",
      analysis: { enabled: false, networkMode: "normal" },
    },
    // A boot timeout must retain the actual first error and MCP state, not
    // just the last few noisy SDK lines after the failed process was closed.
    onStartupFailure: async ({ call, client, logs }) => {
      fs.writeFileSync(path.join(output, "runtime.log"), logs.join(""), {
        mode: 0o600,
      });
      const status = await call("runner_status");
      save("status.json", status);
      Object.assign(report, {
        state: status.state,
        serviceReady: status.serviceReady,
        route: status.current?.route,
        pageReady: status.current?.ready,
        logicFailure: status.logicFailure,
      });
      const entries = [];
      let after = 0;
      for (let i = 0; i < 100; i++) {
        const page = await call("runner_logs", { after, limit: 200 });
        entries.push(...page.entries);
        after = page.nextCursor;
        if (!page.hasMore) break;
      }
      save("logs.json", entries);
      const shot = await client.callTool({
        name: "runner_screenshot",
        arguments: {},
      });
      const image = shot.content.find((x) => x.type === "image");
      if (image)
        fs.writeFileSync(
          path.join(output, "entry.png"),
          Buffer.from(image.data, "base64"),
          { mode: 0o600 },
        );
    },
  });
  // Observe a business-created control/text/image, not only an empty root.
  await until(async () => {
    try {
      const s = await t.call("runner_snapshot");
      return (s.text?.trim().length > 0 || s.elements?.length > 0) && s;
    } catch {
      return false;
    }
  }, 15000).catch((e) => (report.observationTimeout = e.message));
  const waitImages = async () => {
    return until(async () => {
      let after = 0;
      for (let page = 0; page < 100; page++) {
        const r = await t.call("runner_network", {
          filter: { source: "view", resourceType: "Image" },
          summary: true,
          after,
          limit: 100,
        });
        if (r.entries.some((e) => e.state === "pending")) return false;
        if (!r.hasMore) return true;
        after = r.nextCursor;
      }
      return false;
    }, 20000);
  };
  report.steps = [];
  // Actions are explicit test data, never instructions inferred from app text.
  for (const [index, step] of scenario.entries()) {
    const row = { index, ...step };
    report.steps.push(row);
    try {
      if (step.waitHidden) {
        row.wait = await t.call("runner_wait", {kind: "hidden", selector: step.waitHidden, timeoutMs: 20000});
        if (row.wait.status !== "matched") throw Error("Overlay did not disappear: " + row.wait.status);
      }
      if (step.dismissModalTitle) {
        const dialogs = await until(async () => {
          const entries = await t.call("runner_dialog");
          return entries.some(d => d.name === "showModal" && d.args?.title === step.dismissModalTitle) && entries;
        }, 10000);
        const match = dialogs.filter(d => d.name === "showModal" && d.args?.title === step.dismissModalTitle);
        if (match.length !== 1) throw Error("Ambiguous informational modal");
        row.sent = await t.call("runner_dialog", {action: "respond", id: match[0].id, confirm: true});
      } else if (step.clickSelector) {
        const ready = await t.call("runner_wait", {kind: "element", selector: step.clickSelector, timeoutMs: 20000});
        if (ready.status !== "matched") throw Error("Expected control is not visible: " + ready.status);
        row.sent = await t.call("runner_click", {selector: step.clickSelector});
      } else if (step.clickText || step.clickTextPrefix) {
        const matchesText = e => step.clickText ? e.text === step.clickText : e.text?.startsWith(step.clickTextPrefix);
        const snapshot = await until(async () => {
          try {
            const s = await t.call("runner_snapshot");
            return s.elements?.some(matchesText) && s;
          } catch {
            return false;
          }
        }, 20000);
        const matches = snapshot.elements.filter(
          matchesText,
        );
        if (matches.length !== 1)
          throw Error("Ambiguous test control: " + step.clickText);
        row.sent = await t.call("runner_click", { nodeId: matches[0].nodeId });
      } else if (step.back)
        row.sent = await t.call("runner_navigate", {
          method: "navigateBack",
          delta: 1,
        });
      if (step.routeIncludes)
        await until(async () => {
          const s = await t.call("runner_status");
          return (
            s.current?.routed &&
            s.current?.ready &&
            s.current.route.includes(step.routeIncludes)
          );
        }, 20000);
      if (step.waitText) {
        row.wait = await t.call("runner_wait", {
          kind: "text",
          text: step.waitText,
          timeoutMs: 20000,
        });
        if (row.wait.status !== "matched")
          throw Error("Expected text was not observed: " + row.wait.status);
      }
      if (step.waitH5Text) {
        const h5 = await until(async () => {
          const status = await t.call("runner_status");
          const targets = (status.h5 || []).filter(h => h.pageId === status.current?.id && h.visible);
          if (targets.length > 1) throw Error("Multiple H5 targets; scenario must select an unambiguous page");
          const target = targets[0];
          if (target?.state === "failed") throw Error("H5 load failed: " + (target.error?.code || target.httpCode || "unknown"));
          return target?.state === "loaded" && target;
        }, 20000);
        row.h5 = {targetId: h5.targetId, pageId: h5.pageId, state: h5.state, httpCode: h5.httpCode};
        row.h5Wait = await t.call("runner_wait", {kind: "text", targetId: h5.targetId, text: step.waitH5Text, timeoutMs: 20000});
        if (row.h5Wait.status !== "matched") throw Error("Expected H5 text was not observed: " + row.h5Wait.status);
        save(`step-${index}-h5-snapshot.json`, await t.call("runner_snapshot", {targetId: h5.targetId}));
        await screenshot(t.client, `step-${index}-h5`, h5.targetId);
      }
      await waitImages().catch(
        (e) => (row.imageObservationTimeout = e.message),
      );
      await screenshot(t.client, `step-${index}`);
      save(`step-${index}-snapshot.json`, await t.call("runner_snapshot"));
      row.route = (await t.call("runner_status")).current?.route;
      row.status = "observed";
    } catch (e) {
      row.status = "failed";
      row.error = String(e.message).slice(0, 500);
      break;
    }
  }
  await waitImages().catch((e) => (report.imageObservationTimeout = e.message));
  await until(async () => {
    const before = await t.call("runner_status");
    if (!before.current?.ready || !before.current?.routed || before.current.failed) return false;
    const snap = await t.call("runner_snapshot");
    const after = await t.call("runner_status");
    return before.current.id === after.current?.id && after.current.ready &&
      (snap.text?.trim().length > 0 || snap.elements?.length > 0);
  }, 20000).catch((e) => (report.finalPageObservationTimeout=e.message));
  const status = await t.call("runner_status");
  save("status.json", status);
  const snapshot = await t.call("runner_snapshot");
  save("snapshot.json", snapshot);
  const dialogs = await t.call("runner_dialog");
  save("dialogs.json", dialogs);
  await screenshot(t.client, "entry");
  const logs = [];
  let cursor = 0;
  const gaps = [];
  for (let i = 0; i < 100; i++) {
    const r = await t.call("runner_logs", { after: cursor, limit: 200 });
    logs.push(...r.entries);
    if (r.gap) gaps.push(r.gap);
    cursor = r.nextCursor;
    if (!r.hasMore) break;
  }
  save("logs.json", logs);
  const requests = [];
  cursor = 0;
  for (let i = 0; i < 100; i++) {
    const r = await t.call("runner_network", {
      after: cursor,
      limit: 100,
      summary: true,
    });
    requests.push(...r.entries);
    cursor = r.nextCursor;
    if (!r.hasMore) break;
  }
  save("network.json", requests);
  if (process.env.WXAPP_PROBE_BODIES === "1") {
    const details = [];
    for (const req of requests.filter((e) => e.source === "logic").slice(0, 30))
      details.push(await t.call("runner_network", { id: req.id }));
    save("network-details.json", details);
  }
  Object.assign(report, {
    serviceReady: status.serviceReady,
    route: status.current?.route,
    pageReady: status.current?.ready,
    logicFailure: status.logicFailure,
    textLength: snapshot.text?.length,
    elements: snapshot.elements?.length,
    pendingDialogs: dialogs.map((d) => ({ name: d.name, status: d.status })),
    logGaps: gaps,
    errors: logs.filter((e) => e.level === "error").length,
    requests: requests.length,
    images: requests.filter((e) => e.resourceType === "Image").length,
    completedImages: requests.filter(
      (e) =>
        e.resourceType === "Image" &&
        e.state === "complete" &&
        e.status >= 200 &&
        e.status < 400,
    ).length,
  });
} catch (e) {
  report.error = String(e.message).slice(0, 1000);
} finally {
  console.error = originalError;
  if (t) {
    fs.writeFileSync(path.join(output, "runtime.log"), t.logs.join(""), {
      mode: 0o600,
    });
    await t.close();
  }
  save("report.json", report);
  console.log(JSON.stringify(report));
}
