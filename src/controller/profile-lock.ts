import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ControlError } from "./control";
const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code !== "ESRCH";
  }
};
/** Cross-controller ownership protects the same app's storage and Chromium profile. */
export class ProfileLock {
  readonly token = randomUUID();
  readonly file: string;
  released = false;
  private owner: any;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(fs.realpathSync(directory), ".runner-profile.lock");
    this.owner = { token: this.token, controllerPid: process.pid };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.file, "wx", 0o600);
        try {
          fs.writeSync(fd, JSON.stringify(this.owner));
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        let owner: any;
        try {
          owner = JSON.parse(fs.readFileSync(this.file, "utf8"));
        } catch {
          throw new ControlError(
            "PROFILE_IN_USE",
            "Profile has an unreadable ownership lock; select an isolated profile",
          );
        }
        if (alive(owner.controllerPid) || alive(owner.childPid))
          throw new ControlError(
            "PROFILE_IN_USE",
            "Another live process owns this app profile",
          );
        // Check the same owner before removing a stale lock; never remove a new owner.
        if (fs.readFileSync(this.file, "utf8") === JSON.stringify(owner))
          fs.unlinkSync(this.file);
      }
    }
    throw new ControlError(
      "PROFILE_IN_USE",
      "Profile ownership changed while acquiring its lock",
    );
  }
  child(pid?: number) {
    this.owner.childPid = pid;
    fs.writeFileSync(this.file, JSON.stringify(this.owner), { mode: 0o600 });
  }
  release() {
    if (this.released) return;
    this.released = true;
    try {
      if (JSON.parse(fs.readFileSync(this.file, "utf8")).token === this.token)
        fs.unlinkSync(this.file);
    } catch {}
  }
}
