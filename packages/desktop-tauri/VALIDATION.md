# macOS 验证记录

2026-09-12，本机 macOS 26.6.2 / Apple Silicon，Release 构建。这里只记录实际完成的检查；不是 Electron 替换验收。

本页运行、截图与体积数据来自 Koma 改名前的构建。合并 main 时已适配 `KOMA_HOME` 和新旧后端状态目录；这些修改的源码检查不能替代合并后包的界面实测。已有运行中的测试 App 未自动更新或重启。

合并前重新验证：锁文件冻结安装、Tauri 前端构建、类型检查、路径测试（1 个）、Koma profile 兼容测试（5 个）、Rust 宿主隔离测试（2 个）、Rust 格式与 Git 空白检查均通过。前端构建仍有现有大 chunk 提示。

## 构建身份

- 分支：`codex/tauri-test`。
- 源码基线：`e858ecf37d8d0f4f1ff174d0bbf6db92db798eed`，带本次未提交的 Tauri 适配。
- App：`0.1.0`；前端构建：`tauri-test-2026-09-12T08:25:10.616Z`。
- 后端：`0.0.0-lab-202609120807`，Bun `1.3.14`；前端与后端分别构建，后端源码在后续标题栏修改中未变。
- 最终 App 位于 `src-tauri/target/release/bundle/macos/OpenCode Lab Tauri Test.app`，本地 ad-hoc 签名，`codesign --verify --deep --strict` 通过。
- 观察到运行中的最终宿主 PID `36178`、测试后端 PID `36191`；没有覆盖安装 `/Applications/OpenCode Lab.app`。

## 实际检查

| 项目 | 结果 |
| --- | --- |
| 独立 Release 启动 | 通过，加载 `tauri://localhost`，不依赖 Vite |
| 原生项目目录选择 | 通过，打开隔离 Git 示例项目 |
| 聊天 | 通过，实际 Session 提交 `TAURI_FINAL`，固定响应流完成后由运行中回到就绪 |
| 中文与历史 | 中文文本粘贴、显示和退出再打开后的聊天历史通过；未验证输入法组合事件 |
| 新建终端 | 通过，实际 shell 执行 `echo TAURI_PTY_FINAL_OK` 并显示独立输出行 |
| 标题栏外观 | 去除额外的系统标题文字，原生红黄绿按钮与共享标题栏同一行 |
| 双击空白区域 | 最终包通过放大、再双击还原；此前通过原生 getter 确认 `is_maximized` 为 true，窗口物理尺寸变为 3024 × 1750 |
| 全屏切换 | 通过进出全屏，界面同步原生按钮留白 |
| 关窗再打开 | 宿主与后端 PID 保留，会话仍在 |
| 完整退出 | 自定义确认框可取消；确认退出后，测试宿主、后端及其子进程消失 |
| 标题栏按钮 | 侧栏、终端标签页、打开面板按钮仍可点击 |
| 拖动区域 | 已将标题栏嵌套容器适配为 Tauri `deep` 区域；自动化触发原生拖动命令，但没有测到窗口位移，鼠标持续拖动尚需人工验收 |

聊天使用本地固定响应服务，不证明真实模型、原生 Codex 投递或工具执行已通过。Codex app-server 子进程的存在只计入进程清单。

## 已知限制

- 完整退出会停止测试 PTY。再次启动时，旧终端恢复曾出现空白：日志中旧 PTY 返回 404，虽然后台创建了新的 shell，旧标签页仍未正常显示。新建终端正常，且经过窗口放大、还原仍正常。旧终端恢复尚未修复，不能宣称终端恢复与 Electron 等价。
- WebKit 控制台出现 `ResizeObserver loop completed with undelivered notifications`；不能将本次结果描述为零控制台错误。
- 默认双击行为为 Tauri 的放大／还原。尚未验证 macOS 双击标题栏的个性化系统设置、窗口位置持久化和全部原生菜单快捷键。
- 仅验证当前 macOS；尚未验证其他版本、真实模型、中文 IME、大 Diff、长会话压力、正式迁移或自动更新。

## 包体积

测量文件：仓库 `.local/desktop-tests/results/tauri-size.json`。MB 按十进制计算。

| 内容 | 字节 | MB |
| --- | ---: | ---: |
| 完整 `.app` 逻辑大小 | 136,829,756 | 136.8 |
| `.app` 文件磁盘占用 | 136,843,264 | 136.8 |
| 内置后端 | 121,831,856 | 121.8 |
| 原生宿主与嵌入前端 | 13,805,840 | 13.8 |
| ZIP 压缩包 | 51,459,033 | 51.5 |

完整包约 89% 来自保留的后端。ZIP 在 `.local/desktop-tests/results/OpenCode Lab Tauri Test.zip`；它与 App 均为本机 worktree 绑定的测试产物。

## 内存快照

2026-09-12 16:30:26 CST，窗口 1280 × 800、聊天历史已显示、无活动回答、一个正常的新终端及一个待恢复旧终端标签页，Inspector 已关闭。先按启动时间、父 PID 和 WebKit 独立数据目录归属进程，再采样 `vmmap -summary`。

| 进程 | PID | Physical footprint，保留工具单位 |
| --- | ---: | ---: |
| Tauri 宿主 | 36178 | 36.7M |
| WebKit 内容 | 36181 | 189.7M |
| WebKit GPU | 36179 | 121.8M |
| WebKit 网络 | 36180 | 6849K |
| Lab 后端 | 36191 | 430.0M |
| Codex app-server | 36241 | 17.0M |
| 恢复创建的 shell | 36260 | 4096K |
| 活跃新终端 shell | 36638 | 4288K |

原始数据在 `.local/desktop-tests/results/tauri-idle-new-terminal.json`。本地固定响应 HTTP 服务属于外部测试夹具，未计入以上 App 进程。`vmmap` 对后端 malloc zone 给出了无法完整解析的提示，因此这里只使用其进程 footprint 字段，不能据此分析内存分配组成。快照并非稳定性能基准；不能把宿主的 36.7M 当成整个产品内存。

没有完成相同场景的 Electron 对照或冷启动时延测量，因此不作性能胜负结论。

## 检查与证据

- `typecheck` 通过。
- 隔离路径检查：1 个测试，5 个断言通过。
- `cargo fmt --check`、`git diff --check` 通过。
- 完整 `build:tauri` 包装脚本以及后续标题栏增量构建通过；最终包签名验证通过。
- 界面截图：`.local/desktop-tests/results/tauri-final.jpg`；此前终端检查截图：同目录 `terminal.png`。
- 构建日志与原始测量保留在忽略的 `.local/desktop-tests/results/` 目录。
