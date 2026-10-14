import { debugContext, traceContext, copyDebug } from "../debug/context";
import { success, failure, type Options } from "./common";
import {
  miniProgramHeaders,
  type MiniProgramNetworkIdentity,
} from "./network-context";
export function createRequest(
  log: (...a: any[]) => void,
  defaultTimeout = 60000,
  identity: MiniProgramNetworkIdentity = {},
  transport: { serialized?: boolean; chunkOnly?: boolean } = {},
) {
  return function request(o: Options) {
    const controller = new AbortController();
    const headersListeners = new Set<Function>();
    const chunkListeners = new Set<Function>();
    const method = String(o.method || "GET").toUpperCase();
    let url: URL;
    try {
      // WeChat wx.request invokes fail() asynchronously for a malformed URL; it
      // never throws synchronously. Throwing here propagates into a synchronous
      // caller (e.g. the AWSC/collina VM's request op), whose catch handler
      // retries immediately and spins into infinite recursion (100% CPU, dead
      // taps). Mirror WeChat: async fail, no sync throw.
      url = new URL(o.url);
    } catch {
      queueMicrotask(() =>
        failure("request", o, Error("invalid url: " + o.url)),
      );
      return { abort() {} };
    }
    let body: any;
    const headers = miniProgramHeaders(o.header || {}, identity);
    if (o.data != null) {
      if (transport.serialized) {
        // The genuine base library has already encoded data and GET queries.
        // Re-encoding here corrupts native/plugin requests (notably JSON strings).
        if (!["GET", "HEAD"].includes(method)) body = o.data;
      } else if (["GET", "HEAD"].includes(method)) {
        if (typeof o.data === "object")
          for (const [k, v] of Object.entries(o.data))
            url.searchParams.append(k, String(v));
        else url.search += (url.search ? "&" : "?") + String(o.data);
      } else if (
        typeof o.data === "string" ||
        Object.prototype.toString.call(o.data) === "[object ArrayBuffer]" ||
        ArrayBuffer.isView(o.data)
      )
        body = o.data;
      else if (
        headers["content-type"]?.includes("application/x-www-form-urlencoded")
      )
        body = new URLSearchParams(o.data).toString();
      else {
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(o.data);
      }
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      queueMicrotask(() =>
        failure("request", o, Error("only HTTP(S) URLs are supported")),
      );
      return { abort() {} };
    }
    log("NETWORK OUT", method, url.origin + url.pathname);
    const timer = setTimeout(
      () =>
        controller.abort(new DOMException("request timeout", "TimeoutError")),
      o.timeout || defaultTimeout,
    );
    const context = traceContext({
      api: "wx.request",
      requestOptions: copyDebug(
        {
          url: o.url,
          method,
          header: o.header,
          data: o.data,
          dataType: o.dataType,
          responseType: o.responseType,
          timeout: o.timeout,
        },
        32000,
      ).value,
    });
    debugContext.run(context, () =>
      fetch(url, { method, headers, body, signal: controller.signal })
        .then(async (res) => {
          const header = Object.fromEntries(res.headers);
          for (const cb of headersListeners)
            cb({ header, statusCode: res.status });
          let chunked: ArrayBuffer | undefined;
          if (o.enableChunked && res.body) {
            const chunks: Uint8Array[] = [];
            for await (const bytes of res.body as any) {
              // Native streaming success carries no body. Its chunks are
              // already captured by the shared transport; don't retain a second
              // unbounded copy just to discard it when publishing success.
              if (!transport.chunkOnly) chunks.push(bytes);
              const data = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              );
              for (const cb of chunkListeners) cb({ data });
            }
            const joined = Buffer.concat(chunks);
            chunked = joined.buffer.slice(
              joined.byteOffset,
              joined.byteOffset + joined.byteLength,
            );
          }
          const charset =
            /charset\s*=\s*["']?([^\s;"']+)/i.exec(
              res.headers.get("content-type") || "",
            )?.[1] || "utf-8";
          let data: any =
            chunked !== undefined
              ? o.responseType === "arraybuffer"
                ? chunked
                : new TextDecoder(charset).decode(chunked)
              : o.responseType === "arraybuffer"
                ? await res.arrayBuffer()
                : new TextDecoder(charset).decode(await res.arrayBuffer());
          if (
            o.responseType !== "arraybuffer" &&
            (o.dataType ?? "json") === "json"
          )
            try {
              data = JSON.parse(data);
            } catch {}
          log("NETWORK IN", method, url.origin + url.pathname, res.status);
          return {
            data,
            statusCode: res.status,
            header,
            cookies: res.headers.getSetCookie(),
          };
        })
        .then(
          (result) => success("request", o, result),
          (e) => failure("request", o, e),
        )
        .finally(() => clearTimeout(timer)),
    );
    return {
      abort: () =>
        controller.abort(new DOMException("request aborted", "AbortError")),
      onChunkReceived: (fn: Function) => chunkListeners.add(fn),
      offChunkReceived: (fn: Function) => chunkListeners.delete(fn),
      onHeadersReceived: (fn: Function) => headersListeners.add(fn),
      offHeadersReceived: (fn: Function) => headersListeners.delete(fn),
    };
  };
}
