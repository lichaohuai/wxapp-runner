import os from "node:os";
import path from "node:path";

/**
 * In a packaged build the code lives inside app.asar, which is a read-only
 * archive: the repo-relative `.local` defaults cannot be written to and the
 * bundled files never contain account configuration. Downloads and credentials
 * therefore move to a per-user home directory, so a packaged runner works with
 * no flags at all. Source checkouts keep the original `.local` layout.
 */
export function insideArchive(dir: string) {
  return dir.split(path.sep).some((part) => part.endsWith(".asar"));
}

export function userHome() {
  return path.join(os.homedir(), ".wxapp-runner");
}

export function defaultPackageLibrary(repo: string) {
  return insideArchive(repo)
    ? path.join(userHome(), "packages")
    : path.join(repo, ".local", "packages");
}

export function defaultPackageConfig(repo: string) {
  return insideArchive(repo)
    ? path.join(userHome(), "config.json")
    : path.join(repo, ".local", "config.json");
}
