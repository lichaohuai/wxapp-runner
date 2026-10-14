import { LogicInspector } from "../mcp/inspector";
import { ArtifactStore } from "./artifacts";
import { NetworkRules } from "./rules";
import {
  viewResourceHeaders,
  type MiniProgramNetworkIdentity,
} from "../wx-shim/network-context";
/** A dedicated WebSocket CDP observer; native DevTools can independently attach. */
export class ViewNetwork {
  readonly client = new LogicInspector();
  private closed = false;
  private requests = new Map<string, any>();
  private requestPlans = new Map<string, { url: string; metadata: any }>();
  private streams = new Map<
    string,
    {
      id: string;
      initialized: boolean;
      pending: Buffer[];
      ready: Promise<void>;
    }
  >();
  constructor(
    readonly runtimeId: string,
    readonly sessionId: string,
    readonly targetId: string,
    private artifacts: ArtifactStore,
    private rules: NetworkRules,
    private emit: (record: any) => void,
    private event: (event: any) => void,
    private plan: (request: any) => Promise<any>,
    private resourceContext?: MiniProgramNetworkIdentity & {
      documentURL: string;
    },
  ) {}
  async connect(url: string) {
    this.client.onEvent = (method, p) => {
      void this.message(method, p).catch((e) =>
        this.event({
          type: "view-network-error",
          level: "error",
          message: e.message,
          method,
        }),
      );
    };
    await this.client.connect(url, {
      reconnect: true,
      onReconnect: () => this.observe(),
    });
    await this.observe();
  }
  private async observe() {
    await this.client.raw("Network.enable", {
      maxTotalBufferSize: this.artifacts.totalLimit,
      maxResourceBufferSize: this.artifacts.bodyLimit,
      maxPostDataSize: 262144,
    });
    await this.client.raw("Fetch.enable", {
      patterns: [
        { urlPattern: "http://*", requestStage: "Request" },
        { urlPattern: "https://*", requestStage: "Request" },
      ],
    });
    await this.conditions();
  }
  async conditions() {
    const c = this.rules.conditions;
    await this.client.raw("Network.emulateNetworkConditions", {
      offline: c.offline,
      latency: c.latencyMs,
      downloadThroughput: c.downloadBytesPerSecond || -1,
      uploadThroughput: c.uploadBytesPerSecond || -1,
    });
    await this.client.raw("Network.setCacheDisabled", {
      cacheDisabled: c.cacheDisabled,
    });
  }
  private publish(record: any) {
    this.emit({ ...record });
    if (this.requests.size > 1000)
      for (const [key, old] of this.requests) {
        if (!["complete", "failed", "capture-error"].includes(old.state))
          continue;
        this.requests.delete(key);
        this.streams.delete(key);
        if (this.requests.size <= 1000) break;
      }
  }
  private async message(method: string, p: any) {
    if (this.closed) return;
    if (method === "Inspector.detached") {
      for (const [key, record] of this.requests)
        if (!["complete", "failed", "capture-error"].includes(record.state)) {
          const stream = this.streams.get(key);
          if (stream)
            this.artifacts.finish(stream.id, {
              error: "Observer disconnected; body is incomplete",
            });
          Object.assign(record, {
            state: "capture-error",
            captureError: "Observer disconnected; request may still execute",
            endedAt: new Date().toISOString(),
          });
          this.publish(record);
        }
      this.streams.clear();
    }
    if (method === "Inspector.detached" || method === "Inspector.reconnected" || method === "Inspector.transportError") {
      this.event({ type: method, ...p, targetId: this.targetId });
      return;
    }
    if (method === "Fetch.requestPaused") {
      const headers = viewResourceHeaders(
        p.request.headers,
        p.request.url,
        this.resourceContext?.documentURL,
        this.resourceContext,
      );
      const contextApplied = headers !== p.request.headers;
      const plan = await this.plan({ ...p.request, headers, source: "view" });
      const record = this.requests.get(p.networkId);
      const before = Object.fromEntries(
        Object.entries(p.request.headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const after = Object.fromEntries(
        Object.entries(plan.request.headers).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      const metadata = {
        rules: plan.hits,
        ruleIds: plan.hits.map((hit: any) => hit.id),
        blockedReason:
          plan.action === "block"
            ? plan.reason || "NETWORK_RULE_BLOCK"
            : undefined,
        mocked: plan.action === "mock",
        requestHeaders: plan.request.headers,
        url: plan.request.url,
        requestHeaderOverrides: Object.fromEntries(
          [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .filter((k) => before[k] !== after[k])
            .map((k) => [k, after[k] ?? null]),
        ),
        ...(contextApplied ? { hostRequestContext: "mini-program-view" } : {}),
      };
      if (
        record &&
        record.url === p.request.url &&
        !["complete", "failed"].includes(record.state)
      ) {
        Object.assign(record, metadata);
        // Publish the known decision before failRequest can emit loadingFailed.
        this.publish(record);
      } else if (p.networkId) {
        this.requestPlans.set(p.networkId, { url: p.request.url, metadata });
        if (this.requestPlans.size > 1000)
          this.requestPlans.delete(this.requestPlans.keys().next().value!);
      }
      if (plan.action === "block")
        await this.client.raw("Fetch.failRequest", {
          requestId: p.requestId,
          errorReason: "BlockedByClient",
        });
      else if (plan.action === "mock")
        await this.client.raw("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: plan.response.status,
          responseHeaders: Object.entries(plan.response.headers).map(
            ([name, value]) => ({ name, value }),
          ),
          body: Buffer.from(
            plan.response.body,
            plan.response.bodyEncoding === "base64" ? "base64" : "utf8",
          ).toString("base64"),
        });
      else
        await this.client.raw("Fetch.continueRequest", {
          requestId: p.requestId,
          ...(plan.hits.length || contextApplied
            ? {
                url: plan.request.url,
                method: plan.request.method,
                headers: Object.entries(plan.request.headers).map(
                  ([name, value]) => ({ name, value }),
                ),
                ...(plan.request.body !== undefined
                  ? {
                      postData: Buffer.from(
                        plan.request.body,
                        plan.request.bodyEncoding === "base64"
                          ? "base64"
                          : "utf8",
                      ).toString("base64"),
                    }
                  : {}),
              }
            : {}),
        });
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const previous = this.requests.get(p.requestId);
      if (previous && p.redirectResponse) {
        Object.assign(previous, {
          status: p.redirectResponse.status,
          responseHeaders: p.redirectResponse.headers,
          state: "complete",
          endedAt: new Date().toISOString(),
          responseBodyUnavailable: "redirect",
          encodedBytes: p.redirectResponse.encodedDataLength,
        });
        this.publish(previous);
      }
      const index = previous ? (previous.redirectIndex || 0) + 1 : 0;
      const record: any = {
        id: this.targetId + ":" + p.requestId + ":" + index,
        source: "view",
        targetId: this.targetId,
        resourceType: p.type,
        url: p.request.url,
        method: p.request.method,
        requestHeaders: p.request.headers,
        hasRequestBody: p.request.hasPostData,
        requestBody: p.request.postData,
        requestBodyEncoding: "text",
        requestBodyTruncated: !!p.request.hasPostData && !p.request.postData,
        startedAt: new Date(
          (p.wallTime || Date.now() / 1000) * 1000,
        ).toISOString(),
        timestamp: p.timestamp,
        state: "pending",
        initiator: p.initiator,
        redirectIndex: index,
        redirectFrom: previous?.id,
        encodedBytes: 0,
        decodedBytes: 0,
      };
      const pendingPlan = this.requestPlans.get(p.requestId);
      if (pendingPlan && pendingPlan.url === p.request.url) {
        Object.assign(record, pendingPlan.metadata);
        this.requestPlans.delete(p.requestId);
      }
      if (p.request.postData !== undefined)
        record.requestArtifactId = this.artifacts.put(
          {
            runtimeId: this.runtimeId,
            sessionId: this.sessionId,
            kind: "body",
            mimeType:
              p.request.headers["Content-Type"] ||
              p.request.headers["content-type"] ||
              "text/plain",
            representation: "request-bytes",
          },
          Buffer.from(p.request.postData),
        );
      this.requests.set(p.requestId, record);
      this.publish(record);
      return;
    }
    const record = this.requests.get(p.requestId);
    if (!record) {
      if (method.startsWith("Network.webSocket"))
        this.event({
          type: method,
          ...p,
          cdpMethod: method,
          targetId: this.targetId,
        });
      if (
        method === "Runtime.exceptionThrown" ||
        method === "Runtime.consoleAPICalled" ||
        method === "Log.entryAdded"
      )
        this.event({
          type: method,
          ...p,
          cdpMethod: method,
          targetId: this.targetId,
        });
      return;
    }
    if (record.state === "capture-error") return;
    if (method === "Network.requestWillBeSentExtraInfo") {
      // Chromium can report the pre-Fetch headers even after continueRequest
      // supplied replacements. Keep explicitly applied overrides distinguishable.
      record.browserRequestHeaders = p.headers;
      const overrides = record.requestHeaderOverrides || {};
      record.requestHeaders = Object.fromEntries([
        ...Object.entries(p.headers).filter(
          ([k]) => !Object.hasOwn(overrides, k.toLowerCase()),
        ),
        ...Object.entries(overrides).filter(([, v]) => v !== null),
      ]);
      record.requestHeadersSource = Object.keys(overrides).length
        ? "cdp-with-fetch-overrides"
        : "cdp";
      this.publish(record);
    }
    if (method === "Network.responseReceivedExtraInfo") {
      record.responseHeaders = p.headers;
      this.publish(record);
    }
    if (method === "Network.responseReceived") {
      Object.assign(record, {
        state: "headers",
        status: p.response.status,
        responseHeaders: p.response.headers,
        headersMs: (p.timestamp - record.timestamp) * 1000,
        protocol: p.response.protocol,
        mimeType: p.response.mimeType,
        charset: p.response.charset,
        timing: p.response.timing,
        fromDiskCache: p.response.fromDiskCache,
        fromServiceWorker: p.response.fromServiceWorker,
        connectionReused: p.response.connectionReused,
        connectionId: p.response.connectionId,
      });
      this.publish(record);
      const id = this.artifacts.create({
        runtimeId: this.runtimeId,
        sessionId: this.sessionId,
        kind: "body",
        mimeType: p.response.mimeType,
        charset: p.response.charset,
        representation: "decoded",
      });
      const stream = {
        id,
        initialized: false,
        pending: [] as Buffer[],
        ready: Promise.resolve(),
      };
      this.streams.set(p.requestId, stream);
      record.responseArtifactId = id;
      stream.ready = this.client
        .raw("Network.streamResourceContent", { requestId: p.requestId })
        .then((result) => {
          if (this.closed || this.streams.get(p.requestId) !== stream) return;
          if (result.bufferedData)
            this.artifacts.append(
              id,
              Buffer.from(result.bufferedData, "base64"),
            );
          for (const chunk of stream.pending) this.artifacts.append(id, chunk);
          stream.pending.length = 0;
          stream.initialized = true;
        })
        .catch(() => {
          record.streamingCaptureUnavailable = true;
        });
    }
    if (method === "Network.dataReceived") {
      record.encodedBytes += p.encodedDataLength || 0;
      record.decodedBytes += p.dataLength || 0;
      const stream = this.streams.get(p.requestId);
      if (stream && p.data) {
        const bytes = Buffer.from(p.data, "base64");
        stream.initialized
          ? this.artifacts.append(stream.id, bytes)
          : stream.pending.push(bytes);
      }
    }
    if (method === "Network.loadingFinished") {
      const stream = this.streams.get(p.requestId);
      if (stream) await stream.ready;
      if (this.closed || (stream && this.streams.get(p.requestId) !== stream)) return;
      const captured = stream && this.artifacts.info(stream.id);
      // A successful streamResourceContent command is NOT proof of captured
      // bytes: Chromium may return an empty stream for cache/resource fast paths.
      // Read its retained response (never re-fetch the URL) when no/partial data
      // arrived. HEAD and no-content responses intentionally have no body.
      const noBody = record.method === "HEAD" || [204, 205, 304].includes(record.status);
      const missingBytes = captured && record.decodedBytes > captured.observedBytes;
      if (stream && !noBody && (!stream.initialized || !captured?.observedBytes || missingBytes)) {
        try {
          const result = await this.client.raw("Network.getResponseBody", {
            requestId: p.requestId,
          });
          if (this.closed || this.streams.get(p.requestId) !== stream) return;
          const bytes = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
          if (bytes.length < record.decodedBytes)
            throw Error("Chromium retained fewer response bytes than it reported receiving");
          if (captured?.observedBytes) {
            // Replacing a partial stream must not append a full body to it.
            this.artifacts.finish(stream.id, { error: "Incomplete stream superseded by retained response" });
            stream.id = this.artifacts.create({
              runtimeId: this.runtimeId, sessionId: this.sessionId, kind: "body",
              mimeType: record.mimeType, charset: record.charset, representation: "decoded",
            });
            record.responseArtifactId = stream.id;
          }
          this.artifacts.append(
            stream.id,
            bytes,
          );
          record.responseBodyCaptureSource = "cdp-retained-response";
        } catch (e: any) {
          if (this.closed || this.streams.get(p.requestId) !== stream) return;
          record.responseBodyUnavailable = e.message;
        }
      }
      if (stream) {
        const meta = this.artifacts.finish(stream.id, {
          error: record.responseBodyUnavailable,
        });
        const bytes = this.artifacts.preview(stream.id, 262144);
        const text = /text|json|javascript|xml/i.test(meta.mimeType || "");
        record.responseBody = text
          ? new TextDecoder(meta.charset || "utf-8").decode(bytes, {
              stream: meta.bytes > bytes.length,
            })
          : bytes.toString("base64");
        record.responseBodyEncoding = text ? "text" : "base64";
        record.responseBodyTruncated =
          meta.truncated || meta.bytes > bytes.length;
        record.bodyTruncated = meta.truncated;
      }
      Object.assign(record, {
        state: "complete",
        encodedBytes: p.encodedDataLength,
        durationMs: (p.timestamp - record.timestamp) * 1000,
        endedAt: new Date().toISOString(),
        rawResponseUnavailable:
          "Chromium exposes decoded resource bytes, not original compressed bytes",
      });
      this.publish(record);
      this.streams.delete(p.requestId);
    }
    if (method === "Network.loadingFailed") {
      const stream = this.streams.get(p.requestId);
      if (stream) {
        await stream.ready;
        this.artifacts.finish(stream.id, { error: p.errorText });
      }
      Object.assign(record, {
        state: "failed",
        error: p.errorText,
        errorName: p.canceled ? "AbortError" : "NetworkError",
        endedAt: new Date().toISOString(),
      });
      this.publish(record);
      this.streams.delete(p.requestId);
    }
  }
  close() {
    this.closed = true;
    for (const stream of this.streams.values())
      this.artifacts.finish(stream.id, { error: "View closed before response capture completed" });
    this.streams.clear();
    this.requestPlans.clear();
    this.client.close();
  }
}
