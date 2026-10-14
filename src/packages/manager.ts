import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  PackageError,
  archivePath,
  moduleRoot,
  decodeArchive,
  unpackArchive,
} from "./archive";
import { PackageSource, downloadURL, readSourceConfig } from "./client";
import { packageSchema, type PackageArgs } from "./schema";
import { inspectPackage } from "../loader";
type Module = {
  module: string;
  status: string;
  bytes: number;
  files?: number;
  warnings?: string[];
  attempts?: number;
  attemptErrors?: { attempt: number; code: string; httpStatus?: number }[];
};
type Job = {
  jobId: string;
  status: "running" | "complete" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  appid?: string;
  version?: number;
  modules: Module[];
  packageDir?: string;
  files?: number;
  cacheHit?: boolean;
  error?: { code: string; message: string };
};
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function writeJSON(file: string, data: any) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export class PackageManager {
  jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private inflight = new Map<string, string>();
  constructor(
    public root: string,
    private maxArchiveBytes = 256 * 1024 * 1024,
  ) {
    for (const dir of ["jobs", "library", ".staging"])
      fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    for (const file of fs
      .readdirSync(path.join(root, "jobs"))
      .filter((f) => /^[a-f0-9-]+\.json$/.test(f))) {
      try {
        const job: Job = JSON.parse(
          fs.readFileSync(path.join(root, "jobs", file), "utf8"),
        );
        if (job.status === "running") {
          job.status = "interrupted";
          job.error = {
            code: "SERVICE_INTERRUPTED",
            message: "Package service exited; download was not replayed",
          };
          this.save(job);
          fs.rmSync(path.join(root, ".staging", job.jobId), {
            recursive: true,
            force: true,
          });
        }
        this.jobs.set(job.jobId, job);
      } catch {
        /* Ignore an incomplete journal, never infer completion. */
      }
    }
  }
  private save(job: Job) {
    job.updatedAt = new Date().toISOString();
    writeJSON(path.join(this.root, "jobs", job.jobId + ".json"), job);
  }
  private get(id: string) {
    const j = this.jobs.get(id);
    if (!j)
      throw new PackageError("PACKAGE_JOB_NOT_FOUND", "Unknown package job");
    return j;
  }
  private dir(appid: string, version: number) {
    return path.join(this.root, "library", appid, String(version));
  }
  private async cached(appid: string, version: number, verify = false) {
    const dir = this.dir(appid, version),
      file = path.join(dir, "manifest.json");
    if (!fs.existsSync(dir)) return null;
    try {
      const m = JSON.parse(await fsp.readFile(file, "utf8"));
      if (
        m.appid !== appid ||
        m.version !== version ||
        m.complete !== true ||
        !m.files ||
        !m.modules
      )
        throw Error();
      if (verify) {
        for (const [name, entry] of Object.entries(m.files) as [
          string,
          any,
        ][]) {
          const clean = archivePath(name),
            p = path.join(dir, "package", clean);
          // Cached data remains untrusted; never follow a substituted symlink.
          for (let check = p; check !== dir; check = path.dirname(check))
            if ((await fsp.lstat(check)).isSymbolicLink()) throw Error();
          const st = await fsp.stat(p);
          if (
            !st.isFile() ||
            st.size !== entry.size ||
            hash(await fsp.readFile(p)) !== entry.sha256
          )
            throw Error();
        }
      }
      return { ...m, packageDir: path.join(dir, "package") };
    } catch {
      throw new PackageError(
        "PACKAGE_CACHE_CORRUPT",
        "Cached package failed integrity validation; retained for diagnosis, not overwritten",
      );
    }
  }
  async dispatch(raw: unknown, configFile: string, signal?: AbortSignal) {
    const a = packageSchema.parse(raw),
      scope = { scope: "package-library" };
    if (a.action === "get") return { ...scope, ...this.get(a.jobId!) };
    if (a.action === "jobs")
      return {
        ...scope,
        jobs: [...this.jobs.values()]
          .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
          .slice(0, 100),
      };
    if (a.action === "cancel") {
      const j = this.get(a.jobId!);
      this.controllers
        .get(j.jobId)
        ?.abort(new PackageError("PACKAGE_CANCELLED", "Download cancelled"));
      return {
        ...scope,
        ...j,
        cancelRequested: j.status === "running",
        operationRepeated: false,
      };
    }
    if (a.action === "list") {
      const packages: any[] = [];
      for (const appid of await fsp.readdir(path.join(this.root, "library")))
        if (/^wx[0-9a-f]{16}$/.test(appid))
          for (const ver of await fsp.readdir(
            path.join(this.root, "library", appid),
          ))
            if (/^\d+$/.test(ver)) {
              try {
                const m = await this.cached(appid, Number(ver));
                packages.push({
                  appid,
                  version: m.version,
                  packageDir: m.packageDir,
                  modules: m.modules.length,
                  files: Object.keys(m.files).length,
                  downloadedAt: m.downloadedAt,
                  integrity: "not-rechecked",
                });
              } catch (e: any) {
                packages.push({
                  appid,
                  version: Number(ver),
                  error: { code: e.code, message: e.message },
                });
              }
            }
      return { ...scope, packages };
    }
    if (a.action === "inspect") {
      const m = await this.cached(a.appid!, a.version!, true);
      if (!m)
        throw new PackageError("PACKAGE_NOT_FOUND", "Version not downloaded");
      const p = inspectPackage({
        packageDir: m.packageDir,
        baselibDir: a.baselibDir,
      });
      return {
        ...scope,
        appid: a.appid,
        version: a.version,
        packageDir: m.packageDir,
        integrity: "verified",
        startupReady: p.startupReady,
        pages: Object.keys(p.pages).length,
        entry: p.entry,
        errors: p.errors,
        warnings: p.warnings,
        modules: m.modules,
      };
    }
    const source = new PackageSource(readSourceConfig(configFile));
    if (a.action === "search")
      return {
        ...scope,
        ...(await source.search(a.keyword!, a.offset, signal)),
      };
    if (a.action === "resolve") {
      const r = await source.urls(a, signal);
      return {
        ...scope,
        appid: r.appid,
        version: r.version,
        module: r.module,
        alternatives: r.urls.length,
      };
    }
    // Idempotent concurrent downloads of one selection share the original job.
    const key = JSON.stringify([
      path.resolve(configFile),
      a.keyword,
      a.appid,
      a.version,
      a.expectedAppid,
    ]);
    const old = this.inflight.get(key);
    if (old) return { ...scope, ...this.get(old), existingJob: true };
    if (this.controllers.size >= 2)
      throw new PackageError(
        "PACKAGE_BUSY",
        "Two downloads are already active; query or cancel their jobs",
      );
    const job: Job = {
      jobId: randomUUID(),
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      modules: [],
    };
    const controller = new AbortController();
    this.controllers.set(job.jobId, controller);
    this.jobs.set(job.jobId, job);
    this.inflight.set(key, job.jobId);
    this.save(job);
    void this.run(job, a, source, controller)
      .catch(() => {
        job.status = "failed";
        job.error = {
          code: "PACKAGE_STORAGE_FAILED",
          message:
            "Cannot persist package job; check free space and directory permissions",
        };
      })
      .finally(() => {
        this.inflight.delete(key);
        this.controllers.delete(job.jobId);
      });
    return { ...scope, ...job, operationRepeated: false };
  }
  private async run(
    job: Job,
    a: PackageArgs,
    source: PackageSource,
    controller: AbortController,
  ) {
    const signal = controller.signal,
      stage = path.join(this.root, ".staging", job.jobId),
      files: Record<string, { size: number; sha256: string }> =
        Object.create(null),
      canonical = new Map<string, string>();
    let total = 0,
      fileCount = 0,
      lastSave = 0;
    const progress = () => {
      if (Date.now() - lastSave > 300) {
        lastSave = Date.now();
        this.save(job);
      }
    };
    try {
      if (a.appid && a.version) {
        const local = await this.cached(a.appid, a.version, true);
        signal.throwIfAborted();
        if (local) {
          job.appid = a.appid;
          job.version = a.version;
          job.status = "complete";
          job.cacheHit = true;
          job.packageDir = local.packageDir;
          job.modules = local.modules;
          job.files = Object.keys(local.files).length;
          this.save(job);
          return;
        }
      }
      const main = await source.urls(a, signal);
      job.appid = main.appid;
      job.version = main.version;
      this.save(job);
      const cached = await this.cached(main.appid, main.version, true);
      signal.throwIfAborted();
      if (cached) {
        job.status = "complete";
        job.cacheHit = true;
        job.packageDir = cached.packageDir;
        job.modules = cached.modules;
        job.files = Object.keys(cached.files).length;
        this.save(job);
        return;
      }
      await fsp.mkdir(path.join(stage, "package"), {
        recursive: true,
        mode: 0o700,
      });
      const fetchModule = async (info: typeof main, row: Module) => {
        let result: ReturnType<typeof unpackArchive> | undefined,
          failures: string[] = [];
        for (const url of info.urls) {
          signal.throwIfAborted();
          row.attempts = (row.attempts || 0) + 1;
          try {
            const raw = await downloadURL(
              url,
              signal,
              this.maxArchiveBytes,
              (n) => {
                row.bytes = n;
                progress();
              },
            );
            result = unpackArchive(
              await decodeArchive(raw, this.maxArchiveBytes),
            );
            signal.throwIfAborted();
            break;
          } catch (e: any) {
            if (signal.aborted) throw signal.reason;
            const code = e instanceof PackageError ? e.code : "CDN_READ_FAILED";
            // Keep a useful, bounded diagnosis without persisting signed CDN
            // URLs or arbitrary transport error messages.
            const httpStatus =
              code === "CDN_HTTP"
                ? Number(/^CDN HTTP (\d{3})$/.exec(e.message)?.[1])
                : NaN;
            (row.attemptErrors ||= []).push({
              attempt: row.attempts!,
              code,
              ...(Number.isFinite(httpStatus) ? { httpStatus } : {}),
            });
            failures.push(
              code + (Number.isFinite(httpStatus) ? ` ${httpStatus}` : ""),
            );
          }
        }
        if (!result)
          throw new PackageError(
            "MODULE_DOWNLOAD_FAILED",
            `${row.module}: all CDN alternatives failed (${failures.join(", ")})`,
          );
        const root = info.module === "__APP__" ? "" : moduleRoot(info.module),
          names = [...result.files.keys()];
        const prefixCount = root
          ? names.filter((n) => n.startsWith(root + "/")).length
          : 0;
        // A rooted archive uses app-global names. Compiler-emitted shared
        // resources may legitimately be outside its module root; preserve
        // their indexed paths instead of relocating them into that module.
        // Entirely relative archives retain the existing root-prefix adapter.
        // Path traversal and cross-module content conflicts remain errors.
        if (prefixCount && prefixCount !== names.length)
          result.warnings.push(
            `${names.length - prefixCount} app-global shared resource paths preserved outside module root`,
          );
        for (const [relative, bytes] of result.files) {
          signal.throwIfAborted();
          const name = archivePath(
              root && !prefixCount ? root + "/" + relative : relative,
            ),
            sha256 = hash(bytes);
          const segments = name.split("/");
          for (let i = 1; i <= segments.length; i++) {
            const p = segments.slice(0, i).join("/"),
              folded = p.normalize("NFC").toLowerCase(),
              prior = canonical.get(folded);
            if (prior && prior !== p)
              throw new PackageError(
                "PACKAGE_PATH_CONFLICT",
                "Modules contain case-colliding paths",
              );
            canonical.set(folded, p);
            if (i < segments.length && files[p])
              throw new PackageError(
                "PACKAGE_PATH_CONFLICT",
                "Module path overlaps another file",
              );
          }
          if (files[name]) {
            if (files[name].sha256 !== sha256)
              throw new PackageError(
                "PACKAGE_FILE_CONFLICT",
                `Modules disagree on ${name}`,
              );
            continue;
          }
          total += bytes.length;
          if (total > 2 * 1024 * 1024 * 1024 || ++fileCount > 100000)
            throw new PackageError(
              "PACKAGE_TOO_LARGE",
              "Combined package exceeds 2 GiB or 100,000 files",
            );
          files[name] = { size: bytes.length, sha256 };
          const target = path.join(stage, "package", name);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
        }
        row.files = result.files.size;
        row.warnings = result.warnings;
        row.status = "complete";
        this.save(job);
      };
      const mainRow: Module = {
        module: "__APP__",
        status: "downloading",
        bytes: 0,
      };
      job.modules.push(mainRow);
      await fetchModule(main, mainRow);
      let app: any;
      try {
        app = JSON.parse(
          await fsp.readFile(
            path.join(stage, "package", "app-config.json"),
            "utf8",
          ),
        );
      } catch {
        throw new PackageError(
          "APP_CONFIG_MISSING",
          "Main package has no valid app-config.json; it was not published as a runnable mini-program",
        );
      }
      const subs = app.subPackages ?? app.subpackages ?? [];
      if (
        !Array.isArray(subs) ||
        subs.length > 512 ||
        subs.some((s) => !s || typeof s.root !== "string")
      )
        throw new PackageError(
          "INVALID_SUBPACKAGES",
          "Invalid main-package subpackage list",
        );
      const roots = subs.map((s) => moduleRoot(s.root));
      if (new Set(roots.map((r) => r.toLowerCase())).size !== roots.length)
        throw new PackageError(
          "INVALID_SUBPACKAGES",
          "Duplicate subpackage roots",
        );
      job.modules.push(
        ...roots.map((root) => ({
          module: "/" + root + "/",
          status: "pending",
          bytes: 0,
        })),
      );
      this.save(job);
      let index = 1,
        firstFailure: unknown;
      await Promise.all(
        Array.from(
          { length: Math.min(a.concurrency, roots.length) },
          async () => {
            try {
              while (index < job.modules.length) {
                signal.throwIfAborted();
                const row = job.modules[index++];
                row.status = "resolving";
                this.save(job);
                const info = await source.urls(
                  {
                    appid: main.appid,
                    version: main.version,
                    module: row.module,
                  },
                  signal,
                );
                row.status = "downloading";
                await fetchModule(info, row);
              }
            } catch (e) {
              firstFailure ??= e;
              controller.abort(e);
            }
          },
        ),
      );
      if (firstFailure) throw firstFailure;
      signal.throwIfAborted();
      const manifest = {
        format: 1,
        complete: true,
        appid: main.appid,
        version: main.version,
        downloadedAt: new Date().toISOString(),
        modules: job.modules,
        files,
      };
      writeJSON(path.join(stage, "manifest.json"), manifest);
      const dest = this.dir(main.appid, main.version);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      // Another selection may have resolved to this version while we downloaded.
      const checkWinner = async () => {
        const other = await this.cached(main.appid, main.version, true);
        if (
          !other ||
          Object.keys(other.files).length !== fileCount ||
          Object.entries(files).some(
            ([name, value]) => other.files[name]?.sha256 !== value.sha256,
          )
        )
          throw new PackageError(
            "PACKAGE_VERSION_CONFLICT",
            "Two sources returned different content for the same appid/version; existing package retained",
          );
        job.cacheHit = true;
      };
      if (fs.existsSync(dest)) await checkWinner();
      else
        try {
          await fsp.rename(stage, dest);
        } catch (e: any) {
          if (["EEXIST", "ENOTEMPTY"].includes(e.code)) await checkWinner();
          else throw e;
        }
      job.status = "complete";
      job.packageDir = path.join(dest, "package");
      job.files = Object.keys(files).length;
      this.save(job);
    } catch (e: any) {
      job.status = e?.code === "PACKAGE_CANCELLED" ? "cancelled" : "failed";
      job.error = {
        code: e instanceof PackageError ? e.code : "PACKAGE_DOWNLOAD_FAILED",
        message:
          e instanceof PackageError
            ? e.message
            : "Package download or local file operation failed; no complete package was published",
      };
      for (const row of job.modules)
        if (row.status !== "complete") row.status = job.status;
      this.save(job);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
}
