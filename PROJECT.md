# OpenCode Lab：项目定位与边界

本仓是在 OpenCode 上迭代项目／任务工作台的实验 fork。当前目标是把 OpenCode 已有的项目、会话和开发工具组织成更接近 Codex 的日常工作体验，并通过真实使用找出需要补齐的能力。**OpenCode Lab** 是当前独立桌面实验渠道的名称；最终产品命名与更大的平台架构不由这个名称决定。

这份文档供新加入的开发者和 agent 判断“我们在做什么、应该改哪里、什么需要另外决策”。多线开发、完成后自动合入 `dev` 和本地发 Lab 的规则见 [DEVELOPMENT.md](./DEVELOPMENT.md)。产品目标与范围变化时更新相应文档；临时进度、测试日志和发布记录另行报告。

## 1. 上游是谁，本仓是什么

| 项目         | 约定                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 上游         | [anomalyco/opencode](https://github.com/anomalyco/opencode)，本地 remote 名为 `upstream`                           |
| 本 fork      | [kafeifei/opencode](https://github.com/kafeifei/opencode)，本地 remote 名为 `origin`                               |
| 基线分支     | `dev`；不要假设有 `main`，也不要把 `origin/dev` 自动当成最新上游                                                   |
| 仓库形态     | 保留 OpenCode monorepo，在原有包和运行链路上修改                                                                   |
| 当前主要界面 | `packages/app` 的共享 Web UI，以及 `packages/desktop` 的 Electron 桌面应用                                         |
| 归属说明     | 本 fork 和 OpenCode Lab 由本项目维护，不是 OpenCode 团队制作的官方产品，也不隶属于该团队；保留上游许可证与归属信息 |

根目录的多语言 `README`、`CONTRIBUTING.md`、`CONTEXT.md` 和 `specs/` 大量沿用上游内容。它们提供安装、贡献和技术背景，不能单独说明本 fork 的产品路线。上游 README 中的下载链接和包管理安装命令面向官方 OpenCode，不会交付本地 Lab 改动。

核对上游关系时先查看 `git remote -v`、当前分支、HEAD 和工作区 diff。有可用的 `upstream/dev` 时再核对分叉点；没有该引用时明确基线缺失，不能把本地 HEAD 宣称为最新上游。实施任务的本地提交与合线按 [DEVELOPMENT.md](./DEVELOPMENT.md) 执行；同步上游、推送或公开发布需要当前任务的相应授权。

## 2. 我们当前要什么

1. **连续的项目／任务工作台。** 项目和任务入口持续可见；从首页进入会话、切换任务、返回旧任务都沿用清楚的导航关系。
2. **真实且一致的任务数据。** 任务列表接入现有会话索引和事件，支持查找、置顶、改名、归档与恢复；运行中、需要输入、未读等状态来自已有状态链路。
3. **保留完整的工作能力。** 继续使用现有对话、输入、草稿、权限交互、文件、diff 和终端能力；界面改造要覆盖真实工作过程。
4. **可辨认、可验证的本地实验版本。** Lab 与官方安装并存，能够识别当前构建和后端，桌面与本地 Web 入口使用同一套 App 及该实例的后端。
5. **在使用中确认缺口。** 先用 OpenCode 的真实能力完成工作，再决定补哪些功能。“像 Codex”是交互参考，不代表已经具备 Codex 的全部能力。

以上是当前目标和验收方向，不是全部完成的声明。当前代码落点和已知边界见第 6 节。

## 3. 与上游的分界线

**本 fork 主导工作台体验和实验交付方式；OpenCode 的会话、执行、存储及协议继续作为基础。** 功能落点由事实源和所有权决定，不能简单按“只准改前端”划线。

| 变更类型                                        | 落点与要求                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 项目／任务导航、侧栏、标题栏、搜索呈现、布局    | 本 fork 的产品层，优先在 `packages/app` 实现；共享控件沿用现有 UI 包                         |
| 实验渠道身份、构建标识、本地 Web 入口、进程接入 | `packages/desktop` 负责桌面生命周期与平台能力；Web 复用 App，保持 Lab 与其他渠道隔离         |
| 任务查询能力缺失、归档恢复不一致、事件投影错误  | 在拥有该数据的 Session／服务层补齐或修复，保持其他客户端的语义；通过 API 和生成 SDK 接入前端 |
| 对话渲染、工具与权限交互、模型调用、执行调度    | 优先沿用上游；确有缺陷时修所属层，并验证现有消费者，不因换工作台而重新实现                   |
| 上游通用缺陷                                    | 尽量形成能独立解释和验证的通用修复；不要把 Lab 的品牌、路径或布局策略混入通用核心            |
| Console、计费、官网、发布基础设施等其他包       | 仓库包含这些代码不代表本阶段需要开发它们；只有当前任务确实涉及才进入范围                     |

处理上游更新或冲突时，分别判断上游能力演进和本 fork 的产品差异，不能整块覆盖任一方。兼容性以实际使用的协议、服务版本和客户端为准，目录名或包版本号不足以证明兼容。

当前范围没有自动包含：自建多 agent Host、替换 OpenCode 执行引擎、接入多个独立编码代理并统一调度、云端／团队平台、把整个 monorepo 改名。Cindy、Sandy、ACP 等相邻探索可作为参考，采用它们需要单独的目标、所有权设计和验收范围。

## 4. 数据和代码归谁负责

| 对象／层                                                                     | 事实源与边界                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务                                                                         | 工作台中的持久任务以现有 Session 表示，顶层列表以 root Session 为主；草稿在提交前保持草稿身份。不要新增第二套 Task 数据库，也不要把一次模型调用或一个进程等同于任务 |
| 项目、目录、worktree                                                         | 复用项目与工作区模型；按所属 server 和目录／项目身份归组，不用显示名称当唯一标识，不把 worktree 当独立执行引擎                                                      |
| 会话标题、历史、归档状态                                                     | 后端 Session 数据和事件是事实源。前端通过现有 API 写入后同步缓存；归档与恢复要反映持久状态，不能只隐藏或重新插入一行                                                |
| 列表、搜索与运行状态                                                         | 首页和侧栏共享所属 server 的索引与事件缓存，搜索通过后端查询；分页、重连、请求与事件竞态不能丢失旧任务或覆盖新状态                                                  |
| 本地界面偏好                                                                 | 侧栏展开、置顶等可沿用前端持久化；当前置顶按 server scope 存在本地，不承诺跨设备／跨客户端同步，也不代表后端任务状态                                                |
| 路由与当前任务                                                               | 复用现有 tabs、路由和草稿机制。切换任务只改变查看目标，不应隐式取消执行、删除会话或丢失输入                                                                         |
| `packages/app`、`packages/session-ui`、`packages/ui`                         | 分别承担应用组合、会话 UI 与共享控件；优先复用已有组件和状态，不为侧栏复制一套会话渲染器                                                                            |
| `packages/desktop`                                                           | 主进程管理平台能力、后端和 Web 入口；renderer 通过 preload／IPC 调用，不直接接管后端存储与进程                                                                      |
| `packages/opencode`、`packages/core`、`packages/server`                      | 沿用现有 CLI／兼容接口、领域运行时、V2 服务边界；按调用链找到真正所有者后修改，不能因为旧包名就把逻辑集中回去                                                       |
| `packages/schema`、`packages/protocol`、`packages/client`、`packages/sdk/js` | Schema、公开契约及客户端保持各自职责；生成代码不是手工修改入口，依赖方向和生成命令遵守 [AGENTS.md](./AGENTS.md)                                                     |

Session 执行、持久输入、投影、Context Epoch 等具体不变量仍由 [CONTEXT.md](./CONTEXT.md)、[specs/v2/session.md](./specs/v2/session.md) 和根 `AGENTS.md` 的 V2 Session Core 约束。UI 中出现“任务”一词不构成新增一层执行身份或调度器的理由。

## 5. 实验运行与用户数据的边界

- Lab 使用独立的应用身份 `ai.opencode.lab`、协议 `opencode-lab` 和 userData；后端的 data、config、cache、state 放在该 userData 下的 `backend/`，具体规则见 [channel.ts](./packages/desktop/src/main/channel.ts) 与 [lab-environment.ts](./packages/desktop/src/main/lab-environment.ts)。
- Lab 的隔离准备会清除代码列出的配置／数据库等环境覆盖项，禁用项目配置加载与自动更新；它不会自动继承官方 OpenCode 的全局配置和认证存储。不要为“方便测试”接管或迁移官方实例的数据、登录状态或后台服务。
- 这是应用和后端状态隔离，不是文件系统沙箱。用户打开的代码目录仍是真实目录；不能据此宣称所有环境凭据、项目文件、外部工具和网络都已隔离。
- 本地 Web 入口属于该 Desktop 实例，默认开启，可在设置中关闭；仅监听 `127.0.0.1`，代理到该实例的后端。网关检查 Host，对非页面导航请求检查来源，并在代理层加入后端认证；它没有独立的用户登录层，可访问该 loopback 端口的本地程序仍在可达范围内。不能擅自改成公网／局域网服务或新建第二套 Session 数据源。具体规则见 [web-entry-controller.ts](./packages/desktop/src/main/web-entry-controller.ts) 和 [web-entry.ts](./packages/desktop/src/main/web-entry.ts)。
- 源码、`dist-lab` 产物、已安装的 `OpenCode Lab.app`、正在运行的实例和它连接的后端分别核验。即使路径或版本号相同，也不能把一次构建成功当成用户当前实例已经生效。
- 诊断和验证先保留现场；不擅自删除 Session、清理用户存储、reset／stash 工作区、终止已有进程或重启服务。是否允许安装、启动、重启、提交、推送和发布，以整段会话中已有的具体授权为准。

## 6. 当前落点与已知边界

以下是 **2026-09-06 的本地源码核对**，用于找代码，不代表 UI 或发布验收。核对时本地 `dev` 与 `origin/dev` 为 `bbd72fb8b0`，产品改动存在于未提交工作区；已配置 `upstream`，但本地没有 `upstream/dev` 引用。这不是最新上游状态声明，后续任务须重新检查。

| 区域         | 当前源码落点／限制                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务工作台   | [layout-new.tsx](./packages/app/src/pages/layout-new.tsx) 接入 [task-sidebar.tsx](./packages/app/src/pages/layout/task-sidebar.tsx)。新旧布局仍共存，实际界面由 `newLayoutDesigns` 等现有设置决定；改到新布局不等于旧布局同步改变                                                           |
| 共享会话索引 | [home-session-query.ts](./packages/app/src/context/global-sync/home-session-query.ts) 与 [home-session-index.ts](./packages/app/src/context/global-sync/home-session-index.ts) 供首页、侧栏共用。现有 V2 列表适配会分页扫描全部会话，再转成列表摘要；不能把它描述成已优化好的服务端任务索引 |
| 搜索         | [task-search.ts](./packages/app/src/pages/layout/task-search.ts) 调用本 fork 增加的 `/experimental/session/search`，服务端在 [session.ts](./packages/opencode/src/session/session.ts) 查询标题和可见文本。它不等于文件搜索或全部类型消息搜索；连接其他版本服务时需核对端点支持              |
| 归档／恢复   | 侧栏仍有 V1 协议能力门控，写入使用现有 Session 接口；[projector.ts](./packages/core/src/session/projector.ts) 的本地改动涉及恢复归档时清空持久字段。不能承诺所有协议路径已覆盖                                                                                                              |
| Lab 打包     | [Desktop package.json](./packages/desktop/package.json) 提供 `build:lab`、`package:lab`、`lab` 脚本；当前 `package:lab` 面向 macOS 目录包。脚本存在不代表已安装或其他平台已验证                                                                                                             |
| 验证入口     | 任务工作台有 [task-workspace.spec.ts](./packages/app/e2e/regression/task-workspace.spec.ts)，索引、搜索、Session API 和 Lab 隔离各有聚焦测试；测试文件存在不代表本次已经运行或通过                                                                                                          |

## 7. Agent 如何开始和交付

1. 读本文件和对应目录的 `AGENTS.md`，确认整段会话的目标、已有授权、保护项与验收条件；文档描述能力不等于授权执行操作。
2. 看当前分支、HEAD、未提交改动及相关运行实例，区分本次改动与已有工作。先与正常路径／基线比较，再追数据所有者；历史记录只作线索。
3. 把改动归入产品 UI、Desktop 平台能力、上游通用修复或新范围。范围内修根因；遇到关键产品选择或范围扩张，先把方案和影响说清楚。
4. 布局改动先提供可检查的预览并对齐方向；数据和行为改动通过真实 API、事件与用户流程验证。适用时运行聚焦测试和包级 `bun typecheck`；测试不能从仓库根目录运行。纯文档改动检查链接、内容一致性和 diff 即可。
5. 改公开协议或 API 时，按根 `AGENTS.md` 中对应命令生成客户端，不能手改生成文件。改会话／时间线时也遵守 App 的性能基线要求。
6. 交付说明实际改动、验证证据和未验证项。构建、安装、运行验证分别报告；仍有范围内且可执行的必要工作时继续完成。

开发运行方式见 [packages/app/AGENTS.md](./packages/app/AGENTS.md) 和 [packages/desktop/README.md](./packages/desktop/README.md)。当前仓库要求的工具版本以根 [package.json](./package.json) 的 `packageManager` 为准；不要仅依据上游 README 的宽泛版本提示判断环境可用。
