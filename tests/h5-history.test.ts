import test from "node:test";
import assert from "node:assert/strict";
import { H5History } from "../src/native-components/h5-history";
function history(urls: string[], index = urls.length - 1, remove = true) {
  const entries = urls.map((url) => ({ url })),
    calls: number[] = [];
  return {
    entries,
    calls,
    getActiveIndex: () => index,
    getEntryAtIndex: (i: number) => entries[i] || null,
    length: () => entries.length,
    removeEntryAtIndex(i: number) {
      calls.push(i);
      if (!remove || i === index) return false;
      entries.splice(i, 1);
      if (i < index) index--;
      return true;
    },
  };
}
test("one back at the first H5 document exits the mini page without visiting bootstrap blank", () => {
  const h = history(["about:blank", "https://example.test/orders"]),
    p = new H5History();
  assert.equal(p.backSteps(h, 1), 0);
  assert.deepEqual(h.entries, [{ url: "https://example.test/orders" }]);
  assert.equal(p.snapshot(h).bootstrapPending, false);
  assert.deepEqual(h.calls, [0]);
  p.discardBootstrap(h);
  assert.deepEqual(h.calls, [0]);
});
test("removing only the bootstrap retains startup pushState, older documents and forward history", () => {
  const h = history(
      [
        "about:blank",
        "https://example.test/one",
        "https://example.test/spa",
        "https://example.test/forward",
      ],
      2,
    ),
    p = new H5History();
  p.discardBootstrap(h);
  assert.equal(p.backSteps(h, 1), 1);
  assert.equal(p.backSteps(h, 3), 1);
  assert.deepEqual(
    h.entries.map((e) => e.url),
    [
      "https://example.test/one",
      "https://example.test/spa",
      "https://example.test/forward",
    ],
  );
  assert.equal(h.getActiveIndex(), 1);
});
test("initial placeholder or failed removal never consumes a mini page back step", () => {
  for (const h of [
    history(["about:blank"]),
    history(["about:blank", "https://example.test/one"], 1, false),
  ]) {
    const p = new H5History();
    assert.equal(p.backSteps(h, 1), 0);
    assert.equal(p.snapshot(h).bootstrapPending, true);
  }
  const h = history(
    ["about:blank", "https://example.test/one", "https://example.test/two"],
    2,
    false,
  );
  assert.equal(new H5History().backSteps(h, 2), 1);
});
test("Chromium replacement and invalid deltas do not delete application history", () => {
  const h = history(["https://example.test/one", "https://example.test/two"]),
    p = new H5History();
  for (const d of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() => p.backSteps(h, d), /Invalid/);
  assert.deepEqual(h.calls, []);
  assert.equal(p.backSteps(h, 3), 1);
  assert.deepEqual(h.calls, []);
  assert.equal(p.snapshot(h).bootstrapPending, false);
});
