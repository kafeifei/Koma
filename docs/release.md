# Koma beta 发布

Koma 的公开 macOS beta 使用 Lab 工作台及共享后端，应用名为 `Koma`。内部 channel 仍为 `lab`，沿用 `ai.opencode.lab`、`opencode-lab` 和 `~/.opencode`，保留已有 profile 的任务、配置和 CLI 兼容性。自动更新暂未启用，从 GitHub Releases 手动下载更新。

## 构建

先将发布改动合入 `main`，在干净的发布 commit 上构建。版本由 `packages/desktop/package.json` 定义，首版为 `0.1.0-beta.1`；上游依赖包版本不随产品版本重置。

在 `packages/desktop` 执行：

```sh
CSC_NAME="Your Name (TEAMID)" \
APPLE_KEYCHAIN_PROFILE="your-notary-profile" \
bun run release:mac
```

脚本预构建同包后端和 CLI，预留构建序号，生成前端，使用 Developer ID、hardened runtime 和可信时间戳签名，并向 Apple 公证。公证配置缺失时拒绝发布构建。产物位于 `dist-release/`，包含 DMG 和 ZIP。构建不发布、不安装、不操作已有应用进程。

## 验证与发布

- 对候选 App 执行 `codesign --verify --deep --strict`、`xcrun stapler validate` 和 `spctl --assess --type execute`。
- 使用独立 `OPENCODE_HOME` 验证启动、项目与任务操作、OpenCode 和原生 Codex 的代表性流程；对比现有版本，保留原用户数据与运行进程。
- 检查 DMG、ZIP 内的 App 版本、签名和构建 commit，生成 SHA-256 校验文件。
- 将 `main` 推送到 `kafeifei/Koma`，确认远端 commit 与产物一致，再创建 `v<version>` 标签和 GitHub prerelease。上传经验证的 DMG、ZIP 和校验文件。

GitHub 仓库的 Release 与 Git 标签分开管理。清理上游 Release 不删除上游历史标签，也不改写上游提交历史。
