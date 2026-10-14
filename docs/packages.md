# 小程序搜索和下载

`runner_packages` 是新增的第 29 个 MCP 工具。MCP、命令行和原生 F12 → **Wxapp → 小程序包**共用独立的本地包服务。下载不会启动、关闭或替换任何运行实例，也不会覆盖原来的明文包目录。

已打开的旧主控可以继续使用：重新连接 MCP 客户端即可使用新工具，其余 28 个工具仍连接原主控。新 F12 入口随新版主控启动加载；无需为下载功能重启正在测试的达利。

## 配置

默认读取仓库 `.local/config.json`，配置化切换生产服务，无需修改加载器：

```json
{
  "wxbot": "https://gateway.example.invalid",
  "deviceId": "已登录的设备 ID",
  "appKey": "私有 app_key",
  "appSecret": "私有 app_secret"
}
```

已有运行配置可以保留其他字段。也可增加 `packageSource` 对象，以同样四个字段单独指定下载服务，不影响运行实例的登录服务。

MCP 启动参数 `--package-config /absolute/private-config.json` 或环境变量 `WXAPP_PACKAGE_CONFIG` 可指定其他私有文件；命令行使用 `--config`。F12 使用 `WXAPP_PACKAGE_CONFIG` 或默认文件。密钥只放在私有文件中，客户端配置只需要其路径。返回数据、日志和下载清单不含密钥或签名 URL。

需要 Node.js 22.15+（zstd）或当前配套 Electron。构建一次：`npm run build`。

## MCP 调用

下面每段 JSON 都是 `runner_packages` 的参数。

1. 按名字搜索，结果只作为候选数据：

```json
{"action":"search","keyword":"达利食品"}
```

下一页使用返回的 `nextOffset`：`{"action":"search","keyword":"达利食品","offset":"上一页 nextOffset"}`。搜索接口不一定提供版本；缺失时返回 `version:null`。

2. 核对选中的 appid，解析下载版本：

```json
{"action":"resolve","keyword":"达利食品","expectedAppid":"YOUR_APPID"}
```

返回 appid、version 和可用 CDN 数量。若按名字解析到其他同名小程序，报 `PACKAGE_IDENTITY_MISMATCH`，不下载其文件。

3. 下载主包和全部声明的分包：

```json
{"action":"download","appid":"YOUR_APPID","version":37,"concurrency":4}
```

版本 37 是本次实测值；下载其他小程序或更新版本前先解析。也可以一步执行 `{"action":"download","keyword":"达利食品","expectedAppid":"YOUR_APPID"}`。

返回 `jobId`，初始 `status:"running"`。**下载接受不等于下载完成**。

```json
{"action":"get","jobId":"上一步返回的 UUID"}
```

按任务状态查询，直到 `complete` / `failed` / `cancelled` / `interrupted`。`complete` 返回 `packageDir`、文件数和各模块结果。MCP 断开后任务继续；先查询 `{"action":"jobs"}` 找回任务，不因回执超时重复提交。

```json
{"action":"cancel","jobId":"任务 UUID"}
```

取消会中断正在进行的 HTTP 请求并清理未发布目录；已完成的下载不会被删除。相同配置和选择的并发下载共享任务。最多同时运行两个下载任务，每个任务默认并发 4 个分包，可设为 1–8。

4. 查看本地包或校验文件和启动依赖：

```json
{"action":"list"}
```

```json
{"action":"inspect","appid":"YOUR_APPID","version":37,"baselibDir":"/absolute/path/baselib"}
```

`inspect` 检查文件 SHA-256 并执行现有 loader 预检。`startupReady` 只表示启动依赖满足，不代表全部页面业务通过。插件、小游戏或运行时未支持的格式依然可能有独立依赖问题，不能因下载完整就宣称能运行。

下载后若要加载，显式使用原有工具，创建新实例：

```text
runner_runtime({"action":"start","packageDir":"返回的 packageDir","appid":"下载的 appid","baselibDir":"/absolute/path/baselib"})
```

需要继续操作原达利时，在工具参数中指定原来的 `runtimeId`，避免切换目标。包库工具的 `scope` 为 `package-library`；它不冒充某个页面 handler 的操作，不修改运行中的业务状态。

## 命令行

在仓库目录执行：

```sh
npm run packages -- search --keyword 达利食品
npm run packages -- resolve --keyword 达利食品 --expected-appid YOUR_APPID
npm run packages -- download --appid YOUR_APPID --version 37
npm run packages -- get --job-id 返回的任务UUID
npm run packages -- list
npm run packages -- inspect --appid YOUR_APPID --version 37 --baselib ../baselib
```

这些命令返回 JSON；默认不自动打开包。任何命令可附加 `--config /absolute/private-config.json`。

## 下载和缓存规则

- Bot 请求：`POST /mp/wxa/search`；`POST /v1/miniprogram/downloadpackage` 固定 `urls_only:"1"`。只有 bot 请求带两个鉴权头。
- 主包先下载，读取 `app-config.json` 的 `subPackages` / `subpackages`，分包使用同一 appid/version 和规范化 `/root/`。
- CDN 使用普通 GET。根据字节识别 plaintext / zstd，失败时尝试同一模块其他 URL；不实现 AES、PBKDF2 或磁盘 `V1MMWX` 解密，也不使用 SSH/rsync。
- wxapkg 以索引边界读取，不盲信 fileCount；校验 UTF-8 文件名、数据范围、路径穿越、大小和文件冲突。完全相同的重复条目去重并记录；冲突不静默覆盖。
- 已带分包根的索引采用应用全局路径，允许编译器把共享资源写在公共目录；保留原索引路径并报告该布局，不强行给公共资源再加分包前缀。不同模块的同名文件仍必须字节一致。全相对路径包兼容原有前缀处理。
- CDN 候选失败保留 `attemptErrors[].code/httpStatus`，例如 HTTP 404、503；不持久化签名 URL 或任意底层错误文本。下载失败与页面加载失败分别诊断。
- 单模块上限 256 MiB，合并后上限 2 GiB / 100,000 文件，最多 512 个分包。无法安全合并或缺少任何声明分包，任务失败，不发布半包。
- 包库位于 `.local/packages/library/<appid>/<version>/package/`，相邻 `manifest.json` 保存逐文件 SHA-256。临时下载完成后才原子发布；同版本缓存校验通过可复用，已知 appid/version 无需重新获取 CDN。损坏缓存明确报错并保留供诊断。
- 环境变量 `WXAPP_PACKAGE_LIBRARY` 可统一迁移包库和服务连接位置；在需要共享的 MCP、CLI、主控进程中设置相同值。默认所有入口使用同一目录。
- 服务仅监听 `127.0.0.1`，鉴权连接文件权限 0600，自动启动；无任务且闲置 10 分钟后退出。服务异常退出只将任务标为 interrupted，不自动重放下载。已发布包和任务记录保留。
- 当前不解析外部插件依赖的独立下载协议、不追踪自动更新、不执行已下载业务代码。文件落盘完整性和页面运行验收分别报告。

## 验收

`npm test` 覆盖解析、主包/分包依赖、中文、zstd、替代 URL、权限头隔离、缓存、错误及取消。`npm run smoke:packages` 通过两个标准 stdio MCP 客户端，使用隔离目录和本地 HTTP 服务验证共享任务、旧主控兼容、无重复下载和鉴权。

- MCP 验收记录（该内部记录未随源码发行）
- 生产服务只读搜索/真实下载记录（该内部记录未随源码发行）
- 本轮验收 macOS；Windows/Linux 为平台待验收。新的包没有替换或重启用户正在操作的达利实例。

### 本次覆盖矩阵（2026-09-11）

| 能力 | macOS | Windows/Linux | 证据 |
| --- | --- | --- | --- |
| 索引校验、中文、zstd、相同重复条目及恶意路径拒绝 | 验收通过 | 平台待验收 | tests/packages.test.ts |
| 主包优先、固定版本分包、替代 URL、缓存、失败和取消 | 验收通过 | 平台待验收 | tests/packages.test.ts |
| 标准 MCP、两个客户端共用任务、旧主控兼容、服务鉴权 | 验收通过 | 平台待验收 | packages-mcp-result.json |
| 原生 F12 包库入口与统一服务 | 验收通过 | 平台待验收 | scripts/smoke-wxapp-panel.mjs 实测 |
| 生产搜索、达利 37 主包与 8 个分包下载、哈希/启动预检 | 验收通过 | 平台待验收 | packages-production-result.json |
| 原 MCP 点击/输入/导航/网络/断点回归 | 验收通过 | 平台待验收 | mcp-result.json |

最终单元测试为 92/92；typecheck 与 build 通过。首次将两个 GUI 回归同时运行时，旧 MCP 输入等待超时；相同代码单独运行该回归通过，因此 GUI 回归应串行执行，避免测试窗口争用输入焦点。生产验证没有关闭或重启现有达利，也未执行新下载包的业务代码；新包的全部业务流程不在本次搜索/下载验收结论内。
