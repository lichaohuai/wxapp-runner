import { analysisConfig } from "./analysis/boot";
import { debugLimitsSchema } from "./debug/limits";
import fs from "node:fs";
import path from "node:path";
import { readPackageConfig, safePath } from "./loader";
import { RunnerError, diagnostic } from "./diagnostics";
import { resolvePackageVersion } from "./loader/package-version";
import { defaultPackageConfig } from "./packages/paths";
import { prepareHostContacts } from "./loader/contacts";
import { resolveLaunchTarget } from "./loader/launch-target";
export const hostPlatform =
  process.platform === "darwin"
    ? "mac"
    : process.platform === "win32"
      ? "windows"
      : "linux";
export const hostSystem =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : "Linux";
/**
 * A packaged build ships the base library as an app resource; a source checkout
 * keeps it beside the repository. An explicit --baselib always wins.
 */
export function defaultBaselibDir() {
  const resources = (process as any).resourcesPath;
  if (resources) {
    const bundled = path.join(resources, "baselib");
    if (fs.existsSync(bundled)) return bundled;
  }
  return path.resolve("../baselib");
}
export function resolveAppid(
  packageDir: string,
  explicit?: string,
  app: any = {},
) {
  let appid = explicit || app.appid || app.appId;
  if (!appid)
    for (const file of ["project.config.json", "project.private.config.json"]) {
      try {
        const metadata = JSON.parse(
          fs.readFileSync(safePath(packageDir, file), "utf8"),
        );
        if (metadata.appid) {
          appid = metadata.appid;
          break;
        }
      } catch {
        /* Optional project metadata is not required. */
      }
    }
  if (typeof appid !== "string" || !/^wx[0-9a-f]{16}$/i.test(appid))
    throw new RunnerError(
      diagnostic(
        "APPID_REQUIRED",
        "package",
        "No valid appid was supplied or found in package metadata",
        "Pass --appid wx… explicitly; the loader never reuses another app identity.",
      ),
    );
  return appid;
}
// In dev (`electron .`) argv is [electron, appPath, ...userArgs] so the flags
// start at index 2; in a packaged build there is no appPath entry, so they
// start at index 1. `process.defaultApp` is set by Electron only in the dev
// case, letting the packaged .exe still parse --package/--appid/--config.
export function readConfig(
  args = process.argv.slice((process as any).defaultApp ? 2 : 1),
) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i].startsWith("--"))
      opts[args[i].slice(2)] = args[i + 1]?.startsWith("--")
        ? "true"
        : args[++i] || "true";
  const configFile = path.resolve(
    opts.config || defaultPackageConfig(path.resolve(__dirname, "..")),
  );
  const saved = fs.existsSync(configFile)
    ? JSON.parse(fs.readFileSync(configFile, "utf8"))
    : {};
  const packageDir = path.resolve(opts.package || "../package");
  const app = readPackageConfig(packageDir);
  const appid = resolveAppid(
    packageDir,
    opts.appid || process.env.APPID || saved.appid,
    app,
  );
  const version = resolvePackageVersion(
    packageDir,
    appid,
    app,
    opts["app-version"] ??
      (saved.appid === appid ? saved.appVersion : undefined),
  );
  const loaderAdapter =
    opts["loader-adapter"] || saved.loaderAdapter || "official";
  if (!["legacy", "official"].includes(loaderAdapter))
    throw new RunnerError(
      diagnostic(
        "LOADER_ADAPTER_INVALID",
        "package",
        "Unknown loader adapter: " + loaderAdapter,
        "Select official or legacy; unknown adapter settings are never ignored.",
      ),
    );
  return prepareHostContacts({
    packageDir,
    launchTarget: resolveLaunchTarget(app, opts["page-path"]),
    ...version,
    loaderAdapter,
    analysis: analysisConfig(saved.analysis, {
      bootScript: opts["boot-script"]
        ? fs.readFileSync(path.resolve(opts["boot-script"]), "utf8")
        : undefined,
      defeatAntiHook: opts["defeat-anti-hook"] === "true" ? true : undefined,
    }),
    debug: debugLimitsSchema.parse(saved.debug || {}),
    configFile,
    contactsFile: opts.contacts
      ? path.resolve(opts.contacts)
      : saved.contactsFile
        ? path.resolve(path.dirname(configFile), saved.contactsFile)
        : undefined,
    map: saved.map || {},
    userDataDir: opts["user-data"]
      ? path.resolve(opts["user-data"])
      : undefined,
    baselibDir: opts.baselib
      ? path.resolve(opts.baselib)
      : defaultBaselibDir(),
    appid,
    wxbot: opts.wxbot || process.env.WXBOT_BASE || saved.wxbot,
    appKey: opts["app-key"] || process.env.APP_KEY || saved.appKey,
    appSecret: opts["app-secret"] || process.env.APP_SECRET || saved.appSecret,
    deviceId: opts["device-id"] || process.env.DEVICE_ID || saved.deviceId,
    devtools: !!opts.devtools,
    mcp: !!opts.mcp,
    mcpFile: opts["mcp-file"] ? path.resolve(opts["mcp-file"]) : undefined,
    app,
  });
}
export function wxConfig(c: any) {
  return {
    ...c.app,
    ...(c.hostContacts?.appContactInfo
      ? { appContactInfo: structuredClone(c.hostContacts.appContactInfo) }
      : {}),
    // Split compiled bundles use the base library's lazy injection protocol.
    // This host field is often absent from extracted app-config.json. Without
    // it require.async asks for the merged app-service.js and eagerly executes
    // unrelated pages, even though split chunks were already registered.
    isLazyLoad:
      c.app.isLazyLoad ??
      c.plan?.logicFiles.includes("appservice.app.js") ??
      false,
    // Select the real PC bridge branch. Hardware simulation belongs to the
    // public device adapter, not the SDK's internal execution environment.
    platform: c.loaderAdapter === "legacy" ? "android" : hostPlatform,
    nativeBufferEnabled: true,
    appId: c.appid,
    // The real library derives plugin.env and its filesystem permission checks
    // from this boot configuration, before the app's wx shim is installed.
    env: {
      USER_DATA_PATH: "wxfile://usr",
      OPEN_DATA_PATH: "wxfile://opendata",
    },
    system: c.loaderAdapter === "legacy" ? "Android 14" : hostSystem,
    debug: false,
    isReady: true,
    appLaunchInfo: {
      path: c.launchTarget?.path || c.app.entryPagePath.replace(/\.html$/, ""),
      query: { ...(c.launchTarget?.query || {}) },
      scene: 1001,
    },
    accountInfo: { appId: c.appid, appVersion: c.appVersion ?? 0 },
    userInfo: {},
    network: {},
    envVersion: "release",
    deviceWidth: 390,
    deviceHeight: 844,
    screenWidth: 390,
    screenHeight: 844,
    pixelRatio: 1,
  };
}
export const systemInfo = {
  brand: "WxappRunner",
  model: "Desktop",
  platform: "android",
  system: "Android 14",
  version: "8.0.65",
  SDKVersion: "3.17.3",
  language: "zh_CN",
  // AppBaseInfo.host is always an object. A third-party host appId is
  // conditional and must not be replaced with the mini-program's appid.
  host: {} as { appId?: string },
  pixelRatio: 1,
  screenWidth: 390,
  screenHeight: 844,
  windowWidth: 390,
  windowHeight: 794,
  statusBarHeight: 24,
  safeArea: {
    left: 0,
    top: 24,
    right: 390,
    bottom: 794,
    width: 390,
    height: 770,
  },
  benchmarkLevel: 50,
  fontSizeSetting: 16,
  theme: "light",
  environment: "wxapp-runner",
};
