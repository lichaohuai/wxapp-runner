import path from "node:path";

/** Both official CodeManager reads and context execution must resolve the same
 * compiled alias. The manifest only supplies aliases for absent virtual files. */
export function resolvePackageScript(
  file: string,
  aliases: Record<string, string> = {},
) {
  const name = path.posix.normalize(file.replace(/^\//, ""));
  return Object.hasOwn(aliases, name) ? aliases[name] : name;
}

/** A compiled package file runs once per JS context. A failed evaluation is
 * remembered too: retrying a partially executed script could repeat effects. */
export class PackageScripts {
  private states = new Map<
    string,
    { state: "loading" | "loaded" | "failed"; value?: unknown; error?: unknown }
  >();
  constructor(private execute: (file: string) => unknown) {}
  load(file: string): unknown {
    const entry = this.states.get(file);
    if (entry?.state === "loaded") return entry.value;
    if (entry?.state === "failed") throw entry.error;
    if (entry?.state === "loading")
      throw Error("Recursive compiled script load: " + file);
    const next: {
      state: "loading" | "loaded" | "failed";
      value?: unknown;
      error?: unknown;
    } = { state: "loading" };
    this.states.set(file, next);
    try {
      next.value = this.execute(file);
      next.state = "loaded";
      return next.value;
    } catch (error) {
      next.state = "failed";
      next.error = error;
      throw error;
    }
  }
}
