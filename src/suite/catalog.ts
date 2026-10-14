import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import {
  inspectPackage,
  readPackageConfig,
  safePath,
  chunkMap,
} from "../loader";

function walk(node: any, visit: (node: any) => boolean | void) {
  if (!node || typeof node !== "object" || !node.type) return;
  if (visit(node) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc"].includes(key)) continue;
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else walk(value, visit);
  }
}
function member(node: any): string | undefined {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression") {
    const root = member(node.object),
      key = node.computed ? node.property.value : node.property.name;
    if (root && typeof key === "string") return root + "." + key;
  }
}
export function moduleInventory(source: string) {
  const modules = new Map<string, { apis: string[]; handlers: string[] }>();
  const ast = parse(source, {
    ecmaVersion: "latest",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
  walk(ast, (n) => {
    if (
      n.type !== "CallExpression" ||
      n.callee?.name !== "define" ||
      typeof n.arguments[0]?.value !== "string"
    )
      return;
    const route = n.arguments[0].value.replace(/\.js$/, ""),
      apis = new Set<string>(),
      handlers = new Set<string>();
    walk(n.arguments[1], (v) => {
      const name = member(v);
      if (name?.startsWith("wx.")) apis.add(name);
      if (
        v.type === "CallExpression" &&
        ["Page", "Component"].includes(v.callee?.name)
      ) {
        const definition = v.arguments[0];
        for (const property of definition?.properties || []) {
          const key = property.key?.name || property.key?.value;
          if (/Function/.test(property.value?.type)) handlers.add(key);
          if (key === "methods")
            for (const p of property.value?.properties || [])
              handlers.add(p.key?.name || p.key?.value);
        }
      }
    });
    // Keep the most specific static wx path, not both wx.cloud and wx.cloud.database.
    modules.set(route, {
      apis: [...apis]
        .filter((x) => ![...apis].some((y) => y.startsWith(x + ".")))
        .sort(),
      handlers: [...handlers].filter(Boolean).sort(),
    });
    return false;
  });
  return modules;
}
export function buildCatalog(config: {
  packageDir: string;
  baselibDir: string;
  sourceDir?: string;
}) {
  const app = readPackageConfig(config.packageDir),
    plan = inspectPackage({ ...config, app });
  const modules = new Map<string, any>(),
    scanErrors: any[] = [];
  const digest = createHash("sha256").update(
    fs.readFileSync(safePath(config.packageDir, "app-config.json")),
  );
  const files = new Set([
    ...plan.logicFiles,
    ...Object.values(plan.pages).flatMap((p) => p.logicFiles),
    ...Object.values(chunkMap(config.packageDir))
      .filter((c) => path.basename(c) !== "__COMMON__")
      .map((c) => c + ".appservice.js"),
  ]);
  for (const file of [...files].sort()) {
    try {
      const source = fs.readFileSync(safePath(config.packageDir, file), "utf8");
      digest.update(file).update(source);
      for (const [route, entry] of moduleInventory(source))
        modules.set(route, { ...entry, file });
    } catch (e: any) {
      scanErrors.push({ file, error: e.message });
    }
  }
  const pages = Object.values(plan.pages).map((p) => {
    const metadata = modules.get(p.route),
      componentInventory = p.dependencies.map((route) => ({
        route,
        ...(modules.get(route) || { apis: [], handlers: [], unresolved: true }),
      })),
      apis: string[] = [
        ...new Set<string>([
          ...(metadata?.apis || []),
          ...componentInventory.flatMap((c) => c.apis),
        ]),
      ].sort();
    const mobile = apis.filter((a) =>
      /Location|Accelerometer|Compass|Gyroscope|Bluetooth|BLE|Wifi|Battery|Scan|scanCode|Vibrat|Camera|Recorder|NFC|Beacon|DeviceMotion|VKSession|Inference/.test(
        a,
      ),
    );
    const dependencies: string[] = [];
    if (p.route.includes("XRFrame") || apis.some((a) => /VKSession/.test(a)))
      dependencies.push("XR/VK runtime");
    if (apis.some((a) => /Inference/.test(a)) || p.route.includes("/ai/"))
      dependencies.push("model + actual inference backend");
    if (
      apis.some((a) => a.startsWith("wx.cloud")) ||
      p.route.startsWith("packageCloud/")
    )
      dependencies.push("wxbot + cloud environment permissions");
    if (p.renderer === "skyline")
      dependencies.push(
        "WebView fallback; Skyline-specific effects require verified engine",
      );
    const controls: any[] = [];
    let reference: any;
    if (config.sourceDir) {
      try {
        const file = safePath(config.sourceDir, p.route + ".wxml"),
          wxml = fs.readFileSync(file, "utf8");
        for (const m of wxml.matchAll(/<([\w-]+)\b([^<>]*)>/g)) {
          for (const a of m[2].matchAll(
            /\b((?:bind|catch):?[\w-]+)=["']([^"']+)["']/g,
          ))
            controls.push({
              tag: m[1],
              event: a[1],
              handler: a[2],
              compiledHandlerConfirmed: !!metadata?.handlers.includes(a[2]),
            });
        }
        reference = {
          file: p.route + ".wxml",
          sha256: createHash("sha256").update(wxml).digest("hex"),
          provenance: "reference source; build identity not verified",
        };
      } catch {
        /* compiled input remains authoritative */
      }
    }
    return {
      route: p.route,
      entry: "/" + p.route,
      group: p.route.split("/")[0],
      profiles: ["pc", "android", "ios"],
      primaryClass:
        mobile.length || /XRFrame|Skyline/.test(p.route) ? "mobile" : "pc",
      classificationBasis:
        "static API and route inventory; shared pages run under both classes",
      framework: p.framework,
      declaredRenderer: p.renderer,
      effectiveRenderer: p.effectiveRenderer,
      apiInventory: metadata
        ? {
            status:
              "direct module references only; dynamic/indirect calls require observation",
            ...metadata,
          }
        : {
            status: "module not statically identified",
            apis: [],
            handlers: [],
          },
      componentApiInventory: componentInventory,
      dependencyApis: apis,
      mobileInputs: mobile,
      dependencies,
      controls,
      reference,
      preflight: { ready: !p.issues.length, issues: p.issues },
      acceptance: {
        status: "已实现未验收",
        staticPreflight: !p.issues.length,
        visible: null,
        flow: null,
        effectAlignment: null,
      },
      scenarios: [
        {
          id: p.route + ":visible",
          level: "visible",
          expected:
            "Original page becomes ready and contains visible content; this does not certify the business flow.",
        },
        ...controls
          .filter((c) => c.compiledHandlerConfirmed)
          .map((c, i) => ({
            id: p.route + ":handler:" + i,
            level: "flow",
            handler: c.handler,
            event: c.event,
            status: "已实现未验收",
            expected:
              "Original callback and a page-specific visible result; requires explicit assertions.",
          })),
      ],
      exclusions: apis.some((a) => /requestPayment/.test(a)) ? ["payment"] : [],
    };
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    packageFingerprint: digest.digest("hex"),
    pageCount: pages.length,
    scanErrors,
    pages,
    evidencePolicy:
      "Preflight, visibility, flow and effect alignment are independent. Static scans never certify implementation or success.",
    platforms: {
      darwin: "已实现未验收",
      win32: "平台待验收",
      linux: "平台待验收",
    },
  };
}
