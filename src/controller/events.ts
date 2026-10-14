import { RecordLog } from "../mcp/records";
import { redact } from "../mcp/redact";
export class EventStore {
  private log: RecordLog<any>;
  constructor(capacity = 10000) {
    this.log = new RecordLog(capacity);
  }
  push(runtimeId: string, sessionId: string, source: string, detail: any) {
    const method = detail.cdpMethod || detail.type;
    let diagnostic: any = {};
    if (method === "Runtime.exceptionThrown") {
      const exception = detail.exceptionDetails || {};
      diagnostic = {
        level: "error",
        message: exception.exception?.description || exception.text,
        stackTrace: exception.stackTrace,
        exceptionId: exception.exceptionId,
      };
    } else if (method === "Runtime.consoleAPICalled") {
      diagnostic.level =
        (
          {
            error: "error",
            assert: "error",
            warning: "warn",
            debug: "debug",
          } as any
        )[detail.type] || "info";
    } else if (method === "Log.entryAdded") {
      diagnostic = {
        level:
          ({ warning: "warn", verbose: "debug" } as any)[detail.entry?.level] ||
          detail.entry?.level,
        message: detail.entry?.text,
        stackTrace: detail.entry?.stackTrace,
      };
    }
    return this.log.push({
      ...diagnostic,
      ...detail,
      runtimeId,
      sessionId,
      source,
      time: detail.time || new Date().toISOString(),
    });
  }
  page(args: any = {}) {
    // Filter AFTER pagination: advancing through unrelated records must still advance the cursor.
    const result = this.log.page(args.after || 0, args.limit || 50);
    const entries = result.entries.filter(
      (e) =>
        (!args.contractId || (e.contractId || e.args?.[0]?.contractId) === args.contractId) &&
        (!args.callId || (e.callId || e.args?.[0]?.callId) === args.callId) &&
        (args.contextId === undefined || e.context?.contextId === args.contextId) &&
        (args.workerId === undefined || e.context?.workerId === args.workerId) &&
        (!args.runtimeId || e.runtimeId === args.runtimeId) &&
        (!args.sessionId || e.sessionId === args.sessionId) &&
        (!args.source || e.source === args.source) &&
        (!args.level || e.level === args.level) &&
        (!args.operationId ||
          [
            e.operationId,
            e.context?.operationId,
            e.context?.rootOperationId,
          ].includes(args.operationId)),
    );
    const output = { ...result, entries };
    return args.revealSensitive ? output : redact(output);
  }
}
