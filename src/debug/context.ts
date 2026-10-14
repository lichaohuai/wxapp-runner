import { AsyncLocalStorage } from "node:async_hooks";
export const debugContext = new AsyncLocalStorage<Record<string, any>>();
let sink: ((event: any) => void) | undefined;
export function setDebugEmitter(emit: (event: any) => void) {
  sink = emit;
}
export function emitDebug(type: string, detail: any = {}) {
  try {
    sink?.({
      type,
      time: new Date().toISOString(),
      ...copyDebug(detail).value,
      context: debugContext.getStore() || null,
    });
  } catch {}
}
let sequence = 0;
export function traceContext(fields: Record<string, any>) {
  const parent = debugContext.getStore();
  const operationId = `op-${++sequence}`;
  return {
    ...parent,
    parentOperationId: parent?.operationId,
    operationId,
    rootOperationId: parent?.rootOperationId || operationId,
    rootHandler: parent?.rootHandler || fields.handler || null,
    ...fields,
  };
}
/** Bounded copies only: never pass live business objects to IPC or modify them. */
export function copyDebug(value: any, limit = 256 * 1024) {
  let size = 0,
    truncated = false;
  const seen = new WeakSet<object>();
  function visit(v: any, depth: number): any {
    if (size > limit || depth > 20) {
      truncated = true;
      return "[Truncated]";
    }
    if (v == null || typeof v === "boolean" || typeof v === "number") {
      size += 8;
      return v;
    }
    if (typeof v === "string") {
      const bytes = Buffer.from(v);
      const remaining = Math.max(0, limit - size);
      size += bytes.length;
      if (bytes.length > remaining) {
        truncated = true;
        return (
          new TextDecoder().decode(bytes.subarray(0, remaining), {
            stream: true,
          }) + "[Truncated]"
        );
      }
      return v;
    }
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (typeof v !== "object") return String(v);
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (typeof v.message === "string" && typeof v.stack === "string")
      return {
        name: v.name,
        message: visit(v.message, depth + 1),
        stack: visit(v.stack, depth + 1),
        cause: visit(v.cause, depth + 1),
      };
    const entries = Object.entries(v);
    const output: any = Array.isArray(v) ? [] : {};
    for (const [key, val] of entries.slice(0, 2000)) {
      if (size > limit) {
        truncated = true;
        break;
      }
      size += key.length;
      Object.defineProperty(output, key, {
        value: visit(val, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (entries.length > 2000) truncated = true;
    seen.delete(v);
    return output;
  }
  return { value: visit(value, 0), truncated, byteLimit: limit };
}
