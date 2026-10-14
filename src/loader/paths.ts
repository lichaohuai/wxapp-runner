import fs from "node:fs";
import path from "node:path";
export function safePath(root: string, relative: string) {
  const base = fs.realpathSync(root);
  const p = path.resolve(base, relative.replace(/^\//, ""));
  if (!p.startsWith(base + path.sep)) throw Error("Path escapes package");
  const real = fs.realpathSync(p);
  if (!real.startsWith(base + path.sep)) throw Error("Symlink escapes package");
  return real;
}
export function hasFile(root: string, relative: string) {
  try {
    return fs.statSync(safePath(root, relative)).isFile();
  } catch {
    return false;
  }
}
export function routeName(s: string) {
  return s
    .replace(/^\//, "")
    .split("?")[0]
    .replace(/\.(html|js|wxml)$/, "");
}
