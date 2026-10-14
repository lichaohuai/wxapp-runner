# JSAPI 状态

2026-09-13：native `batchGetContact` 已接入显式宿主数据快照，支持异步回调、重复读取、缺失／过期错误；启动前向原基础库注入 `appContactInfo`。原 SDK 本地插件 HTTP / setData 流程验收通过。真实 contact 自动取得及真实插件账号业务仍未验收，不合成域名或校验成功。元数据通路（该内部记录未随源码发行）。

2026-09-12 最新增量：`operateRealtimeData` / `onRealtimeDataResponse` 的本地接收后端验收通过，覆盖原 SDK 页面统计与事件入口、异步回执、F12/MCP 及正文缓存。**微信后台上传仍未实现**，不是云数据库实时订阅。契约和验收（该内部记录未随源码发行）。

2026-09-12：SDK 原函数默认保留，管理器/事件不再通用桩替换。已验证 RecorderManager 的原失败事件、RealtimeLogManager 原对象契约、App show/hide 监听与解绑；**录音采集和实时上传后端仍未完成**。标准 show/hide/setTabBarItem/setTabBarStyle 已复用原 PC 模块，并验证实际视口、样式、文字和图标。结果与能力边界（该内部记录未随源码发行）。

2026-09-12 新包回归：`getAppBaseInfo().host` 保持对象契约；`plugin://` 导航由原基础库解析公开页面；`hideToast` 的普通/插件调用均已接通并验收。旧 `createCanvasContext` 的字体测量、实际线条/色块绘制及 draw 回调通过真实像素检查，完整 Canvas API 仍未验收。范围及结果（该内部记录未随源码发行）。

`wx.request` 的 HTTP/2 响应头桥接已修复：gzip JSON、302、多个 Set-Cookie 及原始/解码正文重复读取有本地 TLS 回归，真实肯德基配置与携程响应复测通过。F12/MCP 正确标记 h2 和未知头压缩大小；大正文预览截断不等于业务收到截断内容。账号和完整业务结果仍分别验收。记录（该内部记录未随源码发行）。

新增 `wx.createWorker`：通过真实基础库创建独立 Worker，原 `worker.onMessage/postMessage` 与 terminate 接线。新增启动前发送快照、绑定取消、原 SDK ArrayBuffer 消息及宿主跨 realm 消息图回归；监听器错误通过原 EventEmitter 错误接口进入日志。已验收两个业务 Worker、request、SocketTask、下载→上传、异步 getFileSystemManager、Node/DOM 隔离、终止时中断请求和 F12/MCP。Worker 允许列表来自原 WMPF 模块；同步 FS、所有 Worker API/Transferable 不因本行通过而视为完整实现。结果（该内部记录未随源码发行）。

2026-09-12 Socket 最新增量：createSocketTask / operateSocketTask / onSocketTaskStateChange 已接通；原 SDK 的文本/二进制、协议协商、关闭、握手拒绝/超时及 F12/MCP 验收通过。WSS TLS 场景、独立业务 Worker 路由和商业插件授权单列。状态与边界（该内部记录未随源码发行）。

2026-09-12 最新增量：`createUploadTask[Async]` / `createDownloadTask[Async]`、对应 operate / listen native 任务已接通。真实基础库上传/下载、headers/progress、取消、超时和 F12/MCP 正文验收通过。公共 downloadFile 同时支持 filePath；当时未通过的原生 SocketTask 更新见上方，商业插件授权仍单列。详情（该内部记录未随源码发行）。

2026-09-12 增量：接通 `createRequestTask` / `createRequestTaskAsync` / `operateRequestTask` / `listenRequestTaskStateChange` / `checkNetworkAPIURL` native 契约。真实基础库的 JSON/二进制/分块/取消/超时、F12/MCP 正文验收通过；当时商业插件 verifyPlugin 与其 Upload/Download/Socket 原生任务未通过；Upload/Download 更新见上方最新增量。详情（该内部记录未随源码发行）。

2026-09-12：`getLogManager` 改为委托真实基础库的同步管理器，启动与 onError 调用回归通过；不代表日志文件持久化或微信后台上传通过。跨包抽查与未解决边界（该内部记录未随源码发行）。

2026-09-12 复入修复：补齐标准底栏角标四个 API，修复未读消息到达后再次进入消息页卡骨架屏；真实包连续三次复入与 224 项单测通过。复现、原因与回归（该内部记录未随源码发行）。

2026-09-12 新增：`wx.getRendererUserAgent` 返回真实视图 UA，Promise<string> 与 success({userAgent,errMsg}) 跨 realm 回归通过，真实消息 SDK 初始化通过。HTMLWebView 的加载/导航/消息子集、H5 隔离及页面自有 wx SDK 已通过本地与闲鱼地址页验收，详见 本轮结果（该内部记录未随源码发行）。未实现完整 H5 微信 JSAPI。

本次新增：`getPrivacySetting`、`onNeedPrivacyAuthorization`、`requirePrivacyAuthorize` 委托真实基础库，双框架的查询、拒绝、按钮校验、显式同意验收通过。`openPrivacyContract` 已委托，宿主网页打开仍为已实现未验收。导航参数的中文/emoji/百分号/加号/嵌套 URL 已专项验收；达利原页面城市与活动详情通过，详见 记录（该内部记录未随源码发行）。

当前全覆盖增量的权威状态见 全覆盖矩阵（该内部记录未随源码发行）。以下历史清单只代表所列旧场景，不代表 356 页新范围已通过。

新增：模拟设备/传感器/BLE/Wi-Fi，真实基础库云 SDK 与数据库只读任务，双框架原生 VideoContext 后端。状态和证据见链接，未完成 Canvas/WebView/XR 等不能算通过；Map/Camera 新增子集见下文。

新增调试能力：`wx.getLocation` 可通过 F12 → Wxapp → 定位 / `runner_state(action:location)` 显式使用模拟坐标；默认关闭，保留原授权和回调，重启恢复系统模式。官方示例渲染验收通过，见 模拟定位验收（该内部记录未随源码发行）；不代表系统真实定位验收通过。

新增：`getSkylineInfo` / `getSkylineInfoSync` 委托真实基础库，native 按 PC 常量返回不支持；同步结果及 success/complete 见 专项验收（该内部记录未随源码发行）。`wx.worklet` 不安装，返回 undefined。`require.async` 已接本地 native 分包任务，见 分包回归（该内部记录未随源码发行）。

“已实现”表示存在实际实现；只有 README / smoke 报告列出的流程经过真实包验收，不代表全部参数均兼容微信。

| 状态            | API / 功能                                                                                                            | 说明                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 验收通过          | App / Page 生命周期、setData、tap / input、分类重渲染                                                                 | 真实基础库处理；原 handler 日志可见                                                                          |
| 验收通过          | navigateTo / navigateBack / switchTab                                                                                 | 独立页面视图、返回保留状态、tab 缓存                                                                         |
| 验收通过        | redirectTo / reLaunch                                                                                                 | 同一页面栈机制；导航回归覆盖实际页面装载，不代表全部业务参数                                                 |
| 验收通过          | request                                                                                                               | 原包 GET 及新包真实登录 POST 出站 200；本地测试验证 POST JSON 和 HTTP 403 回调语义                           |
| 验收通过          | getStorageSync / setStorageSync / removeStorageSync、clearStorageSync、异步 storage、getStorageInfo                   | 按 appid 落盘；未实现微信精确 quota / batch 语义                                                             |
| 已实现未验收          | setNavigationBarTitle                                                                                                 | 更新宿主导航栏标题                                                                                           |
| 已实现未验收          | getSystemInfo(Sync)、getAppBaseInfo、getWindowInfo、getDeviceInfo、getMenuButtonBoundingClientRect                    | 桌面模拟信息                                                                                                 |
| 验收通过 | showToast、hideToast、showLoading、hideLoading、showModal、showActionSheet                                                       | toast/loading 遮罩等待、modal editable、action sheet 人工/MCP 回复及取消已通过隔离回归                       |
| 已实现未验收      | createSelectorQuery、nextTick、createIntersectionObserver、createAnimation、getLaunchOptionsSync、getEnterOptionsSync | 使用真实库实现；复杂节点/原生组件未全测                                                                      |
| 验收通过        | downloadFile、uploadFile                                                                                              | 统一真实传输；流式上传/下载、进度、abort/timeout、multipart 字段与文件信息；本地隔离网络回归                 |
| 验收通过        | connectSocket / SocketTask                                                                                            | 真实 WebSocket 文本/二进制、on/off 监听、send/close、错误与帧日志；本地服务及原生 Network Messages 验证      |
| 已实现未验收          | chooseImage、chooseMedia、chooseMessageFile                                                                           | 运行时选择请求 + 系统文件选择器 / MCP 回复，验证路径、类型、数量；不含拍摄与微信聊天记录来源                 |
| 已实现未验收          | saveFile、getFileSystemManager                                                                                        | read/write/access/mkdir/unlink/readdir/stat/save 的同步/异步子集；不含 unzip、文件描述符、压缩读取等完整 API |
| 已实现未验收          | setClipboardData / getClipboardData、makePhoneCall、previewImage                                                      | 桌面剪贴板、tel 链接、单张预览；本地 wxfile 图片和完整预览手势未全支持                                       |
| 验收通过          | login                                                                                                                 | 新包历史业务登录已通过；本轮原 appid 独立 wx.login→wxbot 返回真实 code，后续业务登录未重测                   |
| 已实现未验收  | getUserProfile / getPhoneNumber、云写入和云文件                                                     | getUserInfo/原页面云函数/MCP 数据库只读已独立通过；本行能力待分别验收                                                       |
| 验收通过        | getSetting / authorize / openSetting 的 scope.userLocation 子集                                                       | 双框架隔离夹具验证授权拒绝、设置显式修改与 MCP 回复；其他 scope 与订阅状态未实现；精确原生时序待核对        |
| 已实现未验收    | getLocation 的 macOS 真实坐标成功分支                                                                                   | CoreLocation + WGS84/GCJ02；拒绝/取消/校验验收通过；本机系统定位关闭，真实位置和业务成功待验收              |
| 验收通过 | 旧 createCanvasContext 的字体测量、fillRect、线条与 draw 回调子集 | 服务实际测量、视图实际像素回读；不包括完整公开 OffscreenCanvas/WebGL |
| 失败          | 广告、完整音频/直播、其余 Canvas native、XR/Skyline/AI、剩余硬件 API                                                       | 保留原 SDK 工厂及事件语义；缺失 native 返回明确失败，不承诺媒体/引擎后端已实现                                     |

`canIUse` 仅报告直接实现或委托的 API 名，暂不支持微信全部点分参数探测语义。原生字体、输入法、系统指标与基础库广告/遥测不是微信真机环境，可能有诊断警告。WXS/组件能力交给原库，但本次未提供专门覆盖全部特性的测试包。

调试能力、MCP 36 个工具、手势/等待与分阶段回归单独列在 v1 覆盖矩阵（该内部记录未随源码发行）。

模拟能力注册表通过 runner_device(action:capabilities) 查询。requestPayment 属于排除项并返回失败，canIUse 不报告支持支付。

## Map / Camera 新增子集

| 状态 | 能力 | 边界 |
| --- | --- | --- |
| 验收通过 | Map 标记点击及 getCenterLocation；cover-view/image 显示、点击、滚轮、动态销毁重建 | 双框架隔离回归，不代表全地图 SDK |
| 验收通过 | Camera 显式图片/模拟输入、onCameraFrame、scancode；wx.scanCode 模拟完成 | 非首个页面、中文/emoji、真实 QR 图片识别、旧 ID 拒绝 |
| 验收通过 | scope.camera 权限保存、明确拒绝、设置修改与定位权限隔离 | 不代表系统摄像头取流成功 |
| 已实现未验收 | 真实电脑摄像头、普通模式 takePhoto | 录像/硬件变焦/完整设备控制仍缺实现 |
| 已实现未验收 | openLocation / openMapApp 目的地预览、其余 MapContext 子集 | 不含外部应用唤起、线路规划、语音导航 |
| 平台待验收 | Windows/Linux | 本轮只验收 macOS |

精确范围及证据（该内部记录未随源码发行）。

## 2026-09-12 随机新包缺口跟进

导航标题/颜色/loading 与 show/hide/updateShareMenu 委托原 PC 模块，按页面保存状态及异步回调；BackgroundFetchToken 支持真实注册/读取，未实现 OS 预拉取。原 node Canvas 2D 已由逻辑层真实绘制并回传原视图，双框架像素和动画取消回归通过；不是完整 WebGL/OffscreenCanvas。分享只提供本地预览，实际对外发送不可用。

原 native verifyPlugin 已接独立 bot CGI，协议/本地服务测试通过；生产端点未部署，返回明确错误。call_plugin_info 仍缺，功能页失败不算修复。逐项验收（该内部记录未随源码发行） · bot 契约（该内部记录未随源码发行）。

## 基础库资源与路由补充（2026-09-13）

`loadWAFile`／`loadWAFileSync` 是 native 桥接入口：读取提供的基础库文件（包括 WASM），不混用业务目录，也不执行读取的 JS。逻辑与视图复用官方 PC 工厂，通过原基础库的二进制桥接还原结果。`getCurrentRoute` 返回官方 Navigator 的 `route`／`currentRoute` 字段；隐藏页面查询时仍读取当前栈顶，返回导航后随栈恢复。具体验收见 第二批契约报告（该内部记录未随源码发行）。
