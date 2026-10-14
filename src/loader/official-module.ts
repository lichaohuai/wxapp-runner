import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { safePath } from "./paths";

/** Extract by module identity, never by build-specific byte offsets. */
export function officialModule(
  baselibDir: string,
  module: string,
  imports: Record<string, unknown>,
  globals: Record<string, unknown> = {},
) {
  const file = safePath(baselibDir, "WAPCAdapterAppIndex.js");
  const source = fs.readFileSync(file, "utf8");
  let factory: any;
  function visit(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "Property" && node.key?.value === module) {
      if (factory) throw Error("Ambiguous official module: " + module);
      factory = node.value;
    }
    for (const value of Object.values(node))
      Array.isArray(value) ? value.forEach(visit) : visit(value);
  }
  visit(parse(source, { ecmaVersion: "latest" }));
  if (!factory) throw Error("Official module missing: " + module);
  const code = source.slice(factory.start, factory.end);
  const context = vm.createContext({
    ...globals,
    module: { exports: {} },
    require(name: string) {
      if (!Object.hasOwn(imports, name))
        throw Error("Unsupported official dependency: " + name);
      return imports[name];
    },
  });
  new vm.Script(`(${code})(module,module.exports,require)`, {
    filename: file + "#" + module,
  }).runInContext(context, { timeout: 1000 });
  return {
    exports: context.module.exports as any,
    provenance: {
      file: "WAPCAdapterAppIndex.js",
      module,
      sha256: createHash("sha256").update(source).digest("hex"),
      factorySha256: createHash("sha256").update(code).digest("hex"),
    },
  };
}
