import { readableModule } from "./deobfuscate";
import { pluginDependencies } from "./source-dependencies";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { fileURLToPath } from "node:url";
import { safePath } from "../loader/paths";
type Module = {
  factoryId: string;
  path: string;
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  sha256: string;
  source: string;
  plugin?: string;
};
export class ModuleSource {
  originalLocation(root: string, script: any, line: number, column: number) {
    if (!script?.sourceMapURL)
      return { url: script?.url, line, column, mapped: false };
    try {
      const prefix = "data:application/json;base64,";
      if (
        !script.sourceMapURL.startsWith(prefix) ||
        script.sourceMapURL.length > 64 * 1024 * 1024
      )
        return {
          url: script.url,
          line,
          column,
          mapped: false,
          reason: "Source map is not an inline analysis map",
        };
      const raw = JSON.parse(
        Buffer.from(
          script.sourceMapURL.slice(prefix.length),
          "base64",
        ).toString("utf8"),
      );
      const original = originalPositionFor(new TraceMap(raw), {
        line,
        column: column - 1,
      });
      if (!original.source || !original.line || original.column == null)
        throw Error("Unmapped generated location");
      const file = safePath(root, original.source);
      // Bind to the package version used to produce the map. Stale source text must
      // never identify a new on-disk factory at an old position.
      const index = raw.sources.indexOf(original.source);
      if (
        typeof raw.sourcesContent?.[index] !== "string" ||
        fs.readFileSync(file, "utf8") !== raw.sourcesContent[index]
      )
        throw Error("Source map does not match the current package");
      return {
        url: file,
        line: original.line,
        column: original.column + 1,
        mapped: true,
      };
    } catch (e: any) {
      return {
        url: script?.url,
        line,
        column,
        mapped: false,
        reason: e.message,
      };
    }
  }
  private cache = new Map<
    string,
    { stamp: string; modules: Module[]; errors: any[] }
  >();
  index(root: string) {
    const candidates: string[] = [];
    const scan = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (
          /^(app-service|appservice\.app|common\.app)\.js$|\.appservice\.js$/.test(
            e.name,
          )
        )
          candidates.push(path.relative(root, p));
      }
    };
    scan(root);
    candidates.sort();
    const stamp = candidates
      .map((f) => {
        const st = fs.statSync(safePath(root, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
      .join("|");
    const existing = this.cache.get(root);
    if (existing?.stamp === stamp) return existing;
    const result = { stamp, modules: [] as Module[], errors: [] as any[] };
    let total = 0;
    for (const file of candidates) {
      try {
        const p = safePath(root, file),
          size = fs.statSync(p).size;
        total += size;
        if (size > 32 * 1024 ** 2 || total > 128 * 1024 ** 2)
          throw Error("Static source scan byte limit exceeded");
        const source = fs.readFileSync(p, "utf8");
        const ast: any = parse(source, {
          ecmaVersion: "latest",
          locations: true,
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
        });
        const pending: any[] = [{ node: ast, plugin: undefined }];
        while (pending.length) {
          const { node: n, plugin } = pending.pop();
          if (!n || typeof n !== "object") continue;
          const childPlugin =
            n.type === "CallExpression" &&
            n.callee?.name === "definePlugin" &&
            typeof n.arguments[0]?.value === "string"
              ? n.arguments[0].value
              : plugin;
          if (
            n.type === "CallExpression" &&
            n.callee?.type === "Identifier" &&
            n.callee.name === "define" &&
            typeof n.arguments[0]?.value === "string"
          ) {
            const factory = n.arguments.find(
              (a: any, i: number) =>
                i > 0 &&
                ["FunctionExpression", "ArrowFunctionExpression"].includes(
                  a.type,
                ),
            );
            if (factory) {
              const text = source.slice(factory.start, factory.end);
              const sha256 = createHash("sha256").update(text).digest("hex");
              result.modules.push({
                factoryId: `${file}:${factory.start}:${sha256}`,
                path: n.arguments[0].value,
                file,
                start: factory.start,
                end: factory.end,
                line: factory.loc.start.line,
                column: factory.loc.start.column + 1,
                endLine: factory.loc.end.line,
                endColumn: factory.loc.end.column + 1,
                sha256,
                source: text,
                ...(plugin ? { plugin } : {}),
              });
            }
          }
          for (const [key, value] of Object.entries(n)) {
            if (["loc", "start", "end"].includes(key)) continue;
            if (Array.isArray(value))
              pending.push(
                ...value.map((node) => ({ node, plugin: childPlugin })),
              );
            else if (value && typeof value === "object")
              pending.push({ node: value, plugin: childPlugin });
          }
        }
      } catch (e: any) {
        result.errors.push({ file, error: e.message });
      }
    }
    result.modules.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.file.localeCompare(b.file) ||
        a.start - b.start,
    );
    if (this.cache.size >= 4)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(root, result);
    return result;
  }
  query(root: string, a: any): any {
    const index = this.index(root),
      metadata = ({ source, ...m }: Module) => ({
        ...m,
        characters: source.length,
      }),
      all = index.modules.filter(
        (m) =>
          (!a.path || m.path === a.path) &&
          (!a.file || m.file === a.file) &&
          (!a.factoryId || m.factoryId === a.factoryId),
      );
    if (a.action === "dependencies")
      return pluginDependencies(root, all, index.modules, index.errors, a);
    if (a.action === "graph") {
      const nodes = all.slice(a.offset, a.offset + a.limit).map((m) => {
        const imports: any[] = [],
          exports: any[] = [],
          calls: any[] = [];
        const ast: any = parse("(" + m.source + "\n)", {
          ecmaVersion: "latest",
          locations: true,
        });
        const visit = (n: any) => {
          if (!n || typeof n !== "object") return;
          const location = {
            line: m.line + n.loc.start.line - 1,
            column:
              n.loc.start.line === 1
                ? m.column + n.loc.start.column - 1
                : n.loc.start.column + 1,
          };
          if (
            n.type === "CallExpression" &&
            n.callee?.type === "Identifier" &&
            n.callee.name === "require" &&
            typeof n.arguments[0]?.value === "string" &&
            imports.length < 40
          )
            imports.push({ module: n.arguments[0].value, ...location });
          if (
            n.type === "AssignmentExpression" &&
            n.left?.type === "MemberExpression" &&
            exports.length < 40
          ) {
            const x = n.left,
              owner = x.object,
              key = x.computed ? x.property.value : x.property.name;
            if (
              owner?.name === "exports" ||
              (owner?.type === "MemberExpression" &&
                owner.object?.name === "module" &&
                owner.property?.name === "exports")
            )
              exports.push({ name: key ?? "[dynamic]", ...location });
            else if (owner?.name === "module" && key === "exports")
              exports.push({ name: "default", ...location });
          }
          if (n.type === "CallExpression" && calls.length < 40)
            calls.push({
              expression: m.source
                .slice(Math.max(0, n.callee.start - 1), n.callee.end - 1)
                .slice(0, 200),
              ...location,
            });
          for (const [k, v] of Object.entries(n)) {
            if (["loc", "start", "end"].includes(k)) continue;
            if (Array.isArray(v))
              v.forEach((x) => {
                if (x?.type) visit(x);
              });
            else if (v && typeof v === "object" && (v as any).type) visit(v);
          }
        };
        visit(ast);
        return {
          ...metadata(m),
          imports,
          exports,
          calls,
          itemsMayBeTruncated: [imports, exports, calls].some(
            (x) => x.length === 40,
          ),
        };
      });
      return {
        nodes,
        total: all.length,
        nextOffset: a.offset + nodes.length,
        hasMore: a.offset + nodes.length < all.length,
        scanErrors: index.errors,
        basis:
          "literal require edges and syntactic export/call sites; no inferred dynamic call graph",
        deobfuscated: false,
      };
    }
    if (["get", "format", "deobfuscate"].includes(a.action)) {
      if (!all.length)
        throw Object.assign(Error("Module factory not found"), {
          code: "MODULE_NOT_FOUND",
        });
      if (new Set(all.map((m) => m.sha256)).size > 1)
        throw Object.assign(
          Error(
            "Module has multiple factories; select factoryId from runner_source list or current:true for the observed runtime factory",
          ),
          { code: "MODULE_AMBIGUOUS", candidates: all.map(metadata) },
        );
      const m = all[0];
      if (a.action !== "get") {
        const r = readableModule(m.source, m, a.action === "format"),
          end = Math.min(r.source.length, a.offset + a.length);
        return {
          ...metadata(m),
          ...r,
          source: r.source.slice(a.offset, end),
          offset: a.offset,
          nextOffset: end,
          hasMore: end < r.source.length,
          representation:
            a.action === "format"
              ? "formatted factory"
              : "conservative transformed factory",
          deobfuscated: r.passes.length > 0,
          map: a.includeMap ? r.map : undefined,
          sourceMapAvailable: true,
        };
      }
      const end = Math.min(m.source.length, a.offset + a.length);
      return {
        ...metadata(m),
        source: m.source.slice(a.offset, end),
        offset: a.offset,
        nextOffset: end,
        hasMore: end < m.source.length,
        offsetUnit: "UTF-16 characters",
        representation: "original define factory",
        deobfuscated: false,
        aliases: all.slice(1).map(metadata),
      };
    }
    if (a.action === "search") {
      const q = a.caseSensitive ? a.q : a.q.toLocaleLowerCase(),
        matches: any[] = [];
      // pathIncludes limits the scan to one package/file so the same obfuscated
      // code copied into many bundles (fm-post, chunk_*, main appservice) does
      // not flood the results. dedupe collapses byte-identical match contexts
      // across packages into one, listing the other paths it also occurs in.
      const scanned = a.pathIncludes
        ? all.filter((m) => m.path.includes(a.pathIncludes) || m.file.includes(a.pathIncludes))
        : all;
      const seen = a.dedupe ? new Map<string, any>() : null;
      let found = 0,
        hasMore = false,
        deduped = 0;
      outer: for (const m of scanned) {
        const text = a.caseSensitive ? m.source : m.source.toLocaleLowerCase();
        let at = 0;
        while ((at = text.indexOf(q, at)) >= 0) {
          if (found++ >= a.offset) {
            const prefix = m.source.slice(0, at),
              lines = prefix.split("\n"),
              preview = m.source.slice(Math.max(0, at - 100), at + q.length + 150);
            if (seen) {
              // Key on the surrounding context: identical code in a sibling
              // package produces the same preview; keep the first and record
              // the duplicate's path instead of emitting a full match.
              const dup = seen.get(preview);
              if (dup) {
                deduped++;
                if (!dup.alsoIn.includes(m.path) && dup.alsoIn.length < 20)
                  dup.alsoIn.push(m.path);
                at += Math.max(1, q.length);
                continue;
              }
            }
            if (matches.length >= a.limit) {
              hasMore = true;
              break outer;
            }
            const match: any = {
              factoryId: m.factoryId,
              path: m.path,
              file: m.file,
              offset: at,
              absoluteOffset: m.start + at,
              line: m.line + lines.length - 1,
              column:
                lines.length === 1 ? m.column + at : lines.at(-1)!.length + 1,
              preview,
            };
            if (seen) {
              match.alsoIn = [];
              seen.set(preview, match);
            }
            matches.push(match);
          }
          at += Math.max(1, q.length);
        }
      }
      return {
        matches,
        nextOffset: a.offset + matches.length,
        hasMore,
        ...(seen ? { dedupedDuplicates: deduped } : {}),
        scanErrors: index.errors,
        offsetUnit: "matches",
      };
    }
    const modules = all.slice(a.offset, a.offset + a.limit).map(metadata);
    return {
      modules,
      total: all.length,
      uniqueModules: new Set(all.map((m) => m.path)).size,
      nextOffset: a.offset + modules.length,
      hasMore: a.offset + modules.length < all.length,
      scanErrors: index.errors,
      basis: "static define calls; presence does not imply module was loaded",
    };
  }
  locate(root: string, url: string, line: number, column: number) {
    let relative: string;
    try {
      relative = path.relative(
        fs.realpathSync(root),
        fs.realpathSync(url.startsWith("file:") ? fileURLToPath(url) : url),
      );
    } catch {
      return [];
    }
    return this.index(root)
      .modules.filter(
        (m) =>
          m.file === relative &&
          (line > m.line || (line === m.line && column >= m.column)) &&
          (line < m.endLine || (line === m.endLine && column <= m.endColumn)),
      )
      .map(({ source, ...m }) => m);
  }
}
