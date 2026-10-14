import fs from "node:fs";
import path from "node:path";
import compiler from "glass-easel-template-compiler";
import { interactionFixture } from "./interaction-fixture.mjs";
export function componentFixture(directory, framework, options = {}) {
  const pkg = interactionFixture(directory, "http://127.0.0.1:1/unused");
  const config = JSON.parse(fs.readFileSync(path.join(pkg, "app-config.json")));
  config.componentFramework = { default: framework, allUsed: [framework] };
  config.page = {
    "home.html": { usingComponents: { outer: "/outer" } },
    "outer.html": { component: true, usingComponents: { leaf: "/leaf" } },
    "leaf.html": { component: true, usingComponents: {} },
  };
  fs.writeFileSync(path.join(pkg, "app-config.json"), JSON.stringify(config));
  const configs = {
    home: { usingComponents: { outer: "/outer" }, glassEaselCompatible: true },
    outer: {
      component: true,
      usingComponents: { leaf: "/leaf" },
      glassEaselCompatible: true,
    },
    leaf: { component: true, usingComponents: {}, glassEaselCompatible: true },
  };
  const statics = Object.entries(configs)
    .map(
      ([name, c]) =>
        `__wxAppCode__[${JSON.stringify(name + ".json")}]=${JSON.stringify(c)};`,
    )
    .join("\n");
  let service = fs
    .readFileSync(path.join(pkg, "app-service.js"), "utf8")
    .replace("App({});", "");
  const components = `
__wxRoute='app';App({});
__wxRoute='leaf';__wxRouteBegin=true;__wxAppCurrentFile__='leaf.js';define('leaf.js',function(require,module,exports){Component({properties:{label:String},data:{count:1},methods:{increase(){this.setData({count:this.data.count+1});}}});},{isPage:false,isComponent:true,currentFile:'leaf.js'});require('leaf.js');
__wxRoute='outer';__wxRouteBegin=true;__wxAppCurrentFile__='outer.js';define('outer.js',function(require,module,exports){Component({data:{show:true},methods:{toggle(){this.setData({show:!this.data.show});}}});},{isPage:false,isComponent:true,currentFile:'outer.js'});require('outer.js');
`;
  service = service
    .replace(
      "Page({data:{input",
      "define('home.js',function(require,module,exports){Page({data:{input",
    )
    .replace(
      "navigate(){wx.navigateTo({url:'/next'});}});",
      "navigate(){wx.navigateTo({url:'/next'});}});},{isPage:true,isComponent:true,currentFile:'home.js'});require('home.js');",
    );
  fs.writeFileSync(
    path.join(pkg, "app-service.js"),
    statics + "\n" + components + service,
  );
  let view = fs.readFileSync(path.join(pkg, "page-frame.html"), "utf8");
  view = view.replace(
    "<script>",
    `<script>${statics}\n__wxAppCode__['outer.wxss']=__wxAppCode__['leaf.wxss']=function(){};`,
  );
  view = view.replace(
    "if(path==='next.wxml')",
    `if(path==='leaf.wxml')return {tag:'wx-page',children:[n('button',{id:'leaf-button',bindtap:'increase'},['nested:'+value(env.label)+':'+value(env.count)])]};
if(path==='outer.wxml')return {tag:'wx-page',children:[n('view',{id:'outer-host'},[n('button',{id:'toggle',bindtap:'toggle'},['toggle']),...(value(env.show)?[n('leaf',{id:'leaf-one',label:'child'},[])]:[])])]};
if(path==='next.wxml')`,
  );
  view = view.replace(
    "</script>",
    "__wxAppCode__['home.wxml']=$gwx('home.wxml');__wxAppCode__['next.wxml']=$gwx('next.wxml');__wxAppCode__['outer.wxml']=$gwx('outer.wxml');__wxAppCode__['leaf.wxml']=$gwx('leaf.wxml');</script>",
  );
  view = view.replace(
    "n('textarea',{id:'entry'",
    "n('outer',{id:'outer-one'},[]),n('textarea',{id:'entry'",
  );
  fs.writeFileSync(path.join(pkg, "page-frame.html"), view);
  fs.writeFileSync(
    path.join(pkg, "app-service.js"),
    view.replace(/<\/?script>/g, "").replaceAll("window.", "globalThis.") +
      "\n" +
      components +
      service,
  );
  for (const route of ["outer", "leaf"])
    fs.writeFileSync(
      path.join(pkg, route + ".html"),
      `<script>__wxAppCode__['${route}.wxss']();document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:$gwx('${route}.wxml')}}));</script>`,
    );
  if (framework === "glass-easel") {
    const templates = {
      home: '<view style="padding:16px"><outer id="outer-one"/><textarea id="entry" value="{{input}}" bindinput="onInput"/><text id="result">{{result}}</text></view>',
      outer:
        '<view id="outer-host"><button id="toggle" bindtap="toggle">toggle</button><leaf wx:if="{{show}}" id="leaf-one" label="child"/></view>',
      leaf:
        options.leafTemplate ||
        '<button id="leaf-button" bindtap="increase">nested:{{label}}:{{count}}</button>',
      next: options.nextTemplate || "<text>Next page</text>",
    };
    const group = new compiler.TmplGroup();
    for (const [name, wxml] of Object.entries(templates)) {
      const errors = group.addTmpl(name, wxml);
      if (errors.length) throw Error(JSON.stringify(errors));
    }
    const templateCode = `__wxCodeSpace__.batchAddCompiledTemplate(function(G,R,D,Q,gdc,X,Y,Z){var P=function(a){return typeof a==='function'?a:()=>{}};return {${Object.keys(
      templates,
    )
      .map((name) => JSON.stringify(name) + ":" + group.getTmplGenObject(name))
      .join(",")}}});`;
    const staticCode = Object.entries({
      ...configs,
      next: { usingComponents: {}, glassEaselCompatible: true },
    })
      .map(
        ([name, c]) =>
          `__wxCodeSpace__.addComponentStaticConfig(${JSON.stringify(name)},${JSON.stringify(c)});`,
      )
      .join("\n");
    const compiled = statics + "\n" + staticCode + "\n" + templateCode;
    fs.writeFileSync(
      path.join(pkg, "app-service.js"),
      compiled + "\n" + components + service,
    );
    fs.writeFileSync(
      path.join(pkg, "page-frame.html"),
      "<script>" + compiled + "</script>",
    );
    for (const route of ["home", "outer", "leaf", "next"])
      fs.writeFileSync(
        path.join(pkg, route + ".html"),
        '<script>document.dispatchEvent(new CustomEvent("generateFuncReady"));</script>',
      );
    group.free();
  }
  return pkg;
}
