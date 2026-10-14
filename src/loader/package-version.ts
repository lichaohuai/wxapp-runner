import fs from "node:fs";
import path from "node:path";

export function resolvePackageVersion(
  packageDir: string,
  appid: string,
  app: any,
  explicit?: unknown,
) {
  if (explicit !== undefined) {
    const value =
      typeof explicit === "string" && /^\d+$/.test(explicit)
        ? Number(explicit)
        : explicit;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw Error(
        "PACKAGE_VERSION_INVALID: appVersion must be a non-negative integer",
      );
    return { appVersion: value, appVersionSource: "explicit" };
  }
  // Library metadata belongs to this exact downloaded app, never to a directory name or another appid.
  if (path.basename(packageDir) === "package") {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(packageDir, "..", "manifest.json"), "utf8"),
      );
      if (
        manifest.format === 1 &&
        manifest.complete === true &&
        manifest.appid === appid &&
        Number.isSafeInteger(manifest.version) &&
        manifest.version > 0
      )
        return {
          appVersion: manifest.version as number,
          appVersionSource: "download-manifest",
        };
    } catch {
      /* Local source packages need not have download metadata. */
    }
  }
  const version = app.accountInfo?.appVersion ?? app.appVersion;
  if (Number.isSafeInteger(version) && version >= 0)
    return { appVersion: version as number, appVersionSource: "app-config" };
  // Official native GetAppPath uses 0 when no positive package version is available.
  return { appVersion: 0, appVersionSource: "unknown-native-zero" };
}
