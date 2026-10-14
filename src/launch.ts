import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defaultPackageConfig, defaultPackageLibrary } from "./packages/paths";

const appidPattern = z.string().regex(/^wx[0-9a-f]{16}$/);

export const launchSchema = z
  .object({
    action: z.enum(["launch", "status", "stop"]).default("launch"),
    appid: appidPattern.optional(),
    version: z.number().int().positive().optional(),
    packageDir: z.string().min(1).optional(),
    baselibDir: z.string().min(1).optional(),
    configFile: z.string().min(1).optional(),
    pagePath: z.string().min(1).max(8192).optional(),
    userDataDir: z.string().min(1).optional(),
    devtools: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(180000).default(90000),
  })
  .superRefine((a, c) => {
    if (a.action !== "launch") return;
    if (!a.packageDir && !(a.appid && a.version))
      c.addIssue({
        code: "custom",
        message:
          "launch requires packageDir, or appid and version of a downloaded package",
      });
  });

export type LaunchArgs = z.infer<typeof launchSchema>;

export const launchTool = {
  description:
    "Start, inspect or stop a local WxappRunner instance for an already-downloaded package, so a mini-program can be opened without its frontend source. launch resolves appid+version in the package library (or an explicit packageDir), spawns the desktop runner and waits until its MCP connection file answers; the other runner_* tools then drive that instance. This starts a real desktop process and executes the mini-program's own code. Download packages with runner_packages first. One connection file hosts one instance: stop it before launching a different appid. status reports the current instance without changing it.",
  readOnly: false,
  schema: launchSchema,
};

export class LaunchError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type LaunchOptions = {
  connectionFile: string;
  configFile?: string;
  repoRoot?: string;
  libraryRoot?: string;
};

const clientId = randomUUID();

function readConnection(file: string) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const url = new URL(c.endpoint);
    if (
      url.hostname !== "127.0.0.1" ||
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      typeof c.token !== "string"
    )
      return null;
    return c;
  } catch {
    /* A missing or half-written connection file simply means "not up yet". */
    return null;
  }
}

/** Confirms the instance actually answers, not merely that a file exists. */
async function probe(file: string) {
  const c = readConnection(file);
  if (!c) return null;
  try {
    const response = await fetch(new URL("/call", c.endpoint), {
      method: "POST",
      headers: {
        authorization: "Bearer " + c.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "runner_status",
        arguments: {},
        clientId,
      }),
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.error) return null;
    return { connection: c, status: data.result ?? data };
  } catch {
    return null;
  }
}

function summary(file: string, c: any, status: any) {
  return {
    status: "running",
    connectionFile: file,
    pid: c.pid,
    appid: c.appid,
    runtimeId: c.runtimeId ?? status?.runtimeId,
    runtime: status,
  };
}

/**
 * Resolves the executable used to start an instance. When this process is the
 * packaged app (running the `mcp` subcommand, or as ELECTRON_RUN_AS_NODE) its
 * own executable is the runner. A plain-node development process cannot start a
 * desktop app by itself, so the electron binary and app path are named
 * explicitly through the environment.
 */
function runner() {
  const exe = process.env.WXAPP_RUNNER_EXE;
  const appPath = process.env.WXAPP_RUNNER_APP;
  if (exe) return { exe, prefix: appPath ? [appPath] : [] };
  if ((process as any).versions?.electron && !(process as any).defaultApp)
    return { exe: process.execPath, prefix: [] as string[] };
  throw new LaunchError(
    "LAUNCH_EXECUTABLE_UNKNOWN",
    "No WxappRunner executable: run this MCP server from the packaged app (WxappRunner mcp …), or set WXAPP_RUNNER_EXE (and WXAPP_RUNNER_APP for a source checkout).",
  );
}

/** Build argv as separate values; card queries never pass through a shell. */
export function launchArguments(args: LaunchArgs, packageDir: string, file: string, configFile?: string) {
  const argv = ["--package", packageDir, "--mcp", "--mcp-file", file];
  if (args.appid) argv.push("--appid", args.appid);
  if (args.baselibDir) argv.push("--baselib", path.resolve(args.baselibDir));
  if (configFile) argv.push("--config", configFile);
  if (args.devtools) argv.push("--devtools");
  if (args.pagePath !== undefined) argv.push("--page-path", args.pagePath);
  if (args.userDataDir) argv.push("--user-data", path.resolve(args.userDataDir));
  return argv;
}

export async function callLaunch(
  raw: unknown,
  options: LaunchOptions,
  signal?: AbortSignal,
) {
  const args = launchSchema.parse(raw);
  const file = path.resolve(options.connectionFile);
  const repo = options.repoRoot || path.resolve(__dirname, "..");
  const library = path.resolve(
    options.libraryRoot ||
      process.env.WXAPP_PACKAGE_LIBRARY ||
      defaultPackageLibrary(repo),
  );

  const live = await probe(file);

  if (args.action === "status")
    return live
      ? summary(file, live.connection, live.status)
      : { status: "not-running", connectionFile: file };

  if (args.action === "stop") {
    if (!live) return { status: "not-running", connectionFile: file };
    const pid = live.connection.pid;
    if (typeof pid !== "number")
      throw new LaunchError(
        "LAUNCH_STOP_UNSUPPORTED",
        "Connection file carries no pid; close the instance window instead.",
      );
    try {
      process.kill(pid);
    } catch (e: any) {
      if (e?.code !== "ESRCH") throw e;
    }
    const end = Date.now() + 15000;
    while (Date.now() < end && (await probe(file))) await delay(200);
    return {
      status: (await probe(file)) ? "stopping" : "stopped",
      connectionFile: file,
      pid,
    };
  }

  // launch
  if (live) {
    const running = live.connection.appid;
    if (args.appid && running && running !== args.appid)
      throw new LaunchError(
        "LAUNCH_CONNECTION_BUSY",
        `This connection file already hosts ${running}. Stop it first (action:"stop"), or run a second server with its own --connection file.`,
      );
    if (args.version !== undefined && live.status?.appVersion !== args.version)
      throw new LaunchError("LAUNCH_CONNECTION_BUSY",
        "The running instance has a different or unknown package version; use its own connection file.");
    if (args.pagePath !== undefined || args.userDataDir)
      throw new LaunchError("LAUNCH_CONNECTION_BUSY",
        "A card launch or account-isolated launch requires a fresh connection file; existing startup options are never silently reused.");
    return { ...summary(file, live.connection, live.status), reused: true };
  }

  const packageDir = args.packageDir
    ? path.resolve(args.packageDir)
    : path.join(library, "library", args.appid!, String(args.version!), "package");
  if (!fs.existsSync(path.join(packageDir, "app-config.json")))
    throw new LaunchError(
      "LAUNCH_PACKAGE_MISSING",
      `No decrypted package at ${packageDir}. Download it first with runner_packages {"action":"download"}.`,
    );

  const configFile = path.resolve(
    args.configFile ||
      options.configFile ||
      process.env.WXAPP_PACKAGE_CONFIG ||
      defaultPackageConfig(repo),
  );

  const { exe, prefix } = runner();
  const spawnArgs = [
    ...prefix,
    ...launchArguments(args, packageDir, file,
      fs.existsSync(configFile) ? configFile : undefined),
  ];

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const logFile = path.join(path.dirname(file), "launch.log");
  const log = fs.openSync(logFile, "a", 0o600);
  const env = { ...process.env };
  // The child must boot the desktop app, never inherit this process's node mode.
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(exe, spawnArgs, {
      detached: true,
      windowsHide: false,
      stdio: ["ignore", log, log],
      env,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    fs.closeSync(log);
  }

  const end = Date.now() + args.timeoutMs;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    await delay(250, undefined, { signal });
    const up = await probe(file);
    if (up)
      return {
        ...summary(file, up.connection, up.status),
        packageDir,
        launched: true,
      };
  }
  throw new LaunchError(
    "LAUNCH_TIMEOUT",
    `Instance did not publish ${file} within ${args.timeoutMs}ms. Inspect ${logFile}.`,
  );
}
