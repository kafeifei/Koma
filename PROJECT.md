# OpenCode Lab：架构差异与边界

[kafeifei/opencode](https://github.com/kafeifei/opencode) 基于 [anomalyco/opencode](https://github.com/anomalyco/opencode)，主线为 `dev`。Lab 增加项目／任务工作台、原生 Codex 接入和共享本地后端；保留上游包结构与协议，是独立实验渠道。

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
- **未发送输入**：每个窗口的新建输入框持有一份临时草稿，切换项目只改变发送目标，首次发送才建立 Session。已有会话输入仍归该 Session；输入偏好和本地置顶不是后端执行状态。具体约束见[工作区与任务](./docs/workspace.md)。
- **生命周期**：归档保留历史和输入，后端拒绝新增输入；归档与停止执行是独立操作。恢复及删除经过目录身份、执行占用和持久保存状态检查，不以客户端显示状态替代判定。

## 运行边界

- Lab 身份为 `ai.opencode.lab`，协议为 `opencode-lab`，默认数据根为 `~/.opencode`。同一 profile 只有一个共享后端，桌面和本 fork 的 CLI 通过认证 loopback 接入；官方渠道的数据与登录不主动迁入。
- 关闭窗口、断开 Web 或 CLI 不停止后端；完整退出桌面时，活动任务或状态查询失败会触发确认，确认后停止所连接的本地后端及其任务。
- 本地 Web 网关只监听 loopback。Remote 是显式开启、默认仅所属账号可访问的独立隧道；远端任务仍属于原设备的后端，网站不转发工作台流量。
- profile 隔离覆盖应用与后端状态，不是文件系统沙箱。项目目录仍是真实文件系统；原生 Codex 使用独立 home，模型配置与凭据接入不改变原生执行归属。

存储迁移、资源快照和入口配置见 [Desktop](./packages/desktop/README.md)；原生投递、审批及恢复边界见 [Codex](./packages/codex/README.md)。

## 与上游的边界

Lab 的差异集中在工作台、宿主接入和独立适配模块。数据一致性与生命周期能力落在所属 Session／服务层；通用核心不携带 Lab 品牌或布局策略，扩展未启用时保留上游行为。现有核心引擎、包边界和协议语义继续成立。

依赖方向保持：Schema → Core／Protocol → Server；Client 运行时代码仅依赖 Schema／Protocol，`sdk-next` 组合 Client、Core 和 Server。公开 API 的客户端由契约生成。

上游 Session 执行与上下文不变量见 [CONTEXT.md](./CONTEXT.md) 和 [Session API](./specs/v2/session.md)。原生 Codex 通过独立宿主接入，不进入 OpenCode 的模型 Provider 或执行循环；当前范围不包含 Cindy／ACP 主架构、Claude／DSH 原生接入、跨引擎调度或云端团队平台。
