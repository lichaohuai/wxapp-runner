# Windows 源码使用

本仓库发布源码，不附带安装包或微信基础库。Windows 的完整运行验收仍待完成。

准备 Node.js 22.19+、Git、你有权使用的基础库与明文小程序目录。构建脚本当前读取同级 `../baselib`。

```powershell
npm ci
npm run typecheck
npm run test:public
npm run build
npx electron . --package C:\workspace\my-miniapp --baselib C:\workspace\baselib --appid YOUR_APPID --mcp --mcp-file .local/mcp.json
```

将 `YOUR_APPID` 替换为你自己的目标 AppID。私有网关配置存入 `.local/config.json`，不要提交到仓库。

MCP 使用 `node dist/mcp.cjs --connection C:\workspace\wxapp-runner\.local\mcp.json`。连接文件包含本机访问令牌，不公开。

如自行运行 `npm run dist:win`，构建结果也不含微信基础库；启动自行构建的 exe 时必须显式指定 `--baselib C:\workspace\baselib`。源码许可证不授予外部基础库或业务包的分发权。
