# 连接 WxappRunner 测试 MCP

先启动目标实例，将 客户端配置（该内部记录未随源码发行） 中的 `mcpServers` 合并到你使用的 AI 工具的 MCP 配置，然后重新连接该 MCP server。配置是本机绝对路径，已经指定可用 Node 可执行文件；不需要填写 bot 密钥。连接文件只对对应主控仍存活时有效。

这是 **stdio MCP**：客户端启动 `dist/mcp.cjs`，通过标准输入输出通信。它不是一个可在浏览器里打开的 MCP 网址，也不要把 `.local/mcp-dali.json` 的内部 HTTP 地址直接当成 Streamable HTTP MCP。

连接成功应看到 **36 个工具**。先做只读检查：

```text
runner_status({})
runner_snapshot({})
runner_screenshot({})
runner_state({})
runner_network({"after":0,"limit":20})
runner_logs({"after":0,"limit":20})
```

保存 `runner_status` 返回的 `runtimeId` 和 `networkCursor`。多实例时传 `runtimeId` 指定目标；查看请求正文使用 `runner_network({"id":"请求ID"})`。密钥和 token 默认脱敏。

测试页面交互时先取新快照，从返回的元素选择 `nodeId`：

```text
runner_click({"runtimeId":"状态中的 runtimeId","nodeId":"快照中的 nodeId"})
runner_wait({"runtimeId":"同一个 runtimeId","kind":"text","text":"预期出现的文字","timeoutMs":10000})
```

点击是实际页面操作，请选择你准备测试的普通功能。`input-sent` 仅代表输入送达，等待条件满足后才能判断页面结果。失效元素重新取快照，超时不要自动重复点击。

小程序搜索和下载也通过同一连接：

```text
runner_packages({"action":"search","keyword":"达利食品"})
runner_packages({"action":"resolve","keyword":"达利食品","expectedAppid":"YOUR_APPID"})
runner_packages({"action":"download","appid":"YOUR_APPID","version":37})
runner_packages({"action":"get","jobId":"下载返回的 UUID"})
runner_packages({"action":"list"})
```

版本 37 是本次实测值。下载其他版本时使用 resolve 的返回值。下载只写独立包库，**不会关闭或替换达利**。无需重启当前运行主控；若客户端已有旧工具列表，断开并重新连接 MCP 即可。

完整参数见 [MCP 使用文档](MCP.md)；生产配置、下载任务、缓存和分包规则见 [搜索下载说明](packages.md)。原生 F12 可以同时使用，人工操作优先；AI 遇到接管提示后应重新读取状态。

执行插桩与 Autopsy 需要新版主控及启动配置，见 [最短操作教程](execution-analysis.md)。
