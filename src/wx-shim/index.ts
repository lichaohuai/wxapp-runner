import { socketApis } from "./socket";
import { locationApis } from "./location";
import { createHostApis, type HostApis } from "./host";
import { systemInfo } from "../config";
import { DeviceRuntime } from "../device/runtime";
import { capabilityRegistry } from "../capabilities";
import { createRequest } from "./network";
import { accountApi } from "./account";
import { success, failure, asyncApi, type Options } from "./common";
export function createWxShim(
  original: any,
  config: any,
  rpc: (name: string, args: any) => Promise<any>,
  log: (...a: any[]) => void,
  device = new DeviceRuntime(systemInfo),
  host: HostApis = createHostApis(config, log),
) {
  const files = host.files;
  // Keep the official storage cache, plugin key guard and serialization shared
  // with SDK/plugin calls. NativeFilesStorage supplies the persistent backend.
  // Standalone shim fixtures without a base library use that backend directly.
  const storage = Object.fromEntries(
    Object.entries(host.storage).map(([name, api]) => [
      name,
      typeof original[name] === "function"
        ? original[name].bind(original)
        : api,
    ]),
  );
  const sockets = socketApis(config.emitNetwork, {
    previewBytes: config.debug?.previewBytes,
    captureFrame: config.captureSocketFrame,
    checkURL: config.checkSocketURL,
  });
  function ui(name: string, o: Options = {}) {
    const { success: s, fail: f, complete: c, ...args } = o;
    return asyncApi(name, o, async () => {
      const r = await rpc(name, args);
      if (name.startsWith("choose"))
        for (const f of r.tempFiles || [])
          files.grant(f.path || f.tempFilePath);
      return r;
    });
  }
  function navigation(name: string, o: Options) {
    // Plugin public page names are code-space exports, not URL pathnames.
    // The original SDK resolves the declared alias and plugin.json pages map
    // before invoking the existing native navigation bridge.
    if (typeof o?.url === "string" && /^plugin(?:-private)?:\/\//.test(o.url)) {
      if (typeof original[name] === "function")
        return Reflect.apply(original[name], original, [o]);
      return asyncApi(name, o, async () => {
        throw Error("Plugin navigation requires the base-library resolver");
      });
    }
    return ui(name, o);
  }
  function navigateTo(o: Options) {
    return navigation("navigateTo", o);
  }
  function redirectTo(o: Options) {
    return navigation("redirectTo", o);
  }
  function switchTab(o: Options) {
    return navigation("switchTab", o);
  }
  function navigateBack(o: Options = {}) {
    return ui("navigateBack", o);
  }
  function reLaunch(o: Options) {
    return navigation("reLaunch", o);
  }
  function setNavigationBarTitle(o: Options) {
    return ui("setNavigationBarTitle", o);
  }
  function showToast(o: Options) {
    return ui("showToast", o);
  }
  function hideToast(o: Options = {}) {
    return ui("hideToast", o);
  }
  function showModal(o: Options) {
    return ui("showModal", o);
  }
  function showLoading(o: Options) {
    return ui("showLoading", o);
  }
  function hideLoading(o: Options = {}) {
    return ui("hideLoading", o);
  }
  function showActionSheet(o: Options) {
    return ui("showActionSheet", o);
  }
  function getSystemInfoSync() {
    return { ...systemInfo };
  }
  function getSystemInfo(o: Options = {}) {
    queueMicrotask(() => success("getSystemInfo", o, getSystemInfoSync()));
  }
  function getAppBaseInfo() {
    return { ...systemInfo };
  }
  function getWindowInfo() {
    return { ...systemInfo };
  }
  function getDeviceInfo() {
    return { ...systemInfo };
  }
  function getRendererUserAgent(o: Options = {}) {
    // 3.17.3 returns Promise<string>, while the optional callback receives
    // {userAgent}. Obtain it from the renderer, never invent a mobile UA.
    return asyncApi("getRendererUserAgent", o, () =>
      rpc("getRendererUserAgent", {}),
    ).then((r) => r?.userAgent);
  }
  function getMenuButtonBoundingClientRect() {
    return {
      left: 290,
      top: 28,
      right: 380,
      bottom: 60,
      width: 90,
      height: 32,
    };
  }
  function setClipboardData(o: Options) {
    return ui("setClipboardData", o);
  }
  function getClipboardData(o: Options) {
    return ui("getClipboardData", o);
  }
  function makePhoneCall(o: Options) {
    return ui("makePhoneCall", o);
  }
  function openLocation(o: Options) {
    return ui("openLocation", o);
  }
  function scanCode(o: Options = {}) {
    return ui("scanCode", o);
  }
  function previewImage(o: Options) {
    return ui("previewImage", o);
  }
  function chooseImage(o: Options) {
    return ui("chooseImage", o);
  }
  function chooseMedia(o: Options) {
    return ui("chooseMedia", o);
  }
  function chooseMessageFile(o: Options) {
    return ui("chooseMessageFile", o);
  }
  const implemented: any = {
    ...locationApis(rpc),
    ...files.api,
    ...sockets.api,
    ...storage,
    ...accountApi(config, log, original.cloud),
    request: createRequest(log, config.app.networkTimeout?.request, config),
    navigateTo,
    redirectTo,
    switchTab,
    navigateBack,
    reLaunch,
    setNavigationBarTitle,
    showToast,
    hideToast,
    showModal,
    showLoading,
    hideLoading,
    showActionSheet,
    getSystemInfoSync,
    getSystemInfo,
    getAppBaseInfo,
    getWindowInfo,
    getDeviceInfo,
    getRendererUserAgent,
    getMenuButtonBoundingClientRect,
    setClipboardData,
    getClipboardData,
    makePhoneCall,
    previewImage,
    openLocation,
    scanCode,
    chooseImage,
    chooseMedia,
    chooseMessageFile,
    ...device.api,
  };
  const delegated = new Set([
    "createWorker",
    "setBackgroundFetchToken",
    "getBackgroundFetchToken",
    "setNavigationBarColor",
    "showNavigationBarLoading",
    "hideNavigationBarLoading",
    "hideHomeButton",
    "showShareMenu",
    "hideShareMenu",
    "updateShareMenu",
    // This synchronous factory already exists in the real library. Returning
    // an async unsupported stub breaks App.onLaunch and can make App.onError
    // recursively throw when the app's error reporter uses manager.log().
    "getLogManager",
    // Preserve the real library's Promise/callback contract and its conversion
    // of all four public APIs to the native setTabBarBadge envelope.
    "setTabBarBadge",
    "showTabBar",
    "hideTabBar",
    "setTabBarItem",
    "setTabBarStyle",
    "removeTabBarBadge",
    "showTabBarRedDot",
    "hideTabBarRedDot",
    // The base library owns privacy metadata, pending authorization resolvers,
    // and verification of the real agreePrivacyAuthorization button event.
    // Keep those APIs together instead of replacing the query with a stub.
    "getPrivacySetting",
    "onNeedPrivacyAuthorization",
    "requirePrivacyAuthorize",
    "openPrivacyContract",
    "createVideoContext",
    "createCameraContext",
    "createMapContext",
    "createContext",
    "drawCanvas",
    "createCanvasContext",
    "canvasGetImageData",
    "canvasPutImageData",
    "canvasToTempFilePath",
    "getSkylineInfo",
    "getSkylineInfoSync",
    "nextTick",
    "createSelectorQuery",
    "createIntersectionObserver",
    "createAnimation",
    "getLaunchOptionsSync",
    "getEnterOptionsSync",
    "getCurrentPages",
    "getApp",
    "getAccountInfoSync",
    "arrayBufferToBase64",
    "base64ToArrayBuffer",
    "getPerformance",
    "eventCenter",
    "getUpdateManager",
  ]);
  function canIUse(name: string) {
    if (name === "requestPayment") return false;
    return implementedNames.has(name) || delegated.has(name);
  }
  implemented.canIUse = canIUse;
  implemented.env = { ...original.env, USER_DATA_PATH: "wxfile://usr" };
  const implementedNames = new Set(Object.keys(implemented));
  const hostImplemented = { ...implemented };
  const missing = new Map();
  // Bundlers (including uni-app) snapshot wx with for..in/Object.assign before
  // startup. A get-only Proxy hides SDK factories and listeners,
  // turning a controlled failure into "undefined is not a function". Preserve
  // the enumerable public API surface without claiming native support for it.
  const sdkOnly = new Set<string>();
  for (const name of Object.keys(original)) {
    if (Object.hasOwn(implemented, name) || name === "worklet") continue;
    const value = original[name];
    if (typeof value !== "function" && !delegated.has(name)) continue;
    // Preserve SDK factories, synchronous returns, validation and listeners.
    // Unsupported operations fail at their actual native dependency instead.
    // This does not add the entry to canIUse's host-supported set.
    const api = typeof value === "function" ? value.bind(original) : value;
    if (!delegated.has(name)) sdkOnly.add(name);
    Object.defineProperty(implemented, name, {
      value: api,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  device.setCapabilities([
    ...capabilityRegistry(hostImplemented, delegated, original, device.api),
    ...[...sdkOnly].map((api) => ({
      api,
      provider: "baselib" as const,
      callable: true,
      requires:
        "Original SDK entry only; native backend support is unverified. Inspect loader.nativeBoundary.",
    })),
  ]);
  let workletReported = false;
  return new Proxy(implemented, {
    get(target, name: any) {
      if (name in target) return target[name];
      // PC WebView has no Skyline worklet installation. Returning the generic
      // function stub here would make `if (wx.worklet)` incorrectly succeed
      // and then crash on worklet.Easing/derived in compatible app code.
      if (name === "worklet") {
        if (!workletReported) log("UNIMPLEMENTED: wx.worklet (WebView host)");
        workletReported = true;
        return undefined;
      }
      if (delegated.has(name))
        return typeof original[name] === "function"
          ? original[name].bind(original)
          : original[name];
      // Apps also use wx as an ordinary namespace (for example a bundler's
      // chunk queue). Inventing functions for absent data properties makes
      // `wx.cache = wx.cache || []` keep a stub instead of creating its array.
      // Known base-library APIs retain their original function contracts.
      if (typeof name !== "string" || typeof original[name] !== "function")
        return undefined;
      if (!missing.has(name)) missing.set(name, original[name].bind(original));
      return missing.get(name);
    },
  });
}
