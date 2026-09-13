# Koma

[项目定位、架构与边界](./PROJECT.md) · [上游 Session Runtime](./CONTEXT.md)

## 分支约定

`main` 承载 Koma 产品；`dev` 只镜像上游，禁止提交 Koma 改动。功能分支从 `main` 创建并合回 `main`。「发 debug」须先将本次改动提交并合入 `main`，再从构建时最新、干净的 `main` 提交构建和安装；该请求已包含必要的提交与合并授权。正式发布使用干净的 `main` 提交。

同步、集成和打包前阅读 [分支策略](./docs/branches.md) 与 [Koma 维护 skill](./.agents/skills/koma-maintenance/SKILL.md)。

「跑 debug」／「快速测试」使用当前源码的 `bun run dev:fast`，页面热更新，测试 profile 与日常数据隔离；原生宿主验证及增量缓存见 [开发说明](./docs/development.md)。这不替代「发 debug」的 main 交付流程。
