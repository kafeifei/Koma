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
3. **保留完整的工作能力。** 继续使用现有对话、输入保留、权限交互、文件、diff 和终端能力；界面改造要覆盖真实工作过程。未发送输入不是独立的草稿任务。
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

Codex 原生执行接入已单独评审并获准实施，方案见 [Codex 集成设计](./docs/plans/codex-native-integration.md)。
它复用同一 Session 任务索引和 App，使用 `packages/codex` 连接原生 app-server；Codex 的执行、
历史和审批仍由原生 runtime 持有。此授权不包括 Cindy／ACP 主架构、Claude／DSH 实施或跨引擎调度。
实现和验收状态以该方案及当前分支的验证证据为准，不能仅凭模块存在认定已交付。

## 4. 数据和代码归谁负责

| 对象／层                                                                     | 事实源与边界                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务                                                                         | 工作台中的持久任务以现有 Session 表示，顶层列表以 root Session 为主；首次发送前只有所属目录的新建输入，不建立独立草稿任务。不要新增第二套 Task 数据库，也不要把一次模型调用或一个进程等同于任务 |
| 项目、目录、worktree                                                         | 复用项目与工作区模型；按所属 server 和目录／项目身份归组，不用显示名称当唯一标识，不把 worktree 当独立执行引擎                                                      |
| 会话标题、历史、归档状态                                                     | 标题与归档沿用后端 Session 元数据。OpenCode 历史沿用原执行存储；Codex 历史从绑定的原生 thread 读取，不写入 OpenCode 历史表。前端通过所属 API 同步；归档与恢复要反映持久状态                                                |
| 列表、搜索与运行状态                                                         | 首页和侧栏共享所属 server 的索引与事件缓存，搜索通过后端查询；分页、重连、请求与事件竞态不能丢失旧任务或覆盖新状态                                                  |
| 本地界面偏好                                                                 | 侧栏展开、置顶等可沿用前端持久化；当前置顶按 server scope 存在本地，不承诺跨设备／跨客户端同步，也不代表后端任务状态                                                |
| 路由与当前任务                                                               | 复用现有 tabs、路由和输入持久化。新建页内部保留确定性 DraftTab 壳，每个 server scope 和规范化实际目录复用一个输入；已有会话保持原持久化 key。切换或关闭不删除输入，不隐式取消执行或删除会话 |
| `packages/app`、`packages/session-ui`、`packages/ui`                         | 分别承担应用组合、会话 UI 与共享控件；优先复用已有组件和状态，不为侧栏复制一套会话渲染器                                                                            |
| `packages/desktop`                                                           | 主进程管理平台能力、后端和 Web 入口；renderer 通过 preload／IPC 调用，不直接接管后端存储与进程                                                                      |
| `packages/opencode`、`packages/core`、`packages/server`                      | 沿用现有 CLI／兼容接口、领域运行时、V2 服务边界；按调用链找到真正所有者后修改，不能因为旧包名就把逻辑集中回去                                                       |
| `packages/schema`、`packages/protocol`、`packages/client`、`packages/sdk/js` | Schema、公开契约及客户端保持各自职责；生成代码不是手工修改入口，依赖方向和生成命令遵守 [AGENTS.md](./AGENTS.md)                                                     |

Session 执行、持久输入、投影、Context Epoch 等具体不变量仍由 [CONTEXT.md](./CONTEXT.md)、[specs/v2/session.md](./specs/v2/session.md) 和根 `AGENTS.md` 的 V2 Session Core 约束。UI 中出现“任务”一词不构成新增一层执行身份或调度器的理由。

工作台不再列出草稿分组。选择项目或已存在 worktree 时打开目标目录自己的文字、附件和上下文，不搬运源输入；待创建 worktree 在获得真实目录前仍归源输入，创建后沿用后端 Session 和权限档位提交。首次发送只清理已提交版本，不覆盖等待期间的新输入。关闭仅离开输入页，保留单例元数据中的上次权限选择；关闭重开、刷新及首次发送后再次新建都不重置该选择，正式会话的权限档位仍各自独立。

普通打开不覆盖已有输入。现有入口显式传入非空预填时，先等待保存内容加载，再按“已有文字、空行、预填文字”的顺序追加，保留已有附件位置和上下文，不另建草稿或恢复界面。

新建输入按 server 和项目保存用户选择的模型、推理档位和权限档位，OpenCode 与 Codex 分别保留设置；同项目的新输入沿用已保存的选择。已有输入中的显式设置优先，正式会话仍以所属后端状态为准。模型目录暂未加载时不覆盖保存值；这些设置只表达新任务的提交意图，不改变权限判定或自动批准规则。

按已批准的旧数据策略，升级时在 tabs 持久化加载后只尝试一轮旧 UUID 草稿清理：通过现有 scoped 删除 API 确认对应保存文档删除完成后，才移除该条旧稿索引；失败索引保持隐藏，留待下次加载接续这次升级清理，不常驻重试。不提供旧稿恢复入口，正式会话输入和新目录单例输入保留。不扫描缺失 tab 元数据的孤立文档，也不承诺跨窗口实时合并。

`packages/codex` 是原生后端适配模块，不是第二套任务数据库或 OpenCode 模型 Provider。共享
`packages/schema` 定义有限的展示与操作数据；原生投影通过现有 SSE 服务进入 App 的同一任务视图。
Backend 管理它创建的 app-server 进程、投递回执、审批和执行租约，Desktop/Web 不各自启动运行时。

## 5. 实验运行与用户数据的边界

- Lab 使用独立的应用身份 `ai.opencode.lab`、协议 `opencode-lab` 和 userData；后端的 data、config、cache、state 放在该 userData 下的 `backend/`，具体规则见 [channel.ts](./packages/desktop/src/main/channel.ts) 与 [lab-environment.ts](./packages/desktop/src/main/lab-environment.ts)。
- Lab 的隔离准备会清除代码列出的配置／数据库等环境覆盖项，禁用项目配置加载与自动更新；它不会自动继承官方 OpenCode 的全局配置和认证存储。不要为“方便测试”接管或迁移官方实例的数据、登录状态或后台服务。
- 这是应用和后端状态隔离，不是文件系统沙箱。用户打开的代码目录仍是真实目录；不能据此宣称所有环境凭据、项目文件、外部工具和网络都已隔离。
- 本地 Web 入口属于该 Desktop 实例，默认开启，可在设置中关闭；仅监听 `127.0.0.1`，代理到该实例的后端。网关检查 Host，对非页面导航请求检查来源，并在代理层加入后端认证；它没有独立的用户登录层，可访问该 loopback 端口的本地程序仍在可达范围内。不能擅自改成公网／局域网服务或新建第二套 Session 数据源。具体规则见 [web-entry-controller.ts](./packages/desktop/src/main/web-entry-controller.ts) 和 [web-entry.ts](./packages/desktop/src/main/web-entry.ts)。
- Remote 是显式开启的独立入口：GitHub 设备授权配合 Microsoft Dev Tunnels，默认仅所属账号可访问。Desktop 主进程持有登录、共享和连接状态；它为当前实例的同一后端创建独立 loopback 网关与私有隧道，关闭共享会关闭该网关及已有连接。独立登录不自动开启共享，连接其他设备也不要求共享本机。网站仅处理登录与设备目录，工作台流量直接进入微软隧道；不另建 Session 数据源。配置与验证边界见 [Desktop README](./packages/desktop/README.md) 和 [Remote Web README](./packages/remote-web/README.md)。
- 源码、`dist-lab` 产物、已安装的 `OpenCode Lab.app`、正在运行的实例和它连接的后端分别核验。即使路径或版本号相同，也不能把一次构建成功当成用户当前实例已经生效。
- 诊断和验证先保留现场；不擅自删除 Session、清理用户存储、reset／stash 工作区、终止已有进程或重启服务。是否允许安装、启动、重启、提交、推送和发布，以整段会话中已有的具体授权为准。

## 6. 当前落点与已知边界

以下是 **2026-09-06 的本地源码核对**，用于找代码，不代表 UI 或发布验收。核对时本地 `dev` 与 `origin/dev` 为 `bbd72fb8b0`，产品改动存在于未提交工作区；已配置 `upstream`，但本地没有 `upstream/dev` 引用。这不是最新上游状态声明，后续任务须重新检查。

| 区域         | 当前源码落点／限制                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务工作台   | [layout-new.tsx](./packages/app/src/pages/layout-new.tsx) 接入 [task-sidebar.tsx](./packages/app/src/pages/layout/task-sidebar.tsx)。新旧布局仍共存，实际界面由 `newLayoutDesigns` 等现有设置决定；改到新布局不等于旧布局同步改变                                                           |
| 共享会话索引 | [home-session-query.ts](./packages/app/src/context/global-sync/home-session-query.ts) 与 [home-session-index.ts](./packages/app/src/context/global-sync/home-session-index.ts) 供首页、侧栏共用。现有 V2 列表适配会分页扫描全部会话，再转成列表摘要；不能把它描述成已优化好的服务端任务索引 |
| 搜索         | [task-search.ts](./packages/app/src/pages/layout/task-search.ts) 调用本 fork 增加的 `/experimental/session/search`，服务端在 [session.ts](./packages/opencode/src/session/session.ts) 查询标题和可见文本。它不等于文件搜索或全部类型消息搜索；连接其他版本服务时需核对端点支持              |
| 归档／恢复   | 侧栏及会话菜单按服务端 capabilities 门控，V1 沿用 Session 接口，V2 使用专用 archive／restore／delete；[projector.ts](./packages/core/src/session/projector.ts) 的本地改动涉及恢复归档时清空持久字段。本轮补齐宿主 V2 生命周期，未集成宿主的独立服务明确报告不支持                                                                                                              |
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
