import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
/** Serve existing local source maps to DevTools without granting it arbitrary filesystem reads. */
export class SourceMaps {
  private maps = new Map<
    string,
    { content: string; runtimeId: string; key: string; bytes: number }
  >();
  private usedBytes = 0;
  private cache = new Map<string, string>();
  constructor(private roots: (runtimeId: string) => string[]) {}
  register(runtimeId: string, script: string, map: string) {
    if (!map || /^(data:|https?:)/i.test(map)) return undefined;
    try {
      const scriptFile = script.startsWith("file:")
        ? fileURLToPath(script)
        : script;
      if (!path.isAbsolute(scriptFile)) return undefined;
      const mapFile = map.startsWith("file:")
        ? fileURLToPath(map)
        : path.resolve(path.dirname(scriptFile), map);
      const allowed = (file: string) => {
        const real = fs.realpathSync(file);
        if (
          !this.roots(runtimeId).some((root) => {
            const rel = path.relative(fs.realpathSync(root), real);
            return (
              rel !== ".." &&
              !rel.startsWith(".." + path.sep) &&
              !path.isAbsolute(rel)
            );
          })
        )
          throw Error("Source map escapes allowed roots");
        if (fs.statSync(real).size > 64 * 1024 ** 2)
          throw Error("Source map exceeds read limit");
        return real;
      };
      const real = allowed(mapFile),
        key = runtimeId + ":" + real + ":" + fs.statSync(real).mtimeMs;
      if (this.cache.has(key)) return this.cache.get(key);
      const content = JSON.parse(fs.readFileSync(real, "utf8"));
      if (content.version !== 3) return undefined;
      if (Array.isArray(content.sources)) {
        content.sourcesContent ||= [];
        let sourceBytes = Buffer.byteLength(JSON.stringify(content));
        content.sources.forEach((source: string, i: number) => {
          if (content.sourcesContent[i] != null) return;
          try {
            const sourceFile = path.resolve(
              path.dirname(real),
              content.sourceRoot || "",
              source,
            );
            if (!/\.(?:[cm]?js|tsx?|jsx|wxs|wxml|wxss|css)$/.test(sourceFile))
              return;
            const file = allowed(sourceFile);
            if (sourceBytes + fs.statSync(file).size > 64 * 1024 ** 2) return;
            content.sourcesContent[i] = fs.readFileSync(file, "utf8");
            sourceBytes += Buffer.byteLength(content.sourcesContent[i]);
          } catch {
            /* Preserve unavailable source locations; never invent source text. */
          }
        });
      }
      const encoded = JSON.stringify(content),
        bytes = Buffer.byteLength(encoded);
      if (bytes > 64 * 1024 ** 2) return undefined;
      while (
        this.usedBytes + bytes > 128 * 1024 ** 2 ||
        this.maps.size >= 1000
      ) {
        const [oldId, old] = this.maps.entries().next().value!;
        this.usedBytes -= old.bytes;
        this.maps.delete(oldId);
        this.cache.delete(old.key);
      }
      const id = randomUUID();
      this.maps.set(id, { runtimeId, content: encoded, key, bytes });
      this.cache.set(key, id);
      this.usedBytes += bytes;
      return id;
    } catch {
      return undefined;
    }
  }
  get(id: string) {
    return this.maps.get(id);
  }
}
