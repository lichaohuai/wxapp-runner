import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SourceMaps } from "../src/controller/source-maps";
test("existing source maps preserve mappings and use allowed source files only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-map-"));
  try {
    const pkg = path.join(root, "package");
    fs.mkdirSync(pkg);
    fs.writeFileSync(
      path.join(pkg, "source.ts"),
      'export const message = "中文";',
    );
    fs.writeFileSync(path.join(root, "outside.ts"), "private");
    const map = {
      version: 3,
      sources: ["source.ts", "../outside.ts"],
      names: [],
      mappings: "AAAA",
      file: "compiled.js",
    };
    fs.writeFileSync(path.join(pkg, "compiled.js.map"), JSON.stringify(map));
    const store = new SourceMaps(() => [pkg]);
    const id = store.register(
      "runtime",
      path.join(pkg, "compiled.js"),
      "compiled.js.map",
    );
    assert.ok(id);
    const result = JSON.parse(store.get(id!)!.content);
    assert.equal(result.mappings, "AAAA");
    assert.equal(result.sourcesContent[0], 'export const message = "中文";');
    assert.equal(result.sourcesContent[1], undefined);
    assert.equal(
      store.register(
        "runtime",
        path.join(pkg, "compiled.js"),
        "compiled.js.map",
      ),
      id,
    );
    fs.writeFileSync(path.join(root, "secret.map"), JSON.stringify(map));
    fs.symlinkSync(path.join(root, "secret.map"), path.join(pkg, "escape.map"));
    assert.equal(
      store.register("runtime", path.join(pkg, "compiled.js"), "escape.map"),
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
