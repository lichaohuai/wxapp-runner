import * as inspector from "node:inspector";
import { brotliDecompress, gunzip, inflate, inflateRaw } from "node:zlib";

const MAX_BODY = 32 * 1024 * 1024;
const MAX_BUFFERED = 64 * 1024 * 1024;

function header(headers: Record<string, unknown> = {}, name: string) {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return typeof value === "string" ? value : "";
}
function charset(headers: Record<string, unknown>, supplied?: string) {
  const type = header(headers, "content-type");
  const explicit =
    supplied || /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1];
  // JSON and the strings serialized by the shim are UTF-8 even without charset.
  const text =
    /^(text\/|application\/(?:[\w.+-]*\+)?(?:json|xml)(?:\s*;|$)|application\/(?:x-www-form-urlencoded|javascript)(?:\s*;|$))/i.test(
      type,
    );
  if (!explicit && !text) return undefined;
  try {
    return new TextDecoder(explicit || "utf-8").encoding;
  } catch {
    return undefined;
  } // Unknown/binary data must not be guessed as text.
}

type Body = {
  chunks: Buffer[];
  size: number;
  encodings: string[];
  charset?: string;
  timer: ReturnType<typeof setTimeout>;
  error?: string;
};

function decompress(fn: typeof gunzip, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    fn(data, { maxOutputLength: MAX_BODY }, (error, output) =>
      error ? reject(error) : resolve(output),
    ),
  );
}

/** Adapt Node 24's wire-body inspector events to native DevTools decoded bodies.
 * Only inspector copies are changed: fetch, HTTP headers and business bytes stay intact.
 */
export function installInspectorCompatibility(
  network = (inspector as any).Network,
) {
  const originals = Object.fromEntries(
    [
      "requestWillBeSent",
      "responseReceived",
      "dataReceived",
      "loadingFinished",
      "loadingFailed",
    ].map((name) => [name, network[name]]),
  );
  const call = (name: string, params: any) =>
    originals[name].call(network, params);
  const bodies = new Map<string, Body>();
  let buffered = 0;
  function release(id: string) {
    const state = bodies.get(id);
    if (!state) return;
    clearTimeout(state.timer);
    buffered -= state.size;
    state.chunks = [];
    state.size = 0;
    bodies.delete(id);
  }
  function failed(params: any, reason: string) {
    release(params.requestId);
    call("loadingFailed", {
      ...params,
      type: "Fetch",
      errorText: `DevTools body decode: ${reason} (business request unchanged)`,
    });
  }
  network.requestWillBeSent = (params: any) => {
    const encoding = charset(params.request?.headers, params.charset);
    return call(
      "requestWillBeSent",
      encoding === "utf-8" ? { ...params, charset: "utf-8" } : params,
    );
  };
  network.responseReceived = (params: any) => {
    const response = params.response;
    const encoding = charset(response.headers, response.charset);
    const encodings = header(response.headers, "content-encoding")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== "identity");
    release(params.requestId);
    if (encodings.length || (encoding && encoding !== "utf-8")) {
      // Disconnects can unsubscribe Node diagnostics before a terminal event arrives.
      const timer = setTimeout(
        () =>
          failed(
            {
              requestId: params.requestId,
              timestamp: performance.now() / 1000,
            },
            "inspector body capture expired",
          ),
        5 * 60_000,
      );
      timer.unref();
      bodies.set(params.requestId, {
        chunks: [],
        size: 0,
        charset: encoding,
        encodings,
        timer,
      });
    }
    return call(
      "responseReceived",
      encoding
        ? { ...params, response: { ...response, charset: "utf-8" } }
        : params,
    );
  };
  network.dataReceived = (params: any) => {
    const state = bodies.get(params.requestId);
    if (!state) return call("dataReceived", params);
    state.timer.refresh();
    if (params.data && !state.error) {
      const chunk = Buffer.from(params.data);
      if (
        state.size + chunk.length > MAX_BODY ||
        buffered + chunk.length > MAX_BUFFERED
      ) {
        state.error = "inspector body buffer limit exceeded";
        buffered -= state.size;
        state.size = 0;
        state.chunks = [];
      } else {
        state.chunks.push(chunk);
        state.size += chunk.length;
        buffered += chunk.length;
      }
    }
    // Preserve wire progress; publish decoded data once complete, before loadingFinished.
    return call("dataReceived", { ...params, data: undefined, dataLength: 0 });
  };
  network.loadingFinished = (params: any) => {
    const state = bodies.get(params.requestId);
    if (!state) return call("loadingFinished", params);
    void (async () => {
      try {
        if (state.error) throw Error(state.error);
        let data: Buffer = Buffer.concat(state.chunks);
        // HEAD/204/304 can advertise compression while legitimately having no body.
        if (data.length) {
          for (const encoding of [...state.encodings].reverse()) {
            if (encoding === "gzip" || encoding === "x-gzip")
              data = await decompress(gunzip, data);
            else if (encoding === "br")
              data = await decompress(brotliDecompress, data);
            else if (encoding === "deflate") {
              try {
                data = await decompress(inflate, data);
              } catch (error: any) {
                if (error.code !== "Z_DATA_ERROR") throw error;
                data = await decompress(inflateRaw, data);
              }
            } else throw Error(`unsupported content-encoding: ${encoding}`);
          }
          if (state.charset && state.charset !== "utf-8") {
            data = Buffer.from(new TextDecoder(state.charset).decode(data));
          }
        }
        if (bodies.get(params.requestId) !== state) return; // Aborted/replaced while decoding.
        call("dataReceived", {
          ...params,
          data,
          dataLength: data.length,
          encodedDataLength: 0,
        });
        release(params.requestId);
        call("loadingFinished", params);
      } catch (error: any) {
        if (bodies.get(params.requestId) === state)
          failed(params, error.message);
      }
    })();
  };
  network.loadingFailed = (params: any) => {
    release(params.requestId);
    return call("loadingFailed", params);
  };
  return () => {
    Object.assign(network, originals);
    for (const id of bodies.keys()) release(id);
  };
}
