# OpenCode Lab Remote Web

网站负责 GitHub 登录、设备目录和跳转；工作台流量直接进入所属设备的 Microsoft Dev Tunnel，任务仍由该设备的 Lab 后端持有。网站不持有 Session，也不通过 Vercel 转发工作台流量。

公开入口为 `https://koma-remote.vercel.app/`，部署在现有 Vercel 项目 `opencode-lab-remote`。生产环境的 `REMOTE_WEB_ORIGIN` 必须与新域名一致；旧域名跳转到此入口。GitHub Pages 仅支持静态托管，不能承载本站的登录、会话和设备 API。

## 认证边界

- GitHub 授权范围为 `read:user`、`read:org`；网站会话与 tunnel 的浏览器授权相互独立，访问隧道需要同一 GitHub 账号。
- Device code、access token 和 refresh token 保存在加密且认证的 `HttpOnly` cookie 中。API 只返回一次性用户代码、账号身份和无凭据的设备信息；会话绝对有效期为 30 天，刷新凭据不延长它。
- 默认 OAuth 应用身份沿用 Sandy／Code OSS，授权页面可能显示 Visual Studio Code。来源与许可证见 [remote/NOTICE](../remote/NOTICE)。自有 OAuth 应用需要共享模块的登录、轮询、刷新使用同一 client ID，当前没有网站配置开关。

## 部署配置

| 项目                | 值／边界                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `REMOTE_WEB_ORIGIN` | 精确的 HTTPS origin；不含凭据、路径、查询或片段，本地开发支持 loopback HTTP                   |
| `SESSION_SECRET`    | 至少 32 字节密钥的十六进制编码，仅存在于部署密钥配置                                          |
| Vercel 根目录       | `packages/remote-web`，同时可访问仓库根锁文件与 `@opencode-ai/remote` 工作区依赖              |
| 安装命令            | `bun install --frozen-lockfile --filter @opencode-ai/remote-web --ignore-scripts`             |
| 构建／产物          | `bun run build`／`dist`；服务端预构建为 `dist-server/vercel.js`，Microsoft SDK 由 Vercel 跟踪 |

五个公共 API 通过 [`api/`](api/) 的 JavaScript 入口加载服务端产物。配置见 [vercel.json](vercel.json)，认证与设备查询见 [server/api.ts](src/server/api.ts)，会话加密见 [server/session.ts](src/server/session.ts)。
