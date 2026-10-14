import test from "node:test";
import assert from "node:assert/strict";
import {
  nativeFallback,
  NativeBoundaryDiagnostics,
} from "../src/native-components/boundary";

test("unknown mutations, listeners and reports never get prefix-based success", () => {
  for (const api of [
    "setUnseenSetting",
    "updateUnknownState",
    "hideUnknown",
    "onUnknownEvent",
    "offUnknownEvent",
    "reportUnknownMetric",
  ]) {
    assert.equal(nativeFallback(api).runnerDisposition, "unsupported");
    assert.match(nativeFallback(api).errMsg, /:fail/);
  }
  for (const api of ["reportIDKey", "reportKeyValue"]) {
    assert.equal(nativeFallback(api).runnerDisposition, "local-only");
    assert.equal(nativeFallback(api).errMsg, api + ":ok");
  }
});
test("native gap inventory bounds growth, discloses omissions and never retains payloads", () => {
  const d = new NativeBoundaryDiagnostics(2);
  const row: any = {
    api: "setFixture",
    layer: "logic",
    disposition: "unsupported",
    context: { pageId: 4, token: "private" },
    args: { token: "private" },
  };
  assert.equal(d.record(row), true);
  assert.equal(d.record(row), false);
  d.record({ ...row, layer: "view" });
  d.record({ ...row, api: "overflow" });
  const s = d.snapshot();
  assert.equal(s.calls, 4);
  assert.equal(s.unsupported, 4);
  assert.equal(s.entries.length, 2);
  assert.equal(s.unretainedCalls, 1);
  assert.equal(s.truncated, true);
  assert.equal(s.entries[0].calls, 2);
  assert.deepEqual(s.entries[0].context, { pageId: 4 });
  assert.ok(!JSON.stringify(s).includes("private"));
  s.entries[0].calls = 999;
  assert.equal(d.snapshot().entries[0].calls, 2);
});
