import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { Agent } from "undici";
import { debugContext } from "./context";

type Sink = (action: string, args: any) => Promise<any>;
/** Native Node/Electron Fetch's legacy handler requires alternating entries.
 * Undici 8 supplies an array for H1 but an object (including array-valued
 * set-cookie) for H2. Passing that object drops every header in native Fetch,
 * disabling content decoding and redirect handling as well as observability.
 */
function legacyHeaderEntries(raw: any, parsed: any) {
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw || parsed || {}).flatMap(([name, values]) =>
    (Array.isArray(values) ? values : [values]).flatMap((value) => [
      Buffer.from(name),
      Buffer.from(String(value)),
    ]),
  );
}
const headerObject = (raw: any): Record<string, string> => {
  if (!Array.isArray(raw))
    return Object.fromEntries(
      Object.entries(raw || {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
  const result: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key = String(raw[i]).toLowerCase();
    result[key] = result[key]
      ? result[key] + ", " + String(raw[i + 1])
      : String(raw[i + 1]);
  }
  return result;
};
function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** Retain native Fetch semantics, including decompression/redirect handling, around a controlled dispatcher. */
export function installTransport(
  sink: Sink,
  emit: (record: any) => void,
  bodyLimit = 64 * 1024 ** 2,
  PREVIEW = 262144,
  agentOptions: Agent.Options = {},
) {
  const original = globalThis.fetch;
  const agent = new Agent({ pipelining: 1, ...agentOptions });
  let sequence = 0;
  const wireContext = new AsyncLocalStorage<any>();
  const wireRequests = new WeakMap<object, any>();
  const created = (event: any) => {
    const context = wireContext.getStore();
    if (context) wireRequests.set(event.request, context);
  };
  const headersSent = (event: any) => {
    const context = wireRequests.get(event.request);
    if (!context) return;
    const raw = String(event.headers);
    const lines = raw.split("\r\n");
    const requestLine = /\s(HTTP\/\d(?:\.\d)?)$/.exec(lines[0]);
    const entries = (requestLine ? lines.slice(1) : lines)
      .filter((line) => line.indexOf(":", line.startsWith(":") ? 1 : 0) > 0)
      .map((line) => {
        const i = line.indexOf(":", line.startsWith(":") ? 1 : 0);
        return { name: line.slice(0, i), value: line.slice(i + 1).trim() };
      });
    const headers = Object.fromEntries(
      entries.map((e) => [e.name.toLowerCase(), e.value]),
    );
    Object.assign(context.hop, {
      requestHeaders: headers,
      requestHeaderEntries: entries,
      requestHeadersText: raw,
      // H2 diagnostics are a textual projection, not HPACK wire bytes.
      requestHeaderBytes: requestLine ? Buffer.byteLength(raw, "latin1") : null,
    });
    Object.assign(context.record, {
      requestHeaders: headers,
      requestHeaderEntries: entries,
      protocol:
        requestLine?.[1] ||
        (event.socket?.alpnProtocol === "h2" ||
        entries.some((e) => e.name.startsWith(":"))
          ? "h2"
          : null),
    });
    publish(context.record);
  };
  channel("undici:request:create").subscribe(created);
  channel("undici:client:sendHeaders").subscribe(headersSent);
  const publish = (record: any) => {
    try {
      emit(structuredClone(record));
    } catch {}
  };
  async function artifact(
    kind: string,
    mimeType: string,
    representation: string,
  ) {
    return (await sink("artifact-create", { kind, mimeType, representation }))
      .id as string;
  }
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const id = String(++sequence),
      started = performance.now();
    const caller = debugContext.getStore();
    if (caller?.kind === "debug-replay") caller.networkRequestId = id;
    const record: any = {
      id,
      source: "logic",
      url: req.url,
      method: req.method,
      requestHeaders: Object.fromEntries(req.headers),
      startedAt: new Date().toISOString(),
      state: "pending",
      hasRequestBody: !!req.body,
      context: debugContext.getStore() || null,
      callStack: new Error("Request call site").stack,
      hops: [],
      encodedBytes: 0,
      decodedBytes: null,
    };
    if (init?.body instanceof FormData)
      record.multipart = [...init.body.entries()].map(([name, value]) =>
        typeof value === "string"
          ? { name, value }
          : {
              name,
              fileName: value.name,
              mimeType: value.type,
              size: value.size,
            },
      );
    publish(record);
    const cancelPlan = () => {
      void sink("cancel", { id }).catch(() => {});
    };
    req.signal.addEventListener("abort", cancelPlan, { once: true });
    try {
      let lastHopDone = Promise.resolve();
      const dispatcher = {
        dispatch(opts: any, handler: any) {
          // Each native Fetch redirect dispatch is independently matched, never inferred from time.
          const url = new URL(opts.path, String(opts.origin)).href;
          const hop: any = {
            index: record.hops.length,
            url,
            method: opts.method,
            startedAt: new Date().toISOString(),
            requestHeaders: headerObject(opts.headers),
            encodedBytes: 0,
            requestBytes: 0,
          };
          record.hops.push(hop);
          let resolveDone!: () => void;
          lastHopDone = new Promise<void>((r) => (resolveDone = r));
          void (async () => {
            const plan = await sink("plan", {
              id,
              hop: hop.index,
              request: {
                url,
                method: opts.method,
                headers: hop.requestHeaders,
                source: "logic",
              },
            });
            if (req.signal.aborted) throw req.signal.reason;
            hop.rules = plan.hits;
            record.rules = [...(record.rules || []), ...plan.hits];
            const next = plan.request;
            const target = new URL(next.url);
            record.url = next.url;
            record.method = next.method;
            record.requestHeaders = next.headers;
            if (plan.action === "block" || plan.conditions.offline)
              throw new TypeError(
                plan.conditions.offline
                  ? "Network is offline"
                  : "Request blocked by debug rule",
              );
            await delay(plan.conditions.latencyMs, req.signal);
            const requestArtifactId = (hop.requestArtifactId = await artifact(
              "body",
              next.headers["content-type"] || "application/octet-stream",
              "request-bytes",
            ));
            const rawArtifactId = (hop.rawResponseArtifactId = await artifact(
              "body",
              "application/octet-stream",
              "transfer-encoded",
            ));
            record.requestArtifactId = requestArtifactId;
            record.rawResponseArtifactId = rawArtifactId;
            let requestPreview = Buffer.alloc(0),
              requestTruncated = false;
            let inputBody: any =
              next.body !== undefined
                ? Buffer.from(
                    next.body,
                    next.bodyEncoding === "base64" ? "base64" : "utf8",
                  )
                : opts.body;
            if (
              inputBody != null &&
              (typeof inputBody === "string" || inputBody instanceof Uint8Array)
            )
              inputBody = [Buffer.from(inputBody)];
            let uploadFinished = false,
              sentBytes = 0;
            const finishUpload = async () => {
              if (uploadFinished) return;
              uploadFinished = true;
              await sink("artifact-finish", { id: requestArtifactId });
              const text =
                /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(
                  next.headers["content-type"] || "",
                );
              record.requestBody = text
                ? new TextDecoder().decode(requestPreview, {
                    stream: requestTruncated,
                  })
                : requestPreview.toString("base64");
              record.requestBodyEncoding = text ? "text" : "base64";
              record.requestBodyTruncated = requestTruncated;
              publish(record);
            };
            const rate = plan.conditions.uploadBytesPerSecond;
            const outgoing =
              inputBody == null
                ? null
                : (async function* () {
                    const clock = performance.now();
                    try {
                      for await (const inputChunk of inputBody) {
                        const bytes = Buffer.from(inputChunk);
                        for (
                          let offset = 0;
                          offset < bytes.length;
                          offset += 16384
                        ) {
                          const chunk = bytes.subarray(offset, offset + 16384);
                          hop.requestBytes += chunk.length;
                          if (requestPreview.length < PREVIEW)
                            requestPreview = Buffer.concat([
                              requestPreview,
                              chunk.subarray(
                                0,
                                PREVIEW - requestPreview.length,
                              ),
                            ]);
                          requestTruncated ||= hop.requestBytes > PREVIEW;
                          await sink("artifact-append", {
                            id: requestArtifactId,
                            data: chunk,
                          });
                          if (rate)
                            await delay(
                              (hop.requestBytes * 1000) / rate -
                                (performance.now() - clock),
                              req.signal,
                            );
                          yield chunk;
                        }
                      }
                    } finally {
                      await finishUpload();
                    }
                  })();
            if (!outgoing) await finishUpload();
            let resume: (() => void) | undefined;
            let headers: Record<string, string> = {};
            let downloadStart = 0;
            let terminal = false;
            let delivery = Promise.resolve();
            const wrapped: any = {
              onConnect: (abort: any, context: any) =>
                handler.onConnect?.(abort, context),
              onHeaders: (
                status: number,
                rawHeaders: any,
                wake: any,
                statusText: string,
              ) => {
                resume = wake;
                headers = headerObject(rawHeaders);
                downloadStart = performance.now();
                hop.status = status;
                hop.responseHeaders = headers;
                hop.headersMs = performance.now() - started;
                record.status = status;
                record.responseHeaders = headers;
                record.headersMs = hop.headersMs;
                record.state = "headers";
                publish(record);
                return handler.onHeaders(status, rawHeaders, wake, statusText);
              },
              onData: (chunk: Buffer) => {
                // llhttp may flush an empty body segment when resuming a
                // partial response. Pausing it again creates an endless
                // resume(empty) microtask loop and starves abort/timeout.
                if (chunk.byteLength === 0) return true;
                hop.encodedBytes += chunk.length;
                record.encodedBytes += chunk.length;
                delivery = delivery
                  .then(async () => {
                    await sink("artifact-append", {
                      id: rawArtifactId,
                      data: chunk,
                    });
                    const rate = plan.conditions.downloadBytesPerSecond;
                    if (rate)
                      await delay(
                        (hop.encodedBytes * 1000) / rate -
                          (performance.now() - downloadStart),
                        req.signal,
                      );
                    if (terminal) return;
                    record.receivedChunks = (record.receivedChunks || 0) + 1;
                    publish(record);
                    if (handler.onData(chunk) !== false) resume?.();
                  })
                  .catch((e: any) => wrapped.onError(e));
                return false;
              },
              onComplete: (trailers: any) => {
                hop.endedAt = new Date().toISOString();
                void delivery
                  .then(() =>
                    sink("artifact-finish", {
                      id: rawArtifactId,
                      mimeType: headers["content-type"],
                      representation: headers["content-encoding"]
                        ? "transfer-encoded"
                        : "identity",
                    }),
                  )
                  .then(() => {
                    if (!terminal) {
                      terminal = true;
                      handler.onComplete(trailers);
                    }
                    resolveDone();
                  })
                  .catch((e: any) => wrapped.onError(e));
              },
              onError: (error: any) => {
                if (terminal) return;
                terminal = true;
                hop.error = error.message;
                void sink("artifact-finish", {
                  id: rawArtifactId,
                  error: error.message,
                }).catch(() => {});
                resolveDone();
                handler.onError(error);
              },
              onUpgrade: (...args: any[]) => handler.onUpgrade?.(...args),
              onBodySent: (chunk: Uint8Array) => {
                handler.onBodySent?.(chunk);
                const total = (sentBytes += chunk.byteLength);
                (init as any)?._onUploadProgress?.({
                  totalBytesSent: total,
                  totalBytesExpectedToSend:
                    Number(next.headers["content-length"]) || 0,
                  progress: Number(next.headers["content-length"])
                    ? Math.min(
                        100,
                        (total * 100) / Number(next.headers["content-length"]),
                      )
                    : 0,
                });
              },
            };
            if (plan.action === "mock") {
              record.mocked = true;
              const response = plan.response;
              const bytes = Buffer.from(
                response.body || "",
                response.bodyEncoding === "base64" ? "base64" : "utf8",
              );
              // Mock uses the same native Fetch dispatcher callbacks, preserving its Response handling.
              let aborted = false,
                resolveWake: (() => void) | undefined;
              wrapped.onConnect((reason: any) => {
                aborted = true;
                if (reason) wrapped.onError(reason);
                resolveWake?.();
              });
              const wake = () => resolveWake?.();
              const rawHeaders = Object.entries(response.headers || {}).flatMap(
                ([k, v]) => [Buffer.from(k), Buffer.from(String(v))],
              );
              wrapped.onHeaders(response.status, rawHeaders, wake, "Mock");
              if (outgoing)
                for await (const _ of outgoing) {
                  if (aborted) return;
                }
              for (let offset = 0; offset < bytes.length; offset += 16384) {
                if (aborted) return;
                await new Promise<void>((resolve) => {
                  resolveWake = resolve;
                  wrapped.onData(bytes.subarray(offset, offset + 16384));
                });
              }
              if (!aborted) wrapped.onComplete([]);
            } else {
              wireContext.run({ record, hop }, () =>
                agent.dispatch(
                  {
                    ...opts,
                    origin: target.origin,
                    path: target.pathname + target.search,
                    method: next.method,
                    headers: next.headers,
                    body: outgoing,
                    idempotent: false,
                  },
                  // Node/Electron's native Fetch still supplies the legacy
                  // handler contract. Undici 8 uses an explicit controller;
                  // retain raw header entries and propagate backpressure and
                  // abort without replacing Fetch's decoding/redirect logic.
                  {
                    onRequestStart(controller, context) {
                      wrapped.onConnect(
                        (reason: any) => controller.abort(reason),
                        context,
                      );
                    },
                    onResponseStart(
                      controller,
                      status,
                      responseHeaders,
                      statusText,
                    ) {
                      const raw = legacyHeaderEntries(
                        controller.rawHeaders,
                        responseHeaders,
                      );
                      if (
                        wrapped.onHeaders(
                          status,
                          raw,
                          () => controller.resume(),
                          statusText,
                        ) === false
                      )
                        controller.pause();
                    },
                    onResponseData(controller, chunk) {
                      if (wrapped.onData(chunk) === false) controller.pause();
                    },
                    onResponseEnd(controller, trailers) {
                      wrapped.onComplete(
                        legacyHeaderEntries(controller.rawTrailers, trailers),
                      );
                    },
                    onResponseError(_controller, error) {
                      wrapped.onError(error);
                    },
                    onBodySent(chunk) {
                      wrapped.onBodySent(chunk);
                    },
                  },
                ),
              );
            }
          })().catch((error) => {
            resolveDone();
            handler.onError(error);
          });
          return true;
        },
      };
      const response = await original(input, { ...init, dispatcher } as any);
      const decodedId = (record.responseArtifactId = await artifact(
        "body",
        response.headers.get("content-type") || "application/octet-stream",
        "decoded",
      ));
      record.status = response.status;
      record.responseHeaders = Object.fromEntries(response.headers);
      void (async () => {
        const reader = response.clone().body?.getReader();
        let size = 0;
        let preview = Buffer.alloc(0);
        let truncated = false;
        try {
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            record.decodedBytesSoFar = size;
            publish(record);
            if (preview.length < PREVIEW)
              preview = Buffer.concat([
                preview,
                value.subarray(0, PREVIEW - preview.length),
              ]);
            await sink("artifact-append", { id: decodedId, data: value });
            if (size > bodyLimit) {
              truncated = true;
              void reader.cancel().catch(() => {});
              break;
            }
          }
          const type = response.headers.get("content-type") || "";
          const charset =
            /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] || "utf-8";
          const text = /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(
            type,
          );
          record.responseBody = text
            ? new TextDecoder(charset).decode(preview, {
                stream: size > PREVIEW,
              })
            : preview.toString("base64");
          record.responseBodyEncoding = text ? "text" : "base64";
          record.responseBodyTruncated = size > PREVIEW;
          record.decodedBytes = truncated ? null : size;
          record.bodyTruncated = truncated;
          await sink("artifact-finish", { id: decodedId, charset });
          await lastHopDone;
          record.state = "complete";
        } catch (e: any) {
          record.state = req.signal.aborted ? "failed" : "capture-error";
          if (req.signal.aborted) {
            record.error = req.signal.reason.message;
            record.errorName = req.signal.reason.name;
          }
          record.captureError = e.message;
          await sink("artifact-finish", {
            id: decodedId,
            error: e.message,
          }).catch(() => {});
        }
        record.endedAt = new Date().toISOString();
        record.durationMs = performance.now() - started;
        req.signal.removeEventListener("abort", cancelPlan);
        publish(record);
      })();
      return response;
    } catch (e: any) {
      req.signal.removeEventListener("abort", cancelPlan);
      const error = req.signal.aborted ? req.signal.reason : e;
      Object.assign(record, {
        state: "failed",
        error: error.message,
        errorName: error.name,
        errorStack: error.stack,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
      });
      publish(record);
      throw error;
    }
  };
  return async () => {
    globalThis.fetch = original;
    channel("undici:request:create").unsubscribe(created);
    channel("undici:client:sendHeaders").unsubscribe(headersSent);
    await agent.destroy();
  };
}
