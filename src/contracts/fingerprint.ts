import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(root, entry.name);
    // Do not follow symlinks into unrelated packages or credentials.
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}
export function treeDigest(root: string, include = (_file: string) => true) {
  const hash = createHash("sha256");
  for (const file of filesUnder(root).filter(include)) {
    const name = path.relative(root,file).split(path.sep).join("/");
    hash.update(JSON.stringify(name)).update(digest(fs.readFileSync(file)));
  }
  return hash.digest("hex");
}

export function contractInputs(root: string, base: string) {
  return {
    baselibVersion: JSON.parse(fs.readFileSync(path.join(base,"WAVersion.json"),"utf8")).version,
    baselib: treeDigest(base),
    implementation: digest(treeDigest(path.join(root,"src")) + fs.readFileSync(path.join(root,"package-lock.json")) + fs.readFileSync(path.join(root,"package.json"))),
    tests: digest(treeDigest(path.join(root,"tests")) + treeDigest(path.join(root,"scripts"))),
  };
}
export const inputsFingerprint = (inputs: object) => digest(JSON.stringify(inputs));
