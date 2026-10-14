import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { hasFile, safePath } from "./paths";

const packageModule = "./src/app/index/manager/pkg.ts";
/** Execute the supplied PC adapter's package manager, not a rewritten guess
 * of its file ordering. Only the explicit host imports below are available.
 * Business files are read as data and are never evaluated in this context. */
export class OfficialPackageAdapter {
  readonly provenance: { file: string; module: string; sha256: string };
  private manager: any;
  private reads: string[] | undefined;
  private prepared = new Set<string>();
  private failed = new Map<string, Error>();
  constructor(
    cfg: { packageDir: string; baselibDir: string; wxConfig: any },
    host: {
      preparePackage(moduleName: string): Promise<void>;
      publish(name: string, data: any): void;
      log(...args: any[]): void;
    },
  ) {
    const file = safePath(cfg.baselibDir, "WAPCAdapterAppIndex.js");
    const source = fs.readFileSync(file, "utf8");
    let factory: any;
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "Property" && node.key?.value === packageModule) {
        if (factory) throw Error("Ambiguous official package manager module");
        factory = node.value;
      }
      for (const value of Object.values(node))
        Array.isArray(value) ? value.forEach(visit) : visit(value);
    };
    visit(parse(source, { ecmaVersion: "latest" }));
    if (!factory) throw Error("Official package manager module is missing");
    this.provenance = {
      file: "WAPCAdapterAppIndex.js",
      module: packageModule,
      sha256: createHash("sha256").update(source).digest("hex"),
    };
    const imports: Record<string, any> = {
      "./src/common/base/binding/xweb.ts": {
        api: {
          loadSubPackage: (name: string, callback: (data: string) => void) => {
            host.preparePackage(name).then(
              () => {
                this.prepared.add(name);
                callback(JSON.stringify({ errCode: 0, moduleName: name }));
              },
              (error) => {
                this.failed.set(
                  name,
                  error instanceof Error ? error : new Error(String(error)),
                );
                callback(
                  JSON.stringify({
                    errCode: -1,
                    moduleName: name,
                    errMsg: String(error),
                  }),
                );
              },
            );
          },
        },
      },
      "./src/common/base/config.ts": { wxConfig: cfg.wxConfig },
      "./src/common/base/logger/index.ts": { info: host.log, warn: host.log },
      "./src/common/base/util.ts": {
        trim: (s: string) => s.replace(/^\/+|\/+$/g, ""),
      },
      "./src/common/base/eval.ts": { CodeType: { usr: "usr", lib: "lib" } },
    };
    const context = vm.createContext({
      module: { exports: {} },
      console: { error: host.log },
      require(name: string) {
        if (!Object.hasOwn(imports, name))
          throw Error("Unsupported official adapter dependency: " + name);
        return imports[name];
      },
    });
    new vm.Script(
      `(${source.slice(factory.start, factory.end)})(module,module.exports,require)`,
      { filename: file + "#" + packageModule },
    ).runInContext(context, { timeout: 1000 });
    this.manager = new context.module.exports.default({
      codeManager: {
        existsCode: async (file: string) => hasFile(cfg.packageDir, file),
        readCodeListSync: (files: string[]) => {
          if (!this.reads)
            throw Error("Official adapter read outside a page load");
          this.reads.push(...files.map((f) => f.replace(/^\//, "")));
          return files.map((f) =>
            fs.readFileSync(safePath(cfg.packageDir, f), "utf8"),
          );
        },
      },
      jsBridge: {
        subscribeHandler: (name: string, data: any) => {
          // This supplied adapter calls reject on a native failure but keeps
          // running its callback. Never announce an unprepared module as ready.
          if (
            name === "onSubPackageReady" &&
            !this.prepared.has(data.moduleName)
          )
            return;
          host.publish(name, data);
        },
      },
    });
    this.manager.init();
  }
  async pageFiles(route: string): Promise<string[]> {
    if (this.reads) throw Error("Official page loads must be serialized");
    this.reads = [];
    try {
      await this.manager.getPagePathRelativeCode(route);
      return this.reads;
    } catch (error) {
      // The original module rejects with a JSON object. Preserve the host
      // error and diagnostic instead of surfacing "STARTUP FAILED undefined".
      throw this.failed.values().next().value || error;
    } finally {
      for (const name of this.failed.keys())
        this.manager.subPackages[name].injected = false;
      this.failed.clear();
      this.reads = undefined;
    }
  }
}
