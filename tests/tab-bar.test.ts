import test from "node:test";
import assert from "node:assert/strict";
import { TabBarState } from "../src/tab-bar";
test("native badges keep per-index state, reject invalid arguments without mutation, and return detached snapshots", () => {
  const t = new TabBarState({ list: [{}, {}] });
  t.updateBadge({ index: 1, type: "text", badgeValue: "9" });
  for (const a of [
    { index: -1, type: "none" },
    { index: 2, type: "redDot" },
    { index: 0.5, type: "text", badgeValue: "x" },
    { index: 0, type: "text", badgeValue: 4 },
    { index: 0, type: "unknown" },
  ])
    assert.throws(() => t.updateBadge(a));
  assert.deepEqual(t.snapshot(), { 1: { type: "text", badgeValue: "9" } });
  const copy = t.snapshot();
  copy[1].badgeValue = "changed";
  assert.equal(t.snapshot()[1].badgeValue, "9");
  t.updateBadge({ index: 0, type: "redDot" });
  t.updateBadge({ index: 1, type: "none" });
  assert.deepEqual(t.snapshot(), {
    0: { type: "redDot" },
    1: { type: "none" },
  });
});
