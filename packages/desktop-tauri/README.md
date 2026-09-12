# Koma Tauri Debug

macOS Apple Silicon 的 Tauri 宿主，复用 App、Session UI 和 Koma CLI。Electron 与 Tauri 各自启动后端、使用独立端口，共用项目、配置、模型与历史数据。

## 数据与进程

- 数据目录由 Koma CLI 解析：`KOMA_HOME` 优先，其次兼容 `OPENCODE_HOME`；macOS 发行默认 `~/Library/Application Support/Koma/profile`。只有 Debug 默认使用 `~/.koma` 并保留已有 Lab 的兼容链接与物理目录。发行与 Debug 的 CLI 构建缓存、默认数据和凭据分离。
- Electron 使用既有实例登记，Tauri 使用 `KOMA_BACKEND_INSTANCE=tauri`，登记、凭据与日志位于数据目录的 `bin/.koma-instances/tauri/`。
- 两边打包完全相同的 `packages/desktop/resources/koma` 产物；构建脚本校验源码身份及 SHA-256。Tauri 不再另行生成 opencode-lab 后端。
- 关闭窗口保留自身后端。完整退出经确认只停止自身后端，不停止另一个客户端的后端。
- 项目及会话数据直接读取共同后端存储。项目列表、语言、主题和模型偏好通过同一份 desktop 存储读写，写入使用进程间锁、原子替换与字段合并；两个窗口每秒接收外部偏好变化。会话草稿和附件共用 drafts.sqlite，窗口的新任务草稿仍按窗口隔离。终端 ID、打开的面板与窗口布局按宿主隔离，避免一个后端恢复另一个后端的 PTY。
- 保留上游独立服务的运行语义；共享持久数据不代表跨进程控制同一条运行中会话。不要把单个进程内的运行状态当成另一个进程的状态。

## 构建

使用 Bun 1.3.14、Rust、Xcode 命令行工具。仓库根目录运行 `bun run build:tauri`，得到 `packages/desktop-tauri/src-tauri/target/release/bundle/macos/Koma Tauri Debug.app`。构建不启动应用；本地签名并验证后可覆盖安装。

`bun run dev:tauri` 启动开发入口。自动化测试必须明确指定临时 `KOMA_HOME`；旧 `.local/desktop-tests/tauri/profile` 与 fixture 脚本保留为测试数据，不再作为安装版默认数据。

运行 `bun run --cwd packages/desktop-tauri typecheck`、`bun run --cwd packages/desktop-tauri test`、`cargo test --locked --manifest-path packages/desktop-tauri/src-tauri/Cargo.toml` 做宿主检查。后端实例并存与恢复边界的测试位于 core 的 `lab-backend.test.ts`、`session-external.test.ts`。

## 验证范围

原隔离验证版的测量和已知问题见 [历史验证记录](./VALIDATION.md)，不能当作本共享数据版本的验收结果。两边使用相同的 App、路由、菜单定义、缩放策略、退出判断与窗口几何配置。Remote 与网页入口的控制器、代理和隧道代码放在 remote/desktop；Electron 在主进程调用，Tauri 随包携带 Node 22，并通过私有进程 IPC 调用，按自身实例管理端口和设备身份。该宿主服务不处理 Session 执行，Koma CLI 保持同一构建产物。两个 Debug 渠道均禁用自动更新。包大小需计入 CLI，内存需计入 WebKit、后端及 Agent，不能用主进程数据代表整个应用。

## 日常维护边界

- 页面、标题栏、关闭图标、标签、设置与业务命令只改 `packages/app` / `packages/ui` / `packages/session-ui`，不要给 Tauri 复制页面。
- 共享桌面策略在 `packages/app/src/desktop`；默认窗口尺寸与 macOS 按钮位置只改 `window.json`。Electron 和 Tauri 的原生调用分别接到同一个 Platform 接口。
- 关闭窗口隐藏该窗口并保留后端；退出使用共同的状态检查、翻译和确认策略。取消不能停止后端；只有明确选择退出才停止对应实例。
- Koma 的桌面数据桥位于私有 `/lab/desktop` API，认证继承 Koma 后端。不得修改上游 Session 调度或 SQLite 运行语义来实现桌面一致性。
- Tauri 的 Node 运行时从官方发行包校验 SHA-256 后打包。CLI、Node、宿主脚本和网页资源启动时保存在当前实例的不可变快照中，覆盖安装不会替换运行中后端的资源。
- Debug 使用与 Electron 相同的开发者证书签名策略，避免每次构建改变钥匙串访问身份。运行 `scripts/build-host.ts` 后可通过 `bun test scripts/host.test.ts` 验证 Node 宿主到 Bun 后端的 HTTP、SSE、WebSocket 和停止边界。
- 系统通知通过原生 macOS 适配发送，点击后聚焦对应窗口并执行共享 UI 的任务导航回调。实际通知展示仍受系统通知设置控制。

## 双内核回归与原生验证

在 `packages/app` 运行 `bunx playwright install chromium webkit` 后，执行 `bun run test:desktop-layout`。同一条回归覆盖两种内核的首页高度、聊天输入框、终端以及窗口尺寸变化，不维护另一份 Tauri 页面或浏览器专属 CSS。

原生验收使用独立测试 profile。日常 UI 自动化可由 electron-builder 使用独立的 `Validation` productName 完整打包，再运行 `packages/desktop/scripts/prepare-validation.ts source.app destination.app profile`；该脚本对验证副本开启 Chromium mock Keychain，不能安装为日常 Debug，也不能证明发行凭据行为。发行验收必须检查未经修改、Developer ID 签名的发行 App，使用真实系统凭据服务验证首次安装、重开和升级，不能用 mock Keychain 的结果代替。测试不读取旧 Lab／Debug 的真实凭据。

Tauri 的窗口按钮通过 AppKit 读取系统基线，再使用 Tauri 的原生 inset 配置；重绘不另行修改页面坐标。菜单快捷键在 WebKit 处理键盘事件之前交给原生菜单，保证终端获得焦点时仍可退出、关闭窗口和打开设置。

2026-09-12 验收：同一布局测试在 Chromium、WebKit 均通过；原生 Tauri 的首页、真实终端回显、固定本地模型流式回答、终端焦点下的退出快捷键及取消保留后端已检查。共享存储并发合并、草稿/附件、退出控制器及 Remote 控制器测试通过。系统通知展示与真实外网隧道仍需单独环境验收，不能由本地夹具结果推定。
