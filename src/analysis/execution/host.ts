import fs from "node:fs";
import path from "node:path";
import { instrumentExecution } from "./instrument";
import { safePath } from "../../loader/paths";

// Opt-in in-memory transformation; package files and base library remain untouched.
export function executionSelected(file: string, config: any) {
  return (
    !!config?.enabled && (!config.files?.length || config.files.includes(file))
  );
}
export function executionSource(source: string, file: string, config: any) {
  if (!executionSelected(file, config)) return source;
  return instrumentExecution(source, file, config).code;
}
export function preflightExecution(
  packageDir: string,
  files: string[],
  config: any,
) {
  if (!config?.enabled) return;
  const found = new Set<string>();
  for (const file of new Set<string>(
    config.files?.length ? config.files : files,
  )) {
    const p = safePath(packageDir, file);
    if (path.extname(p) !== ".js")
      throw Error("EXECUTION_SOURCE_INVALID: select JavaScript files");
    const result = instrumentExecution(
      fs.readFileSync(p, "utf8"),
      file,
      config,
    );
    for (const module of result.modules) found.add(module);
  }
  const missing = (config.modules || []).filter(
    (name: string) => !found.has(name),
  );
  if (missing.length)
    throw Error("EXECUTION_MODULE_NOT_FOUND: " + missing.join(", "));
}
