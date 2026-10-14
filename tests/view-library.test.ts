import {test} from "node:test";
import assert from "node:assert/strict";
import {viewLibraryURL} from "../src/loader/view-library";

test("view library paths resolve in the supplied baselib, not business package space", () => {
  const available = ["WARecordSDK.js", "extra/worker.js"];
  assert.equal(viewLibraryURL("/WARecordSDK.js", available, "http://127.0.0.1:1234/page/1"), "http://127.0.0.1:1234/baselib/WARecordSDK.js");
  assert.equal(viewLibraryURL("extra/worker.js", available, "http://127.0.0.1:1234/page/1"), "http://127.0.0.1:1234/baselib/extra/worker.js");
});
test("view library resolution rejects absent files, URL syntax and path escapes before reading", () => {
  assert.throws(()=>viewLibraryURL("app-service.js", ["WARecordSDK.js"], "http://127.0.0.1:1234/page/1"), /absent/);
  for(const file of ["../app-service.js", "//evil/a.js", "https://evil/a.js", "a.js?query", "a.js#fragment", "%2e%2e/a.js", "a\\b.js", "a/./b.js", "a//b.js", "a.json", "a\u0000.js"])
    assert.throws(()=>viewLibraryURL(file, [file], "http://127.0.0.1:1234/page/1"), /absent or invalid/);
});
