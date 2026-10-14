// Scheduling audit only: executes one unchanged official adapter module in a
// test context. It never executes business bundles, downloads, or native APIs.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { inspectPackage, readPackageConfig } from "../src/loader.ts";
import { hasFile } from "../src/loader/paths.ts";
import { wxConfig } from "../src/config.ts";
const modulePath = "./src/app/index/manager/pkg.ts";
const baselibFile = path.resolve("../baselib/WAPCAdapterAppIndex.js");
const source = fs.readFileSync(baselibFile, "utf8");
const ast = parse(source, {
  ecmaVersion: "latest"
});
let factory;
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "Property" && node.key?.value === modulePath) {
    if (factory) throw Error("Ambiguous official module");
    factory = node.value;
  }
  for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(visit) : visit(value);
}
visit(ast);
if (!factory) throw Error("Official package manager module was not found");
const factorySource = source.slice(factory.start, factory.end);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const evidence = {
  file: "baselib/WAPCAdapterAppIndex.js",
  sha256: sha256(source),
  module: modulePath,
  start: factory.start,
  end: factory.end,
  offsets: "JavaScript UTF-16 code units",
  factorySha256: sha256(factorySource)
};
async function audit(root) {
  const appConfig = readPackageConfig(root);
  const plan = inspectPackage({
    packageDir: root,
    app: appConfig
  });
  const config = wxConfig({
    app: appConfig,
    plan,
    appid: process.env.WXAPP_TEST_APPID || (() => {
      throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
    })()
  });
  const observations = [];
  for (const route of Object.keys(plan.pages)) {
    const requests = [],
      notifications = [],
      modules = [];
    const codeManager = {
      existsCode: async file => hasFile(root, file),
      readCodeListSync: files => {
        requests.push(...files);
        // The audit records selection, not template evaluation.
        return files.map(() => "");
      }
    };
    const imports = {
      "./src/common/base/binding/xweb.ts": {
        api: {
          loadSubPackage: (name, cb) => {
            modules.push(name);
            cb(JSON.stringify({
              errCode: 0,
              moduleName: name
            }));
          }
        }
      },
      "./src/common/base/config.ts": {
        wxConfig: config
      },
      "./src/common/base/logger/index.ts": {
        info() {},
        warn() {}
      },
      "./src/common/base/util.ts": {
        trim: value => value.replace(/^\/+|\/+$/g, "")
      },
      "./src/common/base/eval.ts": {
        CodeType: {
          usr: "usr",
          lib: "lib"
        }
      }
    };
    const sandbox = vm.createContext({
      module: {
        exports: {}
      },
      require(name) {
        if (!(name in imports)) throw Error("Unknown official module dependency: " + name);
        return imports[name];
      },
      console: {
        error() {}
      }
    });
    new vm.Script(`(${factorySource})(module,module.exports,require)`, {
      filename: modulePath
    }).runInContext(sandbox, {
      timeout: 1000
    });
    const manager = new sandbox.module.exports.default({
      codeManager,
      jsBridge: {
        subscribeHandler: (name, data) => notifications.push({
          name,
          moduleName: data.moduleName
        })
      }
    });
    manager.init();
    await manager.getPagePathRelativeCode(route);
    const files = [...requests].map(f => f.replace(/^\//, ""));
    observations.push({
      route,
      mode: "cold-route",
      isLazyLoad: config.isLazyLoad,
      officialBootstrapFiles: files,
      requestedModules: modules,
      notifications,
      missingFiles: files.filter(f => !hasFile(root, f)),
      runnerFiles: plan.pages[route].files,
      note: "Static scheduling comparison; chunk injection and page effects are not executed."
    });
  }
  return {
    packageDir: path.relative(process.cwd(), root),
    pages: observations.length,
    observations
  };
}
const directories = process.argv.slice(2);
if (!directories.length) throw Error("Usage: node --import tsx scripts/audit-official-loader.mjs <package-dir>...");
const packages = [];
for (const directory of directories) packages.push(await audit(path.resolve(directory)));
const report = {
  generatedAt: new Date().toISOString(),
  kind: "official-static-scheduling-audit",
  evidence,
  limitations: ["Native package availability callback is an audit fixture; no cloud, plugin, or business success is inferred.", "isLazyLoad is supplied by the current Runner config for comparison, not recovered from native startup.", "Each route uses a new manager; cold independent packages differ from warm navigation after main-package injection."],
  packages
};
fs.writeFileSync("docs/official-loader-audit.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  evidence,
  packages: packages.map(p => ({
    packageDir: p.packageDir,
    pages: p.pages,
    missingBootstrapPages: p.observations.filter(x => x.missingFiles.length).length
  }))
}));
