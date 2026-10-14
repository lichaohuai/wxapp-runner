import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function inspectPublicText(text) {
  const findings = [];
  for (const [code, regex] of [
    ["APP_ID_LITERAL", /wx[0-9a-f]{16}/gi],
    ["PRIVATE_KEY_MATERIAL", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ]) {
    for (const match of text.matchAll(regex)) {
      findings.push({ code, line: text.slice(0, match.index).split("\n").length });
    }
  }
  return findings;
}
export function checkPublicSource(root = process.cwd()) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  const forbidden = new Set([".local", "dist", "release", "node_modules", "baselib", "re-data", "evidence", "user-data", "data-exports"]);
  for (const file of files) {
    const full = path.join(root, file);
    if (file.split("/").some(part => forbidden.has(part)) || /\.(?:wxapkg|wxvpkg|exe|node|dylib|har|heapsnapshot)$/.test(file) || path.basename(file) === ".env") {
      findings.push({ file, code: "PRIVATE_ARTIFACT" });
      continue;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    for (const finding of inspectPublicText(fs.readFileSync(full, "utf8"))) findings.push({ file, ...finding });
  }
  return { files: files.length, findings };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPublicSource();
  console.log(JSON.stringify(result, null, 2));
  if (result.findings.length) process.exitCode = 1;
}
