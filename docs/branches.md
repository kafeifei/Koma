# Koma 分支与上游同步

- `origin`：`kafeifei/Koma`；默认分支 `main`，承载全部 Koma 产品改动。
- `upstream`：`anomalyco/opencode`；`dev` 仅镜像 `upstream/dev`，保持原提交和文件，不加入 Koma 改动。
- 日常开发与远端开发环境以 `main` 为主线。功能开发从 `main` 创建 `codex/*` 分支，PR 目标为 `main`。
- 「发 debug」的顺序固定为：验证本次改动 → 提交并合入本地 `main` → 重新读取最新 `main` → 从该干净提交构建、验证并安装。该请求已授权本次改动所需的提交和合并，无须另行确认；不包含推送、打标签或正式发布。
- 构建开始前重新解析 `refs/heads/main`，源码 `HEAD` 必须与其一致，工作树必须干净。可以从该提交创建干净的隔离工作区；不能叠加功能分支或未提交补丁，也不能沿用旧候选包。保留其他任务的未提交改动，不将其顺带提交。
- 正式发布须使用干净的 `main` 提交，产物、远端 main 和版本标签一致。分支名与构建 Debug/Release 模式无关。

## 同步与集成

在 Koma 的 main 或功能分支工作目录执行，需要 Python 3、Git；推送另需已登录的 GitHub CLI：

```sh
bun run sync:upstream
bun run sync:upstream --push
```

第一条仅获取上游并预览；第二条快进远端与本地 dev，不修改 main，也不合并产品代码。脚本拒绝 dev 被工作区检出、包含自定义提交、远端状态不一致或上游改写历史的情形，不强推。中断或并发导致本地/远端不同步时，先核对双方提交，仅在确认本地是远端祖先后更新本地引用，再重试。

集成上游是另一步，在干净 main 上创建临时分支：

```sh
git switch -c codex/sync-upstream-YYYYMMDD main
git merge dev
```

解决冲突后验证 Koma 命名、`.koma`、Provider 统一模型和认证、后台子代理默认值、桌面流程与打包。特别检查本文件、维护 skill 和发布拦截仍存在。通过后合入 main；不能把 main 合回 dev。

## Actions 与发布入口

仓库 Actions 当前关闭。纯上游 dev 包含会生成并推送代码、部署和发布的上游 workflows；仅修改 main 的触发分支无法阻止 dev 上的 workflow。同步脚本会核对该设置，启用 Actions 时拒绝推送。以后启用 Koma CI 前，必须先设计能隔离镜像分支所有上游 workflows 的执行策略。

`script/release`、`script/version.ts`、`script/publish.ts`、`script/beta.ts` 是保留的上游发布入口，已限制为上游仓库使用，不能用来发布 Koma。Koma 桌面构建及手动发布见 [release.md](release.md)。本策略调整不创建版本标签、不发布 beta、不重启应用。

2026-09-12 首次迁移时，原本地 dev 与原远端 dev 分别保存在 `archive/dev-local-before-mirror-20260912`、`archive/dev-origin-before-mirror-20260912`；两条备份均推送到 origin。
