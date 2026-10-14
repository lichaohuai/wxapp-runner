import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { instrumentExecution } from "../src/analysis/execution/instrument";
const results = [];
for (const directory of ["package-" + (process.env.WXAPP_TEST_APPID || (() => {
  throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
})()), "package-" + (process.env.WXAPP_TEST_APPID_2 || (() => {
  throw new Error("Set WXAPP_TEST_APPID_2 to the AppID for your authorized test package");
})())]) {
  const file = path.join("..", directory, "app-service.js"),
    source = fs.readFileSync(file, "utf8");
  const started = Date.now(),
    result = instrumentExecution(source, "app-service.js");
  assert.ok(result.instrumentedSites > 1000);
  assert.equal(fs.readFileSync(file, "utf8"), source);
  results.push({
    package: directory,
    sha256: createHash("sha256").update(source).digest("hex"),
    sites: result.instrumentedSites,
    gaps: result.gaps.length,
    modules: result.modules.length,
    milliseconds: Date.now() - started,
    originalUnchanged: true
  });
}
const report = {
  date: new Date().toISOString(),
  parseOnly: true,
  results
};
fs.writeFileSync("docs/execution-preflight-result.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
