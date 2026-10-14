import fs from "node:fs";
import path from "node:path";
import compiler from "glass-easel-template-compiler";

export function videoFixture(directory, framework, source) {
  const pkg = path.join(directory, "video-" + framework);
  fs.mkdirSync(path.join(pkg, "page/component/resources"), { recursive: true });
  fs.copyFileSync(
    "tests/fixtures/native-video.mp4",
    path.join(pkg, "page/component/resources/clip.mp4"),
  );
  fs.writeFileSync(
    path.join(pkg, "app-config.json"),
    JSON.stringify({
      pages: ["home", "next"],
      entryPagePath: "home.html",
      renderer: { default: "webview" },
      componentFramework: { default: framework, allUsed: [framework] },
    }),
  );
  const service = `App({});__wxRoute='home';__wxRouteBegin=true;__wxAppCurrentFile__='home.js';define('home.js',function(require,module,exports){Page({data:{visible:true,state:'ready',time:0,metadata:false},onReady(){this.video=wx.createVideoContext('clip')},play(){this.video.play()},pause(){this.video.pause()},seek(){this.video.seek(2)},danmu(){this.video.sendDanmu({text:'中文弹幕',color:'#ffcc00'})},remove(){this.setData({visible:false})},played(){this.setData({state:'played'})},paused(){this.setData({state:'paused'})},ended(){this.setData({state:'ended'})},error(e){this.setData({state:'error:'+e.detail.errMsg})},time(e){this.setData({time:e.detail.currentTime})},metadata(e){this.setData({metadata:e.detail.width===160 && e.detail.height===90})}})},{isPage:true,isComponent:true,currentFile:'home.js'});require('home.js');__wxRoute='next';__wxRouteBegin=true;__wxAppCurrentFile__='next.js';Page({});`;
  const attrs = {
    id: "clip",
    src: source,
    muted: true,
    controls: true,
    "enable-danmu": true,
    style: "width:320px;height:180px",
    bindplay: "played",
    bindpause: "paused",
    bindended: "ended",
    binderror: "error",
    bindtimeupdate: "time",
    bindloadedmetadata: "metadata",
  };
  let compiled = "";
  if (framework === "glass-easel") {
    const group = new compiler.TmplGroup();
    const buttons = ["play", "pause", "seek", "danmu", "remove"]
      .map((n) => `<button id="${n}" bindtap="${n}">${n}</button>`)
      .join("");
    const attr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${typeof v === "boolean" ? "{{" + v + "}}" : v}"`)
      .join(" ");
    for (const [name, wxml] of Object.entries({
      home: `<video wx:if="{{visible}}" ${attr}/>${buttons}<text id="state">{{state}}</text><text id="metadata">{{metadata}}</text><text id="time">{{time}}</text>`,
      next: "<text>next</text>",
    })) {
      const errors = group.addTmpl(name, wxml);
      if (errors.length) throw Error(JSON.stringify(errors));
    }
    for (const name of ["home", "next"])
      compiled += `__wxCodeSpace__.addComponentStaticConfig('${name}',{usingComponents:{},glassEaselCompatible:true});`;
    compiled += `__wxCodeSpace__.batchAddCompiledTemplate(function(G,R,D,Q,gdc,X,Y,Z){var P=a=>typeof a==='function'?a:()=>{};return {home:${group.getTmplGenObject("home")},next:${group.getTmplGenObject("next")}}});`;
    group.free();
  } else {
    compiled = `__wxAppCode__['home.wxss']=__wxAppCode__['next.wxss']=function(){};$gwx=function(path){window.__wxml_comp_version__=0.02;return function(env,dd){env=window.__mergeData__?window.__mergeData__(env,dd):env;function v(x){return x&&typeof x==='object'&&'__value__'in x?v(x.__value__):x}function n(tag,attr,children=[]){return {tag:'wx-'+tag,attr,children,n:[],raw:{},generics:{}}}return {tag:'wx-page',children:[...(v(env.visible)?[n('video',${JSON.stringify(attrs)})]:[]),...['play','pause','seek','danmu','remove'].map(name=>n('button',{id:name,bindtap:name},[name])),...['state','metadata','time'].map(name=>n('text',{id:name},[String(v(env[name]))]))]}}};`;
  }
  fs.writeFileSync(
    path.join(pkg, "app-service.js"),
    compiled.replaceAll("window.", "globalThis.") + service,
  );
  fs.writeFileSync(
    path.join(pkg, "page-frame.html"),
    "<script>" + compiled + "</script>",
  );
  for (const name of ["home", "next"])
    fs.writeFileSync(
      path.join(pkg, name + ".html"),
      `<script>document.dispatchEvent(new CustomEvent('generateFuncReady',${framework === "glass-easel" ? "{}" : `{detail:{generateFunc:$gwx('${name}.wxml')}}`}));</script>`,
    );
  return pkg;
}
