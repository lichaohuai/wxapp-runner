import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { hasFile, safePath } from "./paths";

export type CompiledPlugins = {
  factories: Record<string, string>;
  aliases: Record<string, string>;
  components: Record<string, any>;
};

/** Protocol paths belong to code spaces, not to the filesystem. */
export function componentPath(value: string, from = "", prefix = ""): string {
  const protocol = /^(plugin(?:-private)?):\/\/([^/]+)\/(.*)$/.exec(value);
  if (protocol) {
    const [, scheme, provider, relative] = protocol;
    const name = path.posix.normalize(
      relative.replace(/\.(json|wxml|js|html)$/, ""),
    );
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.startsWith("../") ||
      /[\\\0]/.test(name)
    )
      throw Error("Invalid plugin component path: " + value);
    return `${scheme}://${provider}/${name}`;
  }
  if (value.includes("://"))
    throw Error("Invalid or unsupported component protocol: " + value);
  const parent = /^(plugin-private:\/\/[^/]+)\/(.*)$/.exec(from);
  if (parent)
    return componentPath(
      `${parent[1]}/${value.startsWith("/") ? value.slice(1) : path.posix.join(path.posix.dirname(parent[2]), value)}`,
    );
  const name = path.posix.normalize(
    (value.startsWith("/")
      ? value.slice(1)
      : path.posix.join(path.posix.dirname(from || "_"), value)
    ).replace(/\.(json|wxml|js|html)$/, ""),
  );
  return prefix && !name.startsWith(prefix) ? prefix + name : name;
}

export function literalComponentConfig(node: any) {
  if (node?.type !== "ObjectExpression")
    throw Error("Dynamic component configuration");
  const config: Record<string, Record<string, string>> = Object.create(null);
  for (const prop of node.properties) {
    const field = prop.key?.name ?? prop.key?.value;
    if (!["usingComponents", "componentPlaceholder"].includes(field)) continue;
    if (
      prop.type !== "Property" ||
      prop.computed ||
      prop.value?.type !== "ObjectExpression"
    )
      throw Error("Dynamic component dependencies");
    const entries: Record<string, string> = Object.create(null);
    for (const entry of prop.value.properties) {
      const alias = entry.key?.name ?? entry.key?.value;
      if (
        entry.type !== "Property" ||
        entry.computed ||
        typeof alias !== "string" ||
        typeof entry.value?.value !== "string"
      )
        throw Error("Dynamic component path");
      entries[alias] = entry.value.value;
    }
    config[field] = entries;
  }
  return config;
}

/** Inventory literal registrations inside compiled definePlugin factories only.
 * Never executes a factory, invents exports, or treats declaration metadata as code.
 * Actual code-space creation and component registration remain in the base library.
 */
export function readCompiledPlugins(
  root: string,
  prefix = "",
): CompiledPlugins {
  const result: CompiledPlugins = {
    factories: Object.create(null),
    aliases: Object.create(null),
    components: Object.create(null),
  };
  const entry = ["appservice.app.js", "app-service.js"].find((f) =>
    hasFile(root, prefix + f),
  );
  if (!entry) return result;
  const file = prefix + entry;
  const source = fs.readFileSync(safePath(root, file), "utf8");
  if (!source.includes("definePlugin")) return result;
  const ast: any = parse(source, {
    ecmaVersion: "latest",
    allowReturnOutsideFunction: true,
  });
  const visit = (n: any, provider?: string) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "CallExpression" && n.callee?.name === "definePlugin") {
      const id = /^plugin:\/\/(wx[0-9a-f]{16})$/.exec(
        n.arguments[0]?.value || "",
      )?.[1];
      const factory = n.arguments[1];
      if (
        id &&
        ["FunctionExpression", "ArrowFunctionExpression"].includes(
          factory?.type,
        )
      ) {
        result.factories[id] = file;
        visit(factory.body, id);
      }
      return;
    }
    if (provider) {
      const member = n.left?.object;
      const registry =
        member?.name === "__wxAppCode__" ||
        member?.property?.name === "__wxAppCode__";
      let name: string | undefined, config: any;
      if (
        n.type === "AssignmentExpression" &&
        n.operator === "=" &&
        registry &&
        typeof n.left.property?.value === "string" &&
        n.left.property.value.endsWith(".json")
      ) {
        name = n.left.property.value;
        config = n.right;
      }
      if (
        n.type === "CallExpression" &&
        n.callee?.object?.name === "__wxCodeSpace__" &&
        n.callee?.property?.name === "addComponentStaticConfig" &&
        typeof n.arguments[0]?.value === "string"
      ) {
        name = `plugin-private://${provider}/${n.arguments[0].value}.json`;
        config = n.arguments[1];
      }
      if (name && config?.type === "ObjectExpression") {
        const key = componentPath(name);
        if (key.startsWith(`plugin-private://${provider}/`))
          result.components[key] = literalComponentConfig(config);
      }
      if (
        n.type === "CallExpression" &&
        (n.callee?.name === "publishDomainComponents" ||
          n.callee?.property?.name === "publishDomainComponents") &&
        n.arguments[0]?.type === "ObjectExpression"
      ) {
        for (const p of n.arguments[0].properties) {
          if (
            p.type !== "Property" ||
            p.computed ||
            typeof p.key?.value !== "string" ||
            typeof p.value?.value !== "string"
          )
            continue;
          const alias = componentPath(p.key.value),
            target = componentPath(p.value.value);
          if (
            alias.startsWith(`plugin://${provider}/`) &&
            target.startsWith(`plugin-private://${provider}/`)
          )
            result.aliases[alias] = target;
        }
      }
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach((x) => visit(x, provider));
      else if (v && typeof v === "object") visit(v, provider);
    }
  };
  visit(ast);
  return result;
}

/** The native code manager requests per-plugin files even when the package
 * compiler embedded that plugin in its parent entry. Resolve only registrations
 * proven by AST, in the same package scope. A declaration/name/string is not code.
 */
export function readEmbeddedPluginAliases(
  root: string,
  prefix: string,
  manifest: CompiledPlugins,
) {
  const aliases: Record<string, string> = Object.create(null);
  const providers = Object.keys(manifest.factories);
  if (!providers.length) return aliases;
  for (const provider of providers) {
    const requested = `${prefix}__plugin__/${provider}/appservice.js`;
    if (!hasFile(root, requested))
      aliases[requested] = manifest.factories[provider];
  }
  const file = ["webview.app.js", "page-frame.js"]
    .map((f) => prefix + f)
    .find((f) => hasFile(root, f));
  if (!file) return aliases;
  const source = fs.readFileSync(safePath(root, file), "utf8");
  if (!source.includes("plugin-private://")) return aliases;
  const templates = new Set<string>();
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    const object = n.left?.object;
    if (
      n.type === "AssignmentExpression" &&
      n.operator === "=" &&
      (object?.name === "__wxAppCode__" ||
        object?.property?.name === "__wxAppCode__") &&
      [
        "CallExpression",
        "FunctionExpression",
        "ArrowFunctionExpression",
        "ArrayExpression",
      ].includes(n.right?.type)
    ) {
      const match = /^plugin-private:\/\/(wx[0-9a-f]{16})\/.+\.wxml$/.exec(
        n.left.property?.value || "",
      );
      if (match) templates.add(match[1]);
    }
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(
    parse(source, { ecmaVersion: "latest", allowReturnOutsideFunction: true }),
  );
  for (const provider of providers) {
    const requested = `${prefix}__plugin__/${provider}/pageframe.js`;
    if (
      // A plugin may expose JS APIs only and retain private templates. Its
      // compiled frame is still real even without publishDomainComponents.
      // Require the matching service factory and an actual WXML assignment;
      // declarations, strings and public export metadata alone are insufficient.
      templates.has(provider) &&
      !hasFile(root, requested)
    )
      aliases[requested] = file;
  }
  return aliases;
}

export function resolvePluginComponent(
  dep: string,
  plugins: Record<string, any>,
  manifest: CompiledPlugins,
) {
  const match = /^(plugin(?:-private)?):\/\/([^/]+)\/(.+)$/.exec(dep);
  if (!match) throw Error("Unsupported component provider: " + dep);
  const [, scheme, alias, name] = match;
  const provider = plugins[alias]?.provider || alias;
  if (!Object.values(plugins).some((p) => p?.provider === provider))
    throw Error("Plugin provider is not declared: " + alias);
  if (!manifest.factories[provider])
    throw Error("Compiled plugin factory is missing: " + provider);
  const key = componentPath(`${scheme}://${provider}/${name}`);
  const target = scheme === "plugin" ? manifest.aliases[key] : key;
  if (!target) throw Error("Plugin component export is not registered: " + key);
  if (!manifest.components[target])
    throw Error("Plugin component configuration is missing: " + target);
  return target;
}
