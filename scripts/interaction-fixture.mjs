import fs from "node:fs";
import path from "node:path";
/** Tiny compiled-template fixture for real WAWebview/WASubContext; never edits supplied packages. */
export function interactionFixture(directory, url) {
  const pkg = path.join(directory, "fixture");
  fs.mkdirSync(pkg);
  fs.writeFileSync(
    path.join(pkg, "app-config.json"),
    JSON.stringify({
      pages: ["home", "next"],
      entryPagePath: "home.html",
      renderer: { default: "webview" },
      componentFramework: { default: "exparser" },
    }),
  );
  fs.writeFileSync(
    path.join(pkg, "app-service.js"),
    `App({});
__wxRoute='home';__wxRouteBegin=true;__wxAppCurrentFile__='home.js';Page({data:{input:'',result:'',tap:0,held:0,moved:0},
 onInput(e){this.setData({input:e.detail.value});},
 submit(){wx.request({url:${JSON.stringify(url)},method:'POST',data:{message:this.data.input},success:r=>this.setData({result:r.data.message})});},
 modal(){wx.showModal({title:'测试弹窗',content:'回调仅执行一次',editable:true,success:r=>this.setData({result:'modal:'+r.content}),complete:()=>console.log('modal-complete')});},
 sheet(){wx.showActionSheet({itemList:['第一项','第二项'],success:r=>this.setData({result:'sheet:'+r.tapIndex}),fail:()=>this.setData({result:'sheet:cancel'}),complete:()=>console.log('sheet-complete')});},
 files(){wx.chooseMessageFile({count:1,extension:['txt'],success:r=>this.setData({result:'file:'+r.tempFiles[0].name}),fail:()=>this.setData({result:'file:cancel'}),complete:()=>console.log('file-complete')});},
 held(){this.setData({held:this.data.held+1});},touchmove(){this.setData({moved:this.data.moved+1,result:'moved:'+ (this.data.moved+1)});},
 navigate(){wx.navigateTo({url:'/next'});}});
__wxRoute='next';__wxRouteBegin=true;__wxAppCurrentFile__='next.js';Page({data:{result:'Next page'}});`,
  );
  fs.writeFileSync(
    path.join(pkg, "page-frame.html"),
    `<script>
__wxAppCode__['home.wxss']=__wxAppCode__['next.wxss']=function(){};
$gwx=function(path){window.__wxml_comp_version__=0.02;return function(env,dd){env=window.__mergeData__?window.__mergeData__(env,dd):env;
function value(v){return v&&typeof v==='object'&&'__value__' in v?value(v.__value__):v;}
function n(tag,attr,children){return {tag:'wx-'+tag,attr:attr||{},children:children||[],n:[],raw:{},generics:{}};}
if(path==='next.wxml')return {tag:'wx-page',children:[n('text',{},['Next page'])]};
return {tag:'wx-page',children:[n('view',{style:'padding:16px'},[
 n('textarea',{id:'entry',value:value(env.input),bindinput:'onInput',style:'height:70px;background:#eee'}),
 n('button',{id:'submit',bindtap:'submit'},['提交']),n('button',{id:'modal',bindtap:'modal'},['弹窗']),
 n('button',{id:'sheet',bindtap:'sheet'},['选项']),n('button',{id:'files',bindtap:'files'},['文件']),
 n('button',{id:'next',bindtap:'navigate'},['下一页']),n('text',{id:'result'},[String(value(env.result)||'Ready')]),
 n('view',{id:'gesture',bindlongpress:'held',bindtouchmove:'touchmove',style:'height:100px;background:#ddf;touch-action:none'},['手势区域']),
 n('view',{id:'bottom',style:'margin-top:900px;height:60px'},['底部'])
])]} }};</script>`,
  );
  for (const route of ["home", "next"])
    fs.writeFileSync(
      path.join(pkg, route + ".html"),
      `<script>__wxAppCode__['${route}.wxss']();document.dispatchEvent(new CustomEvent('generateFuncReady',{detail:{generateFunc:$gwx('${route}.wxml')}}));</script>`,
    );
  return pkg;
}
