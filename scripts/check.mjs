import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--loader")) throw Error("Usage: node scripts/check.mjs [--loader]");
const loaderOnly = args.includes("--loader");
const directory = path.resolve(loaderOnly ? ".local/loader-regression" : ".local/regression");
fs.mkdirSync(directory, {
  recursive: true
});
function fingerprint(directory) {
  const hash = createHash("sha256");
  let count = 0;
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, name);
      if (fs.statSync(f).isDirectory()) visit(f);else {
        hash.update(path.relative(directory, f));
        hash.update(fs.readFileSync(f));
        count++;
      }
    }
  }
  visit(directory);
  return {
    files: count,
    sha256: hash.digest("hex")
  };
}
const inputs = Object.fromEntries(["../package", "../package-" + (process.env.WXAPP_TEST_APPID || (() => {
  throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
})()), "../baselib"].map(dir => [dir, fingerprint(dir)]));
const report = {
  startedAt: new Date().toISOString(),
  scope: loaderOnly ? "loader-contracts" : "full-regression",
  status: "已实现未验收",
  platform: process.platform,
  node: process.versions.node,
  electron: JSON.parse(fs.readFileSync("node_modules/electron/package.json")).version,
  inputs,
  implementation: {
    source: fingerprint("src"),
    scripts: fingerprint("scripts"),
    lockSha256: createHash("sha256").update(fs.readFileSync("package-lock.json")).digest("hex")
  },
  steps: []
};
const reportFile = loaderOnly ? "docs/loader-gate-result.json" : "docs/full-regression-result.json";
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
// Deterministic, account-free contracts run before sampling real app content.
// This is a scoped gate, not certification of every API or business flow.
const loaderScripts = ["smoke-contract-catalog", "smoke-native-libraries", "smoke-official-adapter", "smoke-loader-dependencies", "smoke-view-loader", "smoke-failures", "smoke-preload-viewport", "smoke-official-workers", "smoke-h5-back", "smoke-html-webview", "smoke-components", "smoke-toast-hit-test", "smoke-native-devtools"];
const scripts = loaderOnly ? loaderScripts : ["smoke-h5-back", "smoke-sdk-boundary", "smoke", "smoke-exparser", "smoke-failures", "smoke-loader-dependencies", "smoke-loader-input", "smoke-view-loader", "smoke-official-adapter", "smoke-privacy-navigation", "smoke-renderer-fallback", "smoke-native-devtools", "smoke-mcp", "smoke-input-focus", "smoke-controller", "smoke-trace", "smoke-network-control", "smoke-view-network", "smoke-network-boundaries", "smoke-components", "smoke-page-ui", "smoke-node-canvas", "smoke-legacy-canvas", "smoke-location", "smoke-device-suite", "smoke-native-video", "smoke-interactions", "smoke-upload-workflow", "smoke-debug-workflow", "smoke-wxapp-panel", "smoke-native-debugger", "smoke-breakpoint-stability", "smoke-profiles", "smoke-collaboration", "smoke-managed-original", "smoke-routes", "smoke-packages", "smoke-analysis", "smoke-algorithm-review", "smoke-boot-analysis", "smoke-boot-failure", "smoke-execution", "smoke-analysis-review", "smoke-analysis-workflow", "smoke-analysis-protocol"];
const steps = [["typecheck", "npm", ["run", "typecheck"]], ["units", "npm", ["test"]], ["build", "npm", ["run", "build"]], ...scripts.map(s => [s, process.execPath, s === "smoke-native-libraries" ? ["--import", "tsx", "scripts/run-contract.ts", "foundation-resource-bytes"] : s === "smoke-h5-back" ? ["--import", "tsx", "scripts/run-contract.ts", "h5-history-and-route"] : s === "smoke-view-loader" ? ["--import", "tsx", "scripts/run-contract.ts", "view-library-batches"] : s === "smoke-official-workers" ? ["--import", "tsx", "scripts/run-contract.ts", "worker-native-isolation"] : ["--import", "tsx", "scripts/" + s + ".mjs"]]), ...(loaderOnly ? [] : [["smoke-node-canvas-glass-easel", process.execPath, ["scripts/smoke-node-canvas.mjs", "glass-easel"]], ["smoke-chaos", process.execPath, ["--import", "tsx", "scripts/smoke-chaos.ts"]], ["smoke-boot-intrinsics", process.execPath, ["--import", "tsx", "scripts/smoke-boot-intrinsics.ts"]]])];
steps.push(["contract-drift", process.execPath, ["--import", "tsx", "scripts/audit-native.ts"]]);
report.plannedSteps = steps.map(([name]) => name);
save();
try {
  for (const [name, command, args] of steps) {
    const start = Date.now();
    console.log(`Running ${name}`);
    const logfile = path.join(directory, name + ".log"),
      fd = fs.openSync(logfile, "w");
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const p = spawn(command, args, {
          stdio: ["ignore", fd, fd],
          shell: process.platform === "win32" && command === "npm"
        });
        p.once("error", reject);
        p.once("exit", resolve);
      });
    } finally {
      fs.closeSync(fd);
    }
    report.steps.push({
      name,
      status: code === 0 ? "验收通过" : "失败",
      exitCode: code,
      seconds: Math.round((Date.now() - start) / 10) / 100
    });
    save();
    if (code !== 0) {
      console.error(fs.readFileSync(logfile, "utf8").slice(-10000));
      throw Error(`${name} failed; see ${logfile}`);
    }
    console.log(`PASS ${name} (${report.steps.at(-1).seconds}s)`);
  }
  report.inputsUnchanged = Object.entries(inputs).every(([dir, before]) => fingerprint(dir).sha256 === before.sha256);
  if (!report.inputsUnchanged) throw Error("Input package or base-library files changed");
  report.implementationUnchanged = fingerprint("src").sha256 === report.implementation.source.sha256 && fingerprint("scripts").sha256 === report.implementation.scripts.sha256 && createHash("sha256").update(fs.readFileSync("package-lock.json")).digest("hex") === report.implementation.lockSha256;
  if (!report.implementationUnchanged) throw Error("Implementation changed during regression; run the gate again for a consistent build");
  report.status = "验收通过";
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`PASS ${report.steps.length} regression groups; input packages unchanged`);
} catch (error) {
  report.status = "失败";
  report.error = error.message;
  report.finishedAt = new Date().toISOString();
  save();
  process.exitCode = 1;
}
