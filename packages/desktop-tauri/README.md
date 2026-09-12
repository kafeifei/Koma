# OpenCode Lab Tauri Test

macOS Apple Silicon 上的 Tauri 2 验证入口。复用 `@opencode-ai/app`、`session-ui`、`ui`，从同一 worktree 构建 Lab 后端。它用于验证更换桌面宿主的可行性，当前不是正式 Electron 客户端的完整替代品。

本机已完成的流程、包体积、内存快照和未通过项见 [验证记录](./VALIDATION.md)。完整退出后的旧终端恢复仍有空白问题；新建终端已通过。

## 目录与身份

```text
packages/desktop/                 现有 Electron 客户端
packages/desktop-tauri/
  src/                           Solid 入口和 Platform 适配
  src-tauri/                     Rust 宿主、权限与打包配置
    binaries/                    构建生成的同版本 Lab 后端（忽略）
    target/release/bundle/macos/  Release .app（忽略）
  scripts/                       构建、路径约束和本地响应服务
  dist/                          共享前端构建产物（忽略）
.local/desktop-tests/             每个 worktree 独立，本机数据（忽略）
  tauri/profile/                 测试后端数据、配置、日志、Agent home
  electron/                      为后续同条件 Electron 对照预留
  projects/hello-tauri/           可丢弃的独立 Git 测试项目
  results/                       构建身份与测量结果
```

App 名为 **OpenCode Lab Tauri Test**，ID 为 `ai.opencode.lab.tauri-test`。测试 App 绑定构建它的 worktree；移动／删除该源码目录后需要重建。Rust 宿主不会采用启动环境里的 `OPENCODE_HOME`，也不会回退到正式 `~/.opencode`。WebKit 的 localStorage／IndexedDB 属于独立应用 ID，由 macOS 存放在该应用自己的 WebKit 数据目录，与后端 profile 分开。

不迁移正式配置、登录或历史。可在测试版内单独配置模型。关闭窗口仅隐藏窗口，点击 Dock 可重新打开；完整退出经确认后停止测试 profile 的后端及其任务。启动失败时保留日志。

## 启动与构建

需要 Bun 1.3.14、Rust／Cargo、Xcode 命令行工具。仓库根目录运行：

```sh
bunx bun@1.3.14 install
bunx bun@1.3.14 run dev:tauri
```

开发前端只监听 `127.0.0.1:1420`，端口占用直接失败。后端使用协议自动分配的认证 loopback 端口。首次编译 Rust 依赖较慢，后续增量构建复用 `src-tauri/target`。

生成可直接打开的 Release App：

```sh
bunx bun@1.3.14 run build:tauri
open "packages/desktop-tauri/src-tauri/target/release/bundle/macos/OpenCode Lab Tauri Test.app"
```

构建命令不会安装或重启当前 OpenCode Lab。Release 包自动执行本地 ad-hoc 签名并验证，不作为 Developer ID 签名或公证发行包。后端被完整打入 `.app`，启动 Release App 不依赖 Vite。构建身份记录在 `.local/desktop-tests/results/tauri-build.json` 和包内 `Resources/binaries/build-info.json`。

## 无账号链路测试

另开终端运行以下命令，再启动测试 App，打开脚本打印的 `hello-tauri` 目录：

```sh
bunx bun@1.3.14 run --cwd packages/desktop-tauri fixture
```

脚本仅在测试 profile 中增加名为“本地链路测试（非真实模型）”的 OpenAI 兼容服务。新 profile 默认使用它；已有模型配置不替换。示例目录会初始化为独立 Git 仓库并生成一条仅属于示例仓库的初始提交，避免 Git 操作落到外层源码仓库。它会分块返回 `TAURI_STREAM_OK` 与中文说明，用来验证真实 Session／流式传输／界面／历史链路，**不证明真实模型或原生 Codex 已验证**。服务停止后该测试模型不可用，重新运行脚本会更新它的随机端口。

验证内容：发送消息并看到逐步显示的回答，切换任务后历史仍在；在侧栏终端执行 `printf 'TAURI_PTY_OK\n'`；检查原生目录选择、中文文本输入、关窗后任务保留、退出取消及确认。中文粘贴通过不等于中文输入法组合事件通过。

## 第一版能力范围

已实现的适配：本地后端启动／连接、原生目录与保存对话框、外部链接／文件打开、系统文件定位、独立 WebView 草稿存储。聊天、会话、Diff 与终端复用原界面。暂未接入：Remote、WSL、系统通知、完整原生菜单与快捷键、自动更新、正式渠道迁移、Electron 草稿迁移。

## 窗口适配

与现有 macOS 客户端使用同一套共享标题栏：原生标题栏覆盖到内容区，隐藏系统标题文字，红黄绿按钮位于 `(14, 14)`。宿主入口将共享标题栏路径上的 `data-tauri-drag-region` 适配为 Tauri 2 的 `deep` 子树语义，原生处理器负责拖动、双击与交互控件排除。全屏状态会同步给共享界面，切换时调整原生按钮留白。双击放大还原已实测；持续拖动的窗口位移尚需人工验收。

## WebKit 适配

本地终端的 Ghostty WASM 已内嵌为 `data:` 资源，CSP 允许加载这些资源和编译 WASM。macOS 14 及以上禁用 WebView 后台暂停，避免隐藏／遮挡时延迟启动事件订阅；macOS 12–13 不保证此行为，尚未实测。关闭窗口仍会保留后端进程。退出采用自定义菜单和附着在主窗口上的确认框，不依赖 macOS 默认菜单直接终止进程的行为。

## 测量口径

- 对比 Release 构建，记录 source commit、前端和后端构建身份；开发模式不能用来下性能结论。
- 包体积同时记录 `.app` 逻辑字节、磁盘占用、宿主文件和后端文件；压缩下载大小单独记录。
- 内存分别记录原生宿主、WebKit 内容／网络／GPU 进程、后端、Agent／PTY；不能把主进程 RSS 称为整个 App 内存。
- 同样的会话数据、窗口大小和测试步骤下，分别记录冷启动、闲置、长聊天、终端和大 Diff。当前正式 Electron App 的真实任务状态不作为等条件基线。
- 首轮记录见 `.local/desktop-tests/results/`；没有完成同条件 Electron 对照时，不输出“快了多少”结论。

记录当前包体积：

```sh
bunx bun@1.3.14 run --cwd packages/desktop-tauri measure size
```

内存采样先用 `ps`、进程创建时间与 WebKit 数据目录确认各 PID，再运行 `measure idle host=123 backend=456 webcontent=789 network=790 gpu=791`。脚本记录每个进程的 `vmmap` physical footprint 和 `ps` RSS，结果保存在忽略目录中。不要直接复用文档中的示例 PID。

## 检查

```sh
bunx bun@1.3.14 run --cwd packages/desktop-tauri typecheck
bunx bun@1.3.14 run --cwd packages/desktop-tauri test
cargo fmt --manifest-path packages/desktop-tauri/src-tauri/Cargo.toml --check
```
