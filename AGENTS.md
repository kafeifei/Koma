# Koma

[项目定位、架构与边界](./PROJECT.md) · [上游 Session Runtime](./CONTEXT.md)

## 分支约定

`main` 承载 Koma 产品；`dev` 只镜像上游，禁止提交 Koma 改动。功能分支从 `main` 创建并合回 `main`。Debug 默认从 `main` 构建，正式发布使用干净的 `main` 提交。

同步、集成和打包前阅读 [分支策略](./docs/branches.md) 与 [Koma 维护 skill](./.agents/skills/koma-maintenance/SKILL.md)。
