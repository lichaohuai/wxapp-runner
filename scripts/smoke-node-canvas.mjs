import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const output = path.resolve(".local/node-canvas");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-node-canvas-")),
  pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const framework = process.argv[2] || "exparser";
const configPath = path.join(pkg, "app-config.json"),
  appConfig = JSON.parse(fs.readFileSync(configPath));
appConfig.componentFramework = { default: framework };
fs.writeFileSync(configPath, JSON.stringify(appConfig));
const service = path.join(pkg, "app-service.js"),
  frame = path.join(pkg, "page-frame.html");
fs.writeFileSync(
  service,
  fs.readFileSync(service, "utf8").replace(
    "onInput(e){",
    `drawNode(){
 wx.createSelectorQuery().select('#node-canvas').fields({node:true,size:true}).exec(results=>{
  const c=results[0].node; c.width=120;c.height=80;const ctx=c.getContext('2d');
  ctx.fillStyle='#ff0000';ctx.fillRect(0,0,40,40);ctx.fillStyle='#0000ff';ctx.fillRect(40,0,40,40);
  const frame=c.requestAnimationFrame(()=>{this.cancelledFrameRan=true});c.cancelAnimationFrame(frame);
  this.canvasResult={frameType:typeof frame,document:typeof document,pixels:Array.from(ctx.getImageData(10,10,1,1).data),width:c.width,height:c.height};
  this.setData({result:'node-canvas-painted'});
 });
},onInput(e){`,
  ),
);
fs.writeFileSync(
  frame,
  fs
    .readFileSync(frame, "utf8")
    .replace(
      "n('textarea',{id:'entry'",
      "n('canvas',{id:'node-canvas',type:'2d',style:'width:120px;height:80px'},[]),n('button',{id:'draw-node',bindtap:'drawNode'},['绘制节点画布']),n('textarea',{id:'entry'",
    ),
);
let t;
try {
  t = await managedFixture({ packageDir: pkg });
  await t.call("runner_wait", { kind: "text", text: "绘制节点画布" });
  await t.call("runner_click", { text: "绘制节点画布", exact: true });
  const w = await t.call("runner_wait", {
    kind: "text",
    text: "node-canvas-painted",
  });
  assert.equal(w.status, "matched", JSON.stringify(w));
  const r = await t.call("runner_evaluate", {
    expression: "getCurrentPages()[0].canvasResult",
  });
  assert.deepEqual(r.result.value, {
    frameType: "number",
    document: "undefined",
    pixels: [255, 0, 0, 255],
    width: 120,
    height: 80,
  });
  const targetId = `page:${(await t.call("runner_status")).current.id}`;
  const pixels = await until(async () => {
    const r = await t.call("runner_evaluate", {
      targetId,
      expression: `(()=>{const c=document.querySelector('wx-canvas canvas'),ctx=c.getContext('2d');return {red:Array.from(ctx.getImageData(10,10,1,1).data),blue:Array.from(ctx.getImageData(50,10,1,1).data)}})()`,
    });
    return (
      r.result?.value?.red[0] === 255 &&
      r.result.value.blue[2] === 255 &&
      r.result.value
    );
  });
  assert.equal(
    (
      await t.call("runner_evaluate", {
        expression: "!!getCurrentPages()[0].cancelledFrameRan",
      })
    ).result.value,
    false,
  );
  assert.deepEqual(pixels, { red: [255, 0, 0, 255], blue: [0, 0, 255, 255] });
  await t.call("runner_navigate", { method: "navigateTo", url: "/next" });
  await t.call("runner_navigate", { method: "navigateBack" });
  console.log(
    JSON.stringify({
      passed: true,
      date: new Date().toISOString(),
      framework,
      realCanvasNode: true,
      logicNoDom: true,
      serviceReadback: true,
      viewPixelReadback: true,
    }),
  );
} catch (e) {
  if (t) {
    fs.writeFileSync(path.join(output, "failed.log"), t.logs.join(""));
    const r = await t.call("runner_logs", { level: "error", limit: 10 });
    fs.writeFileSync(path.join(output, "errors.json"), JSON.stringify(r));
  }
  throw e;
} finally {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
