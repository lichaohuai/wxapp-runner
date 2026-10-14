# 官方契约账本与固定验证

本轮从随机换包改为先核对公共契约。范围固定为所提供的 JS 基础库 3.17.3、Electron 40.10.6、official 桌面路径；macOS 实测，Windows/Linux 平台待验收。原生 WeChatAppEx 4.1.9 与该 JS 库的发行配套关系未确认。

## 生成与阅读

```sh
npm run audit:native
npm run build
npm run check:loader
```

`audit:native` 重新读取实际文件，并复用原 PC 注册表提取器，扫描逻辑、视图、Worker、PC 适配器和 Runner 的 AST。输出：

- 完整 JSON（该内部记录未随源码发行）：文件清单、官方位置与哈希、入口候选、测试断言、指纹。
- 可读差异表（该内部记录未随源码发行）。
- 未知调用与失败文件（该内部记录未随源码发行）。
- 修复调查队列（该内部记录未随源码发行）：启动、页面资源、PC 常规接口、诊断统计的优先级。
- 固定回归结果（该内部记录未随源码发行）、MCP/F12 结果（该内部记录未随源码发行）。

所有枚举到的文件均记录为扫描成功、失败或非代码资产；解析失败会令审计命令失败。符号别名只有在绑定可确认时才解析。条件调用同时记录两个可确认的字面量分支并保留条件未知；Worker APIList 是允许列表证据，不是调用成功证明。动态加载生成的代码、无法解析的间接调用仍属于覆盖边界。

稳定契约 ID 格式为 `native:<layer>:<channel>:<api>`。layer 的初始来源是官方文件族，实际调用方通过 pageId/contextId/workerId 记录。PC 注册表中的 `host` 与实际 `view` 调用不自动合并；同名方法跨上下文的关系需补证据。

## 三种结论分别判断

- `entry-found`：找到 Runner 的同名分发条件或入口候选；其中可能只是参数拒绝、转发或失败处理，未证明完整实现。
- `not-indexed`：静态索引尚未确认入口；可能是间接分发、公共封装或缺失，不能直接宣称未实现。
- `verification`：只认证显式登记的断言。无绑定时即使有入口或返回 `:ok`，验收状态也为空（尚未分类），不会标记“已实现”。已登记的可验收条目使用约定的四种状态。

当前仍需逐项核实提供方、同步返回、事件与回调形态，以及必需字段和依赖。JSON 中收集的内联对象键／回调读取键是**源码中观测到的字段**，不等于完整参数和返回 schema。实现候选的源码位置是人工核对接线的入口。不能用这份表自动更新 `wx.canIUse`。

验收记录绑定 src、测试脚本、依赖锁、包声明及整个基础库的指纹。最新一次失败、取消、未结束或指纹过期都不能沿用旧通过；生成账本时保留历史原因。通过状态的范围始终是已登记断言，不认证某个 API 的所有分支。

## MCP

沿用原 stdio MCP 和本地连接文件，不新增顶层工具。使用新构建启动的隔离实例后：

```json
{"tool":"runner_status","arguments":{}}
{"tool":"runner_suite","arguments":{"action":"contracts","q":"loadLibFiles","limit":20}}
{"tool":"runner_suite","arguments":{"action":"contracts","contractId":"native:view:invoke:loadLibFiles","details":true,"limit":1}}
{"tool":"runner_suite","arguments":{"action":"contracts","collection":"files","offset":0,"limit":30}}
{"tool":"runner_suite","arguments":{"action":"contracts","collection":"unresolved","offset":0,"limit":30}}
{"tool":"runner_suite","arguments":{"action":"contracts","collection":"scenarios"}}
{"tool":"runner_suite","arguments":{"action":"contracts","exportReport":true,"limit":1}}
```

分页使用返回的 `nextOffset`，同时传回 `fingerprint`；版本变化会拒绝旧游标。默认返回摘要，`details:true` 查看位置和断言，完整账本通过 `artifact.id` 交给原 `runner_artifact` 分页读取。`q` 为字面子串搜索，还支持 layer 和 verdict 过滤。`current:false` 表示正在查看历史账本，其通过状态不能认证当前运行实例。

```json
{"tool":"runner_suite","arguments":{"action":"contractRun","scenarioId":"view-library-batches"}}
{"tool":"runner_suite","arguments":{"action":"get","jobId":"<返回的 contract:...>"}}
{"tool":"runner_suite","arguments":{"action":"cancel","jobId":"<返回的 contract:...>"}}
```

当前登记四个场景：`view-library-batches`（视图批次和真实 WARecordSDK）、`worker-native-isolation`（原 Worker SDK 的隔离请求、Socket、文件及终止）、`foundation-resource-bytes`（WASM 字节、原桥接二进制解码、同步／异步顺序及失败）、`h5-history-and-route`（web-view 更新／移除、历史返回、Navigator 当前路由）。它们新建本地夹具与独立数据目录，不对当前所选真实页面执行测试动作。任务立即返回 ID，最长 180 秒；取消只清理该夹具，不重复提交业务。不同控制器通过本地运行锁串行生成证据。异常强制杀进程留下锁时，应先核对锁内 PID 是否仍在运行；不自动接管活任务。

旧 `catalog/start/list/get/cancel` 页面场景调用保留。`runner_status.contracts` 显示版本、摘要及本实例实际观察到的缺口。实例退出仍可读取账本和任务结果。

## 调用观测

仅在契约夹具或显式调试配置中开启：

```json
{"debug":{"nativeContractCalls":true}}
```

业务执行前启用逻辑／Worker 和视图入口观测，记录调用身份、进入、同步返回、局部回调送达与抛错；不保存参数、正文、code、token 或凭证。默认只保留原有的有界缺口摘要。完整事件进入现有事件环形缓存，状态摘要最多保留 256 组调用方，淘汰计数明确显示。

```json
{"tool":"runner_events","arguments":{"contractId":"native:worker:invoke:createRequestTask","workerId":1,"after":0,"limit":100}}
```

事件过滤仍遵循原来的游标语义：即使某页过滤后为空，也需在 `hasMore:true` 时继续读 `nextCursor`。还支持 callId/contextId。视图转交主进程的异步回调、未经过这些入口的调用仍有观测边界；未收到回执保留 pending/unknown，不能推断失败、成功或完成次数。业务可见效果继续由场景断言验证。

## 原生 F12

Wxapp → **官方契约** 提供摘要、搜索、下一页、按 ID 查看官方证据与 Runner 位置、未知项和场景、完整账本产物、隔离运行／查询／取消。**加载链路** 同时显示版本和实际缺口。F12 与 MCP 读取同一账本和任务服务。

新增构建不会重启现有用户实例；旧进程使用旧代码，不会突然出现新面板或被新报告认证。需要体验新功能时启动新实例即可。

`runner_status.loader.nativeLibraryModule` 提供实际加载的官方 `loadWAFile.ts` 工厂及哈希。读取字节的 `loadWAFile` 与执行辅助 JS 的 `loadLibFiles` 分别验收；原基础库把 native buffer 描述符转换为调用上下文内的 ArrayBuffer。

Runner 本地命名导出的字面字符串／数组／Set 可跨文件索引；集合在本文件和所有已扫描导入方中都必须仅被只读使用。转导出、命名空间导入、修改、逃逸与动态构造仍保留未知。这只补充入口候选，不自动认证支持。

## 后续推进顺序

1. 继续将未确认接收对象、导入绑定和动态分发分类，并补提供方及返回／事件字段证据；不能把未知直接变成支持。
2. 按调查队列逐项建立最小场景，修复公共能力并绑定断言；现有未绑定固定回归逐步补齐明确关联。
3. 扩展关闭／迟到回调、分包／导航、H5／tab、组件／请求等组合测试。
4. 核心契约完成后才进行至少 20 个保留样本、五类用途、连续两轮盲测。

插件远端元数据、支付、包解密和手机专属引擎仍不纳入本轮修复。账本和已有固定回归通过不代表以上四步全部完成，也不是所有小程序永久兼容的保证。
