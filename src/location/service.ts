import fs from "node:fs";
import path from "node:path";
import gcoord from "gcoord";
import { locationOverrideSchema, type LocationOverride } from "./override";
import {
  locationError,
  type LocationProvider,
  type LocationFix,
} from "./provider";

const scope = "scope.userLocation";
type Prompt = (name: string, args: any, viewId?: number) => Promise<any>;
export function locationOptions(args: any = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw locationError("INVALID_ARGUMENT", "invalid location options");
  const type = args.type ?? "wgs84";
  if (type !== "wgs84" && type !== "gcj02")
    throw locationError("INVALID_ARGUMENT", "type must be wgs84 or gcj02");
  for (const key of ["altitude", "isHighAccuracy"])
    if (args[key] !== undefined && typeof args[key] !== "boolean")
      throw locationError("INVALID_ARGUMENT", key + " must be boolean");
  const expiry = args.highAccuracyExpireTime;
  if (
    expiry !== undefined &&
    (!Number.isFinite(expiry) || expiry <= 0 || expiry > 60000)
  )
    throw locationError(
      "INVALID_ARGUMENT",
      "highAccuracyExpireTime must be greater than 0 and at most 60000 ms",
    );
  return {
    type,
    altitude: args.altitude === true,
    highAccuracy: args.isHighAccuracy === true,
    timeoutMs: args.isHighAccuracy ? (expiry ?? 10000) : 10000,
  };
}
export function locationResult(
  fix: LocationFix,
  options: ReturnType<typeof locationOptions>,
) {
  if (
    ![fix.latitude, fix.longitude, fix.accuracy, fix.timestamp].every(
      Number.isFinite,
    ) ||
    Math.abs(fix.latitude) > 90 ||
    Math.abs(fix.longitude) > 180 ||
    fix.accuracy < 0 ||
    Math.abs(Date.now() - fix.timestamp) > 30000
  )
    throw locationError(
      "LOCATION_INVALID_FIX",
      "native location returned an invalid or stale position",
    );
  const [longitude, latitude] =
    options.type === "gcj02"
      ? gcoord.transform(
          [fix.longitude, fix.latitude],
          gcoord.WGS84,
          gcoord.GCJ02,
        )
      : [fix.longitude, fix.latitude];
  return {
    latitude,
    longitude,
    accuracy: fix.accuracy,
    horizontalAccuracy: fix.accuracy,
    ...(Number.isFinite(fix.speed) && fix.speed! >= 0
      ? { speed: fix.speed }
      : {}),
    ...(options.altitude &&
    Number.isFinite(fix.altitude) &&
    Number.isFinite(fix.verticalAccuracy) &&
    fix.verticalAccuracy! >= 0
      ? { altitude: fix.altitude, verticalAccuracy: fix.verticalAccuracy }
      : {}),
  };
}

/** App permission lives in the appid/profile directory, separately from OS permission. */
export class LocationService {
  private setting: Record<string, boolean> = {};
  private revision = 0;
  private closed = false;
  private authorizing = new Map<string, Promise<void>>();
  private active = new Map<AbortController, number | undefined>();
  private override: LocationOverride = { mode: "system" };
  private savedOverride?: LocationOverride;
  private get debugFilename() {
    return path.join(path.dirname(this.filename), "debug-location.json");
  }
  constructor(
    private provider: LocationProvider,
    private filename: string,
    private prompt: Prompt,
    private appid: string,
    private description: string,
    private event: (event: any) => void = () => {},
    private extraScopes: string[] = [],
  ) {
    try {
      const stored = JSON.parse(fs.readFileSync(filename, "utf8"));
      for (const key of [scope, ...this.extraScopes])
        if (typeof stored[key] === "boolean") this.setting[key] = stored[key];
    } catch (e: any) {
      if (e.code !== "ENOENT")
        throw locationError(
          "PERMISSION_STORE_INVALID",
          "cannot read app permission store",
        );
    }
    try {
      const saved = JSON.parse(fs.readFileSync(this.debugFilename, "utf8"));
      if (saved.version !== 1 || saved.appid !== this.appid)
        throw Error("Debug location does not belong to this app profile");
      this.override = this.savedOverride = locationOverrideSchema.parse(
        saved.location,
      );
    } catch (e: any) {
      if (e.code !== "ENOENT")
        throw locationError(
          "LOCATION_STORE_INVALID",
          "cannot read saved debug location",
        );
    }
  }
  private ensureSupported() {
    if (this.closed) throw locationError("RUNTIME_CLOSED", "runtime closed");
    if (!this.provider.available && this.override.mode === "system")
      throw locationError(
        "LOCATION_UNSUPPORTED",
        "native location is unavailable on this platform",
      );
  }
  debugLocation(value?: unknown, persist?: boolean) {
    if (this.closed) throw locationError("RUNTIME_CLOSED", "runtime closed");
    if (
      persist !== undefined &&
      (typeof persist !== "boolean" || value === undefined)
    )
      throw locationError(
        "INVALID_ARGUMENT",
        "persist requires an explicit location",
      );
    if (value !== undefined) {
      // Complete validation before cancelling any in-flight operation.
      const next = locationOverrideSchema.parse(value);
      // Write before changing live state. A failed save must have no live side effects.
      if (persist === true) {
        fs.mkdirSync(path.dirname(this.debugFilename), { recursive: true });
        const tmp = this.debugFilename + ".tmp";
        fs.writeFileSync(
          tmp,
          JSON.stringify({ version: 1, appid: this.appid, location: next }),
          { mode: 0o600 },
        );
        fs.renameSync(tmp, this.debugFilename);
        this.savedOverride = next;
        this.event({
          type: "location-preference-change",
          persisted: true,
          mode: next.mode,
        });
      } else if (persist === false) {
        fs.rmSync(this.debugFilename, { force: true });
        this.savedOverride = undefined;
        this.event({ type: "location-preference-change", persisted: false });
      }
      if (JSON.stringify(next) !== JSON.stringify(this.override)) {
        const previousMode = this.override.mode;
        for (const controller of this.active.keys()) controller.abort();
        this.override = next;
        this.event({ type: "location-mode-change", previousMode, ...next });
      }
    }
    return {
      ...this.override,
      simulated: this.override.mode === "simulated",
      provider:
        this.override.mode === "simulated"
          ? "debug-simulation"
          : this.provider.name,
      systemProviderAvailable: this.provider.available,
      persisted:
        JSON.stringify(this.override) === JSON.stringify(this.savedOverride),
      savedLocation: this.savedOverride ?? null,
      lifetime:
        JSON.stringify(this.override) === JSON.stringify(this.savedOverride)
          ? "app-profile"
          : "runtime-session",
      appAuthorization: this.setting[scope] ?? "notDetermined",
    };
  }
  private save(value: boolean, key = scope) {
    const next = { ...this.setting, [key]: value };
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const tmp = this.filename + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, this.filename);
    const previous = this.setting[key];
    this.setting = next;
    this.revision++;
    this.event({ type: "permission-change", scope: key, previous, value });
    if (!value && key === scope) for (const controller of this.active.keys()) controller.abort();
  }
  getSetting(args: any = {}) {
    if (this.closed) throw locationError("RUNTIME_CLOSED", "runtime closed");
    // Subscription permission belongs to a separate, currently unsupported service.
    if (args.withSubscriptions)
      throw locationError(
        "API_UNIMPLEMENTED",
        "subscription settings not implemented",
      );
    return { authSetting: { ...this.setting } };
  }
  async authorize(args: any, viewId?: number) {
    const key = args?.scope;
    if (key !== scope && !this.extraScopes.includes(key))
      throw locationError("API_UNIMPLEMENTED", "unsupported authorization scope: " + String(key));
    if (this.closed) throw locationError("RUNTIME_CLOSED", "runtime closed");
    if (key === scope) this.ensureSupported();
    if (this.setting[key] === true) return {};
    const denied = () => locationError(key === scope ? "LOCATION_APP_DENIED" : "PERMISSION_DENIED", "auth deny");
    if (this.setting[key] === false) throw denied();
    if (!this.authorizing.has(key)) {
      const previous = this.setting[key];
      const task = (async () => {
        const camera = key === "scope.camera";
        const response = await this.prompt("authorize", {
          scope: key, appid: this.appid,
          title: camera ? "允许使用相机" : "允许访问位置",
          content: camera ? "此小程序希望使用相机。随后可选择电脑摄像头或调试图片；系统摄像头权限仍单独确认。" : this.description || "此小程序希望获取你的当前位置。",
        }, viewId);
        if (this.closed) throw locationError("RUNTIME_CLOSED", "runtime closed");
        if (previous !== this.setting[key]) throw locationError("PERMISSION_CHANGED", "permission changed while authorization was pending");
        this.save(response.confirm === true, key);
        if (!response.confirm) throw denied();
      })().finally(() => this.authorizing.delete(key));
      this.authorizing.set(key, task);
    }
    await this.authorizing.get(key);
    return {};
  }
  async openSetting(args: any = {}, viewId?: number) {
    this.getSetting(args);
    const revision = this.revision;
    let systemAuthorization = "unavailable";
    if (this.provider.available) {
      try {
        systemAuthorization = await this.provider.status();
      } catch {
        systemAuthorization = "unknown";
      }
    }
    const response = await this.prompt(
      "openSetting",
      {
        title: "小程序授权设置",
        appid: this.appid,
        authSetting: { ...this.setting },
        supportedScopes:
          this.provider.available || this.override.mode === "simulated"
            ? [scope, ...this.extraScopes]
            : [...this.extraScopes],
        systemAuthorization,
        locationMode: this.override.mode,
      },
      viewId,
    );
    if (this.closed) throw locationError("RUNTIME_CLOSED", "runtime closed");
    if (response.cancel) return this.getSetting(args);
    if (revision !== this.revision)
      throw locationError(
        "PERMISSION_CHANGED",
        "settings changed; reopen settings",
      );
    const next = response.authSetting;
    if (
      !next ||
      typeof next !== "object" ||
      Array.isArray(next) ||
      Object.keys(next).some(
        (k) =>
          (k !== scope && !this.extraScopes.includes(k)) ||
          !Object.hasOwn(this.setting, k) ||
          typeof next[k] !== "boolean",
      )
    )
      throw locationError(
        "INVALID_ARGUMENT",
        "settings may change previously requested scopes only",
      );
    for (const key of Object.keys(next)) {
      if (next[key] === this.setting[key]) continue;
      if (key === scope) this.ensureSupported();
      this.save(next[key], key);
    }
    return this.getSetting(args);
  }
  async getLocation(args: any, viewId?: number) {
    const options = locationOptions(args); // Validate before any prompt or host side effect.
    this.ensureSupported();
    const controller = new AbortController();
    this.active.set(controller, viewId);
    try {
      await this.authorize({ scope }, viewId);
      if (controller.signal.aborted)
        throw locationError(
          "LOCATION_CANCELLED",
          "location cancelled: page or runtime closed",
        );
      const revision = this.revision;
      const mode = this.override.mode;
      const fix =
        this.override.mode === "simulated"
          ? {
              latitude: this.override.latitude,
              longitude: this.override.longitude,
              accuracy: this.override.accuracy,
              timestamp: Date.now(),
            }
          : await this.provider.locate(options, controller.signal);
      if (
        controller.signal.aborted ||
        this.closed ||
        !this.setting[scope]
      )
        throw locationError(
          "LOCATION_CANCELLED",
          "location cancelled or permission changed",
        );
      const result = locationResult(fix, options);
      this.event({
        type: "location-result",
        mode,
        simulated: mode === "simulated",
        coordinateSystem: options.type,
        viewId,
      });
      return result;
    } finally {
      this.active.delete(controller);
    }
  }
  closeView(viewId: number) {
    for (const [controller, id] of this.active)
      if (id === viewId) controller.abort();
  }
  close() {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
    this.provider.close();
  }
}
