// Read-only: enumerate both registration forms in the supplied PC bridge.
// This is an official-source index, NOT an assertion that Runner supports it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { pathToFileURL } from "node:url";
export function officialNativeRegistry(base) {
const source = fs.readFileSync(
  path.join(base, "WAPCAdapterAppIndex.js"),
  "utf8",
);
const ast = parse(source, { ecmaVersion: "latest", locations: true });
function walk(n, f) {
  if (!n || typeof n !== "object") return;
  f(n);
  for (const [k, v] of Object.entries(n)) {
    if (k === "loc") continue;
    if (Array.isArray(v)) v.forEach((x) => walk(x, f));
    else if (v && typeof v === "object") walk(v, f);
  }
}
const key = (n) =>
  n?.type === "Identifier"
    ? n.name
    : n?.type === "Literal"
      ? n.value
      : undefined;
const modules = new Map();
walk(ast, (n) => {
  if (
    n.type === "Property" &&
    typeof n.key?.value === "string" &&
    n.key.value.startsWith("./src/") &&
    n.value.type === "FunctionExpression"
  )
    modules.set(n.key.value, n.value);
});
const id = "./src/app/index/bridge/apis.ts",
  root = modules.get(id);
if (!root) throw Error("Official bridge module missing");
const imports = new Map();
walk(root, (n) => {
  if (n.type === "VariableDeclarator" && n.id.type === "Identifier")
    walk(n.init, (x) => {
      if (
        x.type === "CallExpression" &&
        x.callee.name === root.params[2].name &&
        typeof x.arguments[0]?.value === "string"
      )
        imports.set(n.id.name, x.arguments[0].value);
    });
});
const at = (n) => ({
  offset: n.start,
  line: n.loc.start.line,
  column: n.loc.start.column,
});
const implName = (module, exp) => {
  const factory = modules.get(module);
  if (!factory) return {};
  const declarations = new Map();
  let impl;
  walk(factory, (n) => {
    if (n.type === "ClassDeclaration") declarations.set(n.id.name, n);
    if (n.type === "VariableDeclarator" && n.init)
      declarations.set(n.id?.name, n.init);
    if (
      n.type === "AssignmentExpression" &&
      n.left.type === "MemberExpression" &&
      n.left.object.name === factory.params[1].name &&
      key(n.left.property) === exp
    )
      impl = n.right;
  });
  if (impl?.type === "Identifier") impl = declarations.get(impl.name);
  if (!impl) return {};
  let api;
  walk(impl, (n) => {
    if (
      n.type === "PropertyDefinition" &&
      key(n.key) === "name" &&
      typeof n.value?.value === "string"
    )
      api = n.value.value;
    if (
      n.type === "AssignmentExpression" &&
      n.left.type === "MemberExpression" &&
      n.left.object.type === "ThisExpression" &&
      key(n.left.property) === "name" &&
      typeof n.right?.value === "string"
    )
      api = n.right.value;
  });
  return { api, implementation: at(impl) };
};
const rows = [];
walk(root, (n) => {
  if (
    n.type !== "AssignmentExpression" ||
    n.left.type !== "MemberExpression" ||
    n.left.object.name !== root.params[1].name
  )
    return;
  const field = key(n.left.property);
  if (field === "APIMap" && n.right.type === "ObjectExpression")
    for (const p of n.right.properties) {
      const value = p.value,
        module =
          value?.type === "MemberExpression"
            ? imports.get(value.object.name)
            : undefined;
      rows.push({
        api: key(p.key),
        registrationKind: "function-map",
        module: module ?? null,
        export: value?.type === "MemberExpression" ? key(value.property) : null,
        registration: at(p),
        implementation: module
          ? implName(module, key(value.property)).implementation
          : undefined,
        ...(module ? {} : { unknownBoundary: "ambient or dynamic binding" }),
      });
    }
  if (field === "classJsApiMap" && n.right.type === "ArrayExpression")
    for (const x of n.right.elements) {
      if (x?.type !== "NewExpression") continue;
      const module = imports.get(x.callee.object?.name),
        exp = key(x.callee.property),
        flow =
          exp === "FlowJsApiImpl" && typeof x.arguments[0]?.value === "string";
      const found = implName(module, exp);
      rows.push({
        api: flow ? x.arguments[0].value : (found.api ?? null),
        registrationKind: flow ? "flow-class" : "class",
        module: module ?? null,
        export: exp,
        registration: at(x),
        implementation: found.implementation,
        ...(!flow && !found.api
          ? { unknownBoundary: "name requires runtime evaluation; not guessed" }
          : {}),
      });
    }
});
if (!rows.length) throw Error("No official registrations found");
const result = {
  schemaVersion: 1,
  baselibVersion: JSON.parse(
    fs.readFileSync(path.join(base, "WAVersion.json"), "utf8"),
  ).version,
  sourceFile: "WAPCAdapterAppIndex.js",
  sha256: createHash("sha256").update(source).digest("hex"),
  module: id,
  interpretation:
    "Static PC JS registrations only; excludes native/WeChat fallback. No Runner implementation or acceptance inferred.",
  registrations: rows.length,
  uniqueResolvedNames: new Set(rows.flatMap((r) => (r.api ? [r.api] : [])))
    .size,
  unresolvedNames: rows.filter((r) => !r.api).length,
  entries: rows,
};
return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [base = "../baselib", output = "docs/official-native-registry.json"] = process.argv.slice(2);
  const result = officialNativeRegistry(base);
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, JSON.stringify(result,null,2) + "\n");
  console.log(JSON.stringify({output,registrations:result.registrations,uniqueResolvedNames:result.uniqueResolvedNames,unresolvedNames:result.unresolvedNames}));
}
