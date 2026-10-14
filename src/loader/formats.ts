import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { hasFile, safePath, routeName } from "./paths";
import { RunnerError, diagnostic } from "../diagnostics";
import { componentPath, literalComponentConfig } from "./plugins";
export type ViewFormat =
  "page-frame" | "page-frame-script" | "webview-chunks" | "unsupported";
export function detectFormat(root: string, prefix = ""): ViewFormat {
  if (hasFile(root, prefix + "page-frame.html")) return "page-frame";
  if (hasFile(root, prefix + "webview.app.js")) return "webview-chunks";
  if (hasFile(root, prefix + "page-frame.js")) return "page-frame-script";
  return "unsupported";
}
// Static AST inspection: do not execute package code to discover its dependencies.
export function readChunkMap(root: string, prefix = "") {
  return readCompiledManifest(root, prefix).chunks;
}
export function readCompiledManifest(root: string, prefix = "") {
  const file = prefix + "common.app.js";
  const result: Record<string, string> = {};
  const components: Record<string, any> = Object.create(null);
  if (!hasFile(root, file)) return { chunks: result, components };
  const register = (chunk: string, routes: string[]) => {
    for (const route of routes) {
      const key = componentPath(routeName(route), "", prefix);
      const normalized = path.posix.normalize(chunk.replace(/^\//, ""));
      const value =
        prefix && !normalized.startsWith(prefix)
          ? path.posix.join(prefix, normalized)
          : normalized;
      if (result[key] && result[key] !== value)
        throw Error("conflicting chunk registration for " + key);
      result[key] = value;
    }
  };
  try {
    const ast = parse(fs.readFileSync(safePath(root, file), "utf8"), {
      ecmaVersion: "latest",
      allowReturnOutsideFunction: true,
    });
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        node.left?.type === "MemberExpression" &&
        node.left.object?.name === "__wxAppCode__" &&
        typeof node.left.property?.value === "string" &&
        node.left.property.value.endsWith(".json") &&
        node.right?.type === "ObjectExpression"
      ) {
        const key = componentPath(node.left.property.value, "", prefix);
        components[key] = literalComponentConfig(node.right);
      }
      if (
        node.type === "CallExpression" &&
        (node.callee?.name === "initializeCodeChunk" ||
          node.callee?.property?.name === "initializeCodeChunk" ||
          node.callee?.property?.value === "initializeCodeChunk")
      ) {
        const [chunk, routes] = node.arguments;
        if (
          typeof chunk?.value !== "string" ||
          routes?.type !== "ArrayExpression" ||
          routes.elements.some((x: any) => typeof x?.value !== "string")
        )
          throw Error(
            "dynamic initializeCodeChunk arguments are not supported",
          );
        register(
          chunk.value,
          routes.elements.map((item: any) => item.value),
        );
      }
      // exparser's compiled lazy registry uses a literal tuple table, followed
      // by nested forEach assignments to __LAZY_CODE_LOADING_CHUNK_MAP__.
      // Read the table only; never execute its callback during inspection.
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.property?.name === "forEach" &&
        node.callee.object?.type === "ArrayExpression"
      ) {
        const writesRegistry = (n: any): boolean =>
          n &&
          typeof n === "object" &&
          ((n.type === "AssignmentExpression" &&
            n.left?.type === "MemberExpression" &&
            n.left.object?.name === "__LAZY_CODE_LOADING_CHUNK_MAP__") ||
            Object.values(n).some((v) =>
              Array.isArray(v) ? v.some(writesRegistry) : writesRegistry(v),
            ));
        if (node.arguments.some(writesRegistry)) {
          for (const tuple of node.callee.object.elements) {
            const [chunk, routes] = tuple?.elements || [];
            if (
              tuple?.type !== "ArrayExpression" ||
              typeof chunk?.value !== "string" ||
              !chunk.value ||
              routes?.type !== "ArrayExpression" ||
              routes.elements.some((x: any) => typeof x?.value !== "string")
            )
              throw Error(
                "dynamic lazy chunk table arguments are not supported",
              );
            register(
              chunk.value,
              routes.elements.map((item: any) => item.value),
            );
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    };
    visit(ast);
  } catch (e: any) {
    throw new RunnerError(
      diagnostic(
        "CHUNK_MANIFEST_INVALID",
        "package",
        e.message,
        "Provide the original common.app.js; dynamic manifest formats need a new format adapter.",
        { file },
      ),
    );
  }
  return { chunks: result, components };
}
const adapters = {
  "page-frame": (prefix: string) => [prefix + "page-frame.html"],
  "page-frame-script": (prefix: string) => [
    prefix + "page-frame.js",
    prefix + "app-wxss.js",
  ],
  "webview-chunks": (prefix: string) => [
    prefix + "common.app.js",
    prefix + "webview.app.js",
  ],
};
export function formatFiles(
  root: string,
  prefix: string,
  format: ViewFormat,
  hasChunks = false,
) {
  if (format === "unsupported") return [];
  const files = adapters[format](prefix);
  // Some compiled packages use webview.app.js for the shared/plugin frame,
  // and app-wxss.js for page templates/styles, with no initializeCodeChunk
  // registry. Chunked packages must keep loading only their mapped chunks.
  if (format === "webview-chunks" && !hasChunks)
    files.push(prefix + "app-wxss.js");
  // Script frames may hold all templates directly (subpackage layout), or
  // keep their WXML/WXSS registrations in the adjacent app-wxss.js.
  return files.filter(
    (f) =>
      (!f.endsWith("common.app.js") && !f.endsWith("app-wxss.js")) ||
      hasFile(root, f),
  );
}
