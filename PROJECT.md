# Koma：基于 OpenCode 的 Agent 工作台

Koma 是一个基于 OpenCode 的桌面 Agent 工作台，探索类似 Codex 的项目与任务工作方式：围绕项目组织任务，让用户与 Agent 持续协作，在工作区中执行、检查并接续工作。

本项目与 Fumie 研究相同的问题：**Agent 工作台应该如何组织人与 Agent 的协作，让任务、执行环境和工作成果形成完整的工作流程。** 两者从各自的项目基础出发探索这一方向；Lab 以 OpenCode 为基础，发展桌面工作台体验，并接入原生 Codex。

## 探索方向与当前形态

- **以项目和任务组织工作**：把会话放回具体项目中，串联输入、执行状态、历史与工作成果，支持任务切换和后续接续。
- **让执行环境清晰可控**：组织项目目录、分支和 Worktree，明确任务与目录的关系，以及归档、恢复和删除的生命周期。
- **在工作台中接入 Agent 能力**：当前支持 OpenCode 与原生 Codex，在统一界面中呈现执行、历史和审批，同时保留各自运行时的职责与状态归属。
- **让工作延续到不同入口**：以桌面为主要入口，本地网页与远程访问连接同一后端，让任务的执行与客户端连接状态解耦。

[kafeifei/Koma](https://github.com/kafeifei/Koma) 基于 [anomalyco/opencode](https://github.com/anomalyco/opencode)，主线为 `main`。当前以 Koma 作为独立实验渠道，保留上游包结构与协议。以下记录现有实现的架构与边界。

## 架构

```text
Desktop / 本地 Web / Remote → 同一 App ─┐
CLI ──────────────────────────────────┤
                                     ↓
                          同一 profile 的 Lab Backend
                            ├─ OpenCode Session Runtime
                            └─ Codex Host → 原生 app-server
```

| 本仓改动           | 所属模块与边界                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目／任务工作台   | [app](./packages/app/README.md) 组合导航、输入和状态；`session-ui` 与 `ui` 继续提供会话界面和共享控件                                                                  |
| 桌面与访问入口     | [desktop](./packages/desktop/README.md) 持有平台能力、后端接入和本地 Web 网关；`remote` 提供私有隧道，[remote-web](./packages/remote-web/README.md) 提供登录与设备目录 |
| 任务和目录生命周期 | 现有 Session 持有任务元数据；[worktree](./packages/opencode/src/worktree/lifecycle.ts) 管理目录占用、归档快照与回收                                                    |
| 原生 Codex         | [codex](./packages/codex/README.md) 适配原生执行、历史和审批；[Session external](./packages/core/src/session/external/index.ts) 持久保存绑定与投递回执                 |

Lab 复用 OpenCode 的 HTTP 服务、Session 索引和事件链路。Desktop、Web、CLI 不各自运行一套执行循环；客户端断开不改变任务的后端归属。

## 数据与权限

- **任务身份**：持久任务统一为 Session，顶层列表以 root Session 为主。`engine` 区分 OpenCode 与 Codex，原生 thread 绑定在同一 Session 上；没有第二套 Task 数据库。
- **历史**：OpenCode 历史归原执行存储；Codex 历史归原生 runtime，转换后的 UI 投影可重建，不写入 OpenCode 历史表。绑定与发送回执属于工作台的持久记录。
- **权威状态**：运行、权限、投递、归档和删除由所属后端确认。UI 提交用户意图并呈现结果；自动批准、工具执行和调度不属于 UI。未知状态保持未知，历史读取成功不等于执行已结束。
- **项目与目录**：身份包含 server 和实际目录／项目，显示名不是标识。分支选择与是否使用隔离 Worktree 独立；切换视图不取消执行，也不删除目录或任务。
- **未发送输入**：新建输入按 server 与规范化实际目录保存，首次发送才建立 Session。已有会话输入仍归该 Session；输入偏好和本地置顶不是后端执行状态。具体约束见[工作区与任务](./docs/workspace.md)。
- **生命周期**：归档保留历史和输入，后端拒绝新增输入；归档与停止执行是独立操作。恢复及删除经过目录身份、执行占用和持久保存状态检查，不以客户端显示状态替代判定。

## 运行边界

Koma 首个 beta 沿用 Lab 的内部身份、协议和存储布局，以保持已有任务与配置的兼容性；应用展示名为 Koma。

- Lab 身份为 `com.kafeifei.koma.debug`（Debug）／`com.kafeifei.koma`（发行包），协议为 `koma`，默认数据根为 `~/.koma`。同一 profile 只有一个共享后端，桌面和本 fork 的 CLI 通过认证 loopback 接入；官方渠道的数据与登录不主动迁入。
- 关闭窗口、断开 Web 或 CLI 不停止后端；完整退出桌面时，活动任务或状态查询失败会触发确认，确认后停止所连接的本地后端及其任务。
- 本地 Web 网关只监听 loopback。Remote 是显式开启、默认仅所属账号可访问的独立隧道；远端任务仍属于原设备的后端，网站不转发工作台流量。
- profile 隔离覆盖应用与后端状态，不是文件系统沙箱。项目目录仍是真实文件系统；原生 Codex 使用独立 home，模型配置与凭据接入不改变原生执行归属。

存储迁移、资源快照和入口配置见 [Desktop](./packages/desktop/README.md)；原生投递、审批及恢复边界见 [Codex](./packages/codex/README.md)。

## 与上游的边界

Lab 的差异集中在工作台、宿主接入和独立适配模块。数据一致性与生命周期能力落在所属 Session／服务层；通用核心不携带 Lab 品牌或布局策略，扩展未启用时保留上游行为。现有核心引擎、包边界和协议语义继续成立。

依赖方向保持：Schema → Core／Protocol → Server；Client 运行时代码仅依赖 Schema／Protocol，`sdk-next` 组合 Client、Core 和 Server。公开 API 的客户端由契约生成。

上游 Session 执行与上下文不变量见 [CONTEXT.md](./CONTEXT.md) 和 [Session API](./specs/v2/session.md)。原生 Codex 通过独立宿主接入，不进入 OpenCode 的模型 Provider 或执行循环；当前范围不包含 Cindy／ACP 主架构、Claude／DSH 原生接入、跨引擎调度或云端团队平台。

Koma Debug 与 Koma 使用同一工作台和共享后端；`bun run debug` 生成 Koma Debug.app。新 profile 默认使用 `~/.koma`，可用绝对路径 `KOMA_HOME` 指定。已有 Lab profile 保留物理目录和锁，以 `~/.koma` 兼容链接继续使用，不复制数据库；`OPENCODE_HOME` 仍兼容。旧协议标识、存储文件名和上游 OpenCode 引擎包名保留兼容用途。

## 新安装默认值

- 默认 profile 为 `~/.koma`；已有 Lab 数据保留原位置并通过兼容链接接入。
- Codex 与 OpenCode 的可用模型汇总到同一 Provider 模型管理目录，共享显隐偏好；Codex 只负责执行，不提供独立模型目录或登录。模型、endpoint 与认证均来自已有 Provider，各引擎按协议支持能力筛选；旧任务无法确定 Provider 时保留历史并要求重选模型。
- 后台子代理默认开启，显式关闭的设置或环境覆盖继续有效。
- 新任务默认开启 Worktree；未保存分支选择时依次选已有的 `main`、`dev`、当前分支。分支选择与工作目录隔离分别控制。
- 账号、密钥、历史任务、项目级权限和个人模型偏好不内置到应用包。
