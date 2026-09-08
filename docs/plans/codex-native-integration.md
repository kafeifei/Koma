# OpenCode Lab 原生 Codex 接入设计

状态：设计稿，供评审与后续实施；尚未实现、运行或交付。用户本轮授权为设计。

设计基线：2026-09-06，本地 `dev` 提交 `4cac0d1f8d489576f838c9e33dec43bd659c7659`。结束时主线已推进至 `626e6624cba7d2209a90480c57cd7f5d0345bc37`，新增为工作区分隔线／标题栏改动；本设计保留上述审计基线，实施前重查交叉文件。设计工作目录为独立的 `opencode-app-test-codex-plan`，分支 `codex-integration-plan`。以下新增模块、接口名与表字段均为拟议内容，不代表仓库已有能力。

## 1. 目标与决定

用户在同一个 OpenCode Lab 项目／任务工作台里选择 Codex，继续使用现有会话、输入、工具卡片、审批、文件和 diff 界面；实际工作由原生 Codex 完整执行。

采用以下设计：

1. 现有 Session 仍是唯一工作台任务身份。增加不可变的 `engine` 和原生会话绑定，现有 OpenCode Session 默认仍为 `opencode`。
2. 一个独立的 Codex 后端模块连接 `codex app-server`。模型请求、工具、子代理、权限判定和上下文压缩由 Codex 执行；Lab 提交意图、接收事实并维护 UI 投影。
3. 桌面和本地 Web 通过同一个现有后端访问这层，沿用其认证、目录和项目边界。Electron 管理现有 sidecar 生命周期，renderer 不直接管理 Codex 进程。
4. 复用现有 UI 读模型和组件，补齐有限的操作注入点。OpenCode 默认分支继续调用原来的 SDK/sync，不先转换成另一套通用 agent 协议。
5. Codex 原生历史是执行与恢复的事实源。Lab 的 Session 索引、绑定、发送回执是持久工作台记录；历史展示是可重建投影，不进入 OpenCode runner 的消息表。
6. 第一阶段完成 Codex 的完整日常工作链路。Claude、DSH 留独立模块位置；不预建跨引擎切换、调度平台或 ACP 中转层。

## 2. 当前仓库为何需要这些接入口

| 已核对的边界                                                                                                                                                         | 设计影响                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/session-ui/src/context/data.tsx` 的 DataProvider 接收 Session/Message/Part/status/diff；`packages/app/src/pages/directory-layout.tsx` 把目录 sync 数据传入 | 会话展示可复用，但 DataProvider 本身不负责发送、全局任务列表或审批           |
| `packages/session-ui/src/v2/components/prompt-input/interaction.ts` 已有 submit/stop、model/agent/variant 控制器                                                     | 复用输入状态机和持久输入，只替换拥有后端语义的 controls/actions              |
| `packages/app/src/components/prompt-input-v2.tsx`、权限控制器和任务菜单仍直接调用 SDK/sync                                                                           | 需要少量可注入操作，不能只换气泡数据就宣布接入完成                           |
| Lab 默认构建源码 v1 sidecar，但同一服务装配 V2 Session；首页已调用 v2 Session list                                                                                   | 在两种 Session API 和实际执行入口守住 engine；不要求先迁移整个后端           |
| `packages/core/src/session/sql.ts` 的 SessionTable 为共有任务索引；v1 message/part 与 v2 session_message 是执行历史                                                  | 复用 SessionTable；外部历史不得混入这些执行表                                |
| `packages/core/src/session/info.ts` 不透传任意 metadata，projector 又会更新 metadata                                                                                 | engine 不能只藏在 metadata、只在 renderer 记住，或以 provider/model 名称推断 |
| App/session-ui 使用 vendored `@opencode-ai/client`，并非直接消费当前 workspace client                                                                                | 公开协议、生成客户端、实际 App 消费版本必须分别处理；不手改生成文件          |

`SessionExecution` 目前只有 active/resume/wake/interrupt，错误类型与 OpenCode SessionRunner 绑定。它不是可直接替换的完整 Codex 驱动接口。

另有一个交付边界：`OPENCODE_SIDECAR_V2=1` 选择下载的独立 CLI（当前脚本固定 `0.0.0-next-16350`），不是本仓默认 Node 构建。首期验收目标为默认源码 sidecar；另一二进制或外部 server 未返回 Lab 能力时，Codex 明确不可用。修改本仓 API 不代表该二进制已获得扩展。

## 3. 模块、依赖与操作入口

| 位置（拟议）                                     | 职责                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `packages/core/src/session/external/`            | Session 外部绑定、投递回执、engine 检查和索引更新。无需理解 Codex RPC                             |
| `packages/codex/src/transport.ts`                | 官方协议类型、stdio JSON-RPC、请求匹配、握手、进程代际和退出处理                                  |
| `packages/codex/src/session.ts`                  | thread 创建／读取／恢复、提交／steer／queue、中断；关联工作台 Session；每 thread 串行处理控制操作 |
| `packages/codex/src/projection.ts`               | 原生 item 到现有 OpenCode 会话读模型；实时与历史共用映射；稳定身份和内容合并                      |
| `packages/codex/src/interaction.ts`              | 待审批／待回答请求及原生回复；有效性由后端检查                                                    |
| `packages/schema/src/`、`packages/protocol/src/` | 可供浏览器使用的外部会话描述、快照、能力和有限 Lab API 契约                                       |
| `packages/server/src/` 及现有 v1 HttpApi 装配点  | 同一认证服务中组合 Core、Codex 和 API；将扩展同时注册到支持的服务入口                             |
| `packages/app/src/context/` 与 session 组合层    | 根据后端确认的 engine 选择数据与操作，把投影送入现有列表、目录缓存和会话组件                      |

依赖保持 Schema → Core/Protocol → Server。Codex 后端包依赖 Schema 和 Core 暴露的窄服务端口，由 Server 组合；Core 不反向 import Codex。前端只能依赖 Schema/Protocol/Client，不能 import Core、Server 或 Codex 后端包。Codex 协议类型从选定二进制生成，不直接搬入 Sandy 的 VS Code 服务实现。

前端组合处增加一个有限的 Session 后端视图：`descriptor/capabilities`、`snapshot`、`changes` 与 `actions`。不仿造整个 OpenCode SDK。文件浏览、Git、worktree、普通 PTY 仍使用所属目录现有服务。

现有任务列表继续查询 Session；补充 engine 描述和外部状态。OpenCode 分支原样使用原 controls/sync，Codex 分支消费 Lab 扩展。权限卡、问题卡、模型控制器等只增加数据或 callback 参数，组件内部不写 `if codex`。

### 前端改动清单

| 当前文件                                                                                                       | 所需接入口／保留项                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/app/src/context/global.tsx`、`server-sync.tsx`                                                       | 每 server 一个后端视图，复用现有事件连接；共用 session/home cache，不每个任务各开一套同步系统                            |
| `context/global-sync/home-session-query.ts`、`pages/layout/task-search.ts`、`task-sidebar.tsx`                 | 继续查询共有 Session 索引；补批量描述、能力门控、真实活动更新；改名／归档仍提交所属 Session 服务，删除等受限操作不能旁路 |
| `components/prompt-input/submit.ts`、`prompt-input-v2.tsx`                                                     | 现有 model/agent 前置检查改成当前引擎有效 controls 检查；复用输入、附件、worktree 与版本保护，执行动作注入               |
| `pages/session/composer/session-composer-state.ts`、`session-permission-dock.tsx`、`session-question-dock.tsx` | 把直接 SDK 回复改为 callback；审批选项由原生能力提供，不固定 once/always/reject                                          |
| `pages/session/composer/session-request-tree.ts`、session-ui 的 `components/message-part.tsx`                  | 保留 parentID 查找需输入子任务；将工具卡导航改为明确的关联 Session 字段，不要求外部工具谎报名称为 task                   |
| `pages/session.tsx`、`pages/session/review-tab.tsx`                                                            | 分别供应 turn diff／changed-file 提示和工作区 Git diff；保留选区评论与文件读取                                           |
| `components/session/session-context-metrics.ts`、`components/session-context-usage.tsx`                        | 原生 token、context window、费用和账户限额分别显示；缺失则无该数值，不能沿用 OpenCode provider 推算                      |
| `context/notification.tsx`                                                                                     | 复用已有通知／未读入口接收 Codex 确认完成、失败与需输入状态；不把浏览器收到事件当作已读                                  |
| `context/server-session.ts`、`server-session-v2-reducer.ts`、目录 DataProvider                                 | 抽取当前读模型转换的纯函数用于外部投影；只改必要入口，不全量替换旧 SDK 类型                                              |

索引批量描述仍属于原后端范围，状态获取失败只影响外部会话。跨引擎列表分页／搜索继续由统一 Session 索引完成，不在浏览器拼接两套分页结果；标题／项目搜索复用现有索引。原生正文搜索在没有后端能力时不承诺支持，也不返回空结果冒充搜过。

### 有限 Lab API（拟议形状）

路径可在实施中遵循仓库命名统一；以下定义语义，禁止扩张为完整 OpenCode HTTP 模拟服务。

| 操作                                                                | 内容与成功含义                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /lab/engines`                                                  | 引擎可用性、有效模型／effort、经过版本核验的能力                                                                               |
| `GET /lab/engines/codex/account` 与 `POST /lab/engines/codex/login` | 读取原生账户状态；用户主动发起登录时返回原生登录标识与授权入口，完成状态由原生事件／账户重读确认                               |
| `POST /lab/engines/codex/login/cancel`                              | 取消该 runtime scope 的指定登录尝试，不注销其他客户端                                                                          |
| `POST /lab/sessions/describe`                                       | 对当前列表的 Session ID 批量返回 engine、外部状态和能力；只读操作，不创建／恢复原生执行                                        |
| `POST /lab/sessions`                                                | 带 clientRequestID、engine、目标目录及首条输入，原子建立 Session 身份和投递记录；返回持久接收回执                              |
| `GET /lab/sessions/:id`                                             | engine、绑定状态、运行状态、可用操作、待交互及会话快照；未绑定不伪装成空闲可发送                                               |
| `POST /lab/sessions/:id/input`                                      | requestID、内容与 delivery；返回同一回执，不把 HTTP 接收等同原生已执行                                                         |
| `GET /lab/sessions/:id/deliveries/:requestID`                       | 查询一次发送是否待处理、确认接收、明确失败或结果未知                                                                           |
| `POST /lab/sessions/:id/queue`                                      | 对后端确认的队列项执行恢复／撤回，携带操作 ID 与队列 revision；先核对当前原生状态，不把 sending/unknown 当作尚未提交而重复执行 |
| `POST /lab/sessions/:id/interrupt`                                  | 指向已确认的原生 turn；请求成功后等待终态                                                                                      |
| `POST /lab/sessions/:id/interactions/:id/reply`                     | 精确交互身份及用户选择；重查连接代际、请求、thread 和 turn                                                                     |
| `POST /lab/sessions/:id/settings`                                   | 保存设置意图；模型／沙箱待原生确认，默认沙箱下即时切换自动批准；返回有效值，不修改 OpenCode permissionMode                     |
| 现有认证事件流的 Lab 事件扩展                                       | 同一连接交付外部状态、投影和交互变化；不再新增并行 `/lab/events`；公开事件 schema 和实际解码客户端同步升级                     |

API 定义走本仓 Protocol/HttpApi 和生成流程。Lab 扩展生成到独立客户端入口并由 App 显式消费；现有 vendored client 保持原用途。Session 公共摘要增加 engine 时，必须更新两种服务 DTO、相应生成客户端及 App 实际依赖，或者以 Lab 批量描述补齐旧客户端读取；首期选后者降低迁移范围，前端不能把“描述尚未返回”当成 OpenCode。后端 guard 不依赖前端是否正确识别。

批量描述按当前索引页的 ID join，缓存键为 server scope + Session ID；immutable engine 可缓存，binding/capabilities/runtimeStatus 按事件 revision 更新，失效时批量刷新。列表新增事件触发描述补齐，首次创建响应直接带描述，避免逐行请求。共有 Session 改名／归档／恢复由原服务先提交，再从同一事件流通知；Codex 的真实活动时间通过 Core 窄接口更新 Session 索引，不靠浏览器打开时间改变排序。

事件扩展客户端只接管新增的解码分支，并与原 server 事件分发器共用一个网络连接；原 OpenCode 事件保留当前解析和应用路径。新事件不会投递给只认识旧联合类型的 vendor decoder 后再静默丢弃。后端未声明支持时，不启用该扩展分支。

## 4. 数据所有权与创建事务

### 唯一任务身份

- `session.engine`：持久列，迁移旧行默认 `opencode`；创建后不提供改变引擎的普通 API。`agent` 仍表示引擎内角色／配置，`model` 仍表示模型，不用它们充当 engine。
- `session_external_binding`：以 `session_id` 为外键与唯一键，保存原生 thread ID、runtime scope、绑定状态、投影版本及真实活动时间。原生定位键须包含存储 scope，不能只按 thread ID 猜所属目录或账户。
- `session_external_delivery`：以 Session + clientRequestID 唯一，保存可恢复的正文／结构化输入、附件稳定引用、捕获的模型／effort／权限设置、投递方式、状态、原生 client/turn/item 关联及失败原因。完整参数指纹只用于冲突比对，不能替代实际内容。它是外部投递账本，不是新的 Task 表，也不使用会驱动 OpenCode runner 的 session_input。

delivery 账本始终只保证 Lab 接收与原生投递的可核对性。queue 的执行 owner 按第 5 节能力核验决定：原生 queue 可用时，记录原生 queuedSubmission ID 和回执，不再保留一套会自动推进的 Lab 队列；仅在原生能力有明确缺口时才由 Lab 的未提交 delivery 实现排队。

首次创建的 clientRequestID 还必须在 server/runtime scope 内唯一，才能在尚无 Session ID 的并发重试中返回同一个 Session。创建操作先 claim 此键，和分配 Session、绑定占位、首条 delivery 在同一事务提交；失败事务不留下半个任务。相同键比对完整首发参数（包括目录、engine、输入和设置），冲突不复用。可以在投递记录上增加首发专用唯一键，不为它另建任务索引。

每条 delivery 通过事务条件更新领取，进程内每 thread 只有一个提交者；HTTP 重试、队列唤醒与两个窗口不能并行提交同一条。附件在确认持久接收前必须保存为后端可访问且寿命覆盖投递／恢复的内容或稳定引用，不能仅指向已被清空的浏览器 blob URL。对本地图片、选区文本等冻结提交内容；文件路径引用则明确按原生读取文件的语义处理。清理原输入不撤销后端内容的所有权，不自动清理 unknown／未提交记录。客户端不传原生 ID 来选择任意 thread，后端始终由可信绑定解析目标。

engine 与 Session 创建必须在同一持久事件／事务中落地；projector 的旧式更新不得把已有 engine 重置为默认值。绑定只能通过所属服务建立，禁止常规更新 API 清除或改换归属。

现有 v1 prompt/loop、v2 prompt/resume/wake、runner drain 入口均检查 engine：OpenCode 只接受 `opencode`，对外部 Session 返回明确错误。shell、compact、fork/revert、share 等旧写接口同样不能绕过检查。绑定缺失、Codex 不可用时也绝不回落到 OpenCode 执行。

### 首次发送

1. 捕获原输入范围和版本：server scope、实际目录／已完成创建的 worktree、engine、模型、权限设置、附件和 clientRequestID。
2. 后端事务建立 `engine=codex` 的 Session、未完成绑定与 delivery；返回持久接收状态。重复相同 requestID 返回原回执，不同内容复用 ID 报冲突。
3. 创建原生 thread，收到确切 thread ID 后持久绑定；绑定成功后才能提交首条输入。
4. 原生确认接收后更新回执；原生 user item 出现后再显示为确认的历史消息，发送前的内容仅是明确标识的 pending 投影。
5. 前端只清理已获持久接收且版本匹配的输入；失败／未知回执始终可查看或恢复内容，等待期间新增文字和其他目录的输入保持原样。

SQLite 与原生 RPC 不能组成一个事务。若 thread/start 或 turn/start 发出后失去响应，进入 `unknown`，用已知绑定、原生历史及原生 client ID 核对；没有确定证据就不自动重发。尤其 thread/start 未回 ID 的情况，不用相同目录／标题猜匹配，不自动删除可能已创建的 thread。用户主动重试作为新的操作，明确显示前次结果未知。

### 工作台元数据

标题、归档、项目关系由 Lab Session 元数据拥有，沿用当前 API 和列表。Lab 归档不联动原生 thread 归档／删除；后者可能影响原生子任务，且不是隐藏一条工作台记录的同义词。置顶继续遵循已有 server scope 本地偏好。原生生成标题只可作为尚未由用户命名时的建议，不能覆盖用户改名。

首期不导入用户已有 Codex/Sandy 全量历史，不暴露永久删除或跨引擎 fork/revert。对这些操作显式关闭能力，不能调用原 OpenCode 实现完成一个语义不同的动作。

## 5. 原生执行与交互语义

协议核对基线为本地 Sandy 所用、由 `@openai/codex 0.153.4` 生成的官方类型；这是设计候选，不等于已验证 Lab 运行。实施锁定实际二进制及生成协议版本，并用官方 App Server 文档复核。experimental 字段按已验证功能逐项启用，不能因为字段出现在生成类型中就宣称可用。

| Lab 操作／事实 | Codex 对应及规则                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 连接           | 一次 initialize/initialized；每个 Lab runtime scope 一个懒加载 app-server 连接，多个 thread 共享                        |
| 只看历史       | thread/read，不触发模型执行；需要订阅活跃状态或续聊时按原生协议 resume                                                  |
| 新建／续聊     | thread/start；原绑定 thread/resume。恢复不传自造 history，也不新建 thread 替代原会话                                    |
| 空闲发送       | turn/start，带支持的 clientUserMessageId；该字段用于关联，不能凭字段存在就承诺原生 exactly-once                         |
| 运行中补充     | turn/steer + expectedTurnId；明确拒绝且确认旧 turn 已结束时，才转成下一轮；网络结果未知不得自动改投 turn/start          |
| 排队           | B 批先核验原生 thread/queue 能力，固定唯一 owner。原生满足要求时直接适配其 queue；若有明确缺口，才采用后述 Lab 投递队列 |
| 停止           | turn/interrupt 对准当前 turn；收到终态才变为空闲／已中断。停止同时暂停尚未提交的队列，保留内容，防止立即再启动          |
| 模型／effort   | 用原生返回的可用目录与有效设置；运行中修改仅用于下一轮，不把修改塞进不支持设置覆盖的 steer                              |
| 压缩           | 手动操作仅在验证支持时调用原生 compact；自动压缩由 Codex 决定，Lab 显示确认的状态                                       |
| 审批／问题     | 后端接收原生 server request，UI 展示并提交选择，再由后端回应同一个 request                                              |

候选 0.153.4 生成协议已声明 `thread/queue/add|list|update|delete|reorder|start` 和 queue changed 通知，但类型存在不代表指定二进制可用。B 批用隔离原生实例核验持久性、client ID 关联、停止时的暂停保证、设置生效和恢复语义。原生满足要求则只适配其能力；不满足则记录具体缺口，选 Lab 投递队列：保存用户明确 queue 输入，原生 turn 终结且确认空闲后提交一条，再观察状态。它只调度用户输入，不因模型输出自行续循环。支持版本固定一种队列 owner，不在已有会话运行中自动切换，不让原生与 Lab 同时推进。Stop／重启后暂停未提交输入的验收对两种选择都成立，否则该选择不能通过。

审批／交互主身份为 runtime scope + generation + RPC request ID，thread/turn/item 是按请求 kind 校验的关联字段，不统一要求三者都有。特别是 MCP elicitation 没有 itemId，turnId 可空；无 turn 的合法请求仍可显示与回复。不同 Web/桌面窗口同时回复时，第一个有效选择获受理，其他窗口得到已处理状态；旧连接请求不能在重连后复用。处理命令、文件、权限子集请求、结构化问题与 MCP elicitation；不支持的请求明确返回原生允许的取消／拒绝或协议错误，并展示原因，不静默挂起，不自动批准。

权限设置复用现有 `PromptPermissionSelect` 的“默认权限／自动批准／完全访问”，由 Codex 后端适配，移除单独的原生权限菜单。`default` 使用工作区写入沙箱、`on-request` 和人工审批；`auto` 使用相同的原生配置，由 Host 对原生明确提供单次允许选项的命令、文件和权限请求自动回复。它不改原生禁止规则，不选择会话级授权或修改规则，不代答问题或 MCP 表单；缺少单次允许选项时仍保留人工处理。`full` 使用 `danger-full-access` 和 `never`。不将 Codex 的风险自动审查改名为本产品的自动批准。

新 Codex 输入缺少权限选择时显式提交 `default`，不继承 OpenCode 的完全访问选择。旧 `workspace` 与 `default` 等价；旧 `readOnly` 和无法识别的原生组合保留原配置，公共菜单显示“权限”且无选中项，直到用户明确切换。有效值仍来自原生确认及 Host 的持久策略：只有本代原生确认标准工作区配置后，持久的 `auto` 才可自动批准。已在该配置下的 `default`／`auto` 切换即时改变 Host 审批策略，切回 `default` 后不再自动回复。UI 只提交意图，不监听工具事件驱动审批。

交互展示契约是有限的 UI 数据，不是新权限引擎：`id/kind/sessionID/revision`、按 kind 可选的 `turnRef/itemRef`、`prompt`、`choices[{id, label, description, scope}]`、选择方式（单选／多选／表单）、允许的补充输入，以及 resolved/expired 状态。权限子集请求提供明确的网络／路径范围；MCP 表单保留所需字段与校验。后端将原生决定编码为 opaque choice ID，UI 原样回传 ID 与用户填写值，后端校验范围后还原原生回复；不能由按钮名称推断决定。OpenCode 继续生成原有 once/always/reject 控制项。

权限设置继续区分当前有效配置与尚待原生确认的意图；改变沙箱时不能把待生效值当成实际执行权限。公共控件和 i18n 文案保持复用，后端返回有效状态，Codex 控制器只适配取值和提交接口。

## 6. 投影与一致性

### 展示读模型

优先复用 browser-safe 的 `@opencode-ai/schema/session-message`。Codex 模块从原生事件直接生成该读模型的可表达部分；App 复用／抽取现有 V2 → 会话 UI 转换函数。不另造 AHP/ACP 或通用 AgentEvent 中转模型。

这里复用的是数据形状，不能把投影发成 OpenCode 的持久执行事件或写入 message/part/session_message。初期投影驻内存，历史由原生 read 重建；只有性能验证证明必要时才加带版本的可丢弃缓存。输入回执、Session 元数据和绑定仍持久保存。

现有 schema 要求而原生未提供的字段不能编造。对缺失的 agent/model 信息、压缩 summary/recent 等，采用明确的展示扩展／未知状态，组件需要时增加可选展示字段。缺失 cost/tokens 不填 0 来宣称零费用；不额外请求模型来生成展示字段。

| 原生内容                  | 现有 UI 的使用方式                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| userMessage、agentMessage | 原生 ID 对应稳定消息／part，保留正文、附件、阶段及出现顺序                                  |
| reasoning、plan           | 思考／计划展示；只有原生提供的内容才显示，历史缺失不能补写                                  |
| commandExecution          | 现有工具／终端结果卡；保留 command、cwd、真实输出、exitCode；它不是 Lab 独立 PTY            |
| fileChange                | 文件变更卡和原生 patch；不以工作区当前 Git diff 替代该轮执行结果                            |
| MCP/tool items            | 通用工具卡，保留名称、结构化参数、结果与真实成功／失败状态                                  |
| collab/subagent           | 父任务保留委派卡，子 thread 绑定为 parentID Session；子内容不能追加到父工具输出中冒充父执行 |
| compaction                | 原生压缩边界／状态提示；不伪造总结正文                                                      |
| token usage、turn diff    | 数值及作用域分别记录；累计 token 不按每次通知叠加，turn diff 与工作区 Git diff 分开         |
| 未识别 item               | 可检查的通用只读条目；保留类型和可用内容，不能整条丢弃或默认成功                            |

### 身份、排序与快照

- 投影键包含 runtime scope、thread、turn、item 和分段序号；按稳定规则生成符合 OpenCode UI 格式的 ID。不能按数组位置或每次加载时的 Date.now 生成身份。
- 原生 turn 内可能有 steer 用户消息及多段 assistant 内容；不能假定一个 turn 恰好一问一答。按 item 顺序划分展示段，保持用户输入与工具归属。
- 显式携带原生 turn/item 顺序以及映射后 message/part 的展示顺序键，贯穿外部 snapshot、共享缓存、分页合并与 timeline。身份与顺序分开：现有 `utils/session-message.ts` 的 time.created + id 排序和 `server-session.ts` 的 part ID 排序不能重排外部展示。需要 ID 排序来查找的底层数组仍保留查找不变量，渲染使用独立顺序索引；未提供外部顺序时 OpenCode 保持原逻辑。原生缺时间只显示未知，不能捏造时间来排顺序；同 turn 多次 steer、历史重读及旧页插入必须保持相同顺序。
- 创建／完成快照用同一 mapper；完整 item 替换对应内容，不能把已收到的 delta 再追加一次。
- 同一 thread 的事件、原生读取结果和控制响应串行入队。读取期间缓冲事件；完整 item 以原生快照覆盖，只有证明确属快照之后的 delta 才追加。若协议无法确定边界，合并完整内容并请求新快照，不做可能重复的盲目 delta 重放；不得因此自动执行新 turn。
- 现有事件服务承载外部通知；外部快照使用后端 runtime epoch 和每 Session revision。这是 Lab 投影版本，不是原生持久游标。断线后不能完整恢复所需变化时，明确要求重新读取快照；不新增一套自有持久事件日志，也不声称 app-server 能按 Lab 游标恢复遗漏的原生事件。
- 唯一前端 owner 是 server scope 下的 Session 后端视图。它先订阅并缓冲，再取得带 revision 的外部快照，只应用其后的变化；按 Session/epoch 去重，迟到的旧窗口响应不能覆盖新状态。后端在同一发布队列先发布已提交的 Session 元数据变化，再发布相关外部状态；外部快照不覆盖共有服务的标题／归档字段。

### 一套工作台状态

Codex 投影写入现有 server／directory 会话视图及首页索引更新入口，不创建独立 Codex 侧栏。按字段划分事件来源：Session 元数据沿用原服务，Codex 的内容、执行状态与交互由 Lab 扩展拥有；原 OpenCode 状态事件不能把 Codex 会话覆盖成 idle。

active、waiting approval/input、interrupting、disconnected、unknown 与 idle 要能区分。连接失败不等于任务完成；关闭 tab 或 Web 页面不等于停止任务。所有客户端都断开时，后台仍管理已开始的执行与审批，不依赖 renderer 推进任务。

外部 descriptor 明确携带 `runtimeStatus`，不把它强压为旧 idle/busy/retry；旧状态仅供可兼容的展示组件使用，操作权限由 descriptor 决定。delivery 状态单独存在，不把一次未知发送结果当作整个 thread 的确定状态。

| runtimeStatus／附加状态      | 侧栏与 composer 行为                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| resolving/creating           | 标识准备中；保留编辑，禁止重复提交，不显示可停止的原生 turn                                |
| idle                         | 正常发送；有暂停队列时显示恢复入口，不自行继续                                             |
| active                       | 运行标记；可 steer／queue（能力允许时）；Stop 指向原生当前 turn                            |
| waitingApproval/waitingInput | 需输入标记和对应交互；允许回答与 Stop，其他提交按后端能力明确允许或禁用                    |
| interrupting                 | 标识正在停止；禁重复 Stop，保留输入，尚未提交的队列暂停                                    |
| disconnected/systemError     | 标识连接异常／失败；可读已有数据和编辑，禁止未知状态下提交，提供连接重试                   |
| bindingUnavailable           | 标识原生会话不可读；保留原任务，提供读取重试，不自动新建                                   |
| delivery=unknown             | 明确的发送回执提示；先核对，阻止自动重发；用户可保留／恢复文本，主动新发须知道前次结果未知 |

snapshot 的 usage、context、turnDiff、sessionDiff 分别带 availability（available/unavailable/loading）和明确作用域；非 available 没有伪造值。账户 rate limits 与 context usage 是不同对象。将不可用数值传到现有组件时要关闭默认 0／空 diff 的回退，加载失败不宣称没有变更。

父子 thread 的发现与绑定在后端完成，使用原生关系去重、校验 scope。能读取才开放子任务导航；不可读时明确展示受限条目，不制造空子会话。通知、需输入和未读沿用既有规则，收到投影不是“用户已读”。

首期搜索保证标题／项目范围，不承诺现有正文搜索能覆盖未写入 OpenCode 历史表的 Codex 内容。列表 preview 可作为绑定上的非权威摘要缓存，真实 last activity 持久更新到 Session；缺少摘要时只显示标题。后端重启先将运行与待交互置为待核对，读取原生后再恢复；不能从旧审批快照重新激活一个 RPC 请求，也不能默认仍有未回答问题。完成／失败通知经现有通知入口去重，历史回读不能重新触发一遍旧完成通知。

## 7. 生命周期、配置与隔离

Lab 使用独立 Codex home 保存本接入的原生配置与历史，位于 Lab backend 状态目录中；不复制、改写或接管已有 `~/.codex`。按 2026-09-07 实际验收反馈，历史隔离不应强迫重复登录：保留原生已有有效账号；原生未登录时，Desktop 宿主复用模型页已有 OpenAI OAuth，通过原生 `chatgptAuthTokens` 接口提供访问凭据。只有没有可复用身份时才显示原生登录流程。

原生登录使用 account/read、account/login/start、account/login/cancel 及完成事件。浏览器授权与回调由原生流程管理，桌面／Web 显示同一登录尝试状态；取消也只针对所属尝试。前端不接收或保存账户 token，不以拿到授权链接作为登录成功。账户状态变化使相应模型／能力描述失效并重读。外部凭据模式使用原生 `account/chatgptAuthTokens/refresh` 回调，刷新归模型 Provider 的同一个后端凭据所有者；refresh token 不交给原生进程或前端。并发刷新合并，退出或换号不能被旧刷新结果覆盖。Standalone V2 使用自己的 Credential 所有者，未接通复用端口时继续使用原生登录，不跨库读取 V1 凭据。

只传入明确的 cwd／配置，Codex 按自身规则加载适用的项目指令、skills、MCP 和子代理。OpenCode 的 AGENTS/CLAUDE 处理器、系统提示、工具注册和压缩结果不重复注入。有效模型、登录状态、指令来源和权限配置以原生返回为准，不能由 UI 记忆推定已生效。

二进制使用固定版本及显式解析路径；缺失或版本不支持时返回 Codex 不可用，不自动换引擎。首期本地二进制接入可先验证，正式打包再确定内置产物和许可清单，不能拿开发机 PATH 成功充当安装包验证。

app-server 是所属 backend 子进程，惰性启动、握手共享一个 pending promise；每次连接重建递增 generation，拒绝旧响应和旧审批。生命周期不按 tab、目录或单次 turn 分配。后端正常退出时只收束自己创建的进程；不查找或终止用户其他 Codex、Sandy 或 OpenCode 实例。

app-server 崩溃时，冻结受影响的投递与队列，清除失效交互，标记连接丢失。后续重连读取原生状态与历史，只有确认过的结果才更新为完成；不自动恢复未确认的模型执行。停止／失败是否留有原生后台命令，也按原生状态呈现，不声称所有子进程已被清理。

首期不提供完整离线 transcript 缓存。原生暂时不可读时，任务索引及持久发送内容仍可见，历史区域显示读取失败并可重试；不能清空绑定或新建 thread。进程重启不会自动重新投递遗留 sending/unknown 记录，尚未提交的队列也等待明确恢复操作。

## 8. 用户交互范围

- 新建任务时选择执行引擎，再从该引擎目录选择模型／effort。首次发送后 engine 固定；继续保留已有每目录单例输入，不因为切换 engine 新建草稿任务或清空文字。
- 输入的 engine 选择和各引擎模型／权限偏好在原持久输入范围内分别保存。切换时仅更新 controls；不改变输入所属项目或 worktree，不把一家的权限选择解释成另一家的授权。
- 现有任务读取后端 engine 后才能提交；加载中、绑定失败和未知发送结果均明确展示，避免用户误以为还没发出而重复点发送。
- 文本、图片、文件路径及 diff 评论使用现有附件／上下文入口。转换时验证原生支持；OpenCode 专属 agent/command/工具上下文不能原样发送冒充 Codex skill。普通文件附带可识别路径和选区，不默认把整个目录展开到提示词。
- 工作区文件、Git diff、PTY 继续属于项目目录。Codex 内置工具调用不由 UI 重新执行。首次不将 composer 的 shell mode 直接接到原生全权限 shellCommand。
- 本设计不确定控件布局。实施前针对引擎选择、权限选项与未知／待发送状态提供可检查的 UI 预览，按本仓要求先对齐后修改布局。

## 9. 分步实施及通过条件

每批在独立实施 worktree 完成聚焦验证；此表是验收要求，实际状态见文末。

| 批次              | 交付                                                                            | 必须通过的验证                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A：身份与路由     | engine、绑定／投递表、两版本 guard、Lab 描述与 API 客户端                       | 旧 Session 行为不变；所有执行写入口拒绝外部 Session；首发重复 ID 只建一个任务；创建中途失败不出现可执行的 OpenCode 壳         |
| B：原生链路       | 固定版本 app-server、原生登录、新建／续聊／停止、基本投影；核验并选定队列 owner | 隔离目录内真实读文件、执行命令、修改文件；能确认工具确由 Codex 执行；中断停止同一 turn；记录原生 queue 可用性及语义的实际结果 |
| C：完整 UI 与交互 | 同一任务列表／输入／审批／问题／文件卡；Desktop/Web 同步                        | 跨窗口单次回复、状态一致；任务切换不丢输入或终止执行；原生权限行为与显示匹配                                                  |
| D：恢复与复杂内容 | 历史、steer/queue、用量、diff、压缩、子任务、未知事件                           | 重开相同 thread；实时／历史稳定 ID 与内容一致；真实子任务不串父内容；重连无重复消息或工具执行                                 |
| E：交付验证       | 聚焦回归、性能比较、可追溯候选包                                                | OpenCode 回归通过；实际包内版本与协议匹配；隔离运行验证桌面与 Web；源码／候选包／安装／运行分别报告                           |

测试优先覆盖会造成错误执行或数据丢失的边界：

1. 同请求重试、相同 ID 不同内容冲突、原生接受后断线、thread 创建后回执丢失。
2. 历史读取与 delta／完整 item 交错、页面刷新、SSE 游标失效；不能按相同文本去重两个真实用户输入；未知时间下同 turn 多次 steer 与分页插入顺序一致。
3. steer 与 turn 完成竞态，停止时队列不自动续跑；修改模型／沙箱不偷偷改变正在执行的 turn；Host 自动批准策略仅按已确认的原生配置和用户持久选择生效。
4. 审批发出后刷新、两窗口回复、原生撤销、连接换代、未知请求类型，以及无 turn/item 的合法 MCP 请求。
5. 同目录两任务、不同 worktree、父子 thread、相同原生 ID 不同 scope 的隔离。
6. 用量缺失／累计、文件失败／拒绝、原生 diff 与 Git diff 不同、历史无法提供全部思考内容。
7. OpenCode 发送／审批／归档／任务列表／持久输入原行为；未启用 Codex 时不启动 app-server。

必要测试使用真实临时数据库、协议录制样本和隔离原生进程；注入连接断开验证边界，不用只返回成功的假服务替代最终验收。实现 session/timeline 前记录现有生产构建性能基线，之后比较长历史、持续流式与任务切换。按修改包执行 `bun typecheck` 和相关测试；协议修改按生成流程，不从仓库根运行测试。

A/B 通过仅说明基础接通。C/D 是第一阶段完成条件，不能用关闭正常日常能力来把它缩成聊天演示。确实原生不提供的字段／能力明确标注限制；E 的安装与进程操作另按用户交付授权执行。

## 10. 后续引擎与尚待实际验证的条件

Claude 和 DSH 可各自实现同样窄的后端视图与操作入口，使用原生生命周期与恢复语义。共用 Session 身份和 UI 能力声明，不要求它们支持 Codex thread/turn/RPC，也不把 DSH 的模型供应商插件当成原生 DSH 接入。第二个引擎实施时再提取已证明重复的代码。

本设计已选定架构方向；下面是实施验收条件而非先做泛化平台的理由：

- 候选 Codex 版本在隔离环境里的登录、审批类型、能力开关和真实工具执行。
- 原生 clientUserMessageId 的实际回显／重试行为，快照与实时事件交错边界；未证实的 exactly-once 不承诺。
- 长历史读取成本、历史工具／子任务／思考完整性，以及 App 既有转换函数可复用的具体范围。
- 独立 Codex home 的原生登录与项目能力配置体验。若改为复用用户 home，必须重新确定跨客户端写入与历史归属，不能作为实现细节无声替换。

## 11. 参考与证据边界

- [OpenAI App Server 官方文档](https://learn.chatgpt.com/docs/app-server)：核对原生接口与交互语义；网页描述不代替指定二进制的验收。
- [pujitm/opencode PR #1](https://github.com/pujitm/opencode/pull/1)，研究提交 `d5d78ed4a66603737a36503c119f05e4c6e6714b`：复用原会话组件与 adapter 的实现参考；仍为 Draft，作者运行报告不算本项目实测。
- [Gigacode](https://github.com/rivet-dev/sandbox-agent/tree/main/gigacode)：多引擎兼容先例；实验性与兼容缺口使其不适合直接成为本次执行底座。
- Sandy 本地研究提交 `32970edb1cadd58b526ca7c7f5bc8d3a45863df1`：`src/vs/platform/agentHost/node/codex/{codexAgent,codexMapAppServerEvents,codexReplayMapper}.ts` 及同目录生成协议，作为行为／竞态与映射参考。用户实际使用经验有价值，但不能推导所有恢复路径已经无缺陷。
- 当前仓库具体证据见第 2 节；工程边界见 [PROJECT.md](../../PROJECT.md)、[DEVELOPMENT.md](../../DEVELOPMENT.md) 和相关目录 AGENTS.md。

## 12. 实施与验收记录（2026-09-07）

实施位于 `codex-native` 分支的独立 worktree，起点为本地 `dev` 提交
`8ae63380f532449885d72616f0db8b4966051ef3`。实现阶段没有安装应用或重启用户实例。用户随后明确要求“发 debug”，按本仓交付流程合线、构建并安装 Lab，真实账号验收仍单独记录。

已落下 Session engine／绑定／投递迁移、OpenCode 执行入口保护、原生 transport／Host、
两套后端的 Lab HTTP API、生成客户端、共享 SSE 与 App 数据适配。原生模型目录与未登录发送
拒绝已通过隔离 Bun 和 Node 后端验证；已有 OpenCode 会话测试及时间线基线比较已执行。

引擎选择、权限与待投递状态的可检查预览已提供，已按现有输入框布局继续实施生产控件；
开发实例的发送、停止、审批、原生用量、导出、只读计划和子任务导航已通过聚焦测试及
浏览器协议测试；最终生产构建的 14 项浏览器测试通过。320 轮历史、160 次流式更新的
同场景基线比较中，首内容约 361 ms、帧间隔 P95 9.1 ms，没有长任务或消息节点重挂载。

固定原生 0.153.4 与实际 Host HTTP 接口已使用本地 Responses fixture 验证读文件、执行命令、
修改文件、单次批准、steer、stop、暂停／恢复 queue，以及后端重启后的原 thread 恢复。
模型响应由 fixture 提供，工具实际由原生 Codex 执行，不等于真实 OpenAI 账号调用已验收。
新 thread 显式采用 paginated history；实测恢复后 12 条消息 ID、顺序及工具内容保持一致。
旧 legacy 模式会遗漏内层工具和重建部分 ID，不把它作为完整恢复证据。

原生轮次中断可能早于内层命令结束，后端以持久 execution_pending 与工具完成证据保护
工作区占用和队列。无法证明历史执行已经结束时继续阻断执行，不拿 idle 标签替代结束证据。
原生计划通知没有历史回放来源，仅显示当前连接实际收到的计划；重连后恢复为不可用。
原生可选工具仍遵循独立 Codex home 的配置，不强制改写既有配置。

原生 child 创建、同进程等待完成、独立 Session 接管、重启恢复和继续输入均已通过本地
Responses fixture 验证，父内容未被混入。原生 V1 wait 的内存完成通知不随进程重启恢复，
Host 保留这一限制，不从历史伪造 wait 结果。

初次实现验收时，独立 Codex home 尚未登录，尚无真实账号调用证据。随后从干净 `dev`
`4baa890d4c051b3a0c5753d66ec4948e4afb9740` 构建并安装 Lab #18（`20260906.191056`），
候选包内实际 Electron utility sidecar 的原生模型目录、未登录状态与发送拒绝验证通过。

用户在 #18 中完成登录后，首次发送暴露 `Stale read from <Show>` 界面崩溃。只读现场确认
原生任务已接收并执行完毕；界面失败不能当成后台发送失败，更不能自动重发用户输入。
反馈同时指出模型页已有 OpenAI OAuth，独立原生历史不应导致重复登录。后续修复在
`codex-auth-recovery` 分支完成，并按第 7 节接入同一后端凭据所有者；该次真实账号、
界面回归和重新交付证据单独记录，不以初次 fixture 或构建结果代替。

本阶段生成的临时环境和验证日志位于实施 worktree 的 `.cache/`，不作为产品源码提交。
本次按用户“发 debug”授权执行 `DEVELOPMENT.md` 的提交、合线和本地交付；不自动重启应用，不把安装成功等同于真实账号调用验收。

认证与状态修复的真实验收使用隔离后端、独立原生 home 和临时目录：模型页现有 OAuth
仅通过宿主内存端口提供，原生 `gpt-5.6-luna`（high）实际返回 `CODEX_AUTH_REUSE_OK`，
投递为 accepted、任务为 idle；源认证文件哈希未变，原生 home 未落盘 auth.json，也未启动
浏览器登录。实际原生进程还暴露 macOS `/var` 与 `/private/var` 同目录误判，Host 已在路径
写法不同时比较真实目录身份，保留不同 thread、不同目录和无法解析路径的拒绝行为。

同次生产 App 构建已通过真实浏览器首次发送验收：新建任务选择 Codex，自动显示已有账号，
使用 GPT-5.6-Luna / high / 只读发送一条输入，实际收到 `CODEX_UI_LIVE_OK`，从运行中回到
就绪且投递已接收；未出现界面崩溃。生产控件移除会在路由 transition 中失效的 Show callback
accessor，改用安全 memo；七项控件浏览器回归及类型检查通过。旧源码在自动夹具中未稳定
触发该崩溃，旧版失败证据来自 #18 的实际 renderer 栈，不宣称自动回归已重现旧异常。

### Codex 自定义供应商（2026-09-08）

按“Codex 可以使用 XD 的模型”的追加授权，Desktop 所属后端通过独立 `CodexProviders`
端口读取现有全局 Provider 配置与 Auth 凭据。配置了 Responses 协议（`@ai-sdk/openai`）、
有效 endpoint 与 API key 的模型，追加到原生模型目录，保留 `xd/<model>` 身份与供应商名称；
订阅模型保留原生目录和账号要求，自定义模型不要求另外登录 ChatGPT。供应商与模型过滤仍生效。
Standalone 未接通配置端口时继续使用原生目录，不从其他运行实例读取认证库。

执行仍完全属于原生 Codex。Host 在 thread/start 或 idle unsubscribe/resume 时传入原生
`modelProvider` 和 provider config；同一进程可以承载不同供应商。运行中切换供应商的输入
先保持 admitted，直到当前轮完成才在同一个原生 thread 上切换，不重建任务或重发旧输入。
恢复模型取自已接受轮次的首个投递，后续 steer 与未发送的 desired settings 不冒充生效设置。
原生 thread/read 的创建供应商可能长期不变，不能覆盖 resume 或 settings 通知确认的实际值。

密钥仍由现有 Auth 所有者持有，原生 `auth.command` 通过带随机认证的宿主 loopback 端口
按需获取；不将真实 key 写入 provider config、进程环境或 shell snapshot。原 endpoint
发生变化后旧凭据路由拒绝服务，Host 退出时关闭端口。0.153.4 实测 1 秒 refresh interval
只在请求时检查过期；空闲 5 秒不启动新的认证命令。

Responses 协议兼容不等于支持 OpenAI 的托管工具。自定义供应商路径关闭原生 hosted web
search：XD 的 Claude/Bedrock 实际拒绝该工具。普通原生命令、文件与审批流程保持由 Codex
执行；不为第三方模型注入另一套工具循环，也不承诺目录中所有模型支持每种原生可选工具。

已用隔离原生 home、临时项目和实际 XD 凭据验证 GPT-5.6-Luna/high、Claude Haiku 4.5 与 Gemini 3 Flash：
Codex 实际执行读文件命令、投影工具输出并返回正确内容，投递 accepted、任务回到 idle，
无需 ChatGPT 登录。原生 fixture 覆盖订阅与 XD 切换、运行中待投递、恢复后保留未发送选择；
凭据测试使用真实 HTTP/curl 验证轮换、endpoint 失效、访问拒绝和生命周期关闭。
隔离完整 source backend 的 `/lab/engines` 已返回 59 个 XD 模型；当前配置未声明原生
reasoning effort 列表的模型不展示猜测档位。此记录是源码验证，不代表已安装或正在运行的
Lab 包已经包含本次改动。
