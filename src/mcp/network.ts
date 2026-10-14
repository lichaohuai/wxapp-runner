import { debugContext } from "../debug/context";
const LIMIT = 256 * 1024;
/** Observe the original fetch once; consume only a bounded, already decompressed clone. */
export function observeFetch(emit: (record: any) => void) {
  const original = globalThis.fetch;
  let seq = 0;
  const safeEmit = (record: any) => {
    try {
      emit(record);
    } catch {}
  };
  globalThis.fetch = async (input, init) => {
    const id = String(++seq);
    const start = performance.now();
    const source = input instanceof Request ? input : undefined;
    const url = source?.url || String(input);
    const method = init?.method || source?.method || "GET";
    const headers = Object.fromEntries(
      new Headers(init?.headers || source?.headers),
    );
    const raw = init?.body;
    const requestBody =
      typeof raw === "string"
        ? new TextDecoder().decode(Buffer.from(raw).subarray(0, LIMIT), {
            stream: Buffer.byteLength(raw) > LIMIT,
          })
        : undefined;
    const record: any = {
      id,
      url,
      method,
      requestHeaders: headers,
      requestBody,
      requestBodyTruncated:
        typeof raw === "string" && Buffer.byteLength(raw) > LIMIT,
      requestBodyUnavailable: raw != null && typeof raw !== "string",
      startedAt: new Date().toISOString(),
      context: debugContext.getStore() || null,
      callStack: new Error("Request call site").stack,
      state: "pending",
    };
    safeEmit(record);
    try {
      const response = await original(input, init);
      record.status = response.status;
      record.headersMs = performance.now() - start;
      record.responseHeaders = Object.fromEntries(response.headers);
      record.state = "headers";
      safeEmit({ ...record });
      void (async () => {
        try {
          const clone = response.clone();
          const reader = clone.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (reader) {
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const remaining = LIMIT - size;
                chunks.push(value.subarray(0, remaining));
                size += Math.min(value.length, remaining);
                if (value.length > remaining) {
                  record.responseBodyTruncated = true;
                  break;
                }
              }
            } finally {
              // Tee cancellation may wait for the business consumer: never await it.
              void reader.cancel().catch(() => {});
            }
          }
          const bytes = Buffer.concat(chunks);
          const type = response.headers.get("content-type") || "";
          if (/json|text\/|xml|javascript|x-www-form-urlencoded/i.test(type)) {
            const encoding =
              /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] || "utf-8";
            record.responseBody = new TextDecoder(encoding).decode(bytes, {
              stream: !!record.responseBodyTruncated,
            });
            record.responseBodyEncoding = "text";
          } else {
            record.responseBody = bytes.toString("base64");
            record.responseBodyEncoding = "base64";
          }
          record.state = "complete";
        } catch (e: any) {
          record.state = "capture-error";
          record.captureError = e.message;
        }
        record.endedAt = new Date().toISOString();
        record.durationMs = performance.now() - start;
        safeEmit({ ...record });
      })();
      return response;
    } catch (error: any) {
      safeEmit({
        ...record,
        state: "failed",
        error: error.message,
        errorName: error.name,
        errorStack: error.stack,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
      });
      throw error;
    }
  };
  return () => {
    globalThis.fetch = original;
  };
}
