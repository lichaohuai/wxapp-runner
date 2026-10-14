import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { emitDebug } from "../debug/context";
import { fileContentType } from "../http-file";
import { success, failure, type Options } from "./common";
import { miniProgramHeaders } from "./network-context";
export function fileApis(
  config: any,
  log: Function,
  options: { internal?: boolean; grants?: Set<string> } = {},
) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const root = fs.realpathSync(config.dataDir);
  const granted = options.grants || new Set<string>();
  function resolve(p: string, write = false) {
    if (typeof p !== "string") throw Error("file path required");
    if (granted.has(p) && !write) return p;
    let base = root,
      rel = p;
    if (p.startsWith("wxfile://usr/")) rel = p.slice(13);
    else if (p === "wxfile://usr") rel = "";
    else if (p.startsWith("wxfile://tmp/")) rel = "tmp/" + p.slice(13);
    else if (/^wxfile:\/\/(?:sdk|ad|__wxprivate__|opendata)(?:\/|$)/.test(p)) {
      if (!options.internal)
        throw Error("permission denied for internal file space");
      const [, scope, suffix = ""] = p.match(/^wxfile:\/\/([^/]+)\/?(.*)$/)!;
      base = path.join(root, "..", "native-files", scope);
      fs.mkdirSync(base, { recursive: true });
      base = fs.realpathSync(base);
      rel = suffix;
    } else if (p.startsWith("/")) {
      base = fs.realpathSync(config.packageDir);
      rel = p.slice(1);
      if (write) throw Error("package is read-only");
    } else if (/^[a-zA-Z][\w+.-]*:\/\//.test(p))
      throw Error("unknown file scheme");
    else {
      base = fs.realpathSync(config.packageDir);
      if (write) throw Error("package is read-only");
    }
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep))
      throw Error("file path escapes sandbox");
    let ancestor = file;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const real = fs.realpathSync(ancestor);
    if (real !== base && !real.startsWith(base + path.sep))
      throw Error("symlink escapes sandbox");
    return file;
  }
  const asyncWrap = (name: string, o: Options, fn: () => any) =>
    queueMicrotask(() => {
      let result;
      try {
        result = fn();
      } catch (e) {
        failure(name, o, e);
        return;
      }
      // A thrown business success callback is not a second filesystem failure.
      success(name, o, result);
    });
  function readFileSync(
    filePath: string,
    encoding?: BufferEncoding,
    position?: number,
    length?: number,
  ) {
    let data = fs.readFileSync(resolve(filePath));
    const start = position ?? 0,
      size = length ?? data.byteLength - start;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > data.byteLength ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      start + size > data.byteLength ||
      (length !== undefined && size === 0)
    )
      throw Error("position or length is out of range");
    data = data.subarray(start, start + size);
    return encoding
      ? data.toString(encoding)
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  function writeFileSync(
    filePath: string,
    data: any,
    encoding: BufferEncoding = "utf8",
  ) {
    const file = resolve(filePath, true);
    fs.writeFileSync(
      file,
      typeof data === "string" ? data : Buffer.from(data),
      { encoding, mode: 0o600 },
    );
  }
  function mkdirSync(dirPath: string, recursive = false) {
    fs.mkdirSync(resolve(dirPath, true), { recursive });
  }
  function appendFileSync(
    filePath: string,
    data: any,
    encoding: BufferEncoding = "utf8",
  ) {
    fs.appendFileSync(
      resolve(filePath, true),
      typeof data === "string" ? data : Buffer.from(data),
      { encoding, mode: 0o600 },
    );
  }
  function accessSync(p: string) {
    fs.accessSync(resolve(p));
  }
  function unlinkSync(p: string) {
    fs.unlinkSync(resolve(p, true));
  }
  function readdirSync(p: string) {
    return fs.readdirSync(resolve(p));
  }
  function readFile(o: Options) {
    asyncWrap("readFile", o, () => ({
      data: readFileSync(o.filePath, o.encoding, o.position, o.length),
    }));
  }
  function writeFile(o: Options) {
    asyncWrap("writeFile", o, () => {
      writeFileSync(o.filePath, o.data, o.encoding);
      return {};
    });
  }
  function mkdir(o: Options) {
    asyncWrap("mkdir", o, () => {
      mkdirSync(o.dirPath, o.recursive);
      return {};
    });
  }
  function appendFile(o: Options) {
    asyncWrap("appendFile", o, () => {
      appendFileSync(o.filePath, o.data, o.encoding);
      return {};
    });
  }
  function access(o: Options) {
    asyncWrap("access", o, () => {
      accessSync(o.path);
      return {};
    });
  }
  function unlink(o: Options) {
    asyncWrap("unlink", o, () => {
      unlinkSync(o.filePath);
      return {};
    });
  }
  function readdir(o: Options) {
    asyncWrap("readdir", o, () => ({ files: readdirSync(o.dirPath) }));
  }
  function statSync(p: string) {
    const s = fs.statSync(resolve(p));
    return {
      size: s.size,
      mode: s.mode,
      lastAccessedTime: Math.floor(s.atimeMs / 1000),
      lastModifiedTime: Math.floor(s.mtimeMs / 1000),
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
    };
  }
  function stat(o: Options) {
    asyncWrap("stat", o, () => ({ stats: statSync(o.path) }));
  }
  function saveFileSync(tempFilePath: string, filePath?: string) {
    const dest =
      filePath ||
      "wxfile://usr/" + crypto.randomUUID() + path.extname(tempFilePath);
    const destination = resolve(dest, true);
    if (granted.has(tempFilePath)) {
      // A picker grant is read-only access to the user's original file. Import
      // its bytes; never move or delete that external original.
      fs.copyFileSync(resolve(tempFilePath), destination);
    } else {
      // Official PC saveFile consumes a runtime-owned temporary file.
      fs.renameSync(resolve(tempFilePath, true), destination);
    }
    return dest;
  }
  function saveFile(o: Options) {
    asyncWrap("saveFile", o, () => ({
      savedFilePath: saveFileSync(o.tempFilePath, o.filePath),
    }));
  }
  const manager: any = {
    readFileSync,
    writeFileSync,
    appendFileSync,
    mkdirSync,
    accessSync,
    unlinkSync,
    readdirSync,
    statSync,
    saveFileSync,
    readFile,
    writeFile,
    appendFile,
    mkdir,
    access,
    unlink,
    readdir,
    stat,
    saveFile,
  };
  const proxy = new Proxy(manager, {
    get(t, n: any) {
      if (n in t) return t[n];
      return (o: Options = {}) => {
        log("UNIMPLEMENTED: FileSystemManager." + n);
        if (!n.endsWith("Sync"))
          queueMicrotask(() => failure(n, o, Error("not implemented")));
      };
    },
  });
  function getFileSystemManager() {
    return proxy;
  }
  // Shared preflight for public wx APIs and native plugin task envelopes.
  // Resolve and validate before either allocating a native task or sending I/O.
  function validateTransfer(kind: "Upload" | "Download", o: Options) {
    if (typeof o.url !== "string") throw Error("url must be a string");
    const url = new URL(o.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("only HTTP(S) URLs without credentials are supported");
    if (
      o.timeout !== undefined &&
      (!Number.isFinite(o.timeout) || o.timeout < 0)
    )
      throw Error("invalid timeout");
    new Headers(miniProgramHeaders(o.header || {}, config));
    if (kind === "Upload") {
      if (typeof o.name !== "string" || !o.name)
        throw Error("upload name required");
      if (
        o.formData != null &&
        (typeof o.formData !== "object" || Array.isArray(o.formData))
      )
        throw Error("formData must be an object");
      const file = resolve(o.filePath);
      if (!fs.statSync(file).isFile())
        throw Error("upload source must be a file");
      fs.accessSync(file, fs.constants.R_OK);
      return { url, file };
    }
    if (o.filePath !== undefined && o.filePath !== "") {
      const file = resolve(o.filePath, true);
      if (fs.existsSync(file) && !fs.statSync(file).isFile())
        throw Error("download destination must be a file");
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
      return { url, file };
    }
    return { url, file: undefined };
  }
  function transfer(kind: "Upload" | "Download", o: Options) {
    const api = kind === "Upload" ? "uploadFile" : "downloadFile";
    const progress = new Set<Function>(),
      headers = new Set<Function>();
    const controller = new AbortController();
    let finished = false;
    const notify = (listeners: Set<Function>, value: any) => {
      for (const fn of [...listeners]) {
        try {
          fn(value);
        } catch (error) {
          log("FILE TASK CALLBACK ERROR", error);
          emitDebug("callback-error", { api, error });
        }
      }
    };
    // Defer even validation, so listeners and an immediate abort are registered
    // before the first I/O. The native wrapper performs its own sync preflight.
    const timer = setTimeout(
      () =>
        controller.abort(new DOMException("request timeout", "TimeoutError")),
      Number.isFinite(o.timeout) && o.timeout > 0
        ? o.timeout
        : config.app?.networkTimeout?.[api] || 60000,
    );
    const run = async () => {
      const { url, file: requestedFile } = validateTransfer(kind, o);
      controller.signal.throwIfAborted();
      if (kind === "Upload") {
        const file = requestedFile!;
        const form = new FormData();
        for (const [k, v] of Object.entries(o.formData || {}))
          form.append(k, String(v));
        form.append(
          o.name,
          await fs.openAsBlob(file, { type: fileContentType(file) }),
          path.basename(file),
        );
        const requestHeaders = miniProgramHeaders(o.header || {}, config);
        for (const k of Object.keys(requestHeaders))
          if (k.toLowerCase() === "content-type") delete requestHeaders[k];
        controller.signal.throwIfAborted();
        log("UPLOAD OUT", url.origin + url.pathname);
        const response = await fetch(url, {
          method: "POST",
          headers: requestHeaders,
          body: form,
          signal: controller.signal,
          // The shared transport reports bytes actually sent, including multipart
          // framing. Mock responses don't invent upload progress.
          _onUploadProgress: (value: any) => notify(progress, value),
        } as any);
        notify(headers, {
          header: Object.fromEntries(response.headers),
          statusCode: response.status,
        });
        const data = await response.text();
        controller.signal.throwIfAborted();
        return {
          data,
          statusCode: response.status,
          header: Object.fromEntries(response.headers),
        };
      }
      const logical = requestedFile
        ? o.filePath
        : "wxfile://tmp/" +
          crypto.randomUUID() +
          path.extname(url.pathname).slice(0, 12);
      if (!requestedFile)
        fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
      const destination = requestedFile || resolve(logical, true);
      // Write beside the destination and commit only after the entire decoded
      // body arrives. Cancellation preserves an existing destination unchanged.
      const partial = path.join(
        path.dirname(destination),
        ".download-" + crypto.randomUUID() + ".part",
      );
      let fd: number | undefined,
        committed = false;
      try {
        fd = fs.openSync(partial, "wx", 0o600);
        log("DOWNLOAD OUT", url.origin + url.pathname);
        const response = await fetch(url, {
          headers: miniProgramHeaders(o.header || {}, config),
          signal: controller.signal,
        });
        notify(headers, {
          header: Object.fromEntries(response.headers),
          statusCode: response.status,
        });
        let written = 0;
        // Fetch delivers decoded bytes; a compressed Content-Length cannot be
        // used as their denominator. Zero means unknown until EOF.
        const expected = response.headers.get("content-encoding")
          ? 0
          : Number(response.headers.get("content-length")) || 0;
        if (response.body)
          for await (const chunk of response.body as any) {
            controller.signal.throwIfAborted();
            let offset = 0;
            while (offset < chunk.byteLength) {
              const n = fs.writeSync(
                fd,
                chunk,
                offset,
                chunk.byteLength - offset,
              );
              if (!n) throw Error("download file write made no progress");
              offset += n;
            }
            written += chunk.byteLength;
            notify(progress, {
              progress: expected
                ? Math.min(100, Math.floor((written * 100) / expected))
                : 0,
              totalBytesWritten: written,
              totalBytesExpectedToWrite: expected,
            });
          }
        controller.signal.throwIfAborted();
        fs.closeSync(fd);
        fd = undefined;
        resolve(logical, true); // Recheck sandbox after asynchronous transport.
        fs.renameSync(partial, destination);
        committed = true;
        notify(progress, {
          progress: 100,
          totalBytesWritten: written,
          totalBytesExpectedToWrite: written,
        });
        return {
          ...(requestedFile
            ? { filePath: logical }
            : { tempFilePath: logical }),
          statusCode: response.status,
          header: Object.fromEntries(response.headers),
          dataLength: written,
        };
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (!committed) fs.rmSync(partial, { force: true });
      }
    };
    const settle = (ok: boolean, value: any) => {
      finished = true;
      clearTimeout(timer);
      try {
        if (ok) success(api, o, value);
        else
          failure(
            api,
            o,
            controller.signal.aborted ? controller.signal.reason : value,
          );
      } catch (error) {
        // Callback exceptions are observable, but cannot produce a second fail.
        log("FILE TASK CALLBACK ERROR", error);
        emitDebug("callback-error", { api, error });
      } finally {
        progress.clear();
        headers.clear();
      }
    };
    Promise.resolve()
      .then(run)
      .then(
        (value) => settle(true, value),
        (error) => settle(false, error),
      );
    const off = (set: Set<Function>, fn?: Function) =>
      fn ? set.delete(fn) : set.clear();
    return {
      abort: () => {
        if (!finished) controller.abort(new Error("abort"));
      },
      onProgressUpdate: (fn: Function) => {
        if (!finished && typeof fn === "function") progress.add(fn);
      },
      offProgressUpdate: (fn?: Function) => off(progress, fn),
      onHeadersReceived: (fn: Function) => {
        if (!finished && typeof fn === "function") headers.add(fn);
      },
      offHeadersReceived: (fn?: Function) => off(headers, fn),
    };
  }
  function downloadFile(o: Options) {
    return transfer("Download", o);
  }
  function uploadFile(o: Options) {
    return transfer("Upload", o);
  }
  return {
    api: { getFileSystemManager, saveFile, downloadFile, uploadFile },
    grant: (p: string) => granted.add(p),
    resolve,
    validateTransfer,
  };
}
