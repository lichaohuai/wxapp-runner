import fs from "node:fs";
import path from "node:path";
import { hasFile, safePath, routeName } from "./loader/paths";
import {
  detectFormat,
  readChunkMap,
  readCompiledManifest,
  formatFiles,
  type ViewFormat,
} from "./loader/formats";
import { RunnerError, diagnostic, type Diagnostic } from "./diagnostics";
import { rendererSelection } from "./loader/renderer";
import {
  componentPath,
  readCompiledPlugins,
  readEmbeddedPluginAliases,
  resolvePluginComponent,
  type CompiledPlugins,
} from "./loader/plugins";
export { safePath, routeName } from "./loader/paths";
export type PagePlan = {
  route: string;
  packageRoot: string;
  logicFiles: string[];
  framework: string;
  renderer: string;
  effectiveRenderer: string;
  rendererFallback: string | null;
  format: ViewFormat;
  files: string[];
  dependencies: string[];
  issues: Diagnostic[];
  deferredComponents?: {
    owner: string;
    alias: string;
    target: string;
    placeholder: string;
    reason: string;
  }[];
};
export type PackagePlan = {
  format: ViewFormat;
  baselibVersion?: string;
  entry: string;
  logicFiles: string[];
  pages: Record<string, PagePlan>;
  scriptAliases: Record<string, string>;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  startupReady: boolean;
};
export function readPackageConfig(packageDir: string) {
  try {
    const app = JSON.parse(
      fs.readFileSync(safePath(packageDir, "app-config.json"), "utf8"),
    );
    // Normalize the public spelling in memory; the downloaded bundle stays intact.
    app.subPackages ??= app.subpackages;
    if (
      !Array.isArray(app.pages) ||
      !app.pages.length ||
      app.pages.some((p: any) => typeof p !== "string") ||
      typeof app.entryPagePath !== "string"
    )
      throw Error(
        "pages must be a nonempty string array and entryPagePath must be a string",
      );
    if (
      app.subPackages !== undefined &&
      (!Array.isArray(app.subPackages) ||
        app.subPackages.some(
          (s: any) => !s || typeof s.root !== "string" || !s.root,
        ))
    )
      throw Error("subPackages must contain root paths");
    return app;
  } catch (e: any) {
    throw new RunnerError(
      diagnostic(
        "PACKAGE_CONFIG_INVALID",
        "package",
        e.message,
        "Check the decrypted package directory and app-config.json.",
        { file: "app-config.json" },
      ),
    );
  }
}
function roots(app: any): string[] {
  return [
    "",
    ...(app.subPackages || []).map((s: any) =>
      routeName(s.root).replace(/\/?$/, "/"),
    ),
  ];
}
export function chunkMap(packageDir: string) {
  const app = readPackageConfig(packageDir);
  return Object.assign(
    {},
    ...roots(app).map((root) => readChunkMap(packageDir, root)),
  ) as Record<string, string>;
}
const setting = (value: any, fallback: string): string =>
  typeof value === "string" ? value : value?.default || fallback;
function pageConfig(app: any, route: string) {
  const config = app.page?.[route + ".html"] || app.page?.[route] || {};
  return { ...config, ...config.window };
}
export function inspectPackage(config: {
  packageDir: string;
  baselibDir?: string;
  app?: any;
  launchTarget?: { path: string };
}): PackagePlan {
  const { packageDir } = config;
  const app = config.app || readPackageConfig(packageDir);
  const entry = config.launchTarget?.path || routeName(app.entryPagePath);
  const errors: Diagnostic[] = [],
    warnings: Diagnostic[] = [];
  const prefixes = roots(app);
  const manifests = new Map<string, Record<string, string>>();
  const manifestErrors = new Map<string, Diagnostic>();
  const compiledComponents: Record<string, any> = Object.create(null);
  const pluginManifests = new Map<string, CompiledPlugins>();
  const hasPlugins =
    Object.keys(app.plugins || {}).length ||
    app.subPackages?.some((s: any) => Object.keys(s.plugins || {}).length);
  for (const prefix of prefixes) {
    try {
      const manifest = readCompiledManifest(packageDir, prefix);
      manifests.set(prefix, manifest.chunks);
      Object.assign(compiledComponents, manifest.components);
      if (hasPlugins)
        pluginManifests.set(prefix, readCompiledPlugins(packageDir, prefix));
    } catch (e: any) {
      manifestErrors.set(
        prefix,
        e.diagnostic ||
          diagnostic(
            "PLUGIN_MANIFEST_INVALID",
            "package",
            e.message,
            "Supply the original compiled plugin registrations.",
            { file: prefix + "appservice.app.js" },
          ),
      );
    }
  }
  const map: Record<string, string> = Object.assign({}, ...manifests.values());
  const scriptAliases: Record<string, string> = Object.create(null);
  // Chunked packages store shared registrations in common.app.js. This base
  // library may ask the native host for <chunk>.common.js as part of a pair.
  // Resolve only chunks declared by that registry; real per-chunk common files
  // take precedence. Missing service chunks are still preflight errors.
  for (const [prefix, entries] of manifests)
    for (const chunk of new Set(Object.values(entries))) {
      if (chunk === prefix + "__COMMON__") {
        for (const [suffix, candidates] of Object.entries({
          "appservice.js": ["appservice.app.js", "app-service.js"],
          "webview.js": ["webview.app.js"],
        })) {
          const shared = candidates.find((f) =>
            hasFile(packageDir, prefix + f),
          );
          if (shared && !hasFile(packageDir, chunk + "." + suffix))
            scriptAliases[chunk + "." + suffix] = prefix + shared;
        }
      }
      if (!hasFile(packageDir, chunk + ".common.js"))
        scriptAliases[chunk + ".common.js"] = prefix + "common.app.js";
    }
  for (const [prefix, manifest] of pluginManifests)
    Object.assign(scriptAliases, readEmbeddedPluginAliases(packageDir, prefix, manifest));
  const format = detectFormat(packageDir);
  const logicFiles = hasFile(packageDir, "common.app.js")
    ? ["common.app.js"]
    : [];
  // Prefer the original split entry when present. A generated concatenation
  // eagerly registers every page and can repeat chunk initialization.
  const logic = ["appservice.app.js", "app-service.js"].find((f) =>
    hasFile(packageDir, f),
  );
  if (logic) logicFiles.push(logic);
  else
    errors.push(
      diagnostic(
        "LOGIC_BUNDLE_MISSING",
        "package",
        "No supported logic bundle",
        "Provide app-service.js or appservice.app.js.",
        { file: "app-service.js" },
      ),
    );
  let baselibVersion: string | undefined;
  if (config.baselibDir) {
    for (const file of [
      "WAServiceMainContext.js",
      "WASubContext.js",
      "WAWebview.js",
    ]) {
      if (!hasFile(config.baselibDir, file))
        errors.push(
          diagnostic(
            "BASELIB_FILE_MISSING",
            "baselib",
            "Required base library file is missing or inaccessible",
            "Provide a complete base library from the same version.",
            { file },
          ),
        );
    }
    try {
      baselibVersion = JSON.parse(
        fs.readFileSync(safePath(config.baselibDir, "WAVersion.json"), "utf8"),
      ).version;
    } catch {
      /* Unknown versions are reported below. */
    }
    if (baselibVersion !== "3.17.3")
      warnings.push(
        diagnostic(
          "BASELIB_VERSION_UNTESTED",
          "baselib",
          `Base library version ${baselibVersion || "unknown"} has not been verified`,
          "The current bridge has been verified with 3.17.3; other versions may need bridge changes.",
        ),
      );
  }
  const pages: Record<string, PagePlan> = Object.create(null);
  for (const raw of app.pages) {
    const route = routeName(raw),
      pc = pageConfig(app, route);
    const prefix =
      prefixes
        .filter((p) => route.startsWith(p))
        .sort((a, b) => b.length - a.length)[0] || "";
    const subpackage = app.subPackages?.find(
      (p: any) => routeName(p.root).replace(/\/?$/, "/") === prefix,
    );
    const renderer = setting(
      pc.renderer,
      setting(subpackage?.renderer, setting(app.renderer, "webview")),
    );
    const framework = setting(
      pc.componentFramework,
      setting(
        subpackage?.componentFramework,
        setting(app.componentFramework, "exparser"),
      ),
    );
    const selection = rendererSelection(renderer);
    const localFormat = prefix ? detectFormat(packageDir, prefix) : format;
    const issues: Diagnostic[] = [];
    const add = (code: string, message: string, hint: string, file?: string) =>
      issues.push(
        diagnostic(code, "package", message, hint, {
          route,
          ...(file ? { file } : {}),
        }),
      );
    if (selection.effectiveRenderer !== "webview")
      add(
        "RENDERER_UNSUPPORTED",
        `Renderer ${renderer} is unsupported`,
        "This host currently supports webview pages only.",
      );
    if (!["glass-easel", "exparser"].includes(framework))
      add(
        "FRAMEWORK_UNSUPPORTED",
        `Framework ${framework} is unsupported`,
        "A compatible base library and host adapter are required.",
      );
    if (format === "unsupported")
      add(
        "VIEW_FORMAT_UNSUPPORTED",
        "Unknown compiled view format",
        "Expected page-frame.html, page-frame.js or webview.app.js; do not substitute source WXML for compiled files.",
      );
    for (const p of ["", ...(prefix ? [prefix] : [])])
      if (manifestErrors.has(p))
        issues.push({ ...manifestErrors.get(p)!, route });
    if (!hasFile(packageDir, route + ".html"))
      add(
        "PAGE_FILE_MISSING",
        "Page HTML is missing or inaccessible",
        prefix
          ? `Provide the decrypted subpackage ${prefix}.`
          : "Provide the complete decrypted package.",
        route + ".html",
      );
    const needed = new Set<string>();
    const deferredComponents: NonNullable<PagePlan["deferredComponents"]> = [];
    const plugins = { ...(app.plugins || {}), ...(subpackage?.plugins || {}) };
    const pluginManifest: CompiledPlugins = {
      factories: Object.create(null),
      aliases: Object.create(null),
      components: Object.create(null),
    };
    for (const scope of new Set(["", prefix])) {
      const manifest = pluginManifests.get(scope);
      if (manifest)
        for (const key of ["factories", "aliases", "components"] as const)
          Object.assign(pluginManifest[key], manifest[key]);
    }
    const visit = (p: string) => {
      if (needed.has(p)) return;
      needed.add(p);
      const deps = {
        ...(!p.includes("://") ? app.global?.usingComponents : {}),
        ...(!p.includes("://") ? app.usingComponents : {}),
        ...(compiledComponents[p]?.usingComponents || {}),
        ...(pluginManifest.components[p]?.usingComponents || {}),
        ...(pageConfig(app, p).usingComponents || {}),
      };
      const placeholders = {
        ...compiledComponents[p]?.componentPlaceholder,
        ...pluginManifest.components[p]?.componentPlaceholder,
        ...pageConfig(app, p).componentPlaceholder,
      };
      for (const [alias, dep] of Object.entries(deps)) {
        if (typeof dep !== "string") {
          add(
            "COMPONENT_CONFIG_INVALID",
            "Component path is not a string",
            "Check usingComponents in app-config.json.",
          );
          continue;
        }
        let resolved: string;
        try {
          resolved = componentPath(dep, p);
          if (resolved.includes("://"))
            resolved = resolvePluginComponent(
              resolved,
              plugins,
              pluginManifest,
            );
        } catch (e: any) {
          const placeholder = placeholders[alias];
          if (
            placeholder &&
            (/^plugin(?:-private)?:\/\//.test(dep) ||
              p.startsWith("plugin-private://"))
          ) {
            if (
              ["view", "text"].includes(placeholder) ||
              typeof deps[placeholder] === "string"
            ) {
              deferredComponents.push({
                owner: p,
                alias,
                target: dep,
                placeholder,
                reason: e.message,
              });
              // A named fallback also occurs in usingComponents and is visited normally.
              continue;
            }
          }
          add(
            dep.includes("://") || p.includes("://")
              ? "PLUGIN_DEPENDENCY_UNRESOLVED"
              : "COMPONENT_CONFIG_INVALID",
            e.message,
            "Restore the compiled plugin factory/export, or supply a valid declared componentPlaceholder.",
            p,
          );
          continue;
        }
        // A cross-subpackage placeholder is deliberately replaceable later by
        // the base library. Don't eagerly turn it into a startup dependency.
        const depRoot =
          prefixes
            .filter((r) => r && resolved.startsWith(r))
            .sort((a, b) => b.length - a.length)[0] || "";
        if (placeholders[alias] && depRoot && depRoot !== prefix) continue;
        visit(resolved);
      }
    };
    visit(route);
    const files = [
      ...formatFiles(
        packageDir,
        "",
        format,
        Object.keys(manifests.get("") || {}).length > 0,
      ),
      ...(prefix
        ? formatFiles(
            packageDir,
            prefix,
            localFormat,
            Object.keys(manifests.get(prefix) || {}).length > 0,
          )
        : []),
    ];
    const pageLogicFiles: string[] = [];
    if (prefix) {
      if (hasFile(packageDir, prefix + "common.app.js"))
        pageLogicFiles.push(prefix + "common.app.js");
      const subLogic = ["appservice.app.js", "app-service.js"].find((f) =>
        hasFile(packageDir, prefix + f),
      );
      if (subLogic) pageLogicFiles.push(prefix + subLogic);
      else
        add(
          "SUBPACKAGE_LOGIC_MISSING",
          "Subpackage logic entry is missing",
          "Provide the matching subpackage logic bundle before navigating to this page.",
          prefix + "appservice.app.js",
        );
    }
    for (const dep of needed)
      if (map[dep])
        files.push(
          scriptAliases[map[dep] + ".webview.js"] || map[dep] + ".webview.js",
        );
    for (const file of new Set(files))
      if (!hasFile(packageDir, file))
        add(
          "VIEW_DEPENDENCY_MISSING",
          "Required view dependency is missing or inaccessible",
          "Restore the referenced chunk/template file; missing dependencies cannot be skipped.",
          file,
        );
    // Combined app-service.js may embed all logic chunks; split bundles require mapped service chunks.
    const localLogic = prefix ? pageLogicFiles.at(-1) : logic;
    if (localLogic?.endsWith("appservice.app.js"))
      for (const dep of needed)
        if (
          map[dep] &&
          !hasFile(
            packageDir,
            scriptAliases[map[dep] + ".appservice.js"] ||
              map[dep] + ".appservice.js",
          )
        )
          add(
            "LOGIC_DEPENDENCY_MISSING",
            "Required logic chunk is missing",
            "Restore the referenced service chunk.",
            map[dep] + ".appservice.js",
          );
    pages[route] = {
      route,
      packageRoot: prefix,
      logicFiles: pageLogicFiles,
      renderer,
      ...selection,
      framework,
      format: localFormat === "unsupported" ? format : localFormat,
      files: [...new Set(files)],
      dependencies: [...needed].filter((p) => p !== route),
      issues,
      deferredComponents,
    };
    (route === entry ? errors : warnings).push(...issues);
    if (selection.rendererFallback && !issues.length)
      warnings.push(
        diagnostic(
          "RENDERER_FALLBACK",
          "package",
          `Declared ${renderer}; host will use the compiled WebView backend`,
          "Skyline-only features remain unsupported. Package configuration is unchanged; verify this page's behavior in WebView.",
          { route },
        ),
      );
  }
  if (!pages[entry])
    errors.push(
      diagnostic(
        "ENTRY_NOT_REGISTERED",
        "package",
        "Entry page is absent from pages",
        "Correct entryPagePath or supply the matching app-config.json.",
        { route: entry },
      ),
    );
  return {
    format,
    baselibVersion,
    entry,
    logicFiles,
    scriptAliases,
    pages,
    errors,
    warnings,
    startupReady: errors.length === 0,
  };
}
export function pagePlan(config: any, route: string): PagePlan {
  const plan: PackagePlan = config.plan || inspectPackage(config);
  const page = plan.pages[routeName(route)];
  if (!page)
    throw new RunnerError(
      diagnostic(
        "PAGE_NOT_REGISTERED",
        "package",
        "Unknown page",
        "Use a route registered in app-config.json.",
        { route },
      ),
    );
  if (page.issues.length) throw new RunnerError(page.issues[0]);
  return page;
}
export function viewFiles(config: any, route: string) {
  return pagePlan(config, route).files;
}
