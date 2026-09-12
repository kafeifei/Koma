# Koma Tauri Debug

macOS Apple Silicon 的 Tauri 宿主，复用 App、Session UI 和 Koma CLI。Electron 与 Tauri 各自启动后端、使用独立端口，共用项目、配置、模型与历史数据。

## 数据与进程

- 数据目录由 Koma CLI 解析：`KOMA_HOME` 优先，其次兼容 `OPENCODE_HOME`，默认 `~/.koma`。已有 Lab 的兼容链接与物理目录保留。
- Electron 使用既有实例登记，Tauri 使用 `KOMA_BACKEND_INSTANCE=tauri`，登记、凭据与日志位于数据目录的 `bin/.koma-instances/tauri/`。
- 两边打包完全相同的 `packages/desktop/resources/koma` 产物；构建脚本校验源码身份及 SHA-256。Tauri 不再另行生成 opencode-lab 后端。
- 关闭窗口保留自身后端。完整退出经确认只停止自身后端，不停止另一个客户端的后端。
- 项目及会话数据直接读取共同后端存储。首次打开时读取 Electron 的本地项目列表、语言和模型偏好作为界面初始值；窗口布局与未发送草稿仍由各客户端保存，不并发写 Electron 的界面设置文件。
- 保留上游独立服务的运行语义；共享持久数据不代表跨进程控制同一条运行中会话。不要把单个进程内的运行状态当成另一个进程的状态。

## 构建

使用 Bun 1.3.14、Rust、Xcode 命令行工具。仓库根目录运行 `bun run build:tauri`，得到 `packages/desktop-tauri/src-tauri/target/release/bundle/macos/Koma Tauri Debug.app`。构建不启动应用；本地签名并验证后可覆盖安装。

`bun run dev:tauri` 启动开发入口。自动化测试必须明确指定临时 `KOMA_HOME`；旧 `.local/desktop-tests/tauri/profile` 与 fixture 脚本保留为测试数据，不再作为安装版默认数据。

运行 `bun run --cwd packages/desktop-tauri typecheck`、`bun run --cwd packages/desktop-tauri test`、`cargo test --locked --manifest-path packages/desktop-tauri/src-tauri/Cargo.toml` 做宿主检查。后端实例并存与恢复边界的测试位于 core 的 `lab-backend.test.ts`、`session-external.test.ts`。

## 验证范围

原隔离验证版的测量和已知问题见 [历史验证记录](./VALIDATION.md)，不能当作本共享数据版本的验收结果。窗口标题栏仍复用共享组件；Remote、完整原生菜单、通知和更新器尚未对齐。包大小需计入 CLI，内存需计入 WebKit、后端及 Agent，不能用主进程数据代表整个应用。
