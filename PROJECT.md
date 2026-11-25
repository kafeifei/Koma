# Koma

Koma 是 [OpenCode](https://github.com/anomalyco/opencode) 的一个自用分支：底层和功能全部沿用上游 2.x，只改桌面端的操作界面，让它用起来像一个常规的 Agent 工作台（左边按项目列任务，中间对话，右边看改动、浏览器、终端和文件）。

仓库里除本文件外的文档（`README.md`、`AGENTS.md`、各包的说明）都是上游的，照常适用。

## 和上游的差别

改动刻意保持得很少，都带 `Koma:` 注释，方便同步上游时辨认。

| 改动 | 位置 |
| --- | --- |
| 默认布局：侧边栏按项目列出会话 | `packages/app/src/settings/model.tsx` |
| 会话行显示最近更新时间（5m、3h、2d） | `packages/app/src/shell/titlebar/sidebar-customized.tsx`、`packages/app/src/shell/time.ts` |
| 设置和「已归档」入口在侧边栏底部 | `packages/app/src/shell/titlebar/titlebar.tsx` |
| 会话菜单里的归档和置顶，侧边栏顶部的置顶区 | `packages/app/src/shell/titlebar/sidebar-customized.tsx`、`packages/app/src/shell/titlebar/pinned-area.tsx` |
| 侧边栏里的搜索框（按标题过滤各项目下的会话） | `packages/app/src/shell/titlebar/sidebar-customized.tsx` |
| 项目行右键菜单：新建会话、项目设置 | `packages/app/src/shell/titlebar/sidebar-customized.tsx` |
| 会话菜单的字母快捷键（P 置顶、R 重命名、A 归档、D 删除），置顶行也能归档 | `packages/app/src/shell/titlebar/menu-keys.ts`、`packages/app/src/shell/titlebar/session-archive.ts` |
| 每个会话都留在项目列表里（去掉「最近会话」开关）；行尾悬停按钮是「归档」而不是关闭标签页，归档后提示里可「撤销」 | `packages/app/src/shell/titlebar/sidebar-customized.tsx`、`tab-nav.tsx`、`tab-strip.tsx`、`project-session-row.tsx`、`session-archive.ts` |
| 侧边栏最下面显示构建号（每次「发 debug」或发版加一） | `packages/app/src/shell/titlebar/titlebar.tsx`、`packages/desktop/electron.vite.config.ts`、`script/koma-build.ts` |
| 对话区右侧的面板图标栏 | `packages/app/src/session/panel-rail.tsx`、`packages/app/src/session/screen.tsx` |
| 右侧面板的宽度所有标签页共用一份并记住（上游每个标签页各记一份，新开会话回到默认宽度） | `packages/app/src/session/session-layout.ts`、`packages/app/src/shell/state/layout.tsx` |
| 超时转到后台的 Shell 命令再跑 10 分钟仍未结束就停掉（上游会一直跑，卡住的命令让会话永远等着）；用户停掉后台命令时，会话收到「已取消」而不是 `Shell.NotFoundError` | `packages/core/src/tool/plugin/shell.ts` |
| 旧式 OpenAI 登录过期时提示重新连接 | `packages/core/src/plugin/provider/openai.ts` |
| 开关远程访问时先保存设置再停服务（否则桌面端抢先重启的服务读不到新设置，配对一直卡在「Setting up remote access」） | `packages/cli/src/services/service-config.ts` |
| 配置里的 OpenAI 兼容提供商从自己的 `/models` 读取模型清单，设置页可手动刷新 | `packages/core/src/plugin/provider/openai-compatible-discovery.ts`、`packages/schema/src/provider-discovery.ts`、`packages/app/src/settings/models/refresh-button.tsx` |
| 打包身份、图标、独立的后台服务 | `packages/desktop/src/main/koma.ts` 及引用它的文件 |
| 「发 debug」和发版脚本 | `script/koma-debug.ts`、`script/koma-release.ts`、`script/koma-build.ts` |

## 身份与数据

打包出来的应用不与本机安装的 OpenCode 共用任何东西：

| | Koma Debug | Koma Beta | Koma |
| --- | --- | --- | --- |
| 应用标识 | `com.kafeifei.koma.debug` | `com.kafeifei.koma.beta` | `com.kafeifei.koma` |
| 后台服务渠道 | `koma-debug` | `koma-beta` | `koma` |
| 服务端口 | 19277 | 19278 | 19279 |

- 数据库是 `~/.local/share/opencode/opencode-<渠道>.db`，服务登记文件是 `~/.local/state/opencode/service-<渠道>.json`。这是上游按渠道命名的既有规则，Koma 只是用了自己的渠道名。
- 端口固定且低于 49152，避开系统随机分配的临时端口范围。
- 不注册 `opencode://` 协议，没有更新源，所以不会抢 OpenCode 的链接，也不会被它的更新覆盖。
- 配置目录 `~/.config/opencode` 与 OpenCode 共用：服务商、MCP、技能配一次两边都能用。登录凭据存在各自的数据库里，要各登一次。
- `bun run dev:desktop` 的开发运行沿用上游的开发身份（"OpenCode Dev"，数据库 `opencode-local.db`）。

## 开发与「发 debug」

```sh
bun install
bun run dev:desktop   # 开发运行，改界面代码会热更新
bun run debug         # 从干净的 main 构建 Koma Debug 并装到 /Applications
```

「发 debug」的顺序固定为：验证本次改动 → 提交并合入本地 `main` → 从该干净提交构建、安装并启动验证。它已授权本次改动所需的提交和合并，不包含推送、打标签和正式发布。脚本会拒绝在工作树不干净或不在 `main` 时构建。

构建号记在 `.git/koma-build-sequence`（各 worktree 共用），每次构建成功后加一，接着旧 Koma 的编号（旧版最后是 170）。开发运行不显示构建号。

## 发版

版本号沿用 `0.x.y`，标签 `koma-v<版本>`，Beta 在 GitHub 上标为预发布。只在用户明确要求时发。

```sh
bun run release 0.2.0        # Koma Beta：dist/koma/Koma-Beta-0.2.0-mac-arm64.zip 和 SHA256SUMS.txt
bun run release 0.2.0 prod   # Koma（正式版身份）
```

脚本和「发 debug」共用同一套构建：从干净的 `main` 出包，用钥匙串里的 Developer ID 签名，没有签名身份就失败。安装包没有公证（这台机器没有公证凭据），所以下载后第一次打开要到「系统设置 → 隐私与安全性」点“仍要打开”，或执行 `xattr -dr com.apple.quarantine "/Applications/Koma Beta.app"`；发布说明里要写明。出包后先在本机启动确认，再推送标签并用 `gh release create koma-v<版本> --prerelease` 上传 `dist/koma` 里的两个文件。

改 `packages/app` 前先读 `packages/app/AGENTS.md`：文案必须走 i18n 且只加英文；不为测试加参数；应用包的单元测试要带项目配置跑：

```sh
cd packages/app
bun test --conditions=solid --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./src
```

## 同步上游

`upstream` 远端是 `anomalyco/opencode`，主线是 `dev`。`main` 的历史同时接着旧 Koma 和上游，所以同步就是一次普通合并：

```sh
git fetch upstream dev
git switch -c codex/sync-upstream-YYYYMMDD main
git merge upstream/dev
```

冲突只会出现在上表列出的文件里。合并后跑类型检查和各包测试，再走一遍「发 debug」。上游的 `.github/workflows` 会自动发布和部署，这个仓库的 Actions 必须保持关闭。

## 旧 Koma（1.x）

2026 年 9 月的 Koma 0.1.x 基于 OpenCode 1.18，保存在 `koma-1.x` 分支。2026-11-23 重启时上游已整体换成 2.x，旧 Koma 的大部分功能上游已经自带，所以这次以上游 2.x 为底重新开始，没有搬的部分及原因：

- 模型与服务商设置、后台子代理、本地网页入口：上游已有。
- 任务侧栏：上游有按项目分组的侧栏，但归档、置顶、侧栏内搜索、项目行菜单、菜单字母快捷键没有接到这个布局里，已由 Koma 补上（见上表）。上游行尾的 × 只关闭标签页，而「最近会话」关掉时、或会话排在每组前 5 个之后，关掉的会话会从列表里消失，看起来像丢了；Koma 改成和旧版一样：所有会话都留在列表里，悬停按钮是「归档」并可撤销。和旧版仍不同的地方：搜索只按标题（服务端只搜标题，没有正文片段）；已归档是弹窗而不是侧栏内的视图；置顶的会话集中在顶部的置顶区，不是留在项目组里排前；没有「主页」按钮（这个布局里上游没有主页，回到主页会直接跳回上一个会话，对应入口是「新建会话」）；项目行菜单里没有移除项目（在「设置 → 项目」）。
- 原生 Codex 宿主、Remote 隧道与设备目录、Tauri 版：按"全部沿用上游"的方向放弃。上游用 Claude Agent 和 ChatGPT 登录接入模型，用配对码和隧道做远程访问。
- Worktree 归档快照、权限三档、扩展目录、Computer Use：属于后端，暂不做。
- `~/.koma` 里的旧数据没有迁移，原样留在磁盘上。
