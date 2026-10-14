import fs from "node:fs";
import { safePath } from "../loader/paths";
import { officialModule } from "../loader/official-module";

/** Reuse the PC adapter's actual async/finally and synchronous callback paths.
 * This port only reads supplied foundation resources; it never executes them.
 * Bridge binary descriptors let the original SDK reconstruct ArrayBuffers in
 * the receiving realm instead of JSON.stringify silently replacing them by {}.
 */
export class NativeLibraries {
  readonly provenance;
  private readonly api: any;
  constructor(private base: string) {
    const loaded = officialModule(base, "./src/base/program/jsapi/fs/loadWAFile.ts", {
      "./src/common/base/file.ts": { readLibSync: (file: unknown) => this.read(file) },
      "./src/common/base/util.ts": {
        noop() {},
        bufferToArray: (value: Buffer) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      },
    });
    this.provenance = loaded.provenance;
    this.api = loaded.exports;
  }
  private read(file: unknown) {
    if (typeof file !== "string" || !file || file.length > 1024 ||
        /[\\?#:%\u0000-\u001f]/.test(file) || file.replace(/^\//, "").split("/").some(p => !p || p === "." || p === ".."))
      throw Error("invalid foundation resource filename");
    try {
      const absolute = safePath(this.base, file);
      if (!fs.statSync(absolute).isFile()) throw Error();
      return fs.readFileSync(absolute);
    } catch {
      // Do not reveal absolute host paths through the native error envelope.
      throw Error("foundation resource is absent or inaccessible: " + file);
    }
  }
  invoke(name: string, args: any, reply: (result: any) => void, alive: () => boolean = () => true): string | undefined {
    if (name !== "loadWAFile" && name !== "loadWAFileSync") return;
    const encode = (value: any) => ({
      errMsg: value.errMsg,
      ...(value.arrayBuffer === undefined ? {} : {
        __nativeBuffers__: [{ key: "arrayBuffer", base64: Buffer.from(value.arrayBuffer).toString("base64") }],
      }),
    });
    if (name === "loadWAFileSync") {
      let result: any;
      this.api.loadWAFileSync(args || {}, (value: any) => { result = encode(value); });
      return JSON.stringify(result);
    }
    this.api.loadWAFile(args || {}, (value: any) => { if (alive()) reply(encode(value)); });
    return "";
  }
}
