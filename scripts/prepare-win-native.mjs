// Ensure the Windows prebuilt of @napi-rs/canvas is present in node_modules
// before packaging for win32. npm only installs the optional prebuilt matching
// the host platform (darwin on this machine), so the win32-x64-msvc binary must
// be provisioned separately. We fetch just that one tarball and extract it in
// place — deliberately NOT via `npm install --os=win32`, which re-resolves every
// optional dependency for win32 and would strip the macOS esbuild/canvas
// binaries the local build itself needs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const canvasVersion = JSON.parse(
  fs.readFileSync("node_modules/@napi-rs/canvas/package.json", "utf8"),
).version;
const pkg = "@napi-rs/canvas-win32-x64-msvc";
const dest = path.join("node_modules", "@napi-rs", "canvas-win32-x64-msvc");
const nodeFile = path.join(dest, "skia.win32-x64-msvc.node");

if (fs.existsSync(nodeFile)) {
  console.log(`[prepare-win-native] ${pkg} already present, skipping`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-win-canvas-"));
console.log(`[prepare-win-native] fetching ${pkg}@${canvasVersion}`);
execFileSync("npm", ["pack", `${pkg}@${canvasVersion}`], {
  cwd: tmp,
  stdio: "inherit",
});
const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
if (!tgz) throw new Error("prepare-win-native: npm pack produced no tarball");
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
execFileSync(
  "tar",
  ["-xzf", path.join(tmp, tgz), "-C", dest, "--strip-components=1"],
  { stdio: "inherit" },
);
fs.rmSync(tmp, { recursive: true, force: true });
if (!fs.existsSync(nodeFile))
  throw new Error(`prepare-win-native: ${nodeFile} missing after extract`);
console.log(`[prepare-win-native] installed ${pkg}@${canvasVersion}`);
