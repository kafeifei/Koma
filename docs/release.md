# Koma beta 发布

Koma 的公开 macOS beta 提供 Electron（`Koma.app`）和 Tauri（`Koma Tauri.app`）两个 ZIP，目前均为 Apple Silicon。两个宿主复用同一 App 和同一个 Koma CLI，各自运行独立后端与端口，共用 `~/.koma` 中的项目、任务和配置。内部 channel 仍为 `lab`，CLI 为 `koma`。自动更新暂未启用，从 GitHub Releases 手动下载更新。

发行包标识分别为 `com.kafeifei.koma`、`com.kafeifei.koma.tauri`，可以同时安装；Debug 标识仍为 `com.kafeifei.koma.debug`、`ai.opencode.lab.tauri-test`。

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

## 验证与发布

- 对候选 App 执行 `codesign --verify --deep --strict`、`xcrun stapler validate` 和 `spctl --assess --type execute`。
- 使用独立 `OPENCODE_HOME` 验证启动、项目与任务操作、OpenCode 和原生 Codex 的代表性流程；对比现有版本，保留原用户数据与运行进程。
- 检查两个 ZIP 内的 App 版本、签名和构建 commit，并验证同包 CLI 的版本与内容一致，生成 SHA-256 校验文件。
- 将 `main` 推送到 `kafeifei/Koma`，确认远端 commit 与产物一致，再创建 `v<version>` 标签和 GitHub prerelease。上传经验证的两个 ZIP 和校验文件。

GitHub 仓库的 Release 与 Git 标签分开管理。清理上游 Release 不删除上游历史标签，也不改写上游提交历史。

Koma Debug 与 Koma 使用同一工作台和共享后端；`bun run debug` 生成 Koma Debug.app。新 profile 默认使用 `~/.koma`，可用绝对路径 `KOMA_HOME` 指定。已有 Lab profile 保留物理目录和锁，以 `~/.koma` 兼容链接继续使用，不复制数据库；`OPENCODE_HOME` 仍兼容。旧协议标识、存储文件名和上游 OpenCode 引擎包名保留兼容用途。

分支同步与发布入口约束见 [分支策略](branches.md)。`dev` 只镜像上游，不能作为 Koma 发布源码；旧的 `script/release`、`script/version.ts`、`script/publish.ts`、`script/beta.ts` 在 Koma 仓库中会拒绝运行。
