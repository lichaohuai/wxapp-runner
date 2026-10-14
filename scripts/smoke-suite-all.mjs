import { managedFixture, until } from "./managed-test-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
const t = await managedFixture({
  packageDir: path.resolve("../package-" + (process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })())),
  appid: process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })()
});
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  level: "page-ready and screenshot only",
  businessFlowsPassed: 0,
  effectAlignmentVerified: 0,
  status: "已实现未验收",
  simulatedHardware: false,
  accountConfigured: false
};
try {
  const catalog = await t.call("runner_suite", {
    action: "catalog",
    limit: 500
  });
  const job = await t.call("runner_suite", {
    action: "start",
    routes: catalog.pages.map(p => p.route),
    steps: [{
      tool: "runner_screenshot",
      arguments: {}
    }],
    timeoutMs: 4000
  });
  let last = 0;
  const result = await until(async () => {
    const r = await t.call("runner_suite", {
      action: "get",
      jobId: job.id
    });
    if (r.completed >= last + 20 || r.state !== "running") {
      last = r.completed;
      console.log(JSON.stringify({
        completed: r.completed,
        total: r.total,
        state: r.state,
        failed: r.results.filter(r => r.status === "失败").length
      }));
    }
    return r.state !== "running" && r;
  }, 1800000);
  const root = path.resolve(".local/official-suite-screenshots", job.id);
  fs.mkdirSync(root, {
    recursive: true
  });
  for (const row of result.results) {
    for (const e of row.evidence || []) if (e.artifact?.id) {
      const destination = path.join(root, row.route.replaceAll("/", "__") + ".png");
      try {
        await t.call("runner_artifact", {
          action: "export",
          id: e.artifact.id,
          destination,
          revealSensitive: true
        });
        e.localScreenshot = destination;
      } catch (err) {
        e.exportError = err.message;
      }
    }
  }
  report.job = result;
  report.pageCount = catalog.pageCount;
  report.pageReadyPassed = result.results.filter(r => r.status === "验收通过").length;
  report.pageReadyFailed = result.results.filter(r => r.status === "失败").length;
  report.status = report.pageReadyPassed === 356 ? "验收通过" : "失败";
  console.log(JSON.stringify({
    passed: report.pageReadyPassed,
    failed: report.pageReadyFailed,
    status: report.status,
    level: report.level
  }));
} catch (e) {
  report.status = "失败";
  report.error = e.message;
  throw e;
} finally {
  fs.writeFileSync("docs/official-suite-page-ready-result.json", JSON.stringify(report, null, 2) + "\n");
  await t.close();
}
