import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import fs from "node:fs";
import { buildLocation } from "./build-location.mjs";
fs.mkdirSync("dist", { recursive: true });
buildLocation();
execFileSync(process.execPath,["--import","tsx","scripts/audit-native.ts"],{stdio:"inherit"});
const contractFingerprint=JSON.parse(fs.readFileSync("docs/native-contracts.json","utf8")).fingerprint;
fs.writeFileSync("dist/native-contract-build.json",JSON.stringify({fingerprint:contractFingerprint})+"\n");
const define={__WXAPP_CONTRACT_BUILD__:JSON.stringify(contractFingerprint)};
for (const name of [
  "main",
  "runtime-main",
  "supervisor-main",
  "preload",
  "h5-preload",
  "logic",
  "business-worker",
  "devtools-preload",
  "dialog-preload",
])
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true,
    define,
    platform: "node",
    format: "cjs",
    external: ["electron", "@napi-rs/canvas"],
    sourcemap: true,
  });
for (const name of ["view", "shell", "wxapp-panel", "dialog-view", "devtools-media"])
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}.js`,
    bundle: true,
    define,
    platform: "browser",
    loader: {".css":"text"},
    sourcemap: true,
  });

await build({
  entryPoints: ["src/mcp/server.ts"],
  outfile: "dist/mcp.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
});

fs.copyFileSync("src/dialog.html", "dist/dialog.html");
for (const [entry, name] of [["daemon", "package-service"], ["cli", "packages"]])
  await build({entryPoints:[`src/packages/${entry}.ts`],outfile:`dist/${name}.cjs`,bundle:true,platform:"node",format:"cjs",sourcemap:true});
