import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { ServiceCanvas2D } from "../src/native-components/service-canvas";

test("service 2D metrics use real fonts in a DOM-free realm", () => {
  const realm = vm.createContext({
    NativeGlobal: { OffscreenCanvas: ServiceCanvas2D },
  });
  const result = vm.runInContext(
    `(()=>{
    const surface=new NativeGlobal.OffscreenCanvas(0,0), c=surface.getContext('2d');
    c.font='16px sans-serif';const narrow=c.measureText('iiii').width,wide=c.measureText('WWWW').width;
    c.font='32px sans-serif';return {document:typeof document,width:surface.width,height:surface.height,narrow,wide,large:c.measureText('WWWW').width,chinese:c.measureText('中文🙂').width,webgl:surface.getContext('webgl')};
  })()`,
    realm,
  );
  assert.equal(result.document, "undefined");
  assert.equal(result.width, 0);
  assert.equal(result.height, 0);
  assert.ok(result.wide > result.narrow * 2);
  assert.ok(Math.abs(result.large - 2 * result.wide) < 0.1);
  assert.ok(result.chinese > 0);
  assert.equal(result.webgl, null);
});

test("service canvas has real 2D pixels and bounded allocations", () => {
  const canvas = new ServiceCanvas2D(4, 4),
    ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 2, 2);
  assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [255, 0, 0, 255]);
  assert.throws(() => {
    canvas.width = 17000;
  }, /dimension/);
  assert.equal(canvas.width, 4);
  assert.throws(() => new ServiceCanvas2D(10000, 10000), /budget/);
  canvas.width = 4;
  assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [0, 0, 0, 0]);
});

test("node canvas registry presents real rasters, rejects cross-page ID collisions and stops old frames after destruction", async () => {
  const { ServiceCanvasRegistry } =
    await import("../src/native-components/service-canvas");
  let resolve!: (v: any) => void;
  const frame = new Promise<any>((r) => (resolve = r)),
    frames: any[] = [];
  const registry = new ServiceCanvasRegistry((f) => {
    frames.push(f);
    resolve(f);
  });
  registry.save(1, 42, 80, 40);
  const c = registry.get(42),
    ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 40, 40);
  registry.save(1, 42, 80, 40);
  assert.equal(registry.get(42), c);
  assert.throws(() => registry.save(2, 42, 80, 40), /AMBIGUOUS/);
  const actual = await frame;
  assert.equal(actual.pageId, 1);
  assert.equal(actual.canvasNumber, 42);
  assert.equal(actual.png.subarray(1, 4).toString(), "PNG");
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(0, 0, 40, 40);
  registry.closePage(1);
  assert.throws(() => registry.get(42), /NOT_REGISTERED/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(frames.length, 1);
  registry.save(2, 42, 20, 20);
  assert.notEqual(registry.get(42), c);
  registry.closePage(2);
});

test("native canvas frame handles are numeric; both cancellation ports cancel without scheduling an invalid callback", async () => {
  const { CanvasAnimationFrames } =
    await import("../src/native-components/service-canvas");
  const errors: any[] = [];
  let calls = 0;
  const frames = new CanvasAnimationFrames((e) => errors.push(e));
  const id = frames.request(() => calls++, 1)!;
  assert.equal(typeof id, "number");
  frames.request(id);
  const id2 = frames.request(() => calls++, 1)!;
  frames.cancel(id2);
  frames.request(() => calls++, 2);
  frames.closePage(2);
  assert.throws(() => frames.request({} as any), /must be a function/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);
  assert.equal(errors.length, 0);
});

test("aggregate node canvas budget is checked before allocating or resizing a raster", async () => {
  const { ServiceCanvasRegistry } =
    await import("../src/native-components/service-canvas");
  const registry = new ServiceCanvasRegistry(() => {}, 100);
  registry.save(1, 1, 10, 10);
  assert.throws(() => registry.save(2, 2, 1, 1), /TOTAL_RASTER_BUDGET/);
  assert.throws(() => {
    registry.get(1).width = 11;
  }, /TOTAL_RASTER_BUDGET/);
  assert.equal(registry.get(1).width, 10);
  registry.closePage(1);
  registry.save(2, 2, 10, 10);
  registry.closePage(2);
});
