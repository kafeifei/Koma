# Koma beta 发布

Koma 的公开 macOS beta 提供 Electron（`Koma.app`）和 Tauri（`Koma Tauri.app`）两个 ZIP，目前均为 Apple Silicon。两个发行宿主复用同一 App 和同一个发行 Koma CLI，各自运行独立后端与端口，共用 `~/.koma` 中的项目、任务和配置。内部 channel 仍为 `lab`，CLI 为 `koma`。自动更新暂未启用，从 GitHub Releases 手动下载更新。

发行包标识分别为 `com.kafeifei.koma`、`com.kafeifei.koma.tauri`，可以同时安装；Debug 标识仍为 `com.kafeifei.koma.debug`、`ai.opencode.lab.tauri-test`。

发行版与 Debug 共用 `~/.koma` 数据；已有 Lab profile 保留物理目录和兼容链接，不复制数据库。`KOMA_HOME`（兼容 `OPENCODE_HOME`）可显式指定独立测试目录。发行属性编译进 CLI，构建缓存区分 Debug／发行；终端环境不能改变已打包 CLI 的发行身份，默认数据目录不随渠道变化。发行 Electron 使用稳定的 `com.kafeifei.koma Safe Storage` 服务，正常启动和升级沿用相同应用签名；不读取旧品牌标记来选择服务。Tauri 继续使用系统凭据服务，按 profile 隔离。凭据读取失败不由后台轮询反复重试，用户主动刷新可以重试；不降级为明文。

Electron 的发行协议为 `koma://`，Debug 为 `koma-debug://`；全局 CLI 入口分别为 `koma`、`koma-debug`。安装不会覆盖其他 profile 已占用的命令。既有 Debug 安装留下的协议注册、命令和钥匙串不由发行版清理。

## 构建

先将发布改动合入 `main`，在干净的发布 commit 上构建。版本由 `packages/desktop/package.json` 定义，首版为 `0.1.0-beta.1`；上游依赖包版本不随产品版本重置。

Electron 在 `packages/desktop`、Tauri 在 `packages/desktop-tauri` 执行同一个发布命令：

```sh
CSC_NAME="Your Name (TEAMID)" \
APPLE_KEYCHAIN_PROFILE="your-notary-profile" \
bun run release:mac
```

也可使用 `APPLE_API_KEY`（本机 `.p8` 文件路径）、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`。凭据仅通过环境传入，不提交到仓库或打入安装包。

脚本要求干净的 main 提交，预构建同包后端和 CLI，预留构建序号，生成前端，使用 Developer ID、hardened runtime 和可信时间戳签名，并向 Apple 公证。公证配置缺失时拒绝发布构建。两个构建应顺序执行，共用构建序号锁及经过 SHA-256 校验的 CLI。Tauri 的 Node 和 CLI 先单独签名，再签整个 App；公证票据附加到 App 后才生成 ZIP。

产物分别位于各包的 `dist-release/`，命名为 `Koma-Electron-<version>-mac-arm64.zip` 和 `Koma-Tauri-<version>-mac-arm64.zip`。只分发 ZIP，不生成 DMG。构建不发布、不安装、不操作已有应用进程。

Koma 的 Electron 包只携带共享 Koma CLI，不再附带未使用的上游 v2 CLI。发行包不包含源码映射，映射仍保留在构建输出中供调试和 Sentry 使用；Debug 包保留映射。两个发行 ZIP 均使用最高 Deflate 压缩级别，不改变应用运行内容。

两个宿主共用发行版调试开关策略。Koma 固定使用当前工作台布局，已有配置中的旧布局偏好自动归一，不显示上游新旧界面迁移开关和过期提示。

“连接 → 远程隧道”设置始终显示 `https://koma-remote.vercel.app/` 网站入口，Electron 与 Tauri 由共享服务提供同一个默认值；`OPENCODE_REMOTE_WEBSITE` 仍可覆盖。网站托管 GitHub 登录、会话与设备目录 API，实际工作台流量仍走 Microsoft Dev Tunnels；当前网站不能整体部署到仅提供静态托管的 GitHub Pages。

## 验证与发布

- 对候选 App 执行 `codesign --verify --deep --strict`、`xcrun stapler validate` 和 `spctl --assess --type execute`。
- 使用独立 `OPENCODE_HOME` 验证启动、项目与任务操作、OpenCode 和原生 Codex 的代表性流程；对比现有版本，保留原用户数据与运行进程。
- 检查两个 ZIP 内的 App 版本、签名和构建 commit，并验证同包 CLI 的版本与内容一致，生成 SHA-256 校验文件。
- 将 `main` 推送到 `kafeifei/Koma`，确认远端 commit 与产物一致，再创建 `v<version>` 标签和 GitHub prerelease。上传经验证的两个 ZIP 和校验文件。

GitHub 仓库的 Release 与 Git 标签分开管理。清理上游 Release 不删除上游历史标签，也不改写上游提交历史。

Koma Debug 与 Koma 复用工作台和后端代码，默认数据共用，凭据服务身份保持各自规则；`bun run debug` 生成 Koma Debug.app。发行版与 Debug 均默认使用 `~/.koma`，并为已有 Lab profile 保留物理目录、锁和兼容链接，不复制数据库。修正默认路径不代表已完成物理迁移；移动真实数据须另行授权，并先停止占用该目录的应用和后端。旧存储文件名和上游 OpenCode 引擎包名保留兼容用途；它们不表示发行版应继承旧应用身份。

## Debug 交付

「发 debug」先验证本次改动，提交并合入本地 `main`，再从构建时最新、干净的 `main` 提交执行 `bun run debug`。该请求包含必要的提交和合并授权，具体分支检查见 [分支策略](branches.md)。不能先用未合并补丁发包、事后再补合并。

验证候选包后覆盖安装 `/Applications/Koma Debug.app`，保留正在运行的应用与后端，不自动启动或重启。交付时报告版本、构建 ID／序号和来源 `main` 提交，并单独说明实际运行状态。此流程不包含推送、打标签或正式发布。

分支同步与发布入口约束见 [分支策略](branches.md)。`dev` 只镜像上游，不能作为 Koma 发布源码；旧的 `script/release`、`script/version.ts`、`script/publish.ts`、`script/beta.ts` 在 Koma 仓库中会拒绝运行。
