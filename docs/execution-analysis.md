# S / A / B 执行分析：测试入口与边界

最新 闲鱼 AWSC 实测（该内部记录未随源码发行） 已进入真实解释器式函数并修复逗号表达式断链，但其跨实例字节一致性未通过。不同真实样本的结果分别验收，不将某个样本通过推及所有 VM。

当前提供 **36 个标准 MCP 工具**。保留原有 34 个，新增 `runner_execution`、`runner_autopsy`；原生 **F12 → Wxapp** 使用相同服务。基础库之后、业务代码之前安装分析入口；仅改写内存中的选定业务脚本，包文件不变。

本版已在真实本地 Chaos 模块上验证请求等价、字段切片、MD5 及完整请求函数的捕获复算；改变 params 后的请求与原函数一致。它报告这一次执行的依赖和未知边界，不代表已经恢复任意 VM、任意输入下的完整算法。

## 最短测试流程

1. `npm run build` 后启动新版主控。MCP 使用 配置示例（该内部记录未随源码发行），是 stdio 连接，不是浏览器 URL。已有旧主控不能热补 Boot 插桩。
2. 通过下面的 `runner_runtime start` 新建隔离分析实例；`packageDir`、`appid` 填目标包，`modules` 填 `runner_source list` 返回的实际模块路径。可留空采集全包，但较慢、容易触发事件上限。
3. F12 → Wxapp → **请求**，展开目标请求，点 **分析此请求的字段来源**，提交分析参数。看到 `waiting-manual-action` 后，在原小程序里操作一次。也可由 MCP 明确指定一次点击。
4. F12 → **Signer Autopsy** 读取报告，检查字段、`selection.precision`、中间值和 `opaqueBoundaries`。勾选“显示敏感字段”才显示原值。
5. 点报告中的 **准备复算**，填写新参数再提交；通过 **执行反虚拟化** 比较两次 run，通过 **分析产物** 读取或导出完整报告。Oracle 调用会执行真实函数，只有明确调用才执行。

```json
{
  "action": "start",
  "packageDir": "/绝对路径/已解包目录",
  "appid": "实际 appid",
  "analysis": {
    "enabled": true,
    "cryptoTap": true,
    "defeatAntiHook": false,
    "ttlMs": 120000,
    "execution": {
      "enabled": true,
      "files": ["app-service.js"],
      "modules": [],
      "capacity": 50000,
      "maxEvents": 50000,
      "ttlMs": 60000
    }
  }
}
```

以上参数交给 `runner_runtime`。不传 profile 时使用独立 `analysis-…` 数据目录。`start` 创建额外实例；`restart/switch` 会替换选定实例。显式文件或模块不存在、语法不能解析时，预检失败并保留原运行实例。后续分包仍按相同选取规则处理，`files` 是精确包内路径。

无 bot、无账号测试可运行 `npm run smoke:execution`，它自动生成临时包、启动本地 HTTP 服务和真实基础库，测试结束清理实例。

也可以从仓库目录启动本地包，替换下面的路径与 appid：

```sh
npm start -- --package /绝对路径/已解包目录 --appid 实际appid \
  --config config.execution.example.json --mcp \
  --mcp-file .local/mcp-analysis.json --devtools
```

需要真实账号时，把示例中的 `analysis` 字段合并到原私有配置，再传该配置路径；示例文件本身不含 bot 密钥。MCP 客户端的 `--connection` 指向这里生成的连接文件。

## MCP：选择请求并分析

所有示例中的 ID、模块、选择器都是占位值，替换为实际返回值。多实例调用传 `runtimeId`，一轮分析同时保存 `sessionId`；实例重启后重新获取身份和句柄。

```text
runner_source({"action":"list","limit":20})
runner_source({"action":"search","q":"getSign","limit":10})
runner_network({"filter":{"urlIncludes":"/目标路径"},"summary":true,"limit":10})
runner_autopsy({"action":"start","requestId":"选中的请求 ID","field":{"in":"header","name":"X-Sign"},"timeoutMs":60000})
runner_autopsy({"action":"get","jobId":"任务 ID"})
```

无 trigger：仅布置采集，等用户重新操作。原请求 ID 用于选定 URL，不会重发旧请求。自动触发时使用明确的原操作，例如：

```json
{
  "action": "start",
  "urlIncludes": "/目标路径",
  "field": {"in": "header", "name": "X-Sign"},
  "trigger": {"tool": "runner_click", "arguments": {"selector": "#submit"}},
  "timeoutMs": 10000
}
```

trigger 只接受 `runner_click`、`runner_gesture` 或 `runner_oracle(action:call)`，最多执行一次。没有 field 时枚举可观察的 header、顶层 body、query 字段，最多 100 个。不能定位来源的字段明确返回原因；JSON 字符串正文和 URL 查询串可能只具备容器级来源，不能解释成逐字符依赖。

任务返回 `id`，状态为 `running / complete / partial / failed / timed-out / cancelled`。`complete` 只代表本次采集范围的字段报告没有已知缺口，不代表后端业务成功。取消、断线、超时不会撤销或重发原操作；只清理本任务创建的采集和 tap。任务开始前已存在的用户 hook 不会被一起移除。记录不完整时不能按“没看见请求”推断“没有出站”。

## 执行记录、动态字段与 logpoint

```text
runner_execution({"action":"status"})
runner_execution({"action":"watch","properties":["X-Sign","sign"]})
runner_execution({"action":"start","maxEvents":50000,"ttlMs":60000})
runner_execution({"action":"read","runId":"execution-1","watchId":"write-watch-1","after":0,"limit":20})
runner_execution({"action":"explain","eventId":123,"maxNodes":1000,"revealSensitive":true})
runner_execution({"action":"stop","runId":"execution-1"})
runner_execution({"action":"unwatch","watchId":"write-watch-1"})
```

循环较多时先用 `action:"summary"`：按 `groupBy:"source"|"native"|"kind"` 聚合，返回次数及首末事件 ID。`read/summary` 可传 `natives:["String.charCodeAt"]`、`kinds:["call-return"]`、`expressionIncludes` 或精确 `location` 筛选。汇总分页使用 `offset/nextOffset`；下一页同时传 `beforeEvent:上一页.snapshotCursor` 固定观察上界。`gap/cursorResetRequired` 表示需要重新确认缓存范围。默认仍脱敏，源码表达式需显式 `revealSensitive:true`。F12 执行面板可点“按源码汇总执行”。

实测用法见闲鱼 getSign 独立还原（该内部记录未随源码发行）：626 组原始/插桩/独立实现完整输出一致。参考算法只在验收脚本中，运行时不含 appid 补丁。

watch 是筛选器，不会单独开始采集。可用 `objectId` 限定对象，默认覆盖选定源码实际访问的既有及新对象。`write-attempt` 是尝试，`put` 的 `storage` 描述确认方式；setter/Proxy 调用成功不等于该对象真的保存了该字段。动态键的转换和原副作用顺序保持由原 JS 操作执行。

```text
runner_execution({"action":"logpoint","location":{"file":"app-service.js","line":1,"column":500},"kinds":["call"],"when":"args[0] === 'test'","count":5,"ttlMs":30000})
runner_execution({"action":"read","watchId":"返回的 watchId","limit":20})
```

使用**原始业务脚本**的 1-based 行列。函数级条件采样仍可用 `runner_hook`；源码级 logpoint 支持调用、返回和异常，不暂停。条件使用既有只读条件语法，不执行任意条件脚本。指定 `functionSite` 可将新 run 限定在该函数及其可确认的后代调用。

`explain` 从字段记录向后遍历数据依赖，返回 `semantic`、原位置、中间值、缺失 ID、未知边界。默认不把取数组索引所用的解释器分派状态当成值依赖；`includeAddress:true` 可额外查看对象/索引定位依赖。源位置、调用帧及对象身份参与关联，时间接近或值相同不会产生依赖边。

### 大型切片分页（F12 与 MCP 共用）

超过单页上限时使用 `paged:true`，无需导出全量日志再编写外部遍历脚本。原有非分页调用保持兼容。

```text
runner_execution({"action":"explain","eventId":123,"paged":true,"maxNodes":100,"maxTotalNodes":250000,"fields":["kind","operator","native","value","deps","location","provenance","opaque"]})
runner_execution({"action":"explain","sliceCursor":"上次返回的 nextSliceCursor","fields":["kind","operator","native","value","deps","location","provenance","opaque"]})
```

- 第一页指定终点。后续只需传 `sliceCursor`，自动继承终点、页大小、总节点预算和地址依赖选项；显式改变这些选项会被拒绝。
- 默认每页 500、最多 2,000 个节点；默认总预算 250,000、最多 1,000,000。分页按依赖遍历，各页内部按事件 ID 排序，跨页不保证时间顺序，用 `id/deps` 拼接。
- `sliceCursor` 是当前页重读游标，`nextSliceCursor` 是下一页。相同游标可重复读取；读取不会再次执行业务操作。每个 realm 最多缓存 4 个切片任务，5 分钟后过期。已返回事件被淘汰时报告 `SLICE_PAGE_EVICTED`；任务过期、被替换或换会话报告 `SLICE_CURSOR_EXPIRED_OR_UNKNOWN`。
- `hasMore` 表示还有遍历页；`complete` 表示已遍历的依赖图没有缺失 ID 或预算截断，不代表未知边界已解释或算法所有分支已还原。`missing/missingCount`、`opaqueBoundaries/opaqueCount` 分别保留本页与累计诊断。
- `truncated` 表示图预算截断。`outputLimited:true, fullPageInArtifact:true` 只表示这一页转存为产物，**不是图被截断**。先用 `runner_artifact action:read` 按 `offset/nextOffset` 取完 `artifactId`，拼接 Base64 字节后解析 JSON，再跟随 `nextSliceCursor`。它保存了同一页的完整投影结果。敏感值仍需显式 `revealSensitive:true`。
- 原生 F12 → Wxapp → **执行反虚拟化**：填写“切片终点事件 ID”，点击“开始分页切片”及“读取下一页切片”。大页用现有“分析产物”入口读取。

复合赋值（如 `>>=`）和 `++/--` 现在保留为计算步骤。普通数组的 `indexOf/lastIndexOf/includes` 记录已检查索引的来源；`splice` 保留移动、插入及删除结果的逐元素来源。只对可以检查的原生普通数组路径建模，Proxy、访问器、定制 species、对象参数转换及超出规模限制等保持明确边界，不重复调用用户代码。原生数组操作中途抛错时清除可能失效的旧索引依赖。

回归命令：`node scripts/smoke-execution-pages.mjs`。它启动隔离夹具，验证原生 F12 与两个标准 MCP 客户端共用分页，且读取不重跑业务。

## Crypto、复现和 Oracle

自动发现：CryptoJS、WebCrypto、JSEncrypt、forge、tweetnacl、js-sha、aes-js、sm-crypto 的 SM2/SM3/SM4。已加载对象和后续 define 模块使用同一适配；自定义导出可通过 `taps` 指定。库的相似名称不代表所有版本、闭包内部、WASM 内核都可自动识别。

```text
runner_crypto_watch({"action":"start","target":"待匹配输出","match":"exact","count":5})
runner_crypto_watch({"action":"read","matchedOnly":true,"limit":10,"revealSensitive":true})
runner_execution({"action":"cryptoCandidates","runId":"execution-1","limit":10})
runner_oracle({"action":"export","eventId":123})
runner_oracle({"action":"call","oracleId":"返回的 oracleId","args":["新输入"],"revealSensitive":true})
runner_oracle({"action":"batch","oracleId":"同一 oracleId","inputs":[["a"],["b"]],"revealSensitive":true})
```

匹配支持 exact、includes、受限 regex；十六进制、Base64、WordArray 和字节数组会归一化。正则只接受有限匹配语法：字面量、字符类、锚点、有限固定重复；不接受可导致无界回溯的分组、回溯引用和无限重复。分段 update/finalize 保留 stream ID 和累计输入；非可导出 WebCrypto key 只记录句柄及限制，不尝试导出。

`cryptoCandidates` 用观察到的实际 UTF-8 输入/输出验证 MD5/SHA/SM3 候选；它不把常量相似当成证明，也不推断不可见的 HMAC key 或其它编码。结果只对该次调用成立。

Oracle 保存原函数和原 receiver，不复制闭包为独立签名实现。句柄会在 TTL、容量淘汰或实例重启后失效；batch 上限 50 次，入参总量 64 KiB，出错保留已完成/已尝试计数，不重试。

分析启动时可设置 `randomSeed`、`now`；分别控制支持的随机源、Date.now/Date()/new Date()。`runner_crypto_watch({action:"resetRandom",seed:42})` 重置已启用的随机序列；Autopsy 的 `resetSeed` 可在触发前执行相同操作。显式 Date 参数保持原义，采集 TTL 使用宿主真实时钟。未接入的外部随机源、其它 realm、网络响应和后台任务仍可影响复现，状态里保留限制。

```text
runner_execution({"action":"diff","runA":"execution-1","runB":"execution-2","limit":20,"revealSensitive":true})
runner_crypto_watch({"action":"diff","runA":"execution-1","runB":"execution-2","limit":20,"revealSensitive":true})
runner_network({"action":"diff","idA":"请求 A","idB":"请求 B"})
```

执行 Diff 按调用路径、源码位置、属性和次序对齐；无法配对的分支分别列出。Crypto 按算法与实际调用位置/调用树对齐。Diff 对齐不是因果证据。

## 静态源码与符号图

```text
runner_source({"action":"get","path":"utils/util.js","offset":0,"length":12000})
runner_source({"action":"deobfuscate","path":"utils/util.js","includeMap":true})
runner_source({"action":"graph","path":"utils/util.js","runId":"execution-1","limit":20})
runner_source({"action":"locate","target":"getApp().utils.request"})
```

支持格式化、保守常量折叠、无逃逸且已初始化的字面量字符串表、保留声明提升的死分支消除、已识别的封闭 while/switch 分派器展开。直接 eval/with、可能改变语义的别名/调用保持原样。每个 pass 保留变更位置、原始哈希及 source map；不会执行包代码来“计算常量”。`get` 始终返回原工厂，`format/deobfuscate` 返回派生源码，不覆盖磁盘包。符号图的静态候选和 `observedCalls` 动态证据分开返回。

## 输出、清理和已知边界

- 执行缓存默认 10,000 条，单 run 默认 20,000 条、60 秒；可显式配置最大 1,000,000 条、300 秒（建议仅在隔离分析实例使用；默认值不变）。`read` 默认 30、最多 200 条，沿 `nextCursor` 读取；淘汰、跨会话、过期句柄明确报告。
- 原生 Array.concat / slice 在普通数组、无 getter / Proxy / 自定义 species 等可确认条件下保留逐索引来源；原始字符串的字符索引和 length 保留接收值来源。复杂复制语义仍标为未知，不为分析重复触发业务属性访问。
- `runner_debugger action:state` 支持 `scriptId` 筛选，默认不内联返回大型 `data:` source map，改为提供存在性和大小。显式 `includeSourceMaps:true` 可读取原映射；源码定位和原生 DevTools 保持完整映射能力。
- 字段筛选器/logpoint 合计最多 100 个，Oracle 最多 64 个；Oracle/run/对象身份含 realm 唯一标记，重启不会将旧句柄误用于新对象。
- 分析内联输出限制 128 KiB；大图、报告和映射保存为 artifact。用 `runner_artifact({action:"read",id,offset,length})` 获取 Base64 分块；不要把 Base64 字节数当成字符游标。默认保存的脱敏执行报告可直接读，显式原值导出需要 `revealSensitive:true`。大型 source artifact 保留原源码，读取需显式原值访问。
- Boot 硬化干预默认关闭，仅白名单内置对象。停止恢复仍可恢复的描述符；已冻结对象、保存的闭包引用和不可逆应用状态需要重建隔离实例。详情见 [Boot 分析](boot-analysis.md)。
- 原生 F12 Console/Sources 的人工控制继续优先；Wxapp 面板的读取、翻页不再误判为接管。AI 自动触发任务遇到人工接管会停下；明确等待人工输入的任务继续观察这次输入。
- MCP 输入期间使用独立 Chromium CDP 连接设置页面焦点，并在结束时释放，解决原生 F12 位于另一个进程时“文字进了 DOM、原 handler 未收到”的问题。正常加载遮罩仍需用 `runner_wait(kind:hidden,selector:...)` 等待消失，不穿透遮罩点击。
- 这是现代 AST 级执行插桩，**没有 V8 opcode 后端**。动态 eval/new Function、未插桩 JS、WASM/native 内部及未执行分支是明确边界；默认参数/解构、native callback、spread 迭代中无法准确恢复的细粒度依赖标记未知，绝不把后续参数错配到展开参数。
- 真实样本的完整请求字段图仍有未知边界，当前 1708 条事件中保留 379 个未知边界，见最新真实包报告。因此不宣称已经自动导出该包完整独立签名配方，更不宣称所有 Chaos/VMP 都被通用反编译。

闲鱼 AWSC 的另一个真实样本已完成 47,970 条执行记录、5,209 条数据切片及受控对拍（该内部记录未随源码发行）：修复复制/字符串来源后能追到两个原始入参，仍保留 28 个外部或未观测边界。三轮固定已观测 SDK 状态的实验均与原始代码一致；这不覆盖未知状态、完整载荷算法或未执行分支。先重置种子、再通过另一条命令调用目标可能被后台任务干扰；复现实验在目标暂停帧内对齐状态，并把采集限定在单次同步求值内。

P1 增加可读 Crypto 摘要、独立向量验算、`resultCondition` 和只读预检；原生 F12 表单串联选择请求、触发、源码、复算与对照。最新教程（该内部记录未随源码发行）同时列明不可验算项、条件匹配的含义及协议 5 要求。

本轮证据和逐项状态见 验收矩阵（该内部记录未随源码发行）、标准 MCP + F12（该内部记录未随源码发行）、真实 Chaos（该内部记录未随源码发行）、完整回归（该内部记录未随源码发行）。Windows/Linux 为平台待验收。执行分析专项不修改真实包、不访问业务后台；完整基础回归中的其它真实包会自行请求公共配置，未使用账号配置，也未执行支付或破坏性业务操作。

## 启动来源、局部依赖与后台导出（2026-09-12）

初始化来源默认不采集。在新隔离实例的 `analysis.execution` 中增加：

```json
{
  "enabled": true,
  "files": ["app-service.js"],
  "modules": ["实际模块路径.js"],
  "byteLimit": 268435456,
  "initialization": {"enabled": true, "maxEvents": 20000, "ttlMs": 60000}
}
```

这是 execution 子配置，其外层仍需 `analysis.enabled:true`。初始化与随后手动 start 的 run 分别保存，只通过相同上下文的明确绑定/对象引用关联；状态中 `initialization` 与 `cache.retainedBytes/byteLimit` 显示各自范围。后续包初始化在选取范围和预算内继续保留。达到 `event-limit`、`byte-limit` 或 `ttl` 会明确报告原因，缺失来源不会补造。默认 256 MiB 的事件缓存与 artifact 正文缓存是不同限额。

```text
runner_execution({"action":"status"})
runner_execution({"action":"dependencies","eventId":123})
runner_execution({"action":"explain","eventId":123,"includeAddress":true,"expandEvents":[123],"paged":true})
runner_execution({"action":"stop","runId":"execution-1"})
runner_execution({"action":"export","runId":"execution-1"})
runner_execution({"action":"getExport","jobId":"返回的任务 ID"})
runner_artifact({"action":"read","id":"完成结果的 artifactId","offset":0,"length":4096})
```

`dependencies` 是局部展开；`expandEvents` 只对指定事件额外展开定位/控制依赖。它区分 data、address、control 和未知边界，不一次展开整个 VM 的索引分派。当前控制边覆盖 if、条件与逻辑表达式，循环/switch 分派不在完整覆盖承诺内。导出要求 run 已停止，按页流式写 NDJSON；可 `cancelExport`，取消不会重新调用业务函数。默认脱敏，明确指定 `revealSensitive:true` 才读原值。分析实例启动后旧 run/句柄不可跨 session 使用。

### 保存步骤结果的分析场景

`runner_suite` 的 `mode:"analysis"` 保持当前页面。`saveAs` 保存结果，`bind` 把先前结果的标量 ID 绑定给下一工具：

```json
{
  "action": "start",
  "mode": "analysis",
  "steps": [
    {"tool":"runner_oracle","arguments":{"action":"export","target":"getApp().analysisFixture.run"},"saveAs":"fn"},
    {"tool":"runner_execution","arguments":{"action":"start"},"saveAs":"run"},
    {"tool":"runner_oracle","arguments":{"action":"call","args":[1]},"bind":{"oracleId":"fn.oracleId"}},
    {"tool":"runner_execution","arguments":{"action":"stop"},"bind":{"runId":"run.runId"}},
    {"tool":"runner_execution","arguments":{"action":"read","kinds":["return"],"limit":1},"bind":{"runId":"run.runId"},"saveAs":"returns"},
    {"tool":"runner_execution","arguments":{"action":"dependencies"},"bind":{"eventId":"returns.entries.0.id"}}
  ]
}
```

`getApp().analysisFixture.run` 是回归夹具中的函数，实际使用须替换为已定位的原函数。用 `runner_suite action:get/cancel` 查询或取消返回的 job ID。每个分析任务最多显式调用一次 Oracle，不会重发旧 HTTP 请求；清理只停止本任务创建的采集，取消与启动回执竞争也不会遗留该采集。F12 → Wxapp → 验收目录可填写相同 JSON，点击“运行分析场景（保持当前页）”。

通用三组实验（该内部记录未随源码发行） 与 真实 Fireye 结果的限定范围（该内部记录未随源码发行） 分别记录；初始化缓存有来源不代表整个复杂算法已还原。
