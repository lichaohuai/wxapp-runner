import { createCanvas, type Canvas } from "@napi-rs/canvas";

/** DOM-free 2D backend for the service base library. Legacy CanvasContext
 * uses a 0x0 surface for font metrics and keeps its original view command stream.
 * Node Canvas uses the registry below to paint actual raster frames. This does
 * not advertise WebGL, transferable ImageBitmap, or full public OffscreenCanvas.
 */
export class ServiceCanvas2D {
  private canvas: Canvas;
  private w: number;
  private h: number;
  private context: any;
  constructor(
    width: number,
    height: number,
    private changed: () => void = () => {},
    private reserve: (width: number, height: number) => void = () => {},
  ) {
    this.w = dimension(width);
    this.h = dimension(height);
    checkArea(this.w, this.h);
    this.reserve(this.w, this.h);
    // Skia needs a non-empty raster even for measuring on the SDK's 0x0
    // surface. The service-facing dimensions retain the requested values.
    this.canvas = createCanvas(Math.max(1, this.w), Math.max(1, this.h));
  }
  get width() {
    return this.w;
  }
  set width(value: number) {
    const next = dimension(value);
    checkArea(next, this.h);
    this.reserve(next, this.h);
    this.canvas.width = Math.max(1, next);
    this.w = next;
    this.changed();
  }
  get height() {
    return this.h;
  }
  set height(value: number) {
    const next = dimension(value);
    checkArea(this.w, next);
    this.reserve(this.w, next);
    this.canvas.height = Math.max(1, next);
    this.h = next;
    this.changed();
  }
  getContext(type: string, options?: any) {
    if (type !== "2d") return null;
    return (this.context ||= new Proxy(this.canvas.getContext("2d", options), {
      get: (ctx, key) => {
        const value = Reflect.get(ctx, key, ctx);
        if (typeof value !== "function") return value;
        return (...args: any[]) => {
          const result = Reflect.apply(
            value,
            ctx,
            args.map((arg) =>
              arg instanceof ServiceCanvas2D ? arg.canvas : arg,
            ),
          );
          if (
            ![
              "getImageData",
              "measureText",
              "getTransform",
              "isPointInPath",
              "isPointInStroke",
            ].includes(String(key))
          )
            this.changed();
          return result;
        };
      },
      set: (ctx, key, value) => {
        const ok = Reflect.set(ctx, key, value, ctx);
        if (ok) this.changed();
        return ok;
      },
    }));
  }
  png() {
    return this.canvas.toBuffer("image/png");
  }
}

/** Equivalent ownership to the PC save/get/removeOffScreenCanvas registry.
 * A real Skia surface stays in the DOM-free service; raster frames go only to
 * its originating renderer. This is a 2D backend, not a WebGL implementation. */
export class ServiceCanvasRegistry {
  private entries = new Map<
    string,
    {
      pageId: number;
      canvas: ServiceCanvas2D;
      timer?: NodeJS.Timeout;
      sequence: number;
    }
  >();
  constructor(
    private present: (frame: any) => void,
    private maxPixels = 64 * 1024 * 1024,
  ) {}
  save(pageId: number, id: number | string, width: number, height: number) {
    const key = String(id),
      old = this.entries.get(key);
    if (old) {
      if (old.pageId !== pageId) throw Error("CANVAS_ID_AMBIGUOUS");
      return; // A repeated layout registration must not erase painted pixels.
    }
    if (this.entries.size >= 64) throw Error("CANVAS_LIMIT_EXCEEDED");
    const entry: any = { pageId, sequence: 0 };
    entry.canvas = new ServiceCanvas2D(
      width,
      height,
      () => {
        if (this.entries.get(key) !== entry || entry.timer) return;
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          if (this.entries.get(key) !== entry) return;
          this.present({
            pageId,
            canvasNumber: id,
            sequence: ++entry.sequence,
            width: entry.canvas.width,
            height: entry.canvas.height,
            png: entry.canvas.png(),
          });
        }, 16);
      },
      (width, height) => {
        let pixels = Math.max(1, width) * Math.max(1, height);
        for (const other of this.entries.values())
          if (other !== entry)
            pixels +=
              Math.max(1, other.canvas.width) *
              Math.max(1, other.canvas.height);
        if (pixels > this.maxPixels)
          throw Error("CANVAS_TOTAL_RASTER_BUDGET_EXCEEDED");
      },
    );
    this.entries.set(key, entry);
  }
  get(id: number | string) {
    const entry = this.entries.get(String(id));
    if (!entry) throw Error("CANVAS_NOT_REGISTERED: " + id);
    return entry.canvas;
  }
  remove(id: number | string, pageId?: number) {
    const key = String(id),
      entry = this.entries.get(key);
    if (!entry || (pageId !== undefined && entry.pageId !== pageId)) return;
    clearTimeout(entry.timer);
    this.entries.delete(key);
  }
  closePage(pageId: number) {
    for (const [id, entry] of this.entries)
      if (entry.pageId === pageId) this.remove(id, pageId);
  }
}

function dimension(value: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 16384)
    throw new RangeError(
      "Native 2D canvas dimension must be between 0 and 16384",
    );
  return Math.trunc(n);
}
function checkArea(width: number, height: number) {
  if (Math.max(1, width) * Math.max(1, height) > 16 * 1024 * 1024)
    throw new RangeError("Native 2D canvas exceeds 64 MiB raster budget");
}

/** Numeric frame handles, as exposed by the official browser host. The supplied
 * 3.17.3 Canvas.cancelAnimationFrame forwards its numeric handle to the request
 * port (WAServiceMainContext.js, class md); accept that observed cancel envelope
 * as well as the separate native cancel port. Never schedule a non-callable. */
export class CanvasAnimationFrames {
  private sequence = 0;
  private handles = new Map<
    number,
    { timer: NodeJS.Timeout; pageId?: number }
  >();
  constructor(private onError: (e: unknown) => void) {}
  request(callback: Function | number, pageId?: number): number | undefined {
    if (
      typeof callback === "number" &&
      Number.isSafeInteger(callback) &&
      callback >= 0
    ) {
      this.cancel(callback);
      return;
    }
    if (typeof callback !== "function")
      throw TypeError("Animation callback must be a function");
    const id = ++this.sequence;
    const timer = setTimeout(() => {
      this.handles.delete(id);
      try {
        callback(performance.now());
      } catch (e) {
        this.onError(e);
      }
    }, 16);
    this.handles.set(id, { timer, pageId });
    return id;
  }
  cancel(id: number) {
    const h = this.handles.get(id);
    if (!h) return;
    clearTimeout(h.timer);
    this.handles.delete(id);
  }
  closePage(pageId: number) {
    for (const [id, h] of this.handles)
      if (h.pageId === pageId) this.cancel(id);
  }
}
