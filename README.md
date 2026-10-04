<p align="center"><img src="docs/assets/logo/assets/qianwen/logo-square.png" width="96" alt="TaiJi logo" /></p>

<h1 align="center">太极 TaiJi</h1>

<p align="center"><strong>面向长时间、多任务协作的 AI Agent 桌面工作台</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> ｜ <a href="README_EN.md">English</a> ｜ <a href="https://github.com/zhushanwen321/tai-ji/releases">下载安装</a>
</p>

太极是一个 AI Agent 桌面工作台（macOS / Windows / Linux）。它把多个 AI 会话放进同一个窗口，你可以同时推进多个任务，实时看到 AI 的思考、文件编辑和命令执行过程，随时分叉重试。基于 [pi](https://github.com/badlogic/pi-mono) agent 内核，内置 18 个扩展，支持接入各类模型服务。

<p align="center">
  <img src="docs/assets/screenshot/screenshot.png" alt="太极 TaiJi 主界面：侧栏多会话管理与 Agent 对话流，思考、工具调用、文件编辑实时可见" width="900" />
</p>

> 开发约定、关键规则与调试纪律见 [AGENTS.md](AGENTS.md)。

---

## 快速开始

当前最新版本：**v0.10.1**（[查看全部版本](https://github.com/zhushanwen321/tai-ji/releases)）。安装后 app 内会自动检测新版本，提示一键升级。

<!-- INSTALL:BEGIN -->
<!-- 本区块内的版本号由 .agents/skills/merge/scripts/update-readme-install.mjs 在每次正式发布后自动替换；区块外的版本号不会被打扰。 -->

<details>
<summary><b>🇨🇳 国内下载（GitCode 镜像，~15 MB/s）</b></summary>

镜像仓库：[gitcode.com/qq_18433817/tai-ji](https://gitcode.com/qq_18433817/tai-ji)

**macOS（Apple Silicon）**
```bash
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.4/TaiJi-0.10.4-mac-arm64.dmg -o /tmp/TaiJi.dmg && open /tmp/TaiJi.dmg
```

**Linux**
```bash
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.4/TaiJi-0.10.4-x86_64.AppImage -o ~/TaiJi.AppImage && chmod +x ~/TaiJi.AppImage && ~/TaiJi.AppImage
```

**Windows（PowerShell）**
```powershell
Invoke-WebRequest -Uri "https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.4/TaiJi-0.10.4-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

</details>

<details>
<summary><b>🌍 国外下载（GitHub）</b></summary>

仓库：[github.com/zhushanwen321/tai-ji](https://github.com/zhushanwen321/tai-ji)

**macOS（Apple Silicon）**
```bash
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.4/TaiJi-0.10.4-mac-arm64.dmg -o /tmp/TaiJi.dmg && open /tmp/TaiJi.dmg
```

**Linux**
```bash
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.4/TaiJi-0.10.4-x86_64.AppImage -o ~/TaiJi.AppImage && chmod +x ~/TaiJi.AppImage && ~/TaiJi.AppImage
```

**Windows（PowerShell）**
```powershell
Invoke-WebRequest -Uri "https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.4/TaiJi-0.10.4-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

</details>

<details>
<summary><b>❓ 首次启动遇到问题？</b></summary>

- **macOS 提示「已损坏」或「无法验证开发者」**：运行 `xattr -cr /Applications/TaiJi.app`
- **Linux AppImage 无法启动**：确认已 `chmod +x`，或尝试 `--no-sandbox` 参数
- **Windows SmartScreen 警告**：点击「更多信息」→「仍要运行」

</details>

<!-- INSTALL:END -->

---

## 核心能力

### 🔄 多会话并行
同时运行多个 AI 任务，侧栏实时显示每个会话的状态。随时从任意回复分叉新会话、交接上下文、导入已有会话。

### 👁️ 执行过程完全可见
思考链、工具调用、文件编辑逐步流出；每轮结束折叠成一行摘要，点开可查看完整过程。Trace 视图支持按类型筛选和全文搜索。

### 🤖 Subagent & Workflow
把独立任务派给子 agent 并行执行，或用 chain/parallel 模板编排多步工作流。任务托盘实时汇总进度，每个子任务带预算与轮次上限。

### 🛠️ 工作台集成
侧栏文件树（大目录流畅 + git 标记）、抽屉终端（每会话独立现场）、Git/worktree 管理、内置浏览器面板。

### 🧩 21 个内置扩展
Agent 能力通过 pi 扩展机制实现，涵盖权限控制、定时任务、上下文压缩、结构化输出等。16 个可脱离 taiji 独立使用，详见[扩展开发指南](docs/extensions/development-guide.md)。

---

<details>
<summary><b>📖 完整功能列表（点击展开）</b></summary>

### Agent 执行
- **并行 Subagent**：输入框上方的任务托盘汇总运行中的子任务，点开可在抽屉查看完整对话和产出。
- **Workflow 编排**：用 chain、parallel 等模板把多个 subagent 组成有状态工作流，中断后可从断点恢复。
- **Todo 与 Goal**：Agent 把任务拆成 todo 清单逐项完成；长时间运行的目标走 goal 模式，先定验收标准和预算。
- **定时任务**：cron 或 interval 定时任务，到点自动唤醒会话执行，支持暂停、删除和手动触发。
- **上下文管理**：Agent 自主压缩上下文，接近阈值会主动提醒；输入框旁悬停查看当前占用。
- **会话操作**：⌘G 分叉、⌘J 交接、⌘I 导入；输入框支持 `/` 命令、`#` 引用会话、`$` 引用文件、`@` 派 subagent。

### 执行过程可见
- **实时对话流**：思考、工具调用、文件编辑逐步流出；每轮结束折叠成一行摘要。
- **Trace 视图**：台账形式列出全部执行记录，支持按类型筛选和全文搜索，可查看压缩边界。
- **任务状态条**：todo 和 goal 的进度以状态条形式固定显示在对话流中。
- **结构化问答**：Agent 需要确认时弹出表单，支持多问题、选项和自由输入。
- **后台任务**：耗时命令可转后台执行，结束后自动通知；抽屉集中查看输出。

### 工作台
- **文件树**：侧栏文件面板，大目录下依然流畅，改动过的文件带 git 标记。
- **终端**：抽屉内置终端，每个会话独立保留现场。
- **Git 与 worktree**：查看当前分支和文件变更；支持创建、切换、清理 worktree。
- **浏览器面板**：抽屉内置浏览器，可查看 Agent 操作网页的过程。

### 设置与控制
- **系统提示词**：在设置中整段替换，修改前自动快照，可随时还原。
- **工具权限**：输入框旁切换权限档位，从只读到全工具。
- **模型接入**：内置常用 provider 目录，填写 API key 即可使用。
- **设置中心**：Provider、外观、技能、Agent、扩展等 12 个分区。
- **自动更新**：自动检测新版本，确认后重启升级。

</details>

---

## 扩展生态

taiji 的 Agent 能力通过 pi 扩展机制实现，源码在 [`extensions/`](extensions/)（21 个 `@zhushanwen/pi-*` 包 + `shared/` 共享库），其中 18 个随应用打包内置。

以下 16 个扩展可脱离 taiji 独立使用（全部经 npm 发布，也可 `--extension` 直接加载）：

| 扩展 | 用途 |
|------|------|
| [`pi-subagent-workflow`](extensions/universal/subagent-workflow/README.md) | 统一 subagent 执行 + 多 agent workflow 编排 |
| [`pi-goal`](extensions/universal/goal/README.md) | `/goal` 持久目标驱动自治循环 |
| [`pi-todo`](extensions/universal/todo/README.md) | AI 驱动的 todo 列表 |
| [`pi-ask-user`](extensions/universal/ask-user/README.md) | 结构化多问题输入 |
| [`pi-permission`](extensions/universal/permission/README.md) | 四档权限模式 + 三层判定管道 |
| [`pi-scheduler`](extensions/universal/scheduler/README.md) | 定时任务调度（cron / interval） |
| [`pi-session-reader`](extensions/universal/session-reader/README.md) | 读取 / 查询 session 历史 |
| [`pi-session-manager`](extensions/universal/session-manager/README.md) | Agent 托管子会话 |
| [`pi-rename-session`](extensions/universal/rename-session/README.md) | 自动生成会话标题 |
| [`pi-smart-context`](extensions/universal/smart-context/README.md) | Agent 自决上下文压缩 |
| [`pi-structured-output`](extensions/universal/structured-output/README.md) | 结构化输出（JSON Schema） |
| [`pi-pending-notifications`](extensions/universal/pending-notifications/README.md) | 跨扩展异步操作管理 |
| [`pi-base-tool-enhance`](extensions/universal/base-tool-enhance/README.md) | bash 工具增强 |
| [`pi-plan`](extensions/universal/plan/README.md) | 轻量 plan 模式 |
| [`pi-cache-probe`](extensions/universal/cache-probe/README.md) | 缓存前缀指纹采集 |
| [`pi-cw-tool`](extensions/universal/cw-tool/README.md) | cw 2.0 runner + `cw_query` 工具 |

其余 5 个（`pi-agent-ext` / `pi-msg-id-mapper` / `pi-plugin-bridge` / `pi-system-prompt` / `pi-system-prompt-trace`）为 taiji 集成专用。扩展开发见 [docs/extensions/development-guide.md](docs/extensions/development-guide.md)。

---

## 开发指南

**前置条件**: Node.js >= 22.19（推荐 24，见 `.nvmrc`），pnpm >= 10

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发模式（Vite HMR + Electron 主进程）
pnpm build            # 生产构建（DMG/EXE/AppImage/manifest）
pnpm lint             # ESLint
pnpm --filter @taiji/frontend run typecheck  # 类型检查
pnpm test:e2e         # Playwright E2E（需先 pnpm build:e2e）
```

调试 dev app：`pnpm dev` 启动后 Electron 开 CDP 调试端口（`node apps/electron/scripts/dev-instance.mjs --print` 查看端口），可用 Playwright 连接截图/DOM 快照/执行 JS。详见 [AGENTS.md](AGENTS.md)。

### 环境变量

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `TAIJI_MOCK` | 设为 `1` 跳过 runtime 子进程启动 | — |
| `VITE_MOCK` | 设为 `true` 在 ws-client 层拦截 WS 消息 | — |
| `TAIJI_AGENT_DATA_DIR` | 自定义数据目录（dev 模式强制 `~/.taiji-dev`） | `~/.taiji` |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 42 |
| 前端 | Vue 3.5 + TypeScript 5.8 + Pinia 3 + Vite 8 + Tailwind CSS v3 |
| UI | @taiji/ui + reka-ui + @lucide/vue + vue-i18n 10 |
| 后端通信 | WebSocket + pi 子进程 RPC |
| 打包 | electron-builder 26 |

## 发布

| 管线 | 产物 | 触发 tag | Workflow |
|------|------|----------|----------|
| Electron 打包 | DMG / EXE / AppImage / manifest | `v*` | `release.yml` |
| npm 包发布 | `@zhushanwen/pi-*` 扩展 + 引擎/SDK 包 | `npm-*` | `release-npm.yml` |
| npm 预发布 | dev dist-tag 测试版 | `dev-npm-*` | `release-npm-dev.yml` |

## 文档索引

| 文档 | 内容 |
|------|------|
| [AGENTS.md](AGENTS.md) | 开发约定、关键规则、调试与发布纪律 |
| [docs/PRODUCT.md](docs/PRODUCT.md) / [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 产品定位 / 架构总览 |
| [docs/STANDARDS.md](docs/STANDARDS.md) | 编码规范与架构标准 |
| [docs/DESIGN.md](docs/DESIGN.md) | 视觉设计权威（太极纯灰 token 与范式） |
| [docs/extensions/](docs/extensions/) | pi 扩展开发全套指南 |
| [docs/architecture/feature-map.md](docs/architecture/feature-map.md) | 功能规划与阶段现状 |
| [docs/testing/](docs/testing/) + [docs/TEST-STRATEGY.md](docs/TEST-STRATEGY.md) | 测试策略与分功能测试手册 |
| [docs/adr/](docs/adr/) | 架构决策记录 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 问题排查指南 |

## License

Private
