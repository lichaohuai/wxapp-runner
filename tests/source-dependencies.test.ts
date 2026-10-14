import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModuleSource } from "../src/analysis/source";
import { sourceSchema } from "../src/analysis/schemas";
test("dependency inspection distinguishes metadata, executable assets and unresolved plugin calls without evaluating factories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-dependencies-"));
  const metadata = "wx" + "0000000000000002",
    script = "wx" + "0000000000000003";
  try {
    fs.writeFileSync(path.join(root, "app-config.json"), JSON.stringify({
      plugins: {
        risk: {
          provider: metadata,
          version: "1.2"
        },
        missing: {
          provider: "wx" + "0000000000000004"
        }
      },
      subPackages: [{
        root: "sub/",
        plugins: {
          real: {
            provider: script
          }
        }
      }]
    }));
    for (const id of [metadata, script]) fs.mkdirSync(path.join(root, "__plugin__", id), {
      recursive: true
    });
    fs.writeFileSync(path.join(root, "__plugin__", metadata, "plugin.json"), "{}");
    fs.writeFileSync(path.join(root, "__plugin__", script, "plugin.js"), 'throw Error("must not execute")');
    const code = 'define("a.js", function(require,module,exports){ throw Error("must not execute"); requirePlugin("risk"); requirePlugin(name); });';
    fs.writeFileSync(path.join(root, "app-service.js"), code);
    fs.writeFileSync(path.join(root, "appservice.app.js"), code);
    const source = new ModuleSource();
    const a = source.query(root, sourceSchema.parse({
      action: "dependencies",
      limit: 1
    }));
    assert.deepEqual(a.plugins.map((p: any) => p.assetState), ["metadata-or-resources-only", "directory-absent", "script-assets-present"]);
    assert.ok(a.plugins.every((p: any) => p.implementationVerified === false));
    assert.equal(a.plugins[2].scope, "sub/");
    assert.equal(a.total, 2, "identical combined and split factories should not double-count sites");
    assert.equal(a.entries[0].alias, "risk");
    assert.equal(a.entries[0].bindingVerified, false);
    const original = code.slice(0, a.entries[0].column - 1);
    assert.equal(code.slice(original.length, original.length + 13), "requirePlugin");
    const b = source.query(root, sourceSchema.parse({
      action: "dependencies",
      offset: a.nextOffset,
      limit: 1
    }));
    assert.equal(b.entries[0].resolution, "dynamic-unresolved");
    assert.equal(b.entries[0].argument, "name");
    assert.equal(b.hasMore, false);
    assert.deepEqual(b.scanErrors, []);
    fs.appendFileSync(path.join(root, "appservice.app.js"), '\ndefinePlugin("plugin://' + metadata + '",function(define){define("hidden.js",function(){ throw Error("do not execute"); });});');
    const bundled = source.query(root, sourceSchema.parse({
      action: "dependencies",
      path: "a.js"
    }));
    assert.equal(bundled.plugins[0].assetState, "bundled-factories-present", "module filtering must not hide embedded plugin implementations");
    assert.equal(bundled.plugins[0].bundledFactories[0].path, "hidden.js");
    const hidden = source.query(root, sourceSchema.parse({
      action: "list",
      path: "hidden.js"
    }));
    assert.equal(hidden.modules[0].plugin, "plugin://" + metadata);
    assert.equal(source.query(root, sourceSchema.parse({
      action: "list",
      path: "a.js"
    })).modules[0].plugin, undefined);
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
  }
});
test("dependency inspection reports unsafe or missing assets and does not upgrade unavailable content to implementation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-dependencies-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.js"), "never-read");
    fs.mkdirSync(path.join(root, "__plugin__"));
    fs.symlinkSync(outside, path.join(root, "__plugin__", "wx" + "0000000000000005"));
    fs.writeFileSync(path.join(root, "app-config.json"), JSON.stringify({
      plugins: {
        traversal: {
          provider: "../../outside"
        },
        link: {
          provider: "wx" + "0000000000000005"
        }
      }
    }));
    const source = new ModuleSource();
    const a = source.query(root, sourceSchema.parse({
      action: "dependencies"
    }));
    assert.equal(a.plugins[0].assetState, "invalid-declaration");
    assert.equal(a.plugins[1].assetState, "unknown");
    assert.deepEqual(a.plugins[1].files, []);
    fs.writeFileSync(path.join(root, "app-config.json"), "{");
    const b = source.query(root, sourceSchema.parse({
      action: "dependencies"
    }));
    assert.equal(b.scanErrors.length, 1);
    assert.equal(b.runtimeVerified, false);
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
    fs.rmSync(outside, {
      recursive: true,
      force: true
    });
  }
});
