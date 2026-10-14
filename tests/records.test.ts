import { test } from "node:test";
import assert from "node:assert/strict";
import { RecordLog } from "../src/mcp/records";
test("incremental readers consume all retained records in order and see eviction gaps", () => {
  const log = new RecordLog<{ message: string }>(3);
  for (let i = 0; i < 5; i++) log.push({ message: String(i) });
  let page = log.page(0, 1);
  assert.deepEqual(
    page.entries.map((x) => x.id),
    [3],
  );
  assert.equal(page.gap, true);
  assert.equal(page.droppedBefore, 2);
  assert.equal(page.hasMore, true);
  const ids = page.entries.map((x) => x.id);
  while (page.hasMore) {
    page = log.page(page.nextCursor, 1);
    ids.push(...page.entries.map((x) => x.id));
  }
  assert.deepEqual(ids, [3, 4, 5]);
  assert.equal(log.page(5).entries.length, 0);
  assert.equal(log.page(50).cursorResetRequired, true);
});
