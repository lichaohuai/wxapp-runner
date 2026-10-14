import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PackageError } from "./archive";
import { packageSchema } from "./schema";
import { defaultPackageConfig, defaultPackageLibrary } from "./paths";
export type BrokerOptions = {
  repoRoot?: string;
  configFile?: string;
  root?: string;
};
/** Shared by stdio, CLI and the native Wxapp panel. Independent of live runtimes. */
export async function callPackages(
  raw: unknown,
  options: BrokerOptions = {},
  signal?: AbortSignal,
) {
  const args = packageSchema.parse(raw),
    repo = options.repoRoot || path.resolve(__dirname, ".."),
    root = path.resolve(
      options.root ||
        process.env.WXAPP_PACKAGE_LIBRARY ||
        defaultPackageLibrary(repo),
    );
  const file = path.join(root, "service.json");
  const connect = async () => {
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8")),
        url = new URL(c.endpoint);
      if (
        url.hostname !== "127.0.0.1" ||
        url.protocol !== "http:" ||
        url.username ||
        url.password ||
        typeof c.token !== "string"
      )
        return null;
      const r = await fetch(new URL("/health", url), {
        headers: { authorization: "Bearer " + c.token },
        signal: AbortSignal.timeout(600),
        redirect: "error",
      });
      if (r.ok && (await r.json()).service === "wxapp-packages") return c;
    } catch {
      /* A stale connection is not an instruction to replay an operation. */
    }
    return null;
  };
  let c = await connect();
  signal?.throwIfAborted();
  if (!c) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(root, "service.log"), "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [path.join(repo, "dist", "package-service.cjs"), "--root", root],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log, log],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      child.on("error", () => {});
      child.unref();
    } finally {
      fs.closeSync(log);
    }
    const end = Date.now() + 10000;
    while (!c && Date.now() < end) {
      await delay(100, undefined, { signal });
      c = await connect();
    }
    if (!c)
      throw new PackageError(
        "PACKAGE_SERVICE_UNAVAILABLE",
        "Package service did not start; build the project and inspect its local service.log",
      );
  }
  const timeout = AbortSignal.any([
    signal || new AbortController().signal,
    AbortSignal.timeout(45000),
  ]);
  // No retries: an uncertain start response is recovered through jobs, not resubmission.
  const response = await fetch(new URL("/call", c.endpoint), {
    method: "POST",
    headers: {
      authorization: "Bearer " + c.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      args,
      configFile: path.resolve(
        options.configFile ||
          process.env.WXAPP_PACKAGE_CONFIG ||
          defaultPackageConfig(repo),
      ),
    }),
    signal: timeout,
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok || data.error)
    throw new PackageError(
      data.code || "PACKAGE_SERVICE_ERROR",
      data.error || "Package service failed",
    );
  return data.result;
}
