import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackgroundFetchToken } from "../src/native-components/background-fetch";
test("background fetch token persists per profile and rejects invalid writes before modifying state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-fetch-token-"));
  try {
    const a = new BackgroundFetchToken(path.join(dir, "a", "token.json")),
      b = new BackgroundFetchToken(path.join(dir, "b", "token.json"));
    assert.throws(() => a.get(), /no background/);
    a.set("test");
    assert.equal(
      new BackgroundFetchToken(path.join(dir, "a", "token.json")).get().token,
      "test",
    );
    assert.throws(() => b.get(), /no background/);
    for (const bad of [undefined, {}, "x".repeat(1025)])
      assert.throws(() => a.set(bad));
    assert.equal(a.get().token, "test");
    assert.equal(
      fs.statSync(path.join(dir, "a", "token.json")).mode & 0o777,
      0o600,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
