import fs from "node:fs";
import path from "node:path";
import compiler from "glass-easel-template-compiler";
export function cameraMapFixture(dir, framework, tileUrl) {
  const pkg = path.join(dir, framework);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "app-config.json"),
    JSON.stringify({
      pages: ["home", "next"],
      entryPagePath: "home.html",
      renderer: { default: "webview" },
      componentFramework: { default: framework, allUsed: [framework] },
    }),
  );
  fs.writeFileSync(
    path.join(pkg, "icon.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const markers = [
    {
      id: 7,
      latitude: 39.9087,
      longitude: 116.3973,
      title: "测试门店",
      callout: { content: "测试门店", display: "ALWAYS" },
    },
  ];
  const attrs = {
    id: "map",
    latitude: 39.9087,
    longitude: 116.3973,
    scale: 16,
    markers,
    style: "width:320px;height:220px",
    bindmarkertap: "marker",
  };
  const cam = {
    id: "camera",
    mode: "scanCode",
    style: "width:320px;height:260px",
    bindinitdone: "init",
    bindscancode: "scan",
    binderror: "cameraError",
  };
  const names = [
    "authorize",
    "center",
    "remove",
    "scanner",
    "coverToggle",
    "locate",
  ];
  let compiled = "";
  if (framework === "glass-easel") {
    const g = new compiler.TmplGroup();
    const templates = {
      home: `<map id="map" latitude="39.9087" longitude="116.3973" scale="16" markers="{{markers}}" style="width:320px;height:220px" bindmarkertap="marker" show-location="{{showLocation}}"><cover-view wx:if="{{coverVisible}}" id="cover" style="position:absolute;bottom:0;left:0;width:320px;height:75px;background:#ff9800"><cover-view id="cover-button" bindtap="coverTap" style="height:25px">门店列表</cover-view><cover-view id="cover-scroll" style="height:50px;overflow-y:scroll" bindscroll="coverScroll"><cover-view style="height:200px">可滚动内容</cover-view><cover-image id="cover-image" src="icon.png" style="width:20px;height:20px"/></cover-view></cover-view></map><camera wx:if="{{visible}}" id="camera" mode="scanCode" style="width:320px;height:260px" bindinitdone="init" bindscancode="scan" binderror="cameraError"/>${names.map((n) => `<button id="${n}" bindtap="${n}">${n}</button>`).join("")}<text id="result">{{result}}|{{frames}}</text>`,
      next: "<text>Next</text>",
    };
    for (const [name, t] of Object.entries(templates)) {
      const errors = g.addTmpl(name, t);
      if (errors.length) throw Error(JSON.stringify(errors));
      compiled += `__wxCodeSpace__.addComponentStaticConfig('${name}',{usingComponents:{},glassEaselCompatible:true});`;
    }
    compiled += `__wxCodeSpace__.batchAddCompiledTemplate(function(G,R,D,Q,gdc,X,Y,Z){var P=a=>typeof a==='function'?a:()=>{};return {home:${g.getTmplGenObject("home")},next:${g.getTmplGenObject("next")}}});`;
    g.free();
  } else
    compiled = `__wxAppCode__['home.wxss']=__wxAppCode__['next.wxss']=function(){};$gwx=function(path){window.__wxml_comp_version__=0.02;return function(env,dd){env=window.__mergeData__?window.__mergeData__(env,dd):env;function v(x){return x&&typeof x==='object'&&'__value__'in x?v(x.__value__):x}function n(tag,attr,children=[]){return {tag:'wx-'+tag,attr,children,n:[],raw:{},generics:{}}}return {tag:'wx-page',children:[n('map',{...${JSON.stringify(attrs)},'show-location':v(env.showLocation)},v(env.coverVisible)?[n('cover-view',{id:'cover',style:'position:absolute;bottom:0;left:0;width:320px;height:75px;background:#ff9800'},[n('cover-view',{id:'cover-button',bindtap:'coverTap',style:'height:25px'},['门店列表']),n('cover-view',{id:'cover-scroll',style:'height:50px;overflow-y:scroll',bindscroll:'coverScroll'},[n('cover-view',{style:'height:200px'},['可滚动内容']),n('cover-image',{id:'cover-image',src:'icon.png',style:'width:20px;height:20px'})])])]:[]),...(v(env.visible)?[n('camera',${JSON.stringify(cam)})]:[]),...${JSON.stringify(names)}.map(name=>n('button',{id:name,bindtap:name},[name])),n('text',{id:'result'},[String(v(env.result))+'|'+String(v(env.frames))])]}}};`;
  const service = `App({});__wxRoute='home';__wxRouteBegin=true;__wxAppCurrentFile__='home.js';define('home.js',function(require,module,exports){Page({data:{markers:${JSON.stringify(markers)},visible:false,coverVisible:true,showLocation:false,result:'ready',frames:0},locate(){wx.authorize({scope:'scope.userLocation',success:()=>this.setData({showLocation:true})})},coverTap(){this.setData({result:'cover-tap'})},coverScroll(){this.setData({result:'cover-scroll'})},coverToggle(){this.setData({coverVisible:!this.data.coverVisible})},authorize(){wx.authorize({scope:'scope.camera',success:()=>this.setData({visible:true}),fail:e=>this.setData({result:e.errMsg})})},init(){this.setData({result:'initialized'});this.listener=wx.createCameraContext().onCameraFrame(f=>{if(f.width===480&&f.height===640&&f.data.byteLength===1228800)this.setData({frames:this.data.frames+1})});this.listener.start().catch(e=>this.setData({result:'frame error:'+JSON.stringify(e)}))},scan(e){this.setData({result:e.detail.result})},cameraError(e){this.setData({result:'camera error'})},marker(e){this.setData({result:'marker:'+e.detail.markerId})},center(){wx.createMapContext('map').getCenterLocation({success:e=>this.setData({result:Math.abs(e.latitude-39.9087)<.0001?'center-ok':'center-bad'}),fail:e=>this.setData({result:e.errMsg})})},remove(){this.listener?.stop();this.setData({visible:false})},scanner(){wx.scanCode({success:e=>this.setData({result:e.result}),fail:e=>this.setData({result:e.errMsg})})}})},{isPage:true,isComponent:true,currentFile:'home.js'});require('home.js');__wxRoute='next';__wxRouteBegin=true;__wxAppCurrentFile__='next.js';Page({});`;
  fs.writeFileSync(
    path.join(pkg, "app-service.js"),
    compiled.replaceAll("window.", "globalThis.") + service,
  );
  fs.writeFileSync(
    path.join(pkg, "page-frame.html"),
    "<script>" + compiled + "</script>",
  );
  for (const n of ["home", "next"])
    fs.writeFileSync(
      path.join(pkg, n + ".html"),
      `<script>document.dispatchEvent(new CustomEvent('generateFuncReady',${framework === "glass-easel" ? "{}" : `{detail:{generateFunc:$gwx('${n}.wxml')}}`}));</script>`,
    );
  return pkg;
}
