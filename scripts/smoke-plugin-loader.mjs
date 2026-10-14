import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { managedFixture, until } from "./managed-test-runtime.mjs";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runner-bundled-plugin-"));
const provider = process.env.WXAPP_TEST_APPID || (() => {
    throw new Error("Set WXAPP_TEST_APPID to the AppID for your authorized test package");
  })(),
  prefix = `plugin-private://${provider}/`;
const privateProvider = process.env.WXAPP_TEST_APPID_2 || (() => {
  throw new Error("Set WXAPP_TEST_APPID_2 to the AppID for your authorized test package");
})();
// JS-facing plugins can carry private templates without exporting any public
// components. The compiler still merges their frame into webview.app.js.
const privateTemplate = `__wxAppCode__['plugin-private://${privateProvider}/internal.wxml']=function(){return {tag:'wx-page',children:[]}};`;
const privateFactory = `definePlugin('plugin://${privateProvider}',function(define,require,module,exports,global,wx){module.exports=()=>({host:()=>wx.getAppBaseInfo().host});});`;
const mapping = JSON.stringify({
  [`plugin://${provider}/counter`]: prefix + "card",
  [`plugin://${provider}/public-detail`]: prefix + "detail"
});
const hostConfig = `__wxAppCode__['home.json']={usingComponents:{counter:'plugin://${provider}/counter'}};`;
const pluginConfig = `global.__wxAppCode__['${prefix}card.json']={component:true,usingComponents:{}};global.__wxAppCode__['${prefix}plugin.json']={main:'index.js',pages:{'public-detail':'detail'},publicComponents:{counter:'card'}};`;
const template = `function template(kind){globalThis.__wxml_comp_version__=0.02;return function(env,dd){env=globalThis.__mergeData__?globalThis.__mergeData__(env,dd):env;function v(x){return x&&typeof x==='object'&&'__value__'in x?v(x.__value__):x}function n(tag,attr,children){return{tag:'wx-'+tag,attr:attr||{},children:children||[],n:[],raw:{},generics:{}}}return{tag:'wx-page',children:kind==='home'?[n('counter',{id:'counter'},[]),n('button',{bindtap:'openPlugin'},['open-plugin-page'])]:kind==='detail'?[n('text',{},['plugin-page:'+v(env.value)])]:[n('button',{id:'increase',bindtap:'increase'},['plugin-count:'+v(env.count)])]}}};`;
const factory = `definePlugin('plugin://${provider}',function(define,require,module,exports,global,wx,App,Page,Component,Behavior,getApp,getCurrentPages,console,requireMiniProgram){
 ${pluginConfig}
 ${template}
 global.__wxAppCode__['${prefix}card.wxml']=template('card');
 global.__wxAppCode__['${prefix}detail.wxml']=template('detail');
 global.__wxRoute='${prefix}detail';global.__wxRouteBegin=true;global.__wxAppCurrentFile__='${prefix}detail.js';
 define('detail.js',function(require,module,exports){Page({data:{value:''},onLoad(q){this.setData({value:q.value})}})});require('detail.js');
 let loads=1,taps=0,attached=0,detached=0;
 global.__wxRouteBegin=true;global.__wxAppCurrentFile__='${prefix}card.js';
 define('card.js',function(require,module,exports){Component({data:{count:0},lifetimes:{attached(){attached++},detached(){detached++}},methods:{increase(){taps++;this.setData({count:this.data.count+1})}}});});require('card.js');
 define('index.js',function(require,module,exports){
  const fm=wx.getFileSystemManager(),dir=wx.env.USER_DATA_PATH;
  module.exports={counts:()=>({loads,taps,attached,detached}),
   hideToast:()=>new Promise((resolve,reject)=>wx.hideToast({success:resolve,fail:reject})),
   hostSnapshot:()=>({env:dir,stored:wx.getStorageSync('fixture'),text:fm.readFileSync(dir+'/fixture.txt','utf8'),binary:Array.from(new Uint8Array(fm.readFileSync(dir+'/fixture.bin'))),asset:fm.readFileSync('asset.txt','utf8')}),
   async hostCheck(){
    const counts={success:0,fail:0,complete:0};
    const call=(api,args,fail=false)=>new Promise((resolve,reject)=>api({...args,success(r){counts.success++;fail?reject(Error('unexpected success')):0},fail(r){counts.fail++;fail?0:reject(Error(r.errMsg))},complete(r){counts.complete++;resolve(r)}}));
    wx.setStorageSync('fixture',{text:'插件中文🙂',number:0,flag:false});
    await call(wx.setStorage.bind(wx),{key:'async-key',data:{nested:[1,true]}});
    const stored=await call(wx.getStorage.bind(wx),{key:'async-key'});
    await call(wx.removeStorage.bind(wx),{key:'async-key'});
    await call(wx.getStorage.bind(wx),{key:'async-key'},true);
    await call(fm.writeFile.bind(fm),{filePath:dir+'/fixture.txt',data:'插件中文🙂',encoding:'utf8'});
    await call(fm.writeFile.bind(fm),{filePath:dir+'/fixture.bin',data:new Uint8Array([0,255,128,1]).buffer});
    const read=await call(fm.readFile.bind(fm),{filePath:dir+'/fixture.bin',position:1,length:2});
    const stats=await call(fm.stat.bind(fm),{path:dir+'/fixture.bin'});
    await call(fm.appendFile.bind(fm),{filePath:dir+'/append.txt',data:'追加中文'});
    if(fm.readFileSync(dir+'/append.txt','utf8')!=='追加中文')throw Error('append mismatch');
    await call(fm.readFile.bind(fm),{filePath:dir+'/missing'},true);
    let denied=false;try{fm.writeFileSync('wxfile://usr/other-plugin.txt','bad')}catch(e){denied=true}
    return {counts,stored:stored.data,binary:Array.from(new Uint8Array(read.data)),size:stats.stats.size,isFile:stats.stats.isFile(),denied};
   }
  };
 });
 global.publishDomainComponents(${mapping});module.exports=()=>require('index.js');
});requirePlugin('plugin://${provider}');`;
const files = {
  "app-config.json": JSON.stringify({
    pages: ["home", "next", `__plugin__/${provider}/detail`],
    entryPagePath: "home",
    componentFramework: {
      default: "exparser"
    },
    plugins: {
      example: {
        provider,
        version: "1.0.0",
        subpackage: "__APP__"
      },
      privateApi: {
        provider: privateProvider,
        version: "1.0.0",
        subpackage: "__APP__"
      }
    },
    page: {
      "home.html": {
        usingComponents: {
          counter: `plugin://${provider}/counter`
        }
      }
    }
  }),
  "app-service.js": `${hostConfig}${template}${privateFactory}__wxAppCode__['home.wxml']=template('home');${factory}App({});__wxRoute='home';__wxRouteBegin=true;__wxAppCurrentFile__='home.js';Page({openPlugin(){wx.navigateTo({url:'plugin://example/public-detail?value=plugin-query',success(){getApp().pluginNavigationSuccess=(getApp().pluginNavigationSuccess||0)+1}})}});__wxRoute='next';__wxRouteBegin=true;__wxAppCurrentFile__='next.js';Page({});`,
  "page-frame.html": '<script src="webview.app.js"></script>',
  "webview.app.js": `globalThis.pluginFrameLoads=(globalThis.pluginFrameLoads||0)+1;${privateTemplate}${hostConfig}${pluginConfig.replaceAll("global.", "")}${template}publishDomainComponents(${mapping});__wxAppCode__['home.wxml']=template('home');__wxAppCode__['next.wxml']=()=>({tag:'wx-page',children:[]});__wxAppCode__['${prefix}card.wxml']=template('card');__wxAppCode__['${prefix}detail.wxml']=template('detail');__wxAppCode__['${prefix}detail.wxss']=function(){};__wxAppCode__['${prefix}card.wxss']=__wxAppCode__['home.wxss']=__wxAppCode__['next.wxss']=function(){};`,
  "after-plugin.js": `if(!__wxAppCode__['${prefix}card.wxml'])throw Error('plugin template not registered');globalThis.afterPluginLoads=(globalThis.afterPluginLoads||0)+1;`,
  "home.html": `<script>document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:template('home')}}));</script>`,
  "next.html": `<script>document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:()=>({tag:'wx-page',children:[]})}}));</script>`,
  [`__plugin__/${provider}/detail.html`]: `<script>document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:template('detail')}}));</script>`,
  [`__plugin__/${provider}/asset.txt`]: "plugin package asset"
};
for (const [name, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(directory, name)), {
    recursive: true
  });
  fs.writeFileSync(path.join(directory, name), text);
}
let t;
try {
  t = await managedFixture({
    packageDir: directory
  });
  const {
    call
  } = t;
  const viewId = `page:${(await call("runner_status")).current.id}`;
  const loaded = await call("runner_evaluate", {
    targetId: viewId,
    awaitPromise: true,
    expression: `new Promise(resolve=>WeixinJSBridge.invoke('loadJsFiles',{paths:['__plugin__/${privateProvider}/pageframe.js','__plugin__/${provider}/pageframe.js','after-plugin.js']},r=>resolve({errMsg:r.errMsg,frames:globalThis.pluginFrameLoads,after:globalThis.afterPluginLoads})))`
  });
  assert.deepEqual(loaded.result.value, {
    errMsg: "loadJsFiles:ok",
    frames: 1,
    after: 1
  });
  const host = await call("runner_evaluate", {
    expression: `({app:wx.getAppBaseInfo().host,plugin:requirePlugin('privateApi').host()})`
  });
  assert.ok(!host.exceptionDetails, JSON.stringify(host));
  assert.deepEqual(host.result.value, {
    app: {},
    plugin: {}
  });
  assert.equal((await call("runner_wait", {
    kind: "text",
    text: "plugin-count:0"
  })).status, "matched");
  await call("runner_click", {
    text: "plugin-count:0",
    exact: true
  });
  assert.equal((await call("runner_wait", {
    kind: "text",
    text: "plugin-count:1"
  })).status, "matched");
  const counts = async () => (await call("runner_evaluate", {
    expression: `requirePlugin('example').counts()`
  })).result.value;
  assert.deepEqual(await counts(), {
    loads: 1,
    taps: 1,
    attached: 1,
    detached: 0
  });
  await call("runner_navigate", {
    method: "reLaunch",
    url: "/next"
  });
  assert.deepEqual(await counts(), {
    loads: 1,
    taps: 1,
    attached: 1,
    detached: 1
  });
  await call("runner_navigate", {
    method: "reLaunch",
    url: "/home"
  });
  assert.equal((await call("runner_wait", {
    kind: "text",
    text: "plugin-count:0"
  })).status, "matched");
  assert.deepEqual(await counts(), {
    loads: 1,
    taps: 1,
    attached: 2,
    detached: 1
  });
  assert.equal((await call("runner_status")).current.failed, false);
  const hostCheck = (await call("runner_evaluate", {
    expression: `requirePlugin('example').hostCheck()`,
    awaitPromise: true
  })).result.value;
  assert.deepEqual(hostCheck, {
    counts: {
      success: 8,
      fail: 2,
      complete: 10
    },
    stored: {
      nested: [1, true]
    },
    binary: [255, 128],
    size: 4,
    isFile: true,
    denied: true
  });
  const snapshot = () => call("runner_evaluate", {
    expression: `requirePlugin('example').hostSnapshot()`
  }).then(r => r.result.value);
  const beforeRestart = await snapshot();
  assert.deepEqual(beforeRestart, {
    env: `wxfile://usr/__plugins__/${provider}`,
    stored: {
      text: "插件中文🙂",
      number: 0,
      flag: false
    },
    text: "插件中文🙂",
    binary: [0, 255, 128, 1],
    asset: "plugin package asset"
  });
  await call("runner_evaluate", {
    expression: `wx.setStorageSync('host-fixture',{step:1})`
  });
  const changed = await call("runner_storage", {
    action: "set",
    key: "host-fixture",
    value: {
      step: 2
    }
  });
  assert.deepEqual(changed.entries["host-fixture"], {
    step: 2
  });
  assert.deepEqual((await call("runner_evaluate", {
    expression: `wx.getStorageSync('host-fixture')`
  })).result.value, {
    step: 2
  });
  assert.ok(!changed.info.keys.some(key => key.startsWith("__plugins__")));
  await call("runner_runtime", {
    action: "restart"
  });
  await until(async () => {
    const s = await call("runner_status");
    return s.serviceReady && s.current?.ready && !s.current.failed;
  });
  assert.deepEqual(await snapshot(), beforeRestart);
  assert.deepEqual((await call("runner_storage", {
    action: "get",
    key: "host-fixture"
  })).entries["host-fixture"], {
    step: 2
  });
  await call("runner_click", {
    text: "open-plugin-page",
    exact: true
  });
  await until(async () => {
    const s = await call("runner_status");
    return s.current?.ready && s.current?.routed && s.current.route === `__plugin__/${provider}/detail`;
  });
  assert.equal((await call("runner_wait", {
    kind: "text",
    text: "plugin-page:plugin-query"
  })).status, "matched");
  assert.equal((await call("runner_status")).current.route, `__plugin__/${provider}/detail`);
  await until(async () => (await call("runner_evaluate", {
    expression: "getApp().pluginNavigationSuccess"
  })).result.value === 1);
  await call("runner_navigate", {
    method: "navigateBack",
    delta: 1
  });
  assert.equal((await call("runner_wait", {
    kind: "text",
    text: "open-plugin-page"
  })).status, "matched");
  await call("runner_evaluate", {
    expression: "wx.showToast({title:'plugin-toast',duration:60000,mask:true})",
    awaitPromise: true
  });
  assert.equal((await call("runner_wait", {
    kind: "text",
    text: "plugin-toast"
  })).status, "matched");
  const hidden = await call("runner_evaluate", {
    expression: "requirePlugin('example').hideToast()",
    awaitPromise: true
  });
  assert.ok(!hidden.exceptionDetails, JSON.stringify(hidden));
  assert.equal(hidden.result.value.errMsg, "hideToast:ok");
  assert.equal((await call("runner_wait", {
    kind: "hidden",
    selector: '[role="status"]'
  })).status, "matched");
  const result = {
    nativePluginHideToast: true,
    publicPluginPageNavigation: true,
    pluginPageQueryAndReturn: true,
    navigationSuccessOnce: true,
    passed: true,
    platform: process.platform,
    framework: "exparser",
    originalDefinePlugin: true,
    embeddedPluginFileAlias: true,
    privateOnlyPluginFrame: true,
    hostInfoAvailableToAppAndPlugin: true,
    followingBatchScriptExecuted: true,
    parentEntryNotReplayed: true,
    publicToPrivateComponent: true,
    realClickAndSetData: true,
    moduleReused: true,
    detachAndRecreate: true,
    nativePluginStorageAndFilesystem: true,
    nativeCallbackCounts: hostCheck.counts,
    binaryAndPartialRead: true,
    packageAssetRead: true,
    pluginPathIsolation: true,
    restartPersistence: true,
    nativeAppendFile: true,
    mcpStorageCacheCoherence: true,
    pluginKeysHiddenFromApp: true
  };
  fs.writeFileSync("docs/plugin-loader-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (e) {
  if (t) fs.writeFileSync(".local/plugin-fixture-failure.log", t.logs.join(""));
  throw e;
} finally {
  if (t) await t.close();
  fs.rmSync(directory, {
    recursive: true,
    force: true
  });
}
