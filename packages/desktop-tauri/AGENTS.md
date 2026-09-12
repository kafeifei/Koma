# Koma Tauri

仅在此包实现测试宿主与平台适配；界面、Session、任务执行和数据库继续复用现有包。范围与启动方式见 README.md。

按用户确认，Electron 与 Tauri 使用同一份 Koma CLI、共享 Koma 数据目录，但各自启动独立后端与端口。Tauri 固定 `KOMA_BACKEND_INSTANCE=tauri`；数据路径由 Koma CLI 按 `KOMA_HOME`／`OPENCODE_HOME` 与 `~/.koma` 兼容规则解析，不再绑定测试 worktree。

进程登记、认证和退出控制必须按实例隔离；不得停止 Electron 的后端。关闭窗口保留自身后端，完整退出经确认只停止自身后端。数据库和 Session Runtime 保留上游语义，不添加全数据目录的单写入进程门禁。自动化测试使用临时 profile，不操作真实任务。安装不得重启运行中的应用。

性能记录必须区分开发构建与 Release、宿主与 WebView 子进程、后端与 Agent。空壳体积或单个主进程 RSS 不代表完整产品。
