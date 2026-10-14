import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { safePath } from "../loader/paths";

type Factory = {
  path: string;
  file: string;
  line: number;
  column: number;
  factoryId: string;
  sha256: string;
  source: string;
  plugin?: string;
};

/** A package inventory is evidence of available bytes, never of working exports. */
export function pluginDependencies(
  root: string,
  modules: Factory[],
  allModules: Factory[],
  errors: any[],
  a: any,
) {
  const scanErrors = [...errors],
    plugins: any[] = [];
  try {
    const file = safePath(root, "app-config.json");
    if (fs.statSync(file).size > 4 * 1024 ** 2)
      throw Error("Config byte limit exceeded");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const scopes = [
      { root: "", plugins: config.plugins },
      ...(config.subPackages || config.subpackages || []).map((s: any) => ({
        root: s.root,
        plugins: s.plugins,
      })),
    ];
    for (const scope of scopes) {
      for (const [alias, raw] of Object.entries(scope.plugins || {})) {
        const p = raw as any,
          files: string[] = [];
        let truncated = false,
          directoryPresent = false,
          assetError: string | undefined;
        const valid =
          typeof p?.provider === "string" &&
          /^wx[0-9a-f]{16}$/.test(p.provider);
        if (valid) {
          const relative = `__plugin__/${p.provider}`;
          try {
            const dir = safePath(root, relative);
            directoryPresent = true;
            const pending = [dir];
            let visited = 0;
            while (pending.length && !truncated) {
              const current = pending.pop()!;
              for (const e of fs.readdirSync(current, {
                withFileTypes: true,
              })) {
                if (++visited > 10000) {
                  truncated = true;
                  break;
                }
                const entry = path.join(current, e.name);
                // Do not follow links or inspect content outside the selected package.
                if (e.isSymbolicLink()) {
                  assetError = "Symlink asset skipped";
                  continue;
                }
                if (e.isDirectory()) pending.push(entry);
                else if (e.isFile())
                  files.push(
                    path.relative(root, entry).split(path.sep).join("/"),
                  );
              }
            }
          } catch (e: any) {
            if (e.code !== "ENOENT") assetError = e.message;
          }
        }
        files.sort();
        const scripts = files.filter((f) => /\.(?:[cm]?js|wasm)$/i.test(f));
        const bundledFactories = allModules
          .filter((m) => m.plugin === `plugin://${p?.provider}`)
          .map((m) => ({
            factoryId: m.factoryId,
            path: m.path,
            file: m.file,
            line: m.line,
            column: m.column,
            sha256: m.sha256,
          }));
        plugins.push({
          alias,
          scope: scope.root || "",
          provider: valid ? p.provider : null,
          version: p?.version ?? null,
          assetState: !valid
            ? "invalid-declaration"
            : bundledFactories.length
              ? "bundled-factories-present"
              : assetError || truncated
                ? "unknown"
                : scripts.length
                  ? "script-assets-present"
                  : files.length
                    ? "metadata-or-resources-only"
                    : directoryPresent
                      ? "empty-directory"
                      : "directory-absent",
          fileCount: files.length,
          files: files.slice(0, 20),
          scriptFiles: scripts.slice(0, 20),
          filesTruncated: truncated || files.length > 20,
          scriptFilesTruncated: truncated || scripts.length > 20,
          assetError,
          implementationVerified: false,
          bundledFactories: bundledFactories.slice(0, 20),
          bundledFactoryCount: bundledFactories.length,
          bundledFactoriesTruncated: bundledFactories.length > 20,
        });
      }
    }
  } catch (e: any) {
    scanErrors.push({ file: "app-config.json", error: e.message });
  }

  const calls: any[] = [],
    seen = new Set<string>();
  for (const m of modules) {
    // Combined and split bundles often contain the exact same define factory.
    const identity = `${m.plugin || ""}:${m.path}:${m.sha256}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!m.source.includes("requirePlugin")) continue;
    const ast: any = parse("(" + m.source + "\n)", {
      ecmaVersion: "latest",
      locations: true,
    });
    const pending = [ast];
    while (pending.length) {
      const n = pending.pop();
      if (
        n.type === "CallExpression" &&
        n.callee?.type === "Identifier" &&
        n.callee.name === "requirePlugin"
      ) {
        const literal =
          typeof n.arguments[0]?.value === "string"
            ? n.arguments[0].value
            : null;
        calls.push({
          factoryId: m.factoryId,
          path: m.path,
          file: m.file,
          line: m.line + n.loc.start.line - 1,
          column:
            n.loc.start.line === 1
              ? m.column + n.loc.start.column - 1
              : n.loc.start.column + 1,
          argument: n.arguments[0]
            ? m.source
                .slice(n.arguments[0].start - 1, n.arguments[0].end - 1)
                .slice(0, 200)
            : null,
          alias: literal,
          resolution:
            literal === null ? "dynamic-unresolved" : "literal-candidate",
          observed: false,
          bindingVerified: false,
          ...(m.plugin ? { plugin: m.plugin } : {}),
        });
      }
      for (const [key, value] of Object.entries(n)) {
        if (["loc", "start", "end"].includes(key)) continue;
        if (Array.isArray(value)) pending.push(...value.filter((x) => x?.type));
        else if (value && typeof value === "object" && (value as any).type)
          pending.push(value);
      }
    }
  }
  calls.sort(
    (x, y) =>
      x.path.localeCompare(y.path) ||
      x.file.localeCompare(y.file) ||
      x.line - y.line ||
      x.column - y.column,
  );
  const offset = a.offset ?? 0,
    limit = a.limit ?? 50;
  const entries = calls.slice(offset, offset + limit);
  return {
    plugins,
    entries,
    total: calls.length,
    nextOffset: offset + entries.length,
    hasMore: offset + entries.length < calls.length,
    scanErrors,
    basis:
      "Declared plugins, factories nested in definePlugin and files under __plugin__/<provider>; direct syntactic requirePlugin calls only. Static scopes do not verify runtime bindings. Dynamic aliases, native implementations and exports remain unverified. No code executed.",
    runtimeVerified: false,
  };
}
