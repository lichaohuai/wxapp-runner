import { debugContext, emitDebug } from "../debug/context";

const API = "operateRealtimeData";
export const realtimeContentLimit = 256 * 1024;
export type RealtimeRecord = {
  type: "realtime-data";
  api: typeof API;
  realtimeId: number;
  realtimeType: number;
  content: string;
  contentBytes: number;
  priority: "low" | "high" | "immediate";
  runnerDisposition: "local-only";
  uploaded: false;
  time: string;
  context: Record<string, any>;
};

/** WAServiceMainContext 3.17.3 module 9535. This is a local telemetry
 * receiver, NOT cloud database watch or an acknowledgement from WeChat. */
export class NativeRealtimeData {
  private closed = false;
  private pending = new Set<{ contextId?: number; cancel(): void }>();
  constructor(
    private record: (record: RealtimeRecord) => Promise<{ eventId: number }>,
    private publish: (name: string, value: any) => void,
    private timeoutMs = 5000,
    private capacity = 64,
  ) {}
  get pendingCount() {
    return this.pending.size;
  }
  closeContext(contextId: number) {
    for (const task of this.pending)
      if (task.contextId === contextId) task.cancel();
  }
  close() {
    this.closed = true;
    for (const task of this.pending) task.cancel();
  }
  invoke(
    name: string,
    args: any,
    reply: (value: any) => void,
  ): string | undefined {
    if (name !== API) return;
    const fail = (message: string, code: string) => ({
      errMsg: API + ":fail " + message,
      runnerCode: code,
      runnerDisposition: "local-only",
      uploaded: false,
    });
    if (this.closed)
      return JSON.stringify(fail("receiver closed", "REALTIME_CLOSED"));
    if (
      !args ||
      !Number.isSafeInteger(args.id) ||
      args.id < 0 ||
      !Number.isSafeInteger(args.type) ||
      args.type < 0 ||
      typeof args.content !== "string" ||
      !["low", "high", "immediate"].includes(args.priority)
    )
      return JSON.stringify(
        fail(
          "invalid id, type, content or priority",
          "REALTIME_INVALID_ARGUMENT",
        ),
      );
    const contentBytes = Buffer.byteLength(args.content, "utf8");
    if (contentBytes > realtimeContentLimit)
      return JSON.stringify(
        fail("content exceeds 256 KiB", "REALTIME_CONTENT_LIMIT"),
      );
    if (this.pending.size >= this.capacity)
      return JSON.stringify(
        fail("receiver queue is full", "REALTIME_CAPACITY"),
      );

    const context = { ...debugContext.getStore() };
    const record: RealtimeRecord = {
      type: "realtime-data",
      api: API,
      realtimeId: args.id,
      realtimeType: args.type,
      content: args.content,
      contentBytes,
      priority: args.priority,
      runnerDisposition: "local-only",
      uploaded: false,
      time: new Date().toISOString(),
      context,
    };
    let timer: ReturnType<typeof setTimeout>;
    let delivery: ReturnType<typeof setImmediate> | undefined;
    const task = {
      contextId: context.contextId,
      cancel: () => {
        clearTimeout(timer);
        if (delivery) clearImmediate(delivery);
        this.pending.delete(task);
      },
    };
    const failed = (message: string, code: string) => {
      if (!this.pending.has(task)) return;
      task.cancel();
      const result = fail(message, code);
      emitDebug("native-api-error", {
        api: API,
        ...result,
        realtimeId: args.id,
      });
      // The SDK's beforeFail already notifies its subscribers.
      try {
        reply(result);
      } catch (error) {
        emitDebug("native-api-error", { api: API + ".callback", error });
      }
    };
    this.pending.add(task);
    timer = setTimeout(
      () => failed("local receipt timed out; not retried", "REALTIME_TIMEOUT"),
      this.timeoutMs,
    );
    // Retain before acknowledging. No callback is made from invoke's call stack.
    Promise.resolve()
      .then(() => {
        if (!this.pending.has(task)) return;
        return this.record(record);
      })
      .then((receipt) => {
        if (!this.pending.has(task)) return;
        if (!receipt || !Number.isSafeInteger(receipt.eventId))
          throw Error("local receiver did not return a record identity");
        clearTimeout(timer);
        const local = {
          runnerDisposition: "local-only",
          uploaded: false,
          runnerEventId: receipt.eventId,
        };
        try {
          reply({ errMsg: API + ":ok", ...local });
        } catch (error) {
          task.cancel();
          emitDebug("native-api-error", { api: API + ".callback", error });
          return;
        }
        if (!this.pending.has(task)) return;
        // Preserve the separate native invoke and onRealtimeDataResponse paths.
        // The SDK must finish associating historyLog[id] before this event arrives.
        delivery = setImmediate(() => {
          if (!this.pending.has(task)) return;
          task.cancel();
          try {
            this.publish("onRealtimeDataResponse", {
              errcode: 0,
              idList: [args.id],
              ...local,
            });
          } catch (error) {
            emitDebug("native-api-error", {
              api: "onRealtimeDataResponse",
              error,
            });
          }
        });
      })
      .catch((error) =>
        failed(String(error?.message || error), "REALTIME_RECORD_FAILED"),
      );
    return "";
  }
}

/** Shared controller cache entry. Large bodies stay in the existing artifact
 * store; don't truncate JSON before redaction (that could expose credentials). */
export function captureRealtimeData(
  record: RealtimeRecord,
  storeBody: (content: string) => string,
  storeEvent: (detail: any) => { id: number },
) {
  const { content, ...meta } = record;
  const detail =
    record.contentBytes > 8192
      ? { ...meta, contentArtifactId: storeBody(content), contentOmitted: true }
      : record;
  return { eventId: storeEvent({ ...detail, level: "info" }).id };
}
