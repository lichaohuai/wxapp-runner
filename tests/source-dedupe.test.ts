import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModuleSource } from "../src/analysis/source";

// Same obfuscated body copied into two sibling packages — the real-world case
// where runner_source search floods results with byte-identical duplicates.
const body = 'function(require,module,exports){var z=1;return "NEEDLE_TOKEN_"+z;}';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "src-dedupe-"));
  fs.mkdirSync(path.join(dir, "pkgA"));
  fs.mkdirSync(path.join(dir, "pkgB"));
  fs.writeFileSync(path.join(dir, "pkgA", "x.appservice.js"), `define("m/x.js",${body});`);
  fs.writeFileSync(path.join(dir, "pkgB", "x.appservice.js"), `define("m/x.js",${body});`);
  return dir;
}

test("runner_source search dedupe collapses byte-identical cross-package hits", () => {
  const dir = fixture();
  const src = new ModuleSource();
  const base = { action: "search", q: "NEEDLE_TOKEN_", offset: 0, limit: 50, caseSensitive: false };

  const plain = src.query(dir, { ...base });
  assert.equal(plain.matches.length, 2, "without dedupe both package copies show");

  const deduped = src.query(dir, { ...base, dedupe: true });
  assert.equal(deduped.matches.length, 1, "dedupe collapses to one hit");
  assert.equal(deduped.dedupedDuplicates, 1);
  assert.ok(deduped.matches[0].alsoIn.length === 1, "the duplicate path is recorded in alsoIn");

  const scoped = src.query(dir, { ...base, pathIncludes: "pkgA" });
  assert.equal(scoped.matches.length, 1, "pathIncludes limits the scan to one package");
  assert.ok(scoped.matches[0].path === "m/x.js" && scoped.matches[0].file.includes("pkgA"));

  fs.rmSync(dir, { recursive: true, force: true });
});
