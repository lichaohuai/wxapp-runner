import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProfileLock } from "../src/controller/profile-lock";
test("profile ownership rejects concurrent writers and releases only its own lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-lock-"));
  try {
    const a = new ProfileLock(root);
    assert.throws(() => new ProfileLock(root), /Another live process/);
    a.release();
    const b = new ProfileLock(root);
    a.release();
    assert.ok(fs.existsSync(b.file));
    b.release();
    fs.writeFileSync(
      path.join(root, ".runner-profile.lock"),
      JSON.stringify({ controllerPid: 2147483647 }),
    );
    const c = new ProfileLock(root);
    c.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
