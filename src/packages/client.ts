import { gatewayURL } from "../gateway-url";
import fs from "node:fs";
import path from "node:path";
import { PackageError, moduleRoot } from "./archive";
export type SourceConfig = {
  base: string;
  appKey: string;
  appSecret: string;
  deviceId: string;
};
export function readSourceConfig(file: string): SourceConfig {
  const saved = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const c = { ...saved, ...saved.packageSource };
  const config = {
    base: c.base || c.wxbot,
    appKey: c.appKey,
    appSecret: c.appSecret,
    deviceId: c.deviceId,
  };
  for (const v of Object.values(config))
    if (typeof v !== "string" || !v.trim())
      throw new PackageError(
        "SOURCE_CONFIG_REQUIRED",
        "Package source needs wxbot/base, appKey, appSecret and deviceId in a private config file",
      );
  httpURL(config.base);
  return config;
}
export function httpURL(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new PackageError("INVALID_URL", "Invalid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new PackageError(
      "INVALID_URL",
      "HTTP(S) URL without embedded credentials required",
    );
  return u;
}
export async function readBounded(
  res: Response,
  max: number,
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
) {
  if (Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel();
    throw new PackageError(
      "PACKAGE_TOO_LARGE",
      "Response exceeds configured byte limit",
    );
  }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max)
        throw new PackageError(
          "PACKAGE_TOO_LARGE",
          "Response exceeds configured byte limit",
        );
      chunks.push(Buffer.from(value));
      onBytes?.(size);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class PackageSource {
  constructor(private config: SourceConfig) {}
  async post(endpoint: string, body: any, signal?: AbortSignal) {
    const u = gatewayURL(this.config.base, endpoint);
    const s = AbortSignal.any([
      signal || new AbortController().signal,
      AbortSignal.timeout(30000),
    ]);
    let res: Response;
    try {
      res = await fetch(u, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-App-Key": this.config.appKey,
          "X-App-Secret": this.config.appSecret,
        },
        body: JSON.stringify({ device_id: this.config.deviceId, ...body }),
        signal: s,
        redirect: "error",
      });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw new PackageError(
        "SOURCE_UNREACHABLE",
        "Package source request failed or timed out",
      );
    }
    const bytes = await readBounded(res, 4 * 1024 * 1024, s);
    let r: any;
    try {
      r = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new PackageError(
        "SOURCE_INVALID_RESPONSE",
        `Package source returned non-JSON (HTTP ${res.status})`,
      );
    }
    if (
      !res.ok ||
      !r ||
      r.ok === false ||
      r.success === false ||
      (r.ret !== undefined && Number(r.ret) !== 0) ||
      r.error
    )
      throw new PackageError(
        "SOURCE_REJECTED",
        `Package source rejected ${endpoint} (HTTP ${res.status}, ret ${Number.isFinite(Number(r?.ret)) ? Number(r.ret) : "unknown"}); check source login/configuration and keyword/version`,
      );
    return r;
  }
  async search(keyword: string, offset = "", signal?: AbortSignal) {
    const r = await this.post("/mp/wxa/search", { keyword, offset }, signal);
    if (!Array.isArray(r.accounts))
      throw new PackageError(
        "SEARCH_INVALID_RESPONSE",
        "Search response has no accounts array",
      );
    return {
      keyword,
      accounts: r.accounts
        .filter((x: any) => /^wx[0-9a-f]{16}$/.test(x.appid))
        .map((x: any) => ({
          appid: x.appid,
          title: String(x.title || ""),
          description: String(x.desc || ""),
          version:
            Number.isSafeInteger(x.version) && x.version > 0 ? x.version : null,
        })),
      nextOffset: r.next_offset == null ? "" : String(r.next_offset),
      versionNote:
        "A missing version must be resolved by keyword; appid alone cannot fetch a package",
    };
  }
  async urls(
    input: {
      keyword?: string;
      appid?: string;
      version?: number;
      expectedAppid?: string;
      module?: string;
    },
    signal?: AbortSignal,
  ) {
    const { keyword, appid, version, expectedAppid } = input;
    if (
      !keyword &&
      (!appid || !Number.isSafeInteger(version) || (version ?? 0) <= 0)
    )
      throw new PackageError(
        "VERSION_REQUIRED",
        "Provide keyword (a name), or appid and version",
      );
    const module = input.module
      ? "/" + moduleRoot(input.module) + "/"
      : undefined;
    const r = await this.post(
      "/v1/miniprogram/downloadpackage",
      {
        ...(keyword ? { keyword } : { appid, version }),
        urls_only: "1",
        ...(module ? { module } : {}),
      },
      signal,
    );
    if (
      !/^wx[0-9a-f]{16}$/.test(r.appid) ||
      !Number.isSafeInteger(r.version) ||
      r.version <= 0 ||
      !Array.isArray(r.urls) ||
      !r.urls.length ||
      r.urls.length > 20
    )
      throw new PackageError(
        "DOWNLOAD_INVALID_RESPONSE",
        "Download response is missing a valid appid, version or URLs",
      );
    if (
      (expectedAppid && r.appid !== expectedAppid) ||
      (appid && r.appid !== appid) ||
      (version && r.version !== version)
    )
      throw new PackageError(
        "PACKAGE_IDENTITY_MISMATCH",
        "Resolved appid/version differs from selection; no CDN files were downloaded",
      );
    if (module && "/" + moduleRoot(r.module) + "/" !== module)
      throw new PackageError(
        "MODULE_MISMATCH",
        "Source returned a different subpackage module",
      );
    if (!module && !["__APP__", "/", undefined, ""].includes(r.module))
      throw new PackageError(
        "MODULE_MISMATCH",
        "Source did not return the main module",
      );
    for (const url of r.urls) httpURL(url);
    return {
      appid: r.appid as string,
      version: r.version as number,
      module: module || "__APP__",
      urls: r.urls as string[],
    };
  }
}
/** CDN GETs intentionally carry no bot headers, including on redirects. */
export async function downloadURL(
  value: string,
  signal: AbortSignal,
  maxBytes: number,
  onBytes: (n: number) => void,
) {
  let url = httpURL(value);
  const combined = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: combined, redirect: "manual" });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new PackageError(
        "CDN_UNREACHABLE",
        "CDN request failed or timed out",
      );
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location)
        throw new PackageError("CDN_REDIRECT", "CDN redirect has no location");
      const next = httpURL(new URL(location, url).href);
      if (url.protocol === "https:" && next.protocol !== "https:")
        throw new PackageError("CDN_REDIRECT", "CDN HTTPS downgrade rejected");
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new PackageError("CDN_HTTP", `CDN HTTP ${res.status}`);
    }
    return readBounded(res, maxBytes, combined, onBytes);
  }
  throw new PackageError("CDN_REDIRECT", "Too many CDN redirects");
}
