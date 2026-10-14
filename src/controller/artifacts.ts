import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "../mcp/redact";
export type Artifact = {
  id: string;
  runtimeId: string;
  sessionId: string;
  kind: string;
  mimeType?: string;
  representation?: string;
  charset?: string;
  file: string;
  fd?: number;
  bytes: number;
  observedBytes: number;
  truncated: boolean;
  complete: boolean;
  evicted: boolean;
  createdAt: string;
  accessed: number;
  error?: string;
};
/** File-backed, bounded copies. Reading never removes or consumes another client's data. */
export class ArtifactStore {
  private items = new Map<string, Artifact>();
  private total = 0;
  constructor(
    private root: string,
    readonly bodyLimit = 64 * 1024 ** 2,
    readonly totalLimit = 512 * 1024 ** 2,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  create(
    meta: Pick<Artifact, "runtimeId" | "sessionId" | "kind"> &
      Partial<Artifact>,
  ) {
    const id = randomUUID();
    const file = path.join(this.root, id + ".bin");
    const item: Artifact = {
      ...meta,
      id,
      file,
      fd: fs.openSync(file, "wx", 0o600),
      bytes: 0,
      observedBytes: 0,
      complete: false,
      truncated: false,
      evicted: false,
      createdAt: new Date().toISOString(),
      accessed: Date.now(),
    };
    this.items.set(id, item);
    if (this.items.size > 20000)
      for (const old of this.items.values()) {
        if (old.complete) {
          if (!old.evicted) this.evict(old);
          this.items.delete(old.id);
          if (this.items.size <= 20000) break;
        }
      }
    return id;
  }
  append(id: string, input: Uint8Array) {
    const item = this.get(id);
    item.observedBytes += input.byteLength;
    if (item.complete) throw Error("Artifact is already complete");
    if (item.evicted || item.fd === undefined) {
      item.truncated = true;
      return this.info(id);
    }
    const limit = item.kind === "body" ? this.bodyLimit : this.totalLimit;
    let available = Math.min(input.byteLength, limit - item.bytes);
    for (const candidate of [...this.items.values()]
      .filter((a) => a.id !== id && !a.evicted && a.complete)
      .sort((a, b) => a.accessed - b.accessed)) {
      if (this.total + available <= this.totalLimit) break;
      this.evict(candidate);
    }
    available = Math.max(0, Math.min(available, this.totalLimit - this.total));
    if (available < input.byteLength) item.truncated = true;
    if (available) {
      fs.writeSync(item.fd, input.subarray(0, available));
      item.bytes += available;
      this.total += available;
    }
    return this.info(id);
  }
  finish(id: string, meta: Partial<Artifact> = {}) {
    const item = this.get(id);
    if (item.fd !== undefined) fs.closeSync(item.fd);
    item.fd = undefined;
    item.complete = true;
    for (const key of [
      "mimeType",
      "charset",
      "representation",
      "error",
    ] as const)
      if (meta[key] !== undefined) item[key] = meta[key];
    return this.info(id);
  }
  put(
    meta: Pick<Artifact, "runtimeId" | "sessionId" | "kind"> &
      Partial<Artifact>,
    value: Uint8Array,
  ) {
    const id = this.create(meta);
    this.append(id, value);
    this.finish(id);
    return id;
  }
  get(id: string) {
    const item = this.items.get(id);
    if (!item) throw Error("Artifact not found or metadata evicted");
    return item;
  }
  info(id: string) {
    const { file, fd, accessed, ...meta } = this.get(id);
    return meta;
  }
  list(runtimeId?: string, sessionId?: string) {
    return [...this.items.values()]
      .filter(
        (a) =>
          (!runtimeId || runtimeId === a.runtimeId) &&
          (!sessionId || sessionId === a.sessionId),
      )
      .map((a) => this.info(a.id));
  }
  bytes(id: string) {
    const item = this.get(id);
    if (item.evicted)
      throw Error("Artifact body was evicted; metadata remains available");
    item.accessed = Date.now();
    return fs.readFileSync(item.file);
  }
  preview(id: string, length: number) {
    const item = this.get(id);
    if (item.evicted) throw Error("Artifact body was evicted");
    const fd = fs.openSync(item.file, "r");
    try {
      const bytes = Buffer.alloc(Math.min(item.bytes, length));
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return bytes.subarray(0, size);
    } finally {
      fs.closeSync(fd);
    }
  }
  private text(item: Artifact) {
    return (
      (["body", "har"].includes(item.kind) ||
        (item.kind === "native-contract-ledger" && item.representation === "metadata-only") ||
        (item.kind === "execution-report" &&
          item.representation === "redacted")) &&
      /json|text\/|xml|javascript|x-www-form-urlencoded/i.test(
        item.mimeType || "",
      ) &&
      item.representation !== "transfer-encoded"
    );
  }
  read(id: string, offset = 0, length = 262144, revealSensitive = false) {
    const item = this.get(id);
    if (!this.text(item) && !revealSensitive)
      return {
        ...this.info(id),
        requiresExplicitRawAccess: true,
        reason:
          "Binary, compressed and analysis artifacts cannot be reliably redacted; use revealSensitive explicitly",
      };
    let bytes = this.bytes(id);
    if (!revealSensitive) {
      const text = new TextDecoder(item.charset || "utf-8").decode(bytes);
      let value: any = text;
      try {
        value = JSON.parse(text);
      } catch {}
      const safe = redact(value);
      bytes = Buffer.from(
        typeof safe === "string" ? safe : JSON.stringify(safe),
      );
    }
    const end = Math.min(bytes.length, offset + length);
    return {
      ...this.info(id),
      encoding: "base64",
      data: bytes.subarray(offset, end).toString("base64"),
      offset,
      nextOffset: end,
      hasMore: end < bytes.length,
      redacted: !revealSensitive,
      readableBytes: bytes.length,
    };
  }
  export(id: string, destination: string, revealSensitive = false) {
    if (!path.isAbsolute(destination))
      throw Error("Export destination must be an absolute path");
    const item = this.get(id);
    if (!item.complete || item.truncated || item.evicted || item.error)
      throw Error(
        "Incomplete, failed, truncated or evicted artifact cannot be exported as complete",
      );
    if (!this.text(item) && !revealSensitive)
      throw Error("Binary/analysis export requires revealSensitive:true");
    const fd = fs.openSync(destination, "wx", 0o600);
    try {
      if (revealSensitive) {
        const input = fs.openSync(item.file, "r");
        const buffer = Buffer.alloc(262144);
        try {
          for (;;) {
            const count = fs.readSync(input, buffer);
            if (!count) break;
            fs.writeSync(fd, buffer.subarray(0, count));
          }
        } finally {
          fs.closeSync(input);
        }
      } else {
        const result: any = this.read(id, 0, Number.MAX_SAFE_INTEGER, false);
        fs.writeSync(fd, Buffer.from(result.data!, "base64"));
      }
    } finally {
      fs.closeSync(fd);
    }
    return { id, destination, exported: true, redacted: !revealSensitive };
  }
  private evict(item: Artifact) {
    if (item.fd !== undefined) fs.closeSync(item.fd);
    item.fd = undefined;
    this.total -= item.bytes;
    item.evicted = true;
    try {
      fs.unlinkSync(item.file);
    } catch {}
  }
  closeSession(sessionId: string) {
    for (const item of this.items.values())
      if (item.sessionId === sessionId && !item.evicted) this.evict(item);
  }
  close() {
    for (const item of this.items.values()) if (!item.evicted) this.evict(item);
  }
}
