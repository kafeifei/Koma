# Desktop 边界

架构、共享后端与 profile 归属见 [README.md](README.md)；全仓边界见 [PROJECT.md](../../PROJECT.md)。

Renderer 的平台接口是 preload `window.api`，主进程 IPC 位于 `src/main/ipc.ts`。界面与原生菜单共用 typed i18n；主进程经 `nativeT(...)` 消费完整翻译，语言与语法规则属于共享翻译层。
