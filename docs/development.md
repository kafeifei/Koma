# 快速测试

日常「跑 debug」／「快速测试」使用当前功能分支和未提交源码；「发 debug」仍先合入最新、干净的 main，再构建、签名和安装。

## 页面与业务流程

在仓库根目录执行：

```sh
bun run dev:fast
```

脚本直接启动 Koma 源码后端与 Vite，并输出带测试实例认证的浏览器地址。页面和样式保存后通过 Vite 热更新，无须打包、签名或覆盖安装。后端代码变更后，用 Ctrl+C 停止此测试入口，再执行同一命令，并打开新输出的地址。

默认使用此工作区的 `.local/desktop-tests/fast/profile`，保留测试配置，不连接日常 `~/.koma` 实例。测试模型需要在该 profile 配置。`KOMA_FAST_HOME` 可指定绝对测试路径；`KOMA_FAST_PORT` 可固定浏览器端口。停止脚本只终止本脚本启动的进程，不使用按名称杀进程或停止全局后端的命令。

这是 Web 平台上的真实工作台和源码后端，适合页面、设置、插件及服务 API；原生窗口、菜单、钥匙串、通知、宿主 Remote 桥接和打包资源要在对应桌面宿主验证。

## 原生宿主

```sh
KOMA_HOME="$(pwd)/.local/desktop-tests/electron-dev/profile" bun run dev:desktop
KOMA_HOME="$(pwd)/.local/desktop-tests/tauri-dev/profile" bun run dev:tauri
```

两个入口均有前端热更新。首次启动仍准备编译后的后端；后端源码变更需要退出该测试宿主、重新准备后端再启动。不要复用日常 profile 来判断新后端是否生效，因为已有后端可能继续提供旧代码。

Tauri 使用 Cargo 的开发构建缓存，不预留交付序号，也不占用正式打包锁。它仍准备一份供宿主 Web 网关使用的前端快照；窗口内的 Vite 热更新不代表这份远程网页快照也更新。

## 增量复用与交付

Electron 和 Tauri 共用 CLI 构建缓存。缓存按后端及其 workspace 依赖的文件内容、锁文件、构建脚本、版本、Bun 版本、平台和发行模式校验，并核对二进制 SHA-256。仅修改 `packages/app` 页面或仓库文档、仅发生提交或合并，不再让后端缓存失效。共享依赖中的改动仍保守地触发重建。

缓存保存在此仓库的 Git 公共目录 `koma-build-cache/cli`，干净 main 的隔离工作区也能使用。应用构建信息仍记录当前源码提交；CLI 清单中的 `commit` 保留实际编译提交，`validatedCommit` 表示确认输入一致后复用的提交。

完整交付仍会构建前端、组装应用、签名和校验；这不是整个安装包的增量修补，也不跳过必要验证。Debug 交付策略见 [release.md](release.md)。

Electron 与 Tauri 的包体积、内存、冷启动、热更新和打包耗时是不同指标；不能用包大小或主进程内存决定谁构建更快。切换默认 Debug 宿主需要同机、同源码、同缓存状态的完整构建数据和功能验收。
