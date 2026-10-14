import type { HostApis } from "../wx-shim/host";
import { decodeStorageData, encodeStorageData } from "../wx-shim/storage-codec";
import { emitDebug } from "../debug/context";

const storageMethods = new Set([
  "getStorage",
  "setStorage",
  "getStorageInfo",
  "removeStorage",
  "clearStorage",
]);
const fileMethods = new Set([
  "readFile",
  "writeFile",
  "appendFile",
  "mkdir",
  "access",
  "unlink",
  "readdir",
  "stat",
  "saveFile",
]);
const nativeMethods = new Map<string, string>();
for (const method of storageMethods) {
  nativeMethods.set(method, method);
  nativeMethods.set(method + "Sync", method);
}
for (const method of ["setStorage", "clearStorage"])
  nativeMethods.set(method + "Async", method);
for (const method of fileMethods) {
  const native = method === "appendFile" ? "fs_appendFile" : method;
  nativeMethods.set(native, method);
  nativeMethods.set(native + "Sync", method);
}

/** Native envelopes consumed by the unmodified 3.17.3 library, including its
 * plugin WX objects. Sync returns and async callbacks are mutually exclusive. */
export class NativeFilesStorage {
  constructor(
    private host: HostApis,
    private takeBuffer: (id: number) => ArrayBuffer | undefined,
  ) {}

  invoke(
    name: string,
    args: any,
    reply: (value: any) => void,
  ): string | undefined {
    const method = nativeMethods.get(name);
    if (!method) return;
    const run = () => {
      try {
        const data = storageMethods.has(method)
          ? this.storage(method, args, name.endsWith("Sync"))
          : this.file(method, args);
        return { errMsg: name + ":ok", ...data };
      } catch (error: any) {
        // Node errors include host paths. Report the virtual request path and
        // a stable Node code, without leaking the machine's directory tree.
        const message = error.code
          ? `${error.code}: ${args.filePath || args.dirPath || args.path || "file operation failed"}`
          : error.message;
        const result = {
          errMsg: name + ":fail " + message,
          runnerCode: storageMethods.has(method)
            ? "NATIVE_STORAGE_FAILED"
            : "NATIVE_FILE_FAILED",
        };
        emitDebug("native-api-error", { api: name, ...result });
        return result;
      }
    };
    if (name.endsWith("Sync")) return JSON.stringify(run());
    queueMicrotask(() => reply(run()));
    return "";
  }

  private storage(method: string, a: any, sync: boolean) {
    const api = this.host.storageSpace(a.storageId);
    if (
      ["getStorage", "setStorage", "removeStorage"].includes(method) &&
      (typeof a.key !== "string" || !a.key)
    )
      throw Error("key must be a nonempty string");
    switch (method) {
      case "getStorage":
        if (!api.getStorageInfoSync().keys.includes(a.key)) {
          // WeChat semantics diverge by variant: getStorageSync returns "" for a
          // missing key (never fails), while async getStorage invokes fail(). The
          // base library polls storage via the sync envelope, so failing here made
          // it retry in a tight loop and starve the logic thread (tap handlers).
          if (sync) return encodeStorageData("");
          throw Error("data not found");
        }
        return encodeStorageData(api.getStorageSync(a.key));
      case "setStorage":
        api.setStorageSync(a.key, decodeStorageData(a));
        break;
      case "removeStorage":
        api.removeStorageSync(a.key);
        break;
      case "clearStorage":
        api.clearStorageSync();
        break;
      case "getStorageInfo":
        return api.getStorageInfoSync();
    }
    return {};
  }

  private file(method: string, a: any): any {
    const fm = this.host.nativeFiles.api.getFileSystemManager();
    switch (method) {
      case "readFile": {
        const data = fm.readFileSync(
          a.filePath,
          a.encoding,
          a.position,
          a.length,
        );
        // Use the base library's buffer protocol; JSON.stringify(ArrayBuffer)
        // would silently turn binary file content into {}.
        return typeof data === "string"
          ? { data }
          : {
              __nativeBuffers__: [
                { key: "data", base64: Buffer.from(data).toString("base64") },
              ],
            };
      }
      case "writeFile":
      case "appendFile": {
        let data = a.data;
        const descriptor = a.__nativeBuffers__?.find(
          (b: any) => b.key === "data",
        );
        if (descriptor) {
          data =
            descriptor.id !== undefined
              ? this.takeBuffer(descriptor.id)
              : typeof descriptor.base64 === "string"
                ? Buffer.from(descriptor.base64, "base64")
                : undefined;
          if (data === undefined)
            throw Error("native file buffer is unavailable");
        }
        if (
          typeof data !== "string" &&
          !ArrayBuffer.isView(data) &&
          Object.prototype.toString.call(data) !== "[object ArrayBuffer]"
        )
          throw Error("invalid file data");
        fm[method + "Sync"](a.filePath, data, a.encoding);
        break;
      }
      case "mkdir":
        fm.mkdirSync(a.dirPath, a.recursive);
        break;
      case "access":
        fm.accessSync(a.path);
        break;
      case "unlink":
        fm.unlinkSync(a.filePath);
        break;
      case "readdir":
        return { files: fm.readdirSync(a.dirPath) };
      case "saveFile":
        return { savedFilePath: fm.saveFileSync(a.tempFilePath, a.filePath) };
      case "stat": {
        const stat = fm.statSync(a.path);
        if (!a.recursive || !stat.isDirectory()) return this.statFields(stat);
        const stats: Record<string, any> = Object.create(null);
        const visited = new Set<string>();
        let entries = 0;
        const walk = (virtual: string, relative: string, depth: number) => {
          if (depth > 64 || ++entries > 10000)
            throw Error("recursive stat budget exceeded");
          // Resolve every child: a symlink in a traversed directory must not
          // escape the same sandbox checks used for a direct read.
          const real = this.host.nativeFiles.resolve(virtual);
          const current = fm.statSync(virtual);
          stats[relative + (current.isDirectory() ? "/" : "")] =
            this.statFields(current);
          if (current.isDirectory()) {
            if (visited.has(real)) throw Error("recursive stat cycle");
            visited.add(real);
            for (const name of fm.readdirSync(virtual))
              walk(
                virtual.replace(/\/$/, "") + "/" + name,
                relative ? relative + "/" + name : name,
                depth + 1,
              );
          }
        };
        walk(a.path, "", 0);
        return { stats };
      }
    }
    return {};
  }

  private statFields(s: any) {
    return {
      mode: s.mode,
      size: s.size,
      lastAccessedTime: s.lastAccessedTime,
      lastModifiedTime: s.lastModifiedTime,
    };
  }
}
