import { test } from "node:test";
import assert from "node:assert/strict";
import { PackageScripts, resolvePackageScript } from "../src/loader/scripts";
test("compiled aliases normalize native paths and share the execution cache without swallowing absent files", () => {
  const aliases = {
    "__COMMON__.appservice.js": "appservice.app.js",
    "feature/chunk_7.common.js": "feature/common.app.js",
  };
  const reads: string[] = [];
  const scripts = new PackageScripts((file) => {
    reads.push(file);
    if (file === "missing.js") throw Error("missing original script");
  });
  for (const file of [
    "/__COMMON__.appservice.js",
    "appservice.app.js",
    "/feature/./chunk_7.common.js",
    "feature/common.app.js",
  ])
    scripts.load(resolvePackageScript(file, aliases));
  assert.deepEqual(reads, ["appservice.app.js", "feature/common.app.js"]);
  assert.throws(
    () => scripts.load(resolvePackageScript("/missing.js", aliases)),
    /missing original script/,
  );
  assert.equal(resolvePackageScript("constructor", aliases), "constructor");
  assert.equal(resolvePackageScript("../outside.js", aliases), "../outside.js"); // safePath must still reject it.
});
test("compiled script dependencies run once per context, including repeated navigation", () => {
  const counts = new Map<string, number>();
  const loader = new PackageScripts((file) =>
    counts.set(file, (counts.get(file) || 0) + 1),
  );
  for (const file of [
    "common.app.js",
    "feature/common.app.js",
    "feature/appservice.app.js",
    "feature/appservice.app.js",
    "common.app.js",
  ])
    loader.load(file);
  assert.deepEqual([...counts.values()], [1, 1, 1]);
  const another = new PackageScripts((file) =>
    counts.set(file, counts.get(file)! + 1),
  );
  another.load("feature/appservice.app.js");
  assert.equal(counts.get("feature/appservice.app.js"), 2);
});
test("a partial script failure cannot be retried implicitly", () => {
  let effects = 0;
  const failure = Error("fixture failure after a side effect");
  const loader = new PackageScripts(() => {
    effects++;
    throw failure;
  });
  assert.throws(
    () => loader.load("sub/appservice.app.js"),
    (e) => e === failure,
  );
  assert.throws(
    () => loader.load("sub/appservice.app.js"),
    (e) => e === failure,
  );
  assert.equal(effects, 1);
});
