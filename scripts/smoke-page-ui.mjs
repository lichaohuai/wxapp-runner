import { managedFixture, until } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
const output = path.resolve(".local/page-ui");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-page-ui-"));
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const service = path.join(pkg, "app-service.js"),
  frame = path.join(pkg, "page-frame.html");
fs.writeFileSync(
  service,
  fs.readFileSync(service, "utf8").replace(
    "onInput(e){",
    `async colors(){
 const results=[];
 const invoke=(name,args={})=>new Promise((resolve,reject)=>wx[name]({...args,success:r=>{results.push(r.errMsg);resolve(r)},fail:reject}));
 await invoke('setNavigationBarColor',{frontColor:'#ffffff',backgroundColor:'#123456'});
 await invoke('setNavigationBarTitle',{title:'导航测试'});
 await invoke('showNavigationBarLoading');
 await invoke('showShareMenu',{withShareTicket:true,menus:['shareAppMessage','shareTimeline']});
 await invoke('hideShareMenu',{menus:['shareAppMessage']});
 await invoke('updateShareMenu',{withShareTicket:false});
 await invoke('setBackgroundFetchToken',{token:'fixture-token'});
 const token=await invoke('getBackgroundFetchToken');if(token.token!=='fixture-token')throw Error('token registration mismatch');
 this.results=results; this.setData({result:'page-ui-done'});
 },onInput(e){`,
  ),
);
fs.writeFileSync(
  frame,
  fs
    .readFileSync(frame, "utf8")
    .replace(
      "n('textarea',{id:'entry'",
      "n('button',{id:'colors',bindtap:'colors'},['修改导航']),n('textarea',{id:'entry'",
    ),
);
let t;
try {
  t = await managedFixture({ packageDir: pkg });
  await t.call("runner_wait", { kind: "text", text: "修改导航" });
  await t.call("runner_click", { text: "修改导航", exact: true });
  await t.call("runner_wait", { kind: "text", text: "page-ui-done" });
  const s = await t.call("runner_status");
  assert.equal(
    s.current.pageUi.navigationBar.navigationBarBackgroundColor,
    "#123456",
  );
  assert.equal(s.current.pageUi.navigationBar.navigationBarTextStyle, "white");
  assert.equal(
    s.current.pageUi.navigationBar.navigationBarTitleText,
    "导航测试",
  );
  assert.equal(s.current.pageUi.navigationBar.showLoading, true);
  assert.deepEqual(s.current.pageUi.share, {
    showShareMenu: false,
    showShareTimelineMenu: false,
    withShareTicket: false,
  });
  const result = await t.call("runner_evaluate", {
    expression: "getCurrentPages()[0].results",
  });
  assert.equal(result.result.value.length, 8);
  const header = await t.call("runner_dom", {
    target: "shell",
    selector: "header",
    computedStyles: ["background-color", "color", "display"],
  });
  assert.equal(header.styles["background-color"], "rgb(18, 52, 86)");
  assert.equal(header.styles.color, "rgb(255, 255, 255)");
  assert.equal(header.styles.display, "flex");
  await until(async () => {
    const shot = await t.client.callTool({
      name: "runner_screenshot",
      arguments: { target: "shell" },
    });
    const data = shot.content.find((c) => c.type === "image")?.data;
    if (!data) return false;
    const png = PNG.sync.read(Buffer.from(data, "base64")),
      pixel = Array.from(
        png.data.subarray(
          (4 * png.width + 20) * 4,
          (4 * png.width + 20) * 4 + 4,
        ),
      );
    // capturePage uses the monitor profile on macOS; CSS is checked exactly
    // above, while the displayed raster allows bounded wide-gamut conversion.
    if (
      pixel[3] !== 255 ||
      [18, 52, 86].some((v, i) => Math.abs(v - pixel[i]) > 16)
    )
      return false;
    fs.writeFileSync(
      path.join(output, "header.png"),
      Buffer.from(data, "base64"),
    );
    return true;
  });
  const id = s.current.id;
  await t.call("runner_navigate", { method: "navigateTo", url: "/next" });
  await until(
    async () => (await t.call("runner_status")).current?.route === "next",
  );
  assert.equal(
    (await t.call("runner_status")).current.pageUi.navigationBar.showLoading,
    false,
  );
  await t.call("runner_navigate", { method: "navigateBack" });
  assert.equal((await t.call("runner_status")).current.id, id);
  assert.equal(
    (await t.call("runner_status")).current.pageUi.navigationBar
      .navigationBarBackgroundColor,
    "#123456",
  );
  const r = await t.call("runner_evaluate", {
    awaitPromise: true,
    expression:
      "new Promise((resolve,reject)=>wx.hideNavigationBarLoading({success:resolve,fail:reject}))",
  });
  assert.ok(!r.exceptionDetails, JSON.stringify(r));
  assert.equal(
    (await t.call("runner_status")).current.pageUi.navigationBar.showLoading,
    false,
  );
  console.log(
    JSON.stringify({
      passed: true,
      date: new Date().toISOString(),
      originalSdk: true,
      realClick: true,
      headerPixelReadback: true,
      navigationStateRestored: true,
      apiCallbacks: 8,
    }),
  );
} catch (e) {
  if (t) {
    fs.writeFileSync(path.join(output, "failed.log"), t.logs.join(""));
    console.error(e.message);
  }
  throw e;
} finally {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
