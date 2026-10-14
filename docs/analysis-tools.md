# Hook、模块源码和精简网络查询

2026-09-11 更新：同名工厂使用 `factoryId` 精选或 `current:true` 读取实际执行工厂；已观察到的模块支持默认函数导出 Hook。这些功能需要新版主控／Boot 观测，不能依靠重连 stdio 给旧实例补装。见复盘修复教程（该内部记录未随源码发行）。

本次补上 P0 的受控函数 hook 与网络过滤，以及 P1 的模块工厂源码、符号定位、请求 diff。MCP 共 **34 个工具**。原生 F12 的 Wxapp 面板增加「函数 Hook」「模块源码」，「请求」增加过滤和 diff。已有 Console、Sources、Network 保持原有入口。

**当前达利不用关闭或重启。** 重新连接 MCP 客户端即可加载新工具；旧主控通过 stdio 兼容层执行同一分析实现。新版 F12 入口随下次启动主控加载。本次没有在用户运行的达利上安装 hook、执行函数或重放业务请求，只做了只读查询；动态测试使用隔离夹具。

## 一次典型分析

以下是工具名和参数。先查看定义和导出名称，再对实际目标安装 hook。

```text
runner_source({"action":"search","q":"getSign","limit":10})
runner_source({"action":"get","path":"utils/utils.js","length":12000})
runner_hook({"target":{"module":"utils/utils.js","export":"getSign"},"capture":["args","return","stack"],"count":5,"ttlMs":30000})
```

之后正常点击小程序页面，由**原 handler**调用原函数；工具本身不会为采样自动调用 getSign。用返回的 hookId 读取记录：

```text
runner_hook({"action":"read","hookId":"返回的 UUID","after":0,"limit":10})
runner_network({"after":0,"filter":{"bodyIncludes":"sign","source":"logic"},"fields":["id","url","method","status","handler"],"limit":20})
```

这份包没有该导出名时，先按源码结果选择实际路径。可以直接 hook 运行时对象属性：

```json
{"target":"getApp().utils.request","capture":["args","return","this","stack"],"count":5,"when":"args[0].url === '/example'"}
```

## runner_hook

| 参数 | 含义 |
| --- | --- |
| action | install（默认）/ list / read / remove |
| target | `getApp().utils.request`、`globalThis.someFunction` 等属性路径；或 `{module,export}` |
| capture | args / return / this / stack，默认 args、return、stack |
| count | 最多匹配次数，默认 5，上限 1000 |
| ttlMs | 有效期默认 30 秒，上限 5 分钟；未命中也会到期撤除 |
| capacity | 环形缓存条数，默认 50，上限 200 |
| when | 只读条件，可用 `args`、`thisArg`、字面量成员访问、比较和布尔运算 |
| after / limit | read 的记录游标和页大小；缓存淘汰返回 gap，不清空缓存 |
| revealSensitive | 默认脱敏；读取原始敏感参数需显式 true |
| allowModuleLoad | 默认 false。无法确认模块已加载时，拒绝自动 require；显式 true 允许初始化模块 |

```text
runner_hook({"action":"list"})
runner_hook({"action":"remove","hookId":"指定 UUID"})
```

实现只替换选中对象的一个函数属性，保存原属性描述符，以 Proxy 转发调用；返回值、Promise 对象、this、构造调用及抛出的原始值保持原语义。达到次数、原函数同步抛错或 TTL 到期时恢复。递归调用的记录按进入顺序排列，最后一次命中在调用原函数前恢复，避免递归超过次数。

目标被其他代码换成新函数时，不覆盖新值，结果报告 `restore:"conflict"`。只读/访问器目标在替换前拒绝；条件不允许函数调用、赋值或构造表达式，也不执行访问器。每个逻辑上下文最多 16 个活动 hook，保留最多 100 个 hook 的元数据。

### 必须区分的边界

- hook 是属性拦截；业务在安装前保存的函数别名、闭包中的直接引用不会被自动替换。
- return 捕获**同步返回值**。Promise 原样返回，不额外挂 then/catch；不会把 Promise 的最终结果冒充同步 return，也不改变未处理 rejection 的归属。
- 参数快照有深度、条数和字符串长度限制，截断明确标记；不会执行普通对象 getter。Proxy 的反射陷阱仍可能有用户代码行为，受控 hook 不等于隔离沙箱。
- 环形记录重复读取不消耗。单次读取按约 64 KiB 限制分页；用 nextCursor 继续。调用栈仅记录可观察位置，不靠时间相近自动关联其他请求。
- TTL 使用 VM 的定时器。线程暂停或阻塞时不能执行恢复代码，恢复运行后处理到期；MCP 断开不会永久留下 hook，但不保证当场打断暂停中的 VM。新版主控的 hook list/read 不占业务写队列；旧主控兼容路径仍受既有 evaluate 控制通道约束。
- 安装期间函数引用身份会暂时变化。`restore` 字段才是恢复结果依据，不能仅凭 remove 命令送达认定恢复成功。

## runner_source

```text
runner_source({"action":"list","offset":0,"limit":50})
runner_source({"action":"get","path":"utils/utils.js","offset":0,"length":12000})
runner_source({"action":"search","q":"CryptoJS","offset":0,"limit":20})
runner_source({"action":"locate","target":"getApp().utils.request"})
```

list 扫描本地逻辑 bundle 和分包中的 `define("路径", factory)`，返回模块路径、所在文件、起止位置和摘要。`total` 是定义数，`uniqueModules` 是不同模块路径数；同一路径可能出现在不同 bundle。它是静态目录，**不代表模块已加载**。

get 返回原始 factory 源码，偏移单位为 UTF-16 字符；search 返回模块、文件、行、列和短上下文，偏移单位为匹配项。不同文件中的同名工厂内容不同时，用 `file` 显式选择，避免猜一个版本。行/列均从 1 开始，单行压缩代码也提供列号。

locate 使用 V8 `[[FunctionLocation]]` 映射实际脚本位置和模块范围，不依赖 toString 猜测。若函数实际位于共享解释器或包装层，返回其真实位置；没有可信位置就报告 found:false，不假装还原被 VM 化的源函数。

静态扫描不执行 factory，不下载新分包，不写业务包；文件变更会使缓存失效。暂不承诺识别所有 webpack/VMP 自定义模块格式。原始工厂提取已实现，通用 VMP 去混淆和自动还原原始源码尚未实现。

## runner_network

列表默认 summary:true，保留 id/cursor/url/method/status/state/source、实际可取得的 bytes、handler、操作 ID 和正文 artifact ID，不再默认输出整份 header 与调用栈。

```json
{"after":0,"limit":20,"filter":{"urlIncludes":"/api/","bodyIncludes":"sign","source":"logic","hasBody":true,"status":[200,500]},"fields":["id","cursor","url","method","status","handler"]}
```

filter 条件按 AND 组合；fields 支持点路径，如 `context.handler`。不传 after/filter 时保持原来的最近记录数组形式；分页/过滤返回 entries、nextCursor、hasMore、scanned 和 gap。游标按**已检查的原始记录**推进，过滤掉的记录不会导致反复扫描或跳过下一页。maxScan 默认 200，上限 1000；存在后续记录时继续使用 nextCursor。

列表为按创建游标查询的当前快照。进行中的请求以后可能更新同一个 ID；等待响应结束请使用 `runner_wait` 或继续按 ID 检查，不能把创建游标当成状态变更流。

bodyIncludes 检查当前可读的请求/响应正文预览，每个正文最多 256 KiB；未匹配但正文被截断、淘汰或不可读时，返回 filterIncomplete/unsearchedBodies。二进制不按 base64 字符串冒充文本匹配。需要完整大正文时，通过 artifact 读取后分析。

```text
runner_network({"id":"请求 ID"})
runner_artifact({"action":"read","id":"responseArtifactId","offset":0,"length":262144})
```

按 ID 默认给 4 KiB 正文预览，保留兼容的 requestBody/responseBody 文本字段，增加 requestBodyPreview/responseBodyPreview，其中包含 parsed、encoding、truncated 和 artifactId。完整 JSON/表单才解析，不把截断的 JSON 当成完整结构。可显式设置 previewBytes，最大 256 KiB。F12 原生 Network 仍从原缓存读取完整正文，MCP 预览不会消耗它。

```json
{"action":"diff","idA":"请求 A","idB":"请求 B"}
```

diff 比较 method、URL、query、请求头和请求正文，以 JSON Pointer 路径列出 added/removed/changed。使用 offset/limit 分页；单个较大变化值只显示 1 KiB 预览并标记 truncated，完整正文沿返回的 artifact 引用读取。它不重发请求。缓存不完整会标记 incomplete，变更超过 200 项标记 truncated；默认先脱敏再比较。仍使用 `runner_replay` 执行显式重发，应用算法重算使用已有 evaluate，工具不推测签名配方。

## 其他输出投影

logs/events/trace/state 增加可选 fields，保留身份、分页和游标元数据，对 entries/instances/pages/registrations 中的记录进行投影。点路径输出为同名字段；不传 fields 时保持原有数据形状。

```text
runner_logs({"after":0,"limit":20,"fields":["id","level","message","context.handler"]})
runner_events({"after":0,"limit":20,"fields":["id","source","type","operationId"]})
runner_state({"fields":["id","kind","route","instanceId"]})
```

## 本次结果及未完成项

| 能力 | macOS | Windows/Linux | 证据 |
| --- | --- | --- | --- |
| Hook 条件、次数/TTL、异常恢复、递归和环形缓存 | 验收通过 | 平台待验收 | tests/analysis.test.ts |
| 原始模块提取、搜索、V8 符号定位 | 验收通过 | 平台待验收 | analysis-result.json |
| 网络过滤/摘要/投影、正文 artifact、请求 diff | 验收通过 | 平台待验收 | analysis-result.json |
| 标准 MCP、真实基础库及新版 F12 入口 | 验收通过 | 平台待验收 | analysis-result.json |
| 当前达利旧主控只读兼容 | 验收通过 | 平台待验收 | analysis-dali-readonly-result.json |

达利实测同一批 35 条网络记录从 119,381 字节缩减到 15,142 字节；筛选带 sign 的逻辑请求并投影后，5 条结果为 834 字节。扫描主包和本地分包得到 220 个定义、193 个不同模块路径，getSign 搜索命中 3 处。这些数值是当次快照，不是固定包规模。

**尚未实现**：任意 evaluate 自动回滚所有全局/原型、通用 VMP 去混淆、自动还原共享解释器中的原函数、按函数命中自动暂停的断点模式。当前 when 是条件采样，pause/step 仍走原 debugger 工具。Node 目标的 `trace:false` 指 Chromium Tracing 性能域能力，不应为了函数 hook 将其改成 true。

`runner_evaluate` 仍执行真实代码，其副作用和已发出的请求不能承诺回滚。本次自动恢复保障限定为 runner_hook 管理的目标属性，不能称作任意 JS 沙箱。

运行回归：`npm test`、`npm run smoke:analysis`。验收报告不保存真实凭证、原像或签名；真实达利仅执行只读查询，动态采样使用隔离夹具和本地 HTTP 服务。

后续新增：启动分析、crypto watch、执行切片与会话内 oracle，详见 [启动期分析](boot-analysis.md)。原工具接口和受控 hook 的恢复语义保持。
