# WxappRunner

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

面向开发者的小程序加载与调试宿主，基于 **TypeScript + Electron**，提供原生 DevTools 和 **MCP** 接口，便于人工与 AI 使用同一套运行状态、网络记录和调试能力。

## 功能

- 逻辑 Worker 与视图 Renderer 分离，加载用户提供的明文小程序目录。
- 主包、分包、插件和 Worker 的加载管理与诊断；兼容范围见实际运行结果。
- 原生 F12：Console、Sources、Network 等面板，以及 Wxapp 状态面板。
- MCP：页面操作、DOM / 微信状态、storage、日志、网络正文、源码、断点和分析工具。
- 网络观测、显式拦截规则、Mock、手动重发及正文 / HAR 导出。
- 可选启动期插桩、受控 hook、Crypto 捕获、执行切片和会话内 Oracle。
- 通用账号网关适配，服务地址及凭证由用户自行配置。

这是独立的第三方项目，与腾讯、微信无官方隶属关系。本项目公开宿主与适配代码；运行仍依赖用户另行提供且有权使用的微信基础库。仓库不包含基础库、小程序业务包、账号凭证或网关服务。

## 环境要求

- Node.js **22.19+**；建议使用 Node.js 22 LTS。
- Electron **40.10.6**，由依赖锁文件固定。
- 用户提供的基础库（当前适配基线 **3.17.3**）及明文小程序目录。
- macOS 有既有运行验证；Windows / Linux 的完整运行验收仍待完成。

## 快速开始

构建审计脚本当前读取同级 `../baselib`，建议准备以下目录结构：

```text
workspace/
├── baselib/           # 使用者自行准备，不在本仓库中
├── my-miniapp/        # 使用者有权加载的明文小程序包
└── wxapp-runner/
```

```sh
git clone https://github.com/lichaohuai/wxapp-runner.git
cd wxapp-runner
npm ci
npm run build
npx electron . --package ../my-miniapp --baselib ../baselib --appid YOUR_APPID --mcp --mcp-file .local/mcp.json
```

把示例 AppID 换成目标包的实际 AppID。运行时支持 `--baselib PATH`；构建时的基础库位置目前仍按上述目录约定。

F12 打开原生 DevTools。运行期间生成的 `.local/mcp.json` 含本机连接信息，只供本机客户端使用，不要上传。

## MCP 接入

在支持 stdio MCP 的客户端配置中，将路径替换为本机绝对路径：

```json
{
  "mcpServers": {
    "wxapp-runner": {
      "command": "node",
      "args": [
        "/path/to/wxapp-runner/dist/mcp.cjs",
        "--connection",
        "/path/to/wxapp-runner/.local/mcp.json"
      ]
    }
  }
}
```

先用 `runner_status` 查看当前实例，再使用 `runner_snapshot`、`runner_network`、`runner_state` 等能力。超时不代表业务操作已撤销，不要直接重复提交操作。

详细用法：[MCP](docs/MCP.md) · [分析工具](docs/analysis-tools.md) · [启动分析](docs/boot-analysis.md) · [执行分析](docs/execution-analysis.md)

## 可选账号与下载网关

本地加载不要求配置个人网关。登录、用户资料、云调用、搜索与下载等远端能力，需要用户自行提供兼容的服务。

```sh
mkdir -p .local
cp config.example.json .local/config.json
```

编辑本地配置，填入你自己的服务信息：

```json
{
  "wxbot": "https://gateway.example.invalid",
  "appKey": "YOUR_APP_KEY",
  "appSecret": "YOUR_APP_SECRET",
  "deviceId": "YOUR_DEVICE_ID"
}
```

也支持 `WXBOT_BASE`、`APP_KEY`、`APP_SECRET`、`DEVICE_ID` 环境变量。不要把私有配置、连接文件、登录态、原始调试正文或用户数据提交到 GitHub。

## 开发与验证

```sh
npm run typecheck
npm run test:public
npm run scan:public
```

`test:public` 是无需真实账号、真实小程序包或微信基础库的聚焦测试，不等于完整兼容性验收。完整 `npm test`、窗口测试和契约审计中的部分用例依赖外部基础库、真实包或本仓库未分发的夹具，请按各用例准备输入。

## 源码目录

| 目录 | 用途 |
| --- | --- |
| `src/loader` | 加载管理、上下文与生命周期适配 |
| `src/wx-shim` | wx API 宿主实现 |
| `src/controller` | 常驻调试主控、缓存及实例管理 |
| `src/mcp` | stdio MCP 工具与 Inspector 接口 |
| `src/analysis` | 受控 hook、源码及执行分析 |
| `src/native-components` | 原生组件的桌面宿主适配 |
| `tests` | 自动化回归测试 |
| `scripts` | 构建、审计及回归入口 |

[架构](ARCHITECTURE.md) · [JSAPI 清单](JSAPI.md) · [搜索与下载](docs/packages.md) · [Windows](docs/windows.md)

## 许可证与分发范围

自有项目代码采用 **Apache License 2.0**，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。第三方依赖保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本源码发行不包含微信基础库、第三方业务包 / SDK 重构、私人研究记录、账号数据或安装包。用户须自行确认外部依赖与目标包的使用权限；项目许可证不授予第三方软件的权利。参见 [分发范围](DISTRIBUTION.md)。

### 发布前安全检查

公开源码不保留真实 AppID。文档使用 `YOUR_APPID`，单元测试使用运行时生成的独立合成标识；涉及外部小程序的脚本改为通过 `WXAPP_TEST_APPID`（以及必要的编号变体）读取调用者配置。它们不会默认替你选择真实账号或小程序。

安装并校验官方 Gitleaks（当前验证版本 8.30.1）后，在提交后、推送前运行 `npm run scan:public` 和 `npm run scan:secrets`。本仓库 `.gitleaks.toml` 扩展默认规则，并单独拒绝 AppID 字面量；不要通过排除整个测试目录或忽略所有告警绕过检查。
