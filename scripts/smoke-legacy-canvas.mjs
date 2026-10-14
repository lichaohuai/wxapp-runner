import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-canvas-"));
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const service = path.join(pkg, "app-service.js"),
  view = path.join(pkg, "page-frame.html");
fs.writeFileSync(
  service,
  fs.readFileSync(service, "utf8").replace(
    "onInput(e){",
    `
 draw(){
   wx.showToast({title:'drawing',duration:60000,mask:true});
   const ctx=wx.createCanvasContext('curve');ctx.setFontSize(16);
   const narrow=ctx.measureText('iiii').width,wide=ctx.measureText('WWWW').width;
   this.metrics={narrow,wide,document:typeof document};
   ctx.setFillStyle('#ff0000');ctx.fillRect(0,0,40,40);
   ctx.setStrokeStyle('#0000ff');ctx.setLineWidth(4);ctx.beginPath();ctx.moveTo(50,50);ctx.lineTo(180,50);ctx.stroke();
   ctx.draw(false,()=>{
     this.drawCallbacks=(this.drawCallbacks||0)+1;
     wx.hideToast({success:()=>{this.hideCallbacks=(this.hideCallbacks||0)+1;this.setData({result:'canvas-drawn'})}});
   });
 },
 onInput(e){`,
  ),
);
fs.writeFileSync(
  view,
  fs
    .readFileSync(view, "utf8")
    .replace(
      "n('textarea',{id:'entry'",
      `n('canvas',{canvasId:'curve',id:'curve',style:'width:200px;height:100px'},[]),n('button',{id:'draw',bindtap:'draw'},['画曲线']),n('textarea',{id:'entry'`,
    ),
);
let t;
try {
  t = await managedFixture({ packageDir: pkg });
  await t.call("runner_wait", { kind: "text", text: "画曲线" });
  await t.call("runner_click", { text: "画曲线", exact: true });
  assert.equal(
    (await t.call("runner_wait", { kind: "text", text: "canvas-drawn" }))
      .status,
    "matched",
  );
  assert.equal(
    (
      await t.call("runner_wait", {
        kind: "hidden",
        selector: '[role="status"]',
      })
    ).status,
    "matched",
  );
  const result = await t.call("runner_evaluate", {
    expression: `(()=>{const p=getCurrentPages()[0];return {...p.metrics,drawCallbacks:p.drawCallbacks,hideCallbacks:p.hideCallbacks}})()`,
  });
  assert.ok(!result.exceptionDetails, JSON.stringify(result));
  assert.equal(result.result.value.drawCallbacks, 1);
  assert.equal(result.result.value.hideCallbacks, 1);
  assert.equal(result.result.value.document, "undefined");
  assert.ok(result.result.value.wide > result.result.value.narrow * 2);
  const targetId = `page:${(await t.call("runner_status")).current.id}`;
  const pixels = (
    await t.call("runner_evaluate", {
      targetId,
      expression: `(()=>{
   const c=document.querySelector('wx-canvas canvas'),ctx=c.getContext('2d'),sx=c.width/200,sy=c.height/100;return {red:Array.from(ctx.getImageData(10*sx,10*sy,1,1).data),blue:Array.from(ctx.getImageData(80*sx,50*sy,1,1).data)};
 })()`,
    })
  ).result.value;
  assert.deepEqual(pixels.red, [255, 0, 0, 255]);
  assert.deepEqual(pixels.blue, [0, 0, 255, 255]);
  let after = 0,
    errors = [];
  for (;;) {
    const r = await t.call("runner_logs", {
      after,
      level: "error",
      limit: 200,
    });
    errors.push(...r.entries);
    after = r.nextCursor;
    if (!r.hasMore) break;
  }
  assert.ok(
    !/OffscreenCanvas|FLOW_|hideToast:fail/.test(JSON.stringify(errors)),
  );
  const report = {
    passed: true,
    date: new Date().toISOString(),
    platform: process.platform,
    realBaseLibrary: true,
    realPixelReadback: true,
    logicalLayerWithoutDOM: true,
    realFontMetrics: true,
    drawCallbackOnce: true,
    hideToastCallbackOnce: true,
    overlayRemoved: true,
  };
  fs.writeFileSync(
    "docs/legacy-canvas-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (e) {
  if (t) {
    fs.writeFileSync(
      ".local/random-cycle-20260912/canvas-smoke-failed.log",
      t.logs.join(""),
    );
    const status = await t.call("runner_status");
    const diagnostics = await t.call("runner_evaluate", {
      targetId: `page:${status.current.id}`,
      expression: `({html:document.body.innerHTML,route:__wxRoute})`,
    });
    fs.writeFileSync(
      ".local/random-cycle-20260912/canvas-dom.json",
      JSON.stringify(diagnostics),
    );
  }
  throw e;
} finally {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
