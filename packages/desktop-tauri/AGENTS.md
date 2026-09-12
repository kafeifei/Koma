# Tauri 验证版

仅在此包实现测试宿主与平台适配；界面、Session、任务执行和数据库继续复用现有包。范围与启动方式见 README.md。

测试后端只能使用本 worktree 的 `.local/desktop-tests/tauri/profile`。必须同时固定 `KOMA_HOME` 和 `OPENCODE_HOME`，不得回退到默认 `~/.koma`／`~/.opencode`、迁移正式数据、覆盖安装正式 App 或控制正式 App／后端进程。关闭窗口保留后端；完整退出经确认后停止测试后端。

性能记录必须区分开发构建与 Release、宿主与 WebView 子进程、后端与 Agent。空壳体积或单个主进程 RSS 不代表完整产品。
