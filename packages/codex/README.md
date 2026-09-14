# Codex 原生后端

`@opencode-ai/codex` 将原生 Codex app-server 接入 Lab 的同一 Session 索引、App 和事件服务。Codex 拥有模型调用、工具、原生历史和子代理执行；本模块负责宿主适配，不是 OpenCode 模型 Provider。

## 职责与数据归属

| 对象                           | 所有者与代码入口                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务身份、标题、归档、项目关系 | 现有 Session；`engine=codex` 随创建持久保存且不切换。OpenCode 执行入口通过 [engine guard](../core/src/session/external/guard.ts) 拒绝外部任务，不回落执行。                                                |
| 原生绑定、投递、删除回执       | Core [SessionExternal](../core/src/session/external/index.ts) 与 [表定义](../core/src/session/external/sql.ts)；绑定键包含 runtime scope 和 thread ID，不另建任务库，也不使用 OpenCode runner 的输入队列。 |
| 进程、连接与操作               | [Host](src/host.ts) 组合 [Runtime](src/session.ts) 和 [transport](src/transport.ts)，后端拥有一个惰性 app-server 连接，多 thread 共享；连接换代使旧响应与审批失效。                                        |
| 历史与界面投影                 | 原生历史为事实源；[projection](src/projection.ts)／[view](src/view.ts) 生成共享 UI 数据，经现有 SSE 发布，不写入 OpenCode 消息／历史表。                                                                   |
| 目录占用                       | Core [外部执行所有权](../core/src/session/external/ownership.ts) 和宿主注入的 [worktree 接口](src/worktree-access.ts)；UI 不判定目录是否可回收。                                                           |

两套服务端装配同一 Host。`OPENCODE_ENABLE_CODEX=1` 开启原生引擎，未开启时不列出引擎、不启动 app-server。公开展示／操作形状由 [SessionExternal schema](../schema/src/session-external.ts) 定义，App 只提交用户意图和呈现后端确认状态。

## 输入与审批

首次创建在同一事务保存 Session、绑定占位和首条投递。首发 request ID 在 runtime scope 内唯一，后续在 Session 内唯一；相同 ID 只接受参数完全一致的重试。[输入转换](src/input.ts) 冻结正文、附件内容及模型／推理／权限设置，后续设置不改写已接收输入。

Lab 持久接收、原生 RPC 接收和原生历史确认是三个边界。`accepted` 缺少 `nativeItemID` 时仍等待历史确认；只有包含目标终态 turn 的完整 paginated 历史，才能证明已确认接收的输入未进入该轮并退回为 `returned`。SQLite 与原生 RPC 不构成共同事务，`sending`／`unknown` 在重启后不自动重投，也不按目录、标题或相同文字猜测回执。

队列由 Lab 唯一持有：`steer` 在运行中补充输入，显式 `queue` 等原生确认空闲后逐条投递；它不驱动模型执行循环。停止和进程恢复暂停尚未投递的输入；`paused`／`returned` 需显式恢复同一持久请求，新输入不隐式恢复旧队列。`settings` 表示有效配置，`pendingSettings` 表示尚待确认的选择。

[交互适配](src/interaction.ts) 保留原生请求身份，Host 按连接代次、请求 ID 和 revision 校验回复；多窗口只有首个有效回复获受理。UI 回传选择 ID 与表单值，权限子集由后端校验；旧审批不在重连后复活，问题和 MCP 表单不由自动批准代答。

`default` 为原生 workspace-write／on-request；`auto` 使用相同沙箱，仅在本代原生配置已确认后，由 Host 接受原生提供的单次允许选项，不新增规则或会话授权。`full` 为 danger-full-access／never。旧只读或无法识别的原生组合保留原配置，直到用户明确切换。

## 历史、恢复与子任务

历史先按绑定读取，再为未归档任务接入原生执行状态。只读历史不确认执行结束、不释放目录占用、不处理审批或投递队列；接入失败仍保留已读内容。冷加载归档任务不触发原生 resume，已经接入的活动任务保留状态订阅。恢复只连接原 thread，并校验 scope、thread 与真实目录身份。

[history](src/history.ts) 仅在原生 API 无法提供正文时读取已绑定、身份校验通过的精确 rollout 路径；不扫描其他历史，不写入或 resume。UI 的消息身份与展示顺序独立；读取与通知交错时重取快照，避免重复追加 delta。Host 的 epoch／revision 是投影版本，不是原生持久事件游标。缺失的用量、时间、计划和 diff 保持不可用，原生轮次 diff 与工作区 Git diff 分开。

原生名称只替换 Session 的默认标题、首发摘要或本 Host 已写入的标题；Host 重启后保留其他自定义标题，不猜测其来源。

原生子 thread 经后端确认父关系和 scope 后绑定为带 `parentID` 的 Session，各自保留历史。父任务仅展示委派关系，导航只指向已接管的子 Session；无法确定子任务归属时继续保护共享目录占用。原生同进程 wait 的完成通知不随历史持久化，重启读取子历史不会伪造 wait 结果。

## 跨后端接管

同一原生 home 的多个后端通过仅监听 loopback、使用私有随机凭据的 Host 登记协调写入归属。普通历史读取和重试不停止原持有者；写锁冲突时，用户可选择“停止并接管”。原持有者暂停尚未投递的输入，停止目标回合，等待原生工具完成后交出同一 thread。旧窗口保留历史，并停止自动接入；再次控制须显式接管。未知投递和暂停队列不随接管重发。

固定的 Codex 0.154.0 在取消订阅后保留 writer 30 分钟；接管使用原生 archive/unarchive 卸载已停止的 thread，Koma Session 的归档状态不变。先持久记录该 thread 与原先未归档的后代，再恢复这些精确 ID；原先已归档的后代保持归档。恢复途中失败保留记录，显式接管重试完成恢复。仍在执行的后代须先停止，不能通过归档父任务隐式停止它们。

两个后端均须支持此协议。旧后端或不可达的持有者不会被杀进程、删除锁文件或复制历史绕过；升级后需由用户重新启动对应应用。

## 归档与永久删除

归档状态归 Lab Session，保留原生历史并拒绝新输入；归档不隐式停止已经开始的执行。永久删除由现有 Session 删除入口按引擎分派到 Host，同时受服务端能力与目录生命周期约束。

删除前核对任务及已知子任务的绑定、执行、工具、交互和投递状态。活动或结果不明时保留数据；仅能确定从未开始创建原生 thread 的记录可直接清理。删除意图持久保存后冻结新输入及新增子任务，按子到父确认原生 `thread/delete`，再删除本地 Session，最后收尾专属 worktree。

原生删除回执丢失时保留本地任务与删除状态，重试先核实原生结果。确认删除的 scope／thread ID 写入独立于 Session 的 tombstone，父历史刷新不会重新导入已删除子任务；其他读取失败不会被当作已删除。

## 原生边界

运行时固定为 [0.154.0](codex-version.txt)，由 transport 启动前核对。桌面构建携带官方完整运行时包及固定 SHA-256，随不可变 Koma CLI 一起保存；首次使用在当前 profile 的缓存中原子解包，空 profile 无需另行安装 Codex。`OPENCODE_CODEX_BINARY` 是显式开发覆盖，仍须匹配版本；没有随包运行时的源码开发只选择 PATH 中版本匹配的 CLI，不修改系统 Codex。[能力基线](src/capabilities.ts) 记录该版本的实际限制：新 thread 显式使用 paginated history 以保留原生 ID 和内层工具；legacy 历史会缺失内层工具、重建 ID，不能证明执行结束。`turn/interrupt` 可能早于内层命令退出，持久执行占用须等明确完成证据才释放。原生 queue 向空闲 thread 添加输入会立即执行，不承担 Lab 的暂停队列。

原生 plan 只有实时通知，没有重连回放源；Host 启用 `update_plan` 工具，未改写原生配置文件或强制启用可选子代理工具。

[storage](src/storage.ts) 为原生历史提供独立 home 和稳定 scope；transport 向子进程设置 `CODEX_HOME`／`CODEX_SQLITE_HOME`。Codex 不提供独立模型或登录，也不读取、导入、同步原生账号。已有 Provider 的模型、endpoint、API key 或 OpenAI OAuth 由宿主管理；OAuth 刷新和账户切换仍归 Provider，凭据通过临时本地端点按请求解析，token 不进入 UI 或原生 auth 文件。[供应商端口](src/providers.ts)／[凭据适配](src/provider-credentials.ts) 只提供模型目录和原生 provider 配置，实际模型调用仍由 Codex 完成。全局说明经宿主 KomaInstructions 提供，项目指令、skills、MCP 和工具运行仍由 Codex 管理。

## 许可

集成代码沿用仓库 MIT 许可。生成协议来自 OpenAI Codex 0.154.0，保留 Apache-2.0 声明及随附 [LICENSE](src/protocol/LICENSE)、[NOTICE](src/protocol/NOTICE)。
