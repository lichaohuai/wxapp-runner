import { managedFixture } from "./managed-test-runtime.mjs";
import { componentFixture } from "./component-fixture.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const records = Array.from({ length: 80 }, (_, i) => ({
  name: "记录" + i,
  description: "中文😀".repeat(4000),
}));
const server = http.createServer((req, res) =>
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(records)),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/records`;
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  status: "验收通过",
  frameworks: [],
};
try {
  for (const framework of ["exparser", "glass-easel"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxapp-realm-"));
    let t;
    try {
      const pkg = componentFixture(dir, framework, {
        leafTemplate:
          '<view><button id="leaf-button" bindtap="increase">nested:{{label}}:{{count}}</button><view wx:for="{{records}}" wx:key="name">{{item.name}}</view></view>',
      });
      const service = path.join(pkg, "app-service.js");
      let source = fs
        .readFileSync(service, "utf8")
        .replaceAll(
          "increase(){this.setData({count:this.data.count+1});}",
          `increase(){wx.request({url:${JSON.stringify(url)},success:r=>{this.setData({records:r.data,count:this.data.count+1});wx.setStorageSync('records',r.data);globalThis.__realmRecords={array:r.data instanceof Array,object:r.data[0] instanceof Object,storage:wx.getStorageSync('records') instanceof Array,length:r.data.length,last:r.data[79].description.length};}});}`,
        );
      if (framework === "exparser") {
        const old = "['nested:'+value(env.label)+':'+value(env.count)])]";
        const next =
          "['nested:'+value(env.label)+':'+value(env.count)]),...(value(env.records)||[]).map(item=>n('view',{},[value(item).name]))]";
        assert.ok(source.includes(old));
        source = source.replaceAll(old, next);
        const file = path.join(pkg, "page-frame.html");
        fs.writeFileSync(
          file,
          fs.readFileSync(file, "utf8").replaceAll(old, next),
        );
      }
      fs.writeFileSync(service, source);
      t = await managedFixture({ packageDir: pkg });
      await t.call("runner_wait", { kind: "text", text: "nested:child:1" });
      await t.call("runner_click", { text: "nested:child:1" });
      assert.equal(
        (await t.call("runner_wait", { kind: "text", text: "记录79" })).status,
        "matched",
      );
      const v = (
        await t.call("runner_evaluate", {
          expression: "globalThis.__realmRecords",
        })
      ).result.value;
      assert.deepEqual(v, {
        array: true,
        object: true,
        storage: true,
        length: 80,
        last: 16000,
      });
      const page = t.app.windows().find((p) => p.url().includes("/page/"));
      report.frameworks.push({
        framework,
        records: 80,
        lastRowRendered: true,
        jsonBytes: Buffer.byteLength(JSON.stringify(records)),
        dataNotLimitedByDebugPreview: true,
        realmArray: true,
        storageArray: true,
      });
    } finally {
      await t?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(
    "docs/realm-arrays-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await new Promise((r) => server.close(r));
}
