import fs from "node:fs";
import path from "node:path";
import { inspectPackage } from "./loader";
const args = process.argv.slice(2);
const option = (key: string, fallback?: string) => {
  const i = args.indexOf("--" + key);
  return i < 0 ? fallback : args[i + 1];
};
try {
  const plan = inspectPackage({
    packageDir: path.resolve(option("package", "../package")!),
    baselibDir: path.resolve(option("baselib", "../baselib")!),
  });
  const report = {
    ...plan,
    summary: {
      pages: Object.keys(plan.pages).length,
      availablePages: Object.values(plan.pages).filter((p) => !p.issues.length)
        .length,
      blockedPages: Object.values(plan.pages).filter((p) => p.issues.length)
        .length,
    },
    scope:
      "Static file/format checks only; does not execute code, contact wxbot, or guarantee complete JSAPI compatibility.",
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  const output = option("output");
  if (output) fs.writeFileSync(path.resolve(output), json);
  process.stdout.write(json);
  process.exitCode = plan.startupReady ? 0 : 1;
} catch (e: any) {
  console.error(
    JSON.stringify(
      {
        startupReady: false,
        errors: [
          e.diagnostic || { code: "INSPECT_FAILED", message: e.message },
        ],
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
