import { managedFixture } from "./managed-test-runtime.mjs";
import { componentFixture } from "./component-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const reports = [];
let agreed = false,
  reportsSent = 0,
  queries = 0;
const server = http.createServer(async (req, res) => {
  let chunks = [];
  for await (const c of req) chunks.push(c);
  let op;
  try {
    op = JSON.parse(JSON.parse(Buffer.concat(chunks)).data);
  } catch {}
  let value;
  if (op?.api_name === "webapi_getwxauserprivacyauthinfo") {
    queries++;
    value = {
      action_code: 1,
      wording: {
        title_wording: "测试隐私",
        desc: '请阅读<a href="https://example.invalid/privacy">测试隐私指引</a>后选择',
        privacy_protocol_desc:
          '<a href="https://example.invalid/privacy">测试隐私指引</a>',
        allow_wording: "同意",
        cancel_wording: "拒绝",
      },
      need_popup_scope_list: agreed ? [] : ["jsapi_location"],
      unauth_scope_list: [],
      force_official: 0,
      api_info: {
        jsapi_list: ["getLocation"],
        outer_scope_list: ["scope.userLocation"],
      },
    };
  } else if (op?.api_name === "webapi_setwxauserprivacyauthinfo") {
    agreed = true;
    reportsSent++;
    value = {};
  }
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      ok: true,
      ret: 0,
      json: JSON.stringify(
        value ? { err_no: 0, data: JSON.stringify(value) } : { err_no: -1 },
      ),
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const payload = {
  title: "中奖率40% 中文😀",
  nestedUrl: "https://example.invalid/path?q=50%25&a=1+2",
  note: "x=y&z",
};
const encoded = encodeURIComponent(JSON.stringify(payload));
const url = "/next?pageData=" + encoded + "&literal=a+b&raw=40%&eq=a=b";
const buttons = [
  ["query", "query", "读取隐私"],
  ["require", "request", "请求授权"],
  ["reject", "reject", "拒绝"],
  ["wrong", "wrong", "错误按钮"],
  ["agree-btn", "agree", "同意"],
  ["go", "go", "带参跳转"],
];
const wxml =
  "<view>" +
  buttons
    .map(
      ([id, method, text]) =>
        `<button id="${id}" ${id === "agree-btn" ? 'open-type="agreePrivacyAuthorization" bindagreeprivacyauthorization="agree"' : `bindtap="${method}"`}>${text}</button>`,
    )
    .join("") +
  '<text id="privacy-result">{{result}}</text></view>';
const methods = `query(){wx.getPrivacySetting({success:r=>this.setData({result:'need:'+r.needAuthorization})});},request(){wx.onNeedPrivacyAuthorization(()=>{throw Error('old listener must be replaced')});wx.onNeedPrivacyAuthorization((resolve,event)=>{this.resolve=resolve;this.setData({result:'pending:'+event.referrer});});wx.requirePrivacyAuthorize({success:()=>{this.setData({result:'authorized'});globalThis.authorized=(globalThis.authorized||0)+1;},fail:r=>this.setData({result:'denied:'+r.errMsg})});},reject(){this.resolve({event:'disagree'});},wrong(){this.resolve({event:'agree',buttonId:'not-clicked'});},agree(){this.resolve({event:'agree',buttonId:'agree-btn'});},go(){wx.navigateTo({url:${JSON.stringify(url)}});}`;
try {
  for (const framework of ["exparser", "glass-easel"]) {
    agreed = false;
    reportsSent = 0;
    queries = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-privacy-nav-"));
    let t;
    try {
      const pkg = componentFixture(dir, framework, {
        leafTemplate: wxml,
        nextTemplate: '<text id="decoded">{{result}}</text>',
      });
      const sf = path.join(pkg, "app-service.js");
      let source = fs.readFileSync(sf, "utf8");
      source = source.replaceAll(
        "increase(){this.setData({count:this.data.count+1});}",
        methods,
      );
      source = source.replace(
        "Page({data:{result:'Next page'}});",
        `Page({data:{result:''},onLoad(options){globalThis.receivedOptions=options;const data=JSON.parse(decodeURIComponent(options.pageData));this.setData({result:data.title});}});`,
      );
      if (framework === "exparser") {
        const old =
          "n('button',{id:'leaf-button',bindtap:'increase'},['nested:'+value(env.label)+':'+value(env.count)])";
        const next =
          buttons
            .map(
              ([id, method, text]) =>
                `n('button',${JSON.stringify({ id, ...(id === "agree-btn" ? { openType: "agreePrivacyAuthorization", bindagreeprivacyauthorization: "agree" } : { bindtap: method }) })},[${JSON.stringify(text)}])`,
            )
            .join(",") +
          ",n('text',{id:'privacy-result'},[String(value(env.result)||'')])";
        const transform = (s) =>
          s
            .replaceAll(old, next)
            .replaceAll(
              "n('text',{},['Next page'])",
              "n('text',{id:'decoded'},[String(value(env.result)||'')])",
            );
        source = transform(source);
        const vf = path.join(pkg, "page-frame.html");
        fs.writeFileSync(vf, transform(fs.readFileSync(vf, "utf8")));
      }
      fs.writeFileSync(sf, source);
      t = await managedFixture({
        packageDir: pkg,
        config: {
          wxbot: `http://127.0.0.1:${server.address().port}`,
          deviceId: "isolated-fixture",
        },
      });
      const call = t.call;
      async function click(text) {
        await call("runner_click", { text, exact: true });
      }
      async function text(s) {
        const result = await call("runner_wait", { kind: "text", text: s });
        if (result.status !== "matched") {
          console.error(framework, s, (await call("runner_snapshot")).text);
          console.error(
            t.logs
              .filter((l) =>
                /privacyButton|reportPrivacy|buttonId|Error|授权/.test(l),
              )
              .join("")
              .slice(-4000),
          );
        }
        assert.equal(result.status, "matched");
      }
      await text("读取隐私");
      await click("读取隐私");
      await text("need:true");
      assert.equal(reportsSent, 0);
      await click("请求授权");
      await text("pending:requirePrivacyAuthorize");
      await click("拒绝");
      await text("denied:requirePrivacyAuthorize:fail");
      assert.equal(reportsSent, 0);
      await click("请求授权");
      await text("pending:requirePrivacyAuthorize");
      await click("错误按钮");
      await text("denied:requirePrivacyAuthorize:fail");
      assert.equal(reportsSent, 0);
      await click("请求授权");
      await text("pending:requirePrivacyAuthorize");
      await click("同意");
      await text("authorized");
      await click("读取隐私");
      await text("need:false");
      assert.equal(reportsSent, 1);
      assert.ok(queries > 0);
      await click("带参跳转");
      assert.equal((await call("runner_wait",{kind:"route",route:"next"})).status,"matched");
      await text(payload.title);
      const options = (
        await call("runner_evaluate", { expression: "receivedOptions" })
      ).result.value;
      assert.equal(options.pageData, encoded);
      assert.equal(options.literal, "a+b");
      assert.equal(options.raw, "40%");
      assert.equal(options.eq, "a=b");
      await call("runner_navigate", { method: "navigateBack" });
      await text("读取隐私");
      await call("runner_navigate", { method: "navigateTo", url });
      await text(payload.title);
      assert.equal(
        (
          await call("runner_evaluate", {
            expression: "receivedOptions.pageData",
          })
        ).result.value,
        encoded,
      );
      reports.push({
        framework,
        status: "验收通过",
        privacyMetadata: true,
        reject: true,
        invalidButtonRejected: true,
        explicitButtonAgreed: true,
        reportSentOnce: true,
        navigation: ["business click", "MCP"],
        preserved: [
          "JSON",
          "Chinese",
          "emoji",
          "percent",
          "plus",
          "equals",
          "nested URL",
        ],
      });
    } finally {
      await t?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(
    "docs/privacy-navigation-result.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        platform: process.platform,
        localServerOnly: true,
        reports,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(reports));
} finally {
  await new Promise((r) => server.close(r));
}
