import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { managedFixture } from "./managed-test-runtime.mjs";
import { interactionFixture } from "./interaction-fixture.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-manager-"));
const pkg = interactionFixture(dir, "http://127.0.0.1:1/unused");
const file = path.join(pkg, "app-service.js");
fs.writeFileSync(file, fs.readFileSync(file, "utf8")
  .replace("App({});", `App({onLaunch(){this.launchCount=1;wx.getLogManager({level:1}).log('launch',{nested:{value:1}});this.launched=true;},onError(){this.errorCount=(this.errorCount||0)+1;wx.getLogManager().warn('app error');}});`)
  .replace("Page({data:", `Page({onLoad(){const l=wx.getLogManager();l.info('info');l.debug('debug');this.setData({result:getApp().launched?'Logger ready':'Launch interrupted'});},data:`));
let t;
try {
  t = await managedFixture({ packageDir: pkg });
  const wait = await t.call("runner_wait", {kind:"text",text:"Logger ready"});
  assert.equal(wait.status,"matched");
  const result = await t.call("runner_evaluate", {expression:`(()=>{const a=getApp();a.onError('fixture handled error');return {launched:a.launched,launches:a.launchCount,errors:a.errorCount,methods:['log','info','debug','warn'].every(k=>typeof wx.getLogManager()[k]==='function')};})()`});
  assert.equal(result.exceptionDetails,undefined);
  assert.deepEqual(result.result.value,{launched:true,launches:1,errors:1,methods:true});
  assert.ok(!t.logs.join('').includes('UNIMPLEMENTED: wx.getLogManager'));
  const report={date:new Date().toISOString(),platform:process.platform,status:"验收通过",originalBaselib:true,appLaunchCompleted:true,visiblePage:true,appErrorReporterCompletedOnce:true};
  fs.writeFileSync("docs/log-manager-result.json",JSON.stringify(report,null,2)+"\n");
  console.log(report);
} finally {await t?.close();fs.rmSync(dir,{recursive:true,force:true});}
