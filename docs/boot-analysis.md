# 启动期分析与签名定位

2026-09-11 复盘修复：新增 scope/arm/disarm、精确工厂身份、真实探针状态及 local-only 实验模式，需要协议 4 的新主控。旧示例的 scope 默认 all，仍可能在启动时耗尽。请优先使用新的最短教程与验收结果（该内部记录未随源码发行）。

本节保留上一阶段 34 工具的记录。当前已扩展为 36 工具，新增内存执行分析和 Autopsy 见 [最新教程](execution-analysis.md)。

2026-09-11 已修复带插件包在启动分析时的 `Accessor replacement requires an explicit property watch` 故障。新版先保留基础库硬化涉及的白名单属性，再于基础库之后安装探针；原来的 `defeatAntiHook:true + cryptoTap:true` 参数可继续使用。需要重建分析实例，不能热修复旧 realm。真实包和 MCP 失败恢复证据见 Boot 访问器修复（该内部记录未随源码发行）。

本轮新增 `runner_crypto_watch`、`runner_slice`、`runner_oracle`，共 **34 个 MCP 工具**。原 31 个工具兼容。原生 F12 的 Wxapp 面板加入“启动分析 / Crypto 采集 / 执行切片 / 函数 Oracle”。

这是**默认关闭的运行时分析模式**，保留基础库、逻辑 / 视图分离和业务包原文件。它提供可观察的证据，不能承诺任意 VMP 自动去虚拟化或“找到所有签名配方”。

## 启动：先于 app-service.js 执行

连接新版主控，通过 MCP 创建一个额外实例：

```json
{
  "name": "runner_runtime",
  "arguments": {
    "action": "start",
    "packageDir": "/绝对路径/已解包目录",
    "appid": "wx…",
    "analysis": {
      "enabled": true,
      "cryptoTap": true,
      "defeatAntiHook": true,
      "ttlMs": 120000,
      "capacity": 300,
      "captureBytes": 4096,
      "taps": [
        {"target":"String.prototype.charCodeAt","algo":"String.charCodeAt","count":1000},
        {"target":"encodeURIComponent","algo":"encodeURIComponent","count":1000}
      ],
      "bootScript": "globalThis.analysisStartedBeforePackage = true;"
    }
  }
}
```

`appid` 必须填写实际完整值。启动结果带 `runtimeId`、`sessionId`，后续调用可显式指定它们。不要用已有日常实例的 ID 代替新实例 ID。

不指定 profile 时，分析实例自动使用新的 `analysis-…` 数据目录。从普通模式显式 restart 开启分析也默认切到隔离 profile；显式指定 profile 才复用指定数据。原已运行实例不会被 `start` 关闭。新 profile 不包含日常实例的 storage 登录态。

也可在配置 JSON 加入 `analysis` 后沿用原启动命令：

```sh
npm run build
npx electron . --package /绝对路径/解包目录 --appid wx实际完整appid --config /绝对路径/analysis-config.json --mcp --mcp-file /绝对路径/mcp-analysis.json
```

`--boot-script /绝对路径/boot.js` 读取 UTF-8 文件并启用分析；`--defeat-anti-hook` 开启内置对象硬化放宽。MCP 的 `bootScript` 传脚本文本，不是路径；`analysis.bootScript` 也可用。脚本最多 64 Ki 字符、同步执行上限 3 秒。脚本语法在停止旧实例之前校验，执行异常中止新实例启动并恢复受控 patch。

执行顺序：创建业务 VM → **分析白名单属性预留**（仅 `enabled && defeatAntiHook`）→ 基础库初始化 → 结束预留、恢复临时拦截器 → wx realm 桥接和状态采集 → 启动分析 → 用户 bootScript → 第一个业务脚本。预留阶段不装业务 tap、不运行 bootScript。只进入业务 VM，不修改宿主 Node、基础库主上下文或视图 DOM。

**旧主控不能热补启动时机。** 更新构建并重新连接 stdio MCP 后，现有实例可使用 live 采集工具；若旧主控收到 boot 参数，返回 `CONTROLLER_UPGRADE_REQUIRED`，不会忽略参数假装成功。请启动一个新版主控。F12 新入口也需新版主控。

## 硬化放宽的准确范围

`defeatAntiHook:true` 放宽明确列出的内置构造器、原型和 Math / JSON / Reflect 上的冻结、seal、preventExtensions；覆盖 Object.defineProperty / defineProperties 与 Reflect.defineProperty / preventExtensions。

defineProperty **仍然应用调用方要求的值和访问器**，仅在允许的目标上放宽后续修改限制。实际 descriptor 如实反映结果，不伪造 descriptor。普通应用对象仍按正常 JS 规则冻结。Object.prototype 上没有全局 `sign` setter，也不拦截系统其他程序。

这会改变所列对象的 JS 硬化语义，因此是分析开关，不是运行小程序的默认配置。带插件的真实基础库可能在执行业务前，将内置属性及 `define` 等变成不可配置访问器。新版在基础库加载前为明确白名单保留其实际数据属性，不调用这些访问器的 getter，也不尝试给既有不可配置访问器强行写值。`runner_crypto_watch status.preparation` 显示阶段、影响数量、属性清单和截断标记。已经启动的旧 realm 仍无法追溯修复；应用先前捕获的引用、纯闭包内函数和其他 realm 不会凭空替换。它也不隐藏 wrapper 身份、不伪装所有 native 指纹，不能保证绕过所有反调试检测。

tap、放宽和随机源 patch 都有 TTL，默认 60 秒、最大 300 秒。到期/停止后恢复仍属于工具的属性；业务已经替换的属性返回 `restore:"conflict"`，保留新值。保存过的 wrapper 别名停止采集并直通原函数。VM 被暂停或长时间同步阻塞时，定时恢复要等 VM 恢复执行。bootScript 任意自行修改的内容不属于自动回滚范围。

预留阶段放宽过的基础库硬化不能通过停止 tap 还原成原始安全上下文；完整恢复需重建普通实例。启动失败现在通过 `runner_status.state:"failed"`、`logicFailure` 和 error 级日志报告；日志请沿 `nextCursor/hasMore` 读取，筛选后的第一页可能为空。失败实例仍可检查 Inspector、停止或重启。

**次数预算：**这个真实包启动时就会大量调用 `charCodeAt/fromCharCode`。默认 `count:1000` 的两项 tap 在 `App` 注册完成前已耗尽，这是实际计数限制，不能看作安装失败。检查 `status.taps[].remaining/active/restore`；提高 count 仍有上限，重新安装方法上的 tap 不能替换已保存的旧别名。此包的 `utils/md5.min.js` 模块入口由 cryptoTap 实际捕获，适合做函数级输入/输出分析，避免字符级记录淹没缓存。

## Crypto 输入与输出匹配

明确给定算法函数效果最好：

```json
{"name":"runner_crypto_watch","arguments":{
  "action":"start",
  "target":"待寻找的完整输出值",
  "match":"exact",
  "auto":true,
  "count":5,
  "ttlMs":120000,
  "taps":[{"target":{"module":"utils/sign.js","export":"getSign"},"algo":"app.getSign","inputIndex":0}]
}}
```

返回 `watchId` 和操作前的 `cursor`。然后**人工执行原页面动作**，或明确调用已有点击工具。安装 watch 不会替你调用 handler、重发请求或尝试签名组合。

```json
{"name":"runner_crypto_watch","arguments":{"action":"read","watchId":"watch-…","after":0,"limit":10,"revealSensitive":true}}
```

记录含 `callId / parentCallId / runId / algo / phase / input / args / thisArg / output / stack`。`keyIndex` 和 `ivIndex` 可明确指定参数位置；缺失字段不补猜测。`matches` 指向实际相等的观测结果。`match` 支持 exact/includes，当前不支持任意正则。

- 字符串按实际返回值匹配；ArrayBuffer、TypedArray 和 CryptoJS WordArray 可转为十六进制匹配。
- CryptoKey 保持不透明，只能看到业务 API 公开的元数据，不自动 exportKey。
- 原调用的 this、同步返回、抛出的原值保持；不暂停业务线程来逐步取值。
- 默认不观察 Promise 结算。需要 WebCrypto 等异步结果时显式设置 `observePromise:true`。返回给业务的仍是原 Promise，但增加拒绝观察器会改变 unhandled-rejection 的统计，这是该选项的已知影响。
- 自动适配扫描可见全局和实际执行的 define 模块导出；模块尚未执行时不偷偷 require。导出函数在 require 返回给调用方之前包装。闭包内部已捕获函数、内联算法和未公开的私有实现仍可能不可见。
- 适配器包括 CryptoJS 命名函数、WebCrypto、sm-crypto 命名导出、JSEncrypt、forge digest、tweetnacl 和 aes-js 的已知入口。支持的是这些可确认入口，不是所有版本/所有 API。库未出现在运行环境时不会凭空创建它。
- 当前真实算法验收覆盖 WebCrypto SHA-256/HMAC、CryptoJS 4.1.1 的 MD5/SHA256/HMAC/AES、sm-crypto 0.5.7 的 SM3 标准向量/SM4 往返/SM2 签名验证与采集。JSEncrypt、forge、tweetnacl、aes-js 和其他版本矩阵仍是“已实现未验收”。`status.taps` 和 `notices` 是实际安装结果。

boot cryptoTap 也会预置所列第三方库全局名的可配置 getter/setter，赋值时同步安装探针；这会改变 `"CryptoJS" in globalThis` 等存在性判断。没有 WebCrypto 时不会给 `crypto` 预置此监听器。关闭会删除未赋值的全局监听器。

如业务 VM 原本无 WebCrypto，可在分析配置显式加 `webCrypto:true`，使用 Node 实际 WebCrypto 的 realm facade，支持 digest、HMAC、AES 等其原有能力。它不安装任何第三方算法包，不模拟算法结果。

`stop` 带 watchId 只停该匹配器；**不带 watchId 会恢复本 realm 的全部受控启动分析 patch，清除 oracle 句柄**，再次启动完整采集需新 realm。`runner_hook` 是独立的旧钩子管理器，不受这里的 stop 影响。

## 可控随机与时钟

分析启动配置可以加入：

```json
{"enabled":true,"randomSeed":42,"now":1700000000000,"webCrypto":true}
```

只固定业务 realm 的 `Math.random`、公开 `crypto.getRandomValues`，以及 `Date.now`。不改宿主 RNG、网络 TLS 随机数、WebCrypto 内部 generateKey/encrypt 的随机数、`new Date()` 或 performance 时钟。不要将此模式生成的随机值当作安全随机数使用。

```json
{"name":"runner_crypto_watch","arguments":{"action":"resetRandom","seed":42}}
```

必须已经从 boot 开启且随机 patch 尚未过期。相同种子加相同调用顺序才会得到相同序列；不会自动固定异步调度、远端时间或其他输入。

## 执行切片、属性写入和两次对比

给已确认函数设一个“不暂停的调用探针”：

```json
{"name":"runner_slice","arguments":{
  "action":"start","target":"getApp().utils.request","count":1,"ttlMs":60000,
  "probes":[
    {"target":"JSON.stringify","algo":"JSON.stringify"},
    {"target":"Array.prototype.join","algo":"Array.join"}
  ]
}}
```

返回 `runId`，**只装探针，不调用函数**。在原界面执行一次动作后：

```json
{"name":"runner_slice","arguments":{"action":"read","runId":"run-…","limit":20,"revealSensitive":true}}
```

boot 模式用 AsyncLocalStorage 传播 `runId/callId` 到调用时产生的异步任务，网络记录同时带 `context.analysisRunId`、`context.analysisCallId`，不会靠时间接近归因。只有 live 模式而无 boot host 时，仅提供同步调用栈关联，`status.coverage.asyncContext:false`。

记录是**观测切片，不是去虚拟化伪代码**。直接 `+` 拼接、任意属性读写、未装 probe 的局部调用没有证据，不出现在结果里；dispatch 噪声通过只记录选定入口减少。`phase:return` 表示函数返回，不表示页面业务完成。返回 Promise 的根函数尤其不能据此判业务成功。

属性写监视需要一个具体、已经存在、可配置且可写的自有数据属性：

```json
{"name":"runner_slice","arguments":{"action":"watchProperty","target":"getApp().requestHeaders['X-Sign']","ttlMs":30000}}
```

返回 `propertyId`；写入保留新值并记录之前值、实际值和栈。`removeProperty` 恢复原数据属性并保留最后业务值。访问器、冻结属性、继承属性拒绝；不宣称能监视“任意对象中叫 sign 的字段”。

同一动作分别 arm 两次、取得两个 runId。只改一个输入后比较：

```json
{"name":"runner_crypto_watch","arguments":{"action":"diff","runA":"run-A","runB":"run-B","limit":20,"revealSensitive":true}}
```

对比的是观测到的返回序列和输入/输出；ordinal 对齐不是数据流证明，分支或调用数量变化需要人工解读。请求字段继续用 `runner_network {action:"diff",idA,idB}`。可从网络 `fields:["id","url","context.analysisRunId"]` 找到相应请求，不需要重新执行 handler。

## 会话内签名函数 Oracle

```json
{"name":"runner_oracle","arguments":{"action":"export","target":{"module":"utils/sign.js","export":"getSign"},"ttlMs":60000}}
{"name":"runner_oracle","arguments":{"action":"call","oracleId":"oracle-…","args":[{"field":"test"}],"revealSensitive":true}}
```

export 只保留实际函数和 receiver 的句柄；call 明确执行一次，不重放原页面 handler、也不自动重试失败。函数自身如果发请求或写数据，仍会执行这些业务效果。默认不等 Promise，需显式 `awaitPromise:true`。返回 pending 或工具超时，不等于函数没执行，不能自动重复提交。

句柄有期限、绑定 realm/session，重启后失效。这不是脱离应用依赖的独立算法导出，也不会开放 HTTP 签名服务。list/remove 管理句柄。

## 模块依赖与符号

```json
{"name":"runner_source","arguments":{"action":"graph","path":"utils/sign.js","offset":0,"limit":20}}
```

列出原 define 工厂中的字面量 require 边、exports 赋值和语法调用点，附真实文件/行列。每类条目上限 40；达到上限标记可能截断。这不是推导出来的完整动态 callgraph。原 list/get/search/locate 继续可用；get 仍返回原工厂，不修改业务 bundle。

## 缓存、脱敏与验收

- 事件环形缓存默认 300、最大 2,000；值预览默认 4 Ki 字符/字节，最大 16 Ki；二进制用 hex，明确 truncated。
- 每个 tap 默认最多 1,000 次调用、最大 10,000；达到后直通原函数。512 个 patch、64 个 watch/oracle、100 个 run 上限。TTL 过后 API/记录仍可读，但可能已经没有活动探针，请检查 status。
- read 提供 after/nextCursor/hasMore/gap；工具额外按约 128 KiB 限制分页输出。环形缓存已淘汰的内容不会声称完整；没有暗中保存一份“完整原像”产物。
- 参数、输入、receiver、key、iv、输出和属性值默认隐藏；只有 `revealSensitive:true` 才读取原值。通用事件流只传采集元数据和关联 ID，不传密钥或原像。不要把带原值的输出发进公开报告。
- 修改仍经过原实例写入队列与控制租约；状态和读取不等待另一个客户端持有的写租约。F12 与 MCP 共用同一套实现。

| 范围 | macOS 状态 | 证据/限制 |
|---|---|---|
| boot 顺序、freeze 后别名、恢复、语法失败保留旧实例 | 验收通过 | VM 回归 + 实际基础库/MCP |
| 确定性 Math.random / getRandomValues、类型和配额 | 验收通过 | 两 realm 相同种子、配额错误、TTL |
| WebCrypto SHA-256/HMAC、实际输出匹配 | 验收通过 | 实际 Node WebCrypto + MCP SHA-256 |
| 同步 return/throw、异步操作乱序、请求关联 | 验收通过 | 真实本地 HTTP 出站与 AsyncLocalStorage |
| 具体属性写监视、oracle 单次调用、符号图 | 验收通过 | 隔离夹具及原值/调用次数断言 |
| F12 入口与多客户端只读 | 验收通过 | 原生 Wxapp 面板 + 标准 MCP |
| CryptoJS 4.1.1 / sm-crypto 0.5.7 的上述算法 | 验收通过 | 实际库与原始参数/返回值断言 |
| JSEncrypt / forge / tweetnacl / aes-js 与其他版本矩阵 | 已实现未验收 | 入口适配已写，不能以夹具冒充所有算法通过 |
| Windows / Linux | 平台待验收 | 本轮只执行 macOS |

Boot 层不提供 V8 opcode 后端、通用 Chaos VM/VMP 反虚拟化或独立算法脱壳。后来加入的 AST 执行记录、已插桩代码字段写监视、保守模块变换及 Autopsy 见[执行分析](execution-analysis.md)，不能覆盖未插桩／native 内部和未执行分支。P1（该内部记录未随源码发行）增加步骤摘要与独立验算，不把一次数值匹配称为完整算法。

[Inspector Debugger 官方能力列表](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/) 提供断点、单步、源码及调用帧等能力；当前方案没有底层 JS opcode 流。不能给已有按钮改一个名字就称为完整去虚拟化。

回归命令：`npm test`、`npm run typecheck`、`npm run smoke:boot-analysis`。端到端证据：boot-analysis-result.json（该内部记录未随源码发行）。所有修改性测试使用隔离 profile 和本地夹具，真实账号小程序未参与随机固定、改原型或签名重算测试。
