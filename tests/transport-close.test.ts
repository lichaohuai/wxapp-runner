import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

// Run in a child: the old parser assertion is thrown by a socket event and
// cannot be caught by fetch(). This must detect a real process crash.
test("remote FIN under artifact backpressure completes intact responses and rejects truncated bodies", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", path.resolve("tests/fixtures/transport-close.ts")],
    { timeout: 25000 },
  );
  assert.equal(JSON.parse(stdout.trim()).passed, 7);
});
