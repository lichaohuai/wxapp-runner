# MCP / 原生 F12 调试

新版桌面加载状态、Worker 调试目标和 Wxapp「加载链路」入口见 最短教程（该内部记录未随源码发行），逐项测试及未完成边界见 官方契约矩阵（该内部记录未随源码发行）。现有实例不热换代码；新启动实例才使用新版加载链路。

运行时提供标准 stdio MCP；客户端连接已经打开的 WxappRunner。F12 的 Console / Sources / Network 连接真实逻辑 worker，新增 **Wxapp** 页签检查实例、数据、请求和存储。页面 DOM/CSS 仍使用 ⌘⌥I。二者可与 MCP 同时使用。

达利实例运行时可使用 客户端配置（该内部记录未随源码发行） 和 [快速开始](MCP-快速开始.md)。连接文件对应的主控必须仍在运行。[小程序搜索/下载](packages.md) 保留旧主控兼容；[执行分析与 Autopsy](execution-analysis.md) 需要新版主控及新分析实例。

## 启动和客户端配置

```sh
npm install
npm start -- --package ../package --appid YOUR_APPID \
  --mcp --mcp-file .local/mcp-original.json --devtools
```

`--mcp` 发布本地主控连接文件；回环服务、F12、状态观测和缓存始终存在。同一主控的多个实例共用连接文件，通过 runtimeId 选择。wxbot 仍从 `.local/config.json` 或环境变量读取，客户端配置不需要填写账号密钥。

```json
{
  "mcpServers": {
    "wxapp-runner": {
      "command": "node",
      "args": [
        "/absolute/path/wxapp-runner/dist/mcp.cjs",
        "--connection",
        "/absolute/path/wxapp-runner/.local/mcp-original.json"
      ]
    }
  }
}
```

替换为实际绝对路径；Node.js 22.19+。不要把 `npm start` 当作 MCP server，stdio 的 stdout 专用于协议。每次调用重新读取连接文件，运行时重启无需复制端口或令牌。

## 函数与模块分析

[受控 Hook、模块源码、网络过滤和 diff](analysis-tools.md) 保留原有调用。网络列表默认摘要；需要完整字段可显式设置 summary:false，正文默认 4 KiB 预览并附 artifact 引用。Boot 插桩无法通过重连 MCP 补装到已执行业务代码的实例。

`runner_execution` 支持 `explain paged:true` 和 `sliceCursor` 续读，大页使用同页 artifact；原生 Wxapp 面板提供分页按钮。详见 [大型切片分页](execution-analysis.md#大型切片分页f12-与-mcp-共用) 和 真实 Fireye 后续验收（该内部记录未随源码发行）。

`runner_execution` 新增 `action:"summary"`，支持源码/native/事件类型聚合；`read/summary` 支持 `natives`、`expressionIncludes`、`location` 和固定 `beforeEvent` 过滤。分组用 `offset/nextOffset` 翻页，默认脱敏。闲鱼真实复杂算法的 626 组独立对拍与使用示例（该内部记录未随源码发行）。

原生 SocketTask 也通过 `runner_network` 查看：详情含 WebSocket 握手头、frames、关闭码与错误，frames.artifactId 可交给 runner_artifact 重复读取。大消息预览会标记 truncated；二进制原值读取需显式 revealSensitive。原生 F12 使用 Network → Messages；offline 只在新连接握手前检查，HTTP 规则不自动控制消息。Socket 用法与边界（该内部记录未随源码发行）。

基础库 native RequestTask、UploadTask、DownloadTask 都进入相同 `runner_network`。Upload/Download 额外提供 `context.nativeTaskType`；`multipart` 显示字段和文件名/MIME/大小。下载 `filePath` 与临时路径共用原文件授权，正文 artifact 可重复读。上传/下载验证与边界（该内部记录未随源码发行）。

基础库 native RequestTask 也进入相同 `runner_network`。详情的 `context.nativeApi/nativeTaskId/nativeCallStack` 可区分调用通路并追到原 handler；来源未提供时不会伪造插件 ID。`X-WECHAT-HOSTSIGN` / `hostSign` / `host_sign` 默认脱敏，原值需显式 `revealSensitive:true`。新版主控和新实例才加载更新；重连 MCP 不会热换旧 worker。原生网络专项结果（该内部记录未随源码发行）。

## 工具清单（36 个）

| 工具                | 参数与用途                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `runner_status`     | appid、页面表、栈、当前页面和就绪状态；`networkCursor` 用于操作前标记                                                  |
| `runner_snapshot`   | 可见文字、输入值、nodeId、矩形；`target: page / shell`，默认 page                                                      |
| `runner_screenshot` | 标准 MCP PNG image + 身份元数据；fullPage:true 或 container:CSS-selector                                               |
| `runner_click`      | 四选一：nodeId、selector、精确 text、完整 x/y；拒绝混用、越界、陈旧或遮挡目标                                          |
| `runner_input`      | nodeId 或 selector + text；替换可编辑 input/textarea，派发输入和失焦                                                   |
| `runner_navigate`   | method + url；navigateBack 使用 delta；其余方法必须有 url                                                              |
| `runner_logs`       | after、limit；按 id 升序连续读取，结构化 args、level、route / context / stack（如可取得）                              |
| `runner_network`    | 不带 id 列表保持原调用兼容；带 id 重复读取正文；带 after 返回游标分页                                                  |
| `runner_state`      | action: list / get / events / setData / locate / location；get/setData/locate 要 instanceId；setData 要 patch；locate 要 selector；location 查询或显式设置模拟定位（见下） |
| `runner_storage`    | action: list / get / set / remove / clear；键操作要 key，set 要 value，clear 要 confirm:true                           |
| `runner_dom`        | nodeId 或 selector；action: inspect / highlight；返回属性、HTML、样式、矩形，包含 open shadow root                     |
| `runner_gesture`    | scroll / swipe / longpress / drag / doubleclick / keys / focus，详见下文                                               |
| `runner_wait`       | start / list / cancel；条件等待、超时、传输取消和显式 waitId 取消                                                      |
| `runner_dialog`     | list 查询待处理 wx 对话框；respond 用 id 回复 modal、选项或文件                                                        |
| `runner_evaluate`   | expression 在真实业务 VM 执行；可选 contextId / callFrameId / awaitPromise                                             |
| `runner_debugger`   | state / source / setBreakpoint / removeBreakpoint / pause / resume / stepOver / stepInto / stepOut；行号从 1 开始      |

| `runner_events` | 主控统一事件，after/limit/source/level/operationId；可以查询已退出会话 |
| `runner_trace` | operationId 查询确定关联的操作时间线 |
| `runner_network_rules` | list/set/remove/enable/disable/conditions/paused/resolve，默认规则关闭 |
| `runner_replay` | id，显式重发一次；可选替代 url/method/headers/body/bodyEncoding |
| `runner_profile` | start/get/list/stop；kind:cpu/trace/heap/allocations，targetId 选择目标 |
| `runner_runtime` | list/start/stop/restart/switch/closeSession；启动/换包须 packageDir |
| `runner_control` | state/acquire/renew/release；ttlMs 默认 60000 |
| `runner_artifact` | list/read/export/har/session；读取分块，显式导出文件或网络会话目录 |
| `runner_device` | get/capabilities/preset/set/emit/location；PC/Android/iOS、模拟输入、能力来源 |
| `runner_native` | list/get/capabilities/play/pause/seek；真实 DOM 表面与原生桥接记录 |
| `runner_cloud` | status/list/get/start；真实 SDK 云任务，显式确认函数和写入 |
| `runner_suite` | catalog/start/list/get/cancel；逐页清单与后台场景任务 |
| `runner_hook` | install/list/read/remove；条件采样、环形缓存、次数/TTL/异常自动恢复 |
| `runner_source` | list/get/search/locate/format/deobfuscate/graph/dependencies；原工厂、保守变换、静态/动态符号图、插件依赖 |
| `runner_packages` | search/resolve/download/get/jobs/cancel/list/inspect；生产搜索与 CDN 包库，下载不替换运行实例 |
| `runner_crypto_watch` | 原像匹配、分段密码调用、随机重置、Diff；read summary:true 返回步骤及独立验算 |
| `runner_slice` | 原有函数探针和属性监视，保持兼容 |
| `runner_oracle` | export/list/call/batch/remove；目标函数或捕获事件导出会话句柄 |
| `runner_execution` | 执行记录、字段监视、logpoint、反向切片、Diff、候选验证 |
| `runner_autopsy` | preflight/start/get/list/cancel；单次操作字段分析与可选 resultCondition 业务等待 |

所有工具可增量传入 runtimeId/sessionId/targetId；不支持某类目标的动作会报错。省略 runtimeId 使用默认实例。targetId 从 runner_status.targets 读取，逻辑为 logic，页面为 page:<id>。页面输入只接受活动页面，检查和调试可指定仍存活的页面。runner_state.instanceId 继续表示 Page/Component/App 的微信实例 ID，不能拿它替代 runtimeId。

输入操作返回 `status: "input-sent", businessCompleted: false`；导航返回 `route-sent`。这表示输入或路由消息已发送，业务是否完成要根据页面、请求或状态条件检查。超时后不会自动重试，也不会回滚。

nodeId 绑定客户端、页面和页面版本，本客户端下一次快照或导航会使其失效；其他客户端刷新快照不影响本客户端。点击和输入不会自动滚动到屏幕外目标，先滚动再取快照。element 等待默认要求矩形稳定 100 ms（stableMs 可设 0–1000）；输入前再次检查目标是否移动。控件被隐藏、禁用、遮挡或输入框不可编辑时直接拒绝。F12 暂停逻辑 worker 时，页面输入仍可能已发送；先检查断点状态再继续。

## 不漏掉快速请求的操作顺序

```js
const before = await call("runner_status", {});
await call("runner_input", { selector: "textarea", text: "允许测试的链接" });
await call("runner_click", { text: "解析" });
const done = await call("runner_wait", {
  kind: "network",
  after: before.networkCursor,
  urlIncludes: "/parse",
  method: "POST",
  networkState: "complete",
  timeoutMs: 10000,
});
if (done.status === "matched") {
  const response = await call("runner_network", { id: done.result.id });
}
```

这里 `call` 代表客户端工具调用，selector、按钮文字、URL 条件需按当前小程序确定。开始等待之前已经完成的请求仍可从 after 游标查到。省略 after 表示从等待开始时的新请求查找。请求记录被淘汰或游标来自另一次运行时，明确报错，不能据此认定请求未发送。

`runner_network({after,limit})` 返回 entries、nextCursor、latestCursor、hasMore、oldestCursor、gap、cursorResetRequired。after 按**请求开始顺序**分配；状态和正文更新不改变 cursor。看到 pending / headers 后用同一 id 重读，或用 runner_wait 等待完成。

新版主控的网络摘要同时返回 `captureError`、`responseBodyUnavailable`、`endedAt`。`state:"capture-error"` 表示页面／实例退出或观察连接中断造成采集缺口，不能当作 pending、真实网络失败或成功；用 `{"after":0,"filter":{"state":"capture-error"},"summary":true}` 查询原因。`wx-image` 可能使用 CSS 背景图，`document.images.length` 不能单独用于判断小程序图片是否加载。实例退出与重复读取回归（该内部记录未随源码发行）。

`runner_logs` 和 `runner_state(action:events)` 返回 entries、nextCursor、hasMore、oldestId、droppedBefore、gap、cursorResetRequired。使用 nextCursor 读取下一页；gap 表示游标之前有记录被缓存淘汰。主控统一事件默认保留 10,000 条。runner_state 的即时实例事件副本是额外的有界视图，完整操作历史使用 runner_events/runner_trace。跨会话读取时显式传 sessionId；旧游标不能用于新会话。

## 条件等待与取消

定位无需修改业务代码：`runner_state({action:"location"})` 查询；传 `location:{mode:"simulated",latitude:39.907333,longitude:116.391083,accuracy:25}` 启用显式 WGS84 模拟坐标，传 `location:{mode:"system"}` 恢复。默认只修改当前 runtime；额外传 `persist:true` 显式保存至此 appid/profile，重启在业务运行前恢复；`persist:false` 清除保存值。`runner_device` 的 location 操作支持相同参数。保留小程序授权，模拟模式不调用系统定位后端。详细边界见 定位文档（该内部记录未随源码发行）。

默认 10 秒，最大 60 秒；客户端单次工具超时请设为 **至少 65 秒**。MCP stdio 到运行时的传输超时为 65 秒；普通调用为 35 秒。标准 TypeScript SDK 可使用：

```js
await client.callTool(
  {
    name: "runner_wait",
    arguments: { kind: "text", text: "解析成功", timeoutMs: 60000 },
  },
  undefined,
  { timeout: 65000 },
);
```

| kind             | 条件                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| element / hidden | selector 或 nodeId，等待可见 / 不再可见；未知、过期 ID 仍报错                                                        |
| text             | text，等待页面可见文字包含该内容                                                                                     |
| route            | route，匹配当前路由                                                                                                  |
| network          | after、urlIncludes、method、statusCode、networkState（默认 complete）                                                |
| state            | instanceId、path（data 的键路径数组）、equals                                                                        |
| dialog           | 可选 dialogType，等待指定类型的 wx 对话框                                                                            |
| log              | after、source、level、text，查找明确匹配的事件                                                                       |
| operation        | operationId + result，后者是 element/hidden/text/route/state/network/log 条件；只有条件匹配才 businessCompleted:true |

返回 status 为 matched / timeout / cancelled。可指定 waitId，另一个调用使用 `{action:"cancel",waitId}` 取消；`{action:"list"}` 查看正在等待的任务。客户端的标准 MCP 取消信号同样透传到运行时。取消只停止等待，不重复或撤销业务操作。绑定某个页面的等待遇到页面关闭/切换会报错。

## 手势与对话框

```json
{"action":"scroll","deltaY":600}
{"action":"longpress","selector":"#target","durationMs":750}
{"action":"swipe","x":200,"y":500,"endX":200,"endY":200,"durationMs":400}
{"action":"drag","nodeId":"从当前快照取得","endX":280,"endY":300}
{"action":"doubleclick","selector":"#target"}
{"action":"keys","selector":"textarea","keys":["Cmd","A"]}
```

scroll 正 deltaY 向下；未定位时在视口中心滚动。坐标相对页面视口，单位 CSS px。长按默认 650 ms，滑动/拖拽默认 400 ms，持续时间 100–5000 ms。keys 接收一个键及可选 Cmd / Meta / Ctrl / Shift / Alt 修饰；没有定位时作用于当前焦点。macOS 的编辑快捷键转交当前 WebContentsView。手势发出真实原生输入，具体 wx 事件由基础库处理；双击不新增微信没有的业务事件。

对话框使用运行时自己的桌面模态窗口，人工操作与 MCP 共用一个待处理请求。对话框待处理时拒绝向下层页面发送输入，先使用 runner_dialog 回复：

```json
{"action":"respond","id":"待处理 modal 的 id","confirm":true,"content":"编辑框内容"}
{"action":"respond","id":"待处理 action sheet 的 id","tapIndex":1}
{"action":"respond","id":"待处理文件选择的 id","files":["/absolute/path/test.txt"]}
{"action":"respond","id":"待处理请求的 id","cancel":true}
```

modal 的取消返回 confirm:false / cancel:true；action sheet 和文件取消走原 wx fail / complete。重复回复、错误选项、超出数量、不可读文件或不符合类型的文件会被拒绝；不会提前消耗有效请求。文件通过原有授权机制交给文件 API。人工“选择文件…”按钮仍打开系统选择器。文件 API 的手机拍摄、聊天记录来源以及完整媒体元数据仍不在此版本范围。

## 微信状态与定位

实例来自真实基础库。glass-easel、exparser 分别通过可确认的 owner 链和 scoped ID 建立父子树/DOM 映射，动态销毁会使旧实例失效。无法确定的关系返回 unknown。`runner_state({action:"setData",instanceId,patch})` 调用原实例 setData，不直接改内部缓存；storage 通过 wx API 修改并记录事件。

`runner_dom` 返回元素属性、value、HTML 预览、计算样式、布局、scroll 信息及真实组件映射。DOM 高亮使用 `action:"highlight"`。`runner_state(action:locate)` 返回限定实例的 SelectorQuery 和可确认的 DOM 位置。整页截图使用 `fullPage:true`，滚动容器截图使用 `container`，最大 6400 万像素，结束时恢复原滚动位置。

## 规则、暂停与重发

云调用多层 JSON、请求投影、源码搜索和远程 JS Mock 示例见 预览与调试入口（该内部记录未随源码发行）。`runner_network` 详情的 `responseBodyPreview.decoded` / `requestBodyPreview.decoded` 为展示用展开结果，`decoding.paths` 列出转换位置；原始正文及 `parsed` 字段含义保持不变。包内脚本不经 HTTP，当前网络规则不能替代包内 JS 文件。

```json
{"action":"set","rule":{"enabled":false,"priority":10,"match":{"urlIncludes":"/test","source":"logic"},"action":"modify","change":{"headers":{"x-debug":"yes"},"body":"替代正文"}}}
{"action":"conditions","conditions":{"latencyMs":100,"uploadBytesPerSecond":32768,"downloadBytesPerSecond":65536}}
{"action":"set","rule":{"enabled":true,"match":{"urlIncludes":"/local-test"},"action":"mock","response":{"status":200,"headers":{"content-type":"application/json"},"body":"{\"ok\":true}"}}}
```

这些参数传给 runner_network_rules。rule.match.url 支持 `*` 通配符，urlIncludes 是子串；可附 method/source。新规则默认关闭；排序为 priority 降序、创建顺序升序。modify 继续评估，block/mock 终止。修改头时大小写不敏感，removeHeaders 可删除指定头；bodyEncoding 为 text 或 base64。非法 URL、头、编码在规则保存之前拒绝。

暂停规则使用 `action:"pause"`。通过 `runner_network_rules({action:"paused"})` 获取挂起请求，再显式处理：

```json
{"action":"resolve","id":"挂起请求ID","decision":{"action":"continue"}}
{"action":"resolve","id":"挂起请求ID","decision":{"action":"modify","change":{"headers":{"x-debug":"resume"}}}}
{"action":"resolve","id":"挂起请求ID","decision":{"action":"block"}}
{"action":"resolve","id":"挂起请求ID","decision":{"action":"mock","response":{"body":"local response"}}}
```

只允许请求 owner 或人工处理。客户端断线释放挂起请求，并禁用其暂停规则；60 秒保护性释放会记事件，避免永远悬挂。取消原请求不会将其继续出站。

`runner_replay({id})` 发起一个新请求，返回 requestId 并关联 replayOf，默认应用当前规则。不会调用原 handler。原正文被淘汰、截断或失败时必须提供 body 替代。修改到不同 origin 时清除原 Authorization/Cookie，除非调用方显式提供替代头。业务重发永不自动发生。

`conditions` 支持 offline、latencyMs、uploadBytesPerSecond、downloadBytesPerSecond、cacheDisabled。0 速率表示不限速。逻辑传输和页面 Chromium 分别执行实际节流；逻辑无缓存，原生缓存相关操作返回不适用。控制范围是运行时 HTTP(S)，不安装系统证书或代理，不改写 WebSocket 帧。

## 调试、分析与产物

runner_debugger 支持 state/open/source/search、setBreakpoint/removeBreakpoint/breakpoints、pause/resume/stepOver/stepInto/stepOut、exceptions、properties/releaseObjects、capabilities。精确 action 名及字段以 `tools/list` schema 为准。输入的 line/column 从 1 开始；返回的原始 CDP lineNumber/columnNumber 从 0 开始；setBreakpoint 可传 condition。断点返回实际位置。

从 `state.paused.callFrames` 取得 callFrameId，再用 runner_evaluate 在该帧求值。returnByValue:false 可返回 objectId，使用 debugger properties 读取。原生 F12 所有的调用帧、对象和断点带连接前缀；断线或继续后应重新获取，不能缓存后盲用。逻辑和页面各有 capabilities；已有 source map 使用原映射，无 map 不承诺还原源码。

```json
{"action":"start","targetId":"logic","kind":"cpu"}
{"action":"get","jobId":"上一步返回的id"}
{"action":"stop","jobId":"同一个id"}
```

分析启动是异步任务，查询到 running 后执行待测操作，再 stop，随后查询到 complete。heap 是自动完成的一次性任务，不支持安全中途停止；trace 仅用于页面。CPU/分配采样/heap 支持逻辑及页面。任务冲突、断线、预算不足有明确失败状态。

runner_artifact 的 read 用 offset/length 分块读取（最大 256 KiB），返回 base64、nextOffset、hasMore 与元数据。export 要求绝对 destination，不覆盖现有文件。har 创建 HAR 产物，再 export；session 将当前网络记录及可用正文写到一个**新的绝对目录**，session.json 标记每份正文的缺失、截断、失败或脱敏状态。CPU 导出 `.cpuprofile`，heap 导出 `.heapsnapshot`，分配采样导出 `.heapprofile`，trace 导出 `.json`，均可导入原生 DevTools。

默认正文单体 64 MiB、总量 512 MiB；超过缓存限制只影响诊断副本。大响应的解码观测若在上限停止，decodedBytes 为 null，decodedBytesSoFar 表示已观察量，不伪造完整大小。元数据、原始字节和文本视图分开。无效/截断产物不能被导出为完整文件。

文本凭证默认脱敏。原值要显式 revealSensitive:true，二进制及性能/内存文件也需要显式原值授权。导出目录只存所选会话。源码、截图、任意主动求值可能包含业务数据，应按实际工作目的使用。

## 实例、会话与多客户端

runner_runtime start/switch 接收 packageDir，可附 appid/baselibDir/configFile/profile。换包先预检，失败不停止原实例。restart 保留用户数据；同一 appid 的额外实例默认创建隔离 profile。stop 只退出实例，仍可读取网络/异常和 exit 记录。closeSession 显式清理该会话的临时正文；当前正在运行的会话不能清理。重启后可用旧 sessionId 读取保留的 events/network/artifact/profile，旧写调用会被拒绝。

多步骤 AI 自动化可 acquire 租约，默认 60 秒（ttlMs 1000–300000），renew 延期，release 释放。其他客户端可读但不可写。人工页面输入、原生 F12 输入和 Wxapp 修改优先，会撤销租约、拒绝排队中的旧修改。收到 CONTROL_CHANGED 后重新读取状态，不自动重复操作。

主控状态与恢复命令独立于业务执行。观察连接自动重连，重读目标/会话，不重放业务调用；实例崩溃等待显式 restart。标准 MCP 每个 stdio 客户端都有身份与心跳，断线清理等待/暂停请求；连接文件和鉴权入口保持兼容。普通错误带 code/message/status/operationRepeated:false；超时并不证明业务没有执行。

## 回归

`npm run check` 串行运行 TypeScript、单元测试、真实双包、标准 MCP、原生 F12、网络/组件/交互夹具、分析导入、多客户端与重启，以及第二包 39 页导航。测试使用隔离数据与空账号配置，真实 wxbot 独立回归。详见 覆盖矩阵（该内部记录未随源码发行） 和 最新完整回归（该内部记录未随源码发行）。


## 设备、原生组件与验收任务

`runner_device` 预设只改变业务可见平台，基础库内部桥接平台保持原设置。默认 PC 且模拟关闭，修改通过实例队列；定位继续使用已有授权与模拟服务。

```json
{"action":"preset","preset":"android","simulation":true}
{"action":"set","state":{"battery":{"level":63,"isCharging":false}}}
{"action":"emit","event":"compass","data":{"direction":123}}
{"action":"emit","event":"bleValue","data":{"deviceId":"当前连接ID","serviceId":"服务UUID","characteristicId":"特征UUID","value":[1,2,255]}}
{"action":"emit","event":"bleDisconnect","data":{"deviceId":"当前连接ID"}}
```

以上是 `runner_device` 参数。传感器必须已由业务代码启动；BLE 必须先连接并打开通知，断开后订阅失效。`bluetoothDevices`（含 services/characteristics）和 `wifiList` 由 set 显式提供，默认没有虚构外围设备。`apiRegistry` 表示实现来源和可调用性，不代表页面验收通过。SDK 内部和业务可见平台的差别会在返回值中标明。

`runner_native` 只操作当前页面的真实 DOM 后端。组件标签存在但没有后端会返回 `backendAvailable:false`；video 提供原页面 VideoContext 与 MCP play/pause/seek。缺失的 Map/Camera/Live/WebView 后端不能通过返回成功补齐。切页/销毁后重新 list，不复用旧 ID。

`runner_suite({action:"catalog",limit:500})` 返回编译模块、依赖组件的静态 API、PC/移动分类及场景。可选 `sourceDir` 提供 WXML 控件参考；引用源码的构建身份未核实时会明确标识。后台任务只执行调用方指定的步骤，不自动点击全部按钮：

```json
{"action":"start","routes":["packageAPI/pages/device/compass/compass"],"steps":[{"tool":"runner_wait","arguments":{"kind":"text","text":"指南针"}},{"tool":"runner_screenshot","arguments":{}}]}
```

routes、selector、文字应来自当前目录/快照。start 返回 id，用 get 查询、cancel 取消。每实例只运行一个 suite；客户端断开、人工接管或会话改变会停止后续步骤，不重放已提交的业务操作。请求等待可使用 `after:"$before"`，引用该场景操作前保存的网络游标。单纯页面加载和截图只算 page-ready；只有明确结果断言匹配才算 asserted-flow，也不自动认定与真机效果一致。

`runner_cloud` 保留真实基础库 SDK，不切换 Mock：

```json
{"action":"start","operation":"databaseQuery","collection":"允许读取的集合","limit":1}
{"action":"start","operation":"function","name":"明确允许执行的函数","data":{},"confirm":true}
{"action":"get","jobId":"返回的jobId"}
```

可显式传 env；不传时沿用小程序原 `wx.cloud.init`。databaseAdd/Update/Remove/deleteFile 和函数调用要求 confirm:true，更新/删除要求具体 documentId，不提供批量破坏性修改。任务返回 submitted，不代表业务完成。status 中的 SDK uploadFile 能力表示原 SDK 方法存在，当前 runner_cloud 专用上传操作尚未接入；原页面云上传也待独立验收。云账号授权确认没有默认自动同意路径。

当前真实服务与限制见 全覆盖矩阵（该内部记录未随源码发行）。

## 相机与地图组件

`runner_native` 现在列出 Map、Camera 和 cover 实例的实际后端状态；新增 `camera-input`（system/image/simulated）、`scan` 和 `stop` 操作。先取得当前页面 ID，再显式提供图片或模拟内容。示例与权限/支持边界见 原生组件说明（该内部记录未随源码发行）。F12 Wxapp 的原生组件分区调用相同工具。

## 启动分析扩展

Boot 阶段新增 `runner_crypto_watch` / `runner_slice` / `runner_oracle`，`runner_runtime` 增加 `analysis`、`bootScript`、`defeatAntiHook`；`runner_source` 增加 `graph`。这些能力继续保留，当前总数为 36。配置、逐步调用和边界见 [启动分析](boot-analysis.md)。

## 执行插桩与自动分析

当前版本保留 34 个工具并新增 `runner_execution` / `runner_autopsy`，共 36 个。完整操作教程、F12 对应入口和未知边界见 [执行分析](execution-analysis.md)。新增执行能力要求主控分析协议版本 3；旧主控返回升级要求，不能忽略配置冒充已经启用。

P1 新参数 `summary:true`、`resultCondition`、`preflight` 要求协议 5，旧工具名称和合法调用继续兼容。F12 表单与最短 MCP 调用（该内部记录未随源码发行）说明独立验算、条件匹配、取消／超时产物和版本检查。

## 2026-09-12 加载与 H5 检查

`runner_status.loader` 返回 stage/context 诊断，`status.h5` 给出独立网页 targetId。对 H5 使用相同 runner_snapshot/evaluate/screenshot/gesture/wait 和 debugger(open)；网页自己的 wx SDK 与小程序 worker 的 wx 分离。导航期间求值失效报告 CONTEXT_CHANGED，重新读取状态后决定下一步，不自动重放表达式。

`runner_network` 的 filter 新增 resourceType/state/blockedReason，摘要保留失败与规则命中；例如 `{"after":0,"filter":{"resourceType":"Image","state":"failed"},"limit":20}`。`runner_logs` 可按 `source:"view",level:"error"` 找到 H5 未捕获异常/console.error，保留堆栈及原 CDP 方法。日志在分页后筛选，空 entries 不代表末页：继续 nextCursor，直到 hasMore=false。

初始化来源、局部依赖、后台导出、场景 ID 绑定示例见 [执行分析](execution-analysis.md#启动来源局部依赖与后台导出2026-09-12)。登录后真实页面和本机测试连接（该内部记录未随源码发行）。

## PC 页面 UI 与插件校验诊断（2026-09-12）

`runner_status.current.pageUi` / `stack[].pageUi` 返回所属页面的导航栏与分享菜单状态，`pageUiModules` 给出原 PC 模块来源；`runner_dom`、`runner_screenshot` 可传 `target:"shell"` 检查实际标题栏。

`runner_status.loader.pluginVerification` 返回最近 native 插件校验的状态、provider/内部版本、耗时及明确错误；`runner_logs`/`runner_network` 保留脱敏记录。`PLUGIN_VERIFY_ENDPOINT_UNAVAILABLE` 表示所配置端点返回 404/501，不等于已证明当前业务必须新增端点。接口与边界（该内部记录未随源码发行）。

`runner_runtime start/restart/switch` 新增 `contactsFile`，读取明确指定的宿主元数据快照。`runner_status.loader.pluginContacts` 显示实际注入来源、内部版本、缺失条目和 `lastError.runnerCode`；F12 → Wxapp → 加载链路查看相同摘要。错误文件、版本不符或过期在替换实例前拒绝；读取不到 contact 不会伪造成功。格式、例子和真实数据来源边界（该内部记录未随源码发行）。
## 实时日志补充（2026-09-12）

`runner_logs({source:"realtime",after:0,limit:50})` 或 `runner_events` 查询真实基础库 `operateRealtimeData` 的本地接收记录。`id` 是调试游标，`realtimeId` 是基础库生成的 ID；记录内 `uploaded:false` 表示未上传微信后台。大正文使用 `contentArtifactId` 配合 `runner_artifact({action:"read",id})` 重复读取。默认脱敏，分页根据 `nextCursor / hasMore / gap` 处理。F12 的 Wxapp → 实时日志查看同一记录。完整契约和限制（该内部记录未随源码发行）。

## 图片与音视频预览

`runner_network({filter:{resourceType:"Image"},limit:20})` 查询图片，`resourceType:"Media"` 查询媒体。按 ID 获取 `mimeType`、`responseBodyCapture` 和 `responseArtifactId`；`responseBodyCaptureSource:"cdp-retained-response"` 表示从 Chromium 原响应缓存补全正文。F12 的 Network → Preview 使用同一正文；WAV/WebM 可通过内嵌播放器检查，预览不重新出站。修复与完整边界（该内部记录未随源码发行）。
