# Koma Desktop

Electron 壳复用 [App](../app/README.md)，持有平台能力、窗口和连接入口。Renderer 通过 preload 的 `window.api` 访问主进程；IPC 位于 [`ipc.ts`](src/main/ipc.ts)。任务执行、权限和持久状态属于共享后端。

## 共享后端

Electron 的 Desktop、Web 和 Koma CLI 默认连接 electron 实例；Tauri 以 tauri 实例独立启动后端，使用不同端口，共用同一 profile 的数据。Desktop 先将同包 `koma` 发布到不可变版本路径，再启动 `backend serve`；底层仍是现有 HTTP 服务与 Session 引擎。两种宿主打包同一份 Koma CLI 产物；其他渠道保留原选择。

关闭窗口、网页或 CLI 不停止后端。完整退出／重启 Desktop 时先查询活动任务：存在任务或查询失败时默认取消；确认后停止已连接的本地后端及全部任务（包括 CLI 任务），等待 profile 释放。安装新包不替换运行中后端，下次启动才使用安装后的程序。`koma backend status` 返回实际 PID、版本和协议；`backend stop` 是显式停止入口。

CLI 的 TUI、`run`、会话查询／删除／导出、模型查询和权限应答通过同一后端；`run --no-wait` 在输入接纳后返回 Session ID。未适配 HTTP 的命令显式失败，不回退为独立执行或直写数据库。官方 `opencode` 命令及数据保持独立。

实现：[`koma-backend.ts`](src/main/koma-backend.ts)、[`KomaBackend`](../core/src/koma-backend.ts)、[`shutdown-confirmation.ts`](src/main/shutdown-confirmation.ts)。

## Koma shared storage

应用身份 `com.kafeifei.koma.debug`（Debug）／`com.kafeifei.koma`（发行包），协议 `koma`；默认 profile 为 `~/.koma`，绝对路径 `OPENCODE_HOME` 可选择独立 profile。

| 路径                                            | 归属                                             |
| ----------------------------------------------- | ------------------------------------------------ |
| `desktop/`                                      | Electron profile、Web 存储和界面偏好             |
| `data/`、`config/`、`cache/`、`state/`、`logs/` | 数据库／认证／快照、配置、缓存、后端状态、日志   |
| `worktrees/`、`repos/`                          | 受管工作目录与仓库副本                           |
| `engines/codex/`                                | 原生 Codex 的独立认证、设置与历史                |
| `bin/`                                          | CLI、不可变版本和 `.lab-backend/` 所有权／启动锁 |
| `storage.json`                                  | 迁移记录、数据库选择及已有 worktree 身份         |

桌面首次启动迁移旧 `~/Library/Application Support/OpenCode Lab`；CLI 不执行旧桌面迁移。迁移先取得旧单实例锁，旧进程／服务占用、目标已有独立数据、跨文件系统均阻止迁移。目录重命名保留 SQLite 与 WAL，持久清单支持中断恢复，兼容链接和原逻辑目录身份保留任务、权限及输入的原 key。独立 profile 仅采用相邻 `<OPENCODE_HOME>.legacy`。

共享后端激活前检查旧数据库占用，再将清单提升至 v2（`backendProtocol: 1`）；保留该格式兼容性；数据库入口沿用上游行为，不再校验单个后端 PID。协议不兼容、所有权无效、存活但无响应的后端均阻止接管。应用包回退不构成数据回退。

Lab 清除所属配置／数据库环境覆盖项，禁用自动更新与项目配置自动加载，不迁入官方配置或认证。用户代码目录仍是真实目录；profile 隔离不提供文件系统沙箱。迁移保留旧文件与已归档目录身份，不自动恢复任务。

实现：[`StoragePaths`](../core/src/storage-paths.ts)、[`StorageMigration`](../core/src/storage-migration.ts)、[`KomaEnvironment`](../core/src/koma-environment.ts)。

## Koma global instructions

全局说明由后端加载，只导入文本，不导入其他客户端的设置或认证：

- 共同叠加非空 `~/.agents/AGENTS.md`。
- OpenCode 优先 `<OPENCODE_HOME>/config/AGENTS.md`；缺失／空白时按实际 API 模型 ID 回退：GPT／Codex／o 系列使用个人 Codex 说明，Claude 使用 `~/.claude/CLAUDE.md`，其他模型不回退。网关名称不参与选择，Claude 说明禁用选项仍有效。
- 原生 Codex 始终叠加个人 Codex 说明，不经过 OpenCode 配置或模型分类。个人 Codex 说明是后端 `CODEX_HOME`（未设置／空值时为 `~/.codex`）下首个非空的 `AGENTS.override.md`、`AGENTS.md`。

OpenCode 每个 provider turn 重选说明，V2 以替换方式记录变化。原生 Codex 经 start／resume 的 `developerInstructions` 注入，在后续空闲 turn 前更新，保留原生项目规则加载；活动 turn 不重启。项目说明和 skills 保留所属加载策略；非 Lab 入口保持上游行为。实现：[`KomaInstructions`](../core/src/koma-instructions.ts)。

## Web 与 Remote

本地 Web 提供同包 App，经 loopback 网关代理后端 HTTP、SSE 和 WebSocket。Host／Origin 校验约束入口，网关注入后端凭据；Web 没有独立用户登录层，可访问该端口的本地程序仍可经网关访问后端。入口保存首选端口，冲突时分配新端口。实现：[`web-entry.ts`](src/main/web-entry.ts)。

Remote 使用 GitHub device authorization（`read:user`、`read:org`）和 Microsoft Dev Tunnels。登录只发现设备；“允许远程访问”才为现有后端建立 owner-only tunnel。关闭共享会关闭网关及活动流；登出还断开本客户端的其他计算机连接，Session 仍归原服务端。凭据由 Electron `safeStorage` 加密，不接受不可用或明文存储；桌面 GitHub 请求使用 Chromium 网络栈。

另一台 Desktop 经本地 relay 复用服务器选择与 Session UI，私有连接失败不回退公网。客户端重启后需重新连接，尽量复用原端口以保留输入和偏好。共享端须保持运行与唤醒。[Remote Web](../remote-web/README.md) 独立部署，`OPENCODE_REMOTE_WEBSITE` 指定其 HTTPS 入口；网站登录与 tunnel 浏览器授权是两个会话。

OAuth 应用身份沿用 Sandy／Code OSS，授权页面可能显示 Visual Studio Code；未导入 Sandy 登录数据。来源与许可证见 [`remote/NOTICE`](../remote/NOTICE)。

## 构建与运行资源

[本包脚本](package.json)：`bun dev` 启动开发实例；`bun run debug` 完成预构建、前端构建和 macOS 打包签名，产物为 `dist-debug/mac-arm64/Koma Debug.app`，不安装或启动应用。包包含本仓 Node 后端、Koma CLI 和固定版本 V2 CLI；实际 Lab 使用同包 CLI 后端。Remote 依赖在候选包内由所带 Electron 加载检查。

构建信息含版本、构建 ID、序号、commit、dirty 和时间。各 worktree 共用 Git 元数据中的序号与锁；`build:debug` 成功后计数，`debug` 等全部阶段成功后计数，失败不占号，锁超时失败而不抢占。成功但未安装的包仍计数。实现：[`build-koma.ts`](scripts/build-koma.ts)、[`koma-build-sequence.ts`](scripts/koma-build-sequence.ts)。

打包实例将 ASAR 与 unpacked 资源复制到独立 `koma-runtime-*` 临时目录，供 renderer、preload 和本地 Node sidecar 使用；正常退出并停止服务后清理本实例快照。运行中整体换包依赖该快照，旧实例没有快照时不具备换包条件。不可变 CLI 版本独立于临时快照，后端持续存活时仍可使用。源码、安装包与运行版本因此可以不同。实现：[`runtime-resources.ts`](src/main/runtime-resources.ts)、[`resources.ts`](src/main/resources.ts)。

`build:koma-cli` 构建终端程序；`install:koma-cli [binary]` 原子安装受管版本及 `~/.local/bin/koma` 链接，已有独立同名命令构成冲突。显式 `OPENCODE_HOME` 只安装到指定 home；卸载只移除受管命令链接，保留数据及已有版本。

## 实验配置

实验功能保存于 `config/experiments.json`，属于本机后端启动偏好。后台子代理选项映射 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`；保存值与运行值分开显示，下次后端启动生效，不自动重启，也不改变 Task 的前后台默认模式。未保存时沿用上游环境变量行为。实现：[`backend-experiments.ts`](src/main/backend-experiments.ts)。

Koma Debug 与 Koma 使用同一工作台和共享后端；`bun run debug` 生成 Koma Debug.app。新 profile 默认使用 `~/.koma`，可用绝对路径 `KOMA_HOME` 指定。已有 Lab profile 保留物理目录和锁，以 `~/.koma` 兼容链接继续使用，不复制数据库；`OPENCODE_HOME` 仍兼容。旧协议标识、存储文件名和上游 OpenCode 引擎包名保留兼容用途。


### 连接设置

“设置 → 服务器 → 连接”分为“原生服务”和“远程隧道”。原生服务管理 App 内置服务、手动添加的本机/LAN/公网地址，以及本地 Web 入口。服务的“打开项目”是导航操作，多服务状态仍由原有 Server 上下文持有。

远程隧道集中管理 GitHub 登录、本机共享、账号设备、配额和远程 Web 入口。关闭本机共享保留登记及向外的设备连接；退出 GitHub 按现有语义停止本机共享和该账号的客户端连接，云端登记保留。

离线记录可逐条或批量清理。桌面管理目录包含缺少端口的 Koma 残留登记，连接目录继续要求完整的单个 HTTP 端口。删除前重新核对账号归属、产品标签、实例身份和宿主在线状态；本机、正在使用的连接、在线与未知状态不被清理。批量结果逐条反馈，删除云端 tunnel 不删除设备上的任务或项目。SDK 没有按宿主连接数条件删除的接口，复查与删除之间仍有服务端竞态窗口。

配额从服务商的账号限制接口读取，缺失时保持未知，不用 Koma 过滤列表的数量替代账号总量。这里不自动删除离线设备；服务商默认连续 30 天无活动后回收登记。
