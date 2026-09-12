# OpenCode Lab App

Desktop、本地 Web 与 Remote 复用此应用。App 组合项目／任务工作台、路由和会话界面，Session 与执行仍属于连接的后端。

## 状态边界

- 首页、侧栏和搜索复用所属 server 的会话索引、API 与事件缓存。
- 路由、未发送输入和界面偏好由 App 持有；新建输入是窗口内输入框的一份临时草稿，已有会话输入按正式 Session 隔离。
- 运行、归档、恢复、删除与权限状态来自后端；UI 提交意图，不驱动执行循环或自行批准工具。
- `session-ui` 提供会话呈现，`ui` 提供共享控件；Desktop 平台能力通过宿主接口接入。

## 入口

- [项目边界](../../PROJECT.md)与[工作台数据和目录](../../docs/workspace.md)
- [应用组合](src/app.tsx)与[工作台布局](src/pages/layout-new.tsx)
- [服务端同步](src/context/server-sync.tsx)与[任务侧栏](src/pages/layout/task-sidebar.tsx)
- [输入持久化](src/context/prompt-state.ts)与[首次提交](src/components/prompt-input/submit.ts)
- [Codex 原生接入](../codex/README.md)与[Desktop 宿主](../desktop/README.md)
