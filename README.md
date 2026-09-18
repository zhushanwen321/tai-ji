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

## 安装

当前最新版本：**v0.10.1**（[查看全部版本](https://github.com/zhushanwen321/tai-ji/releases)）。安装后 app 内会自动检测新版本，提示一键升级。

<!-- INSTALL:BEGIN -->
<!-- 本区块内的版本号由 .agents/skills/merge/scripts/update-readme-install.mjs 在每次正式发布后自动替换；区块外的版本号不会被打扰。 -->

### 国内下载（GitCode 镜像，国内直连实测约 15 MB/s）

镜像仓库：[gitcode.com/qq_18433817/tai-ji](https://gitcode.com/qq_18433817/tai-ji)

#### macOS（Apple Silicon）

```bash
# 下载并打开 DMG（也可到 Releases 页用浏览器下载 dmg，双击安装）
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg

# 若启动时提示「已损坏」或「无法验证开发者」，执行（curl 下载通常不需要，浏览器下载需要）：
# xattr -cr /Applications/TaiJi.app
```

#### Linux

```bash
# 下载、赋可执行权限并启动 AppImage
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

```powershell
# PowerShell（推荐；避免 curl 在 PowerShell 是别名导致的参数冲突）
Invoke-WebRequest -Uri "https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"

# 命令提示符 / cmd.exe（系统自带 curl.exe，Win10 1803+ 默认含）：
# curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

### 国外下载（GitHub）

仓库：[github.com/zhushanwen321/tai-ji](https://github.com/zhushanwen321/tai-ji)

#### macOS（Apple Silicon）

```bash
# 下载并打开 DMG
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg

# 若启动时提示「已损坏」或「无法验证开发者」，执行（curl 下载通常不需要，浏览器下载需要）：
# xattr -cr /Applications/TaiJi.app
```

#### Linux

```bash
# 下载、赋可执行权限并启动 AppImage
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

```powershell
# PowerShell
Invoke-WebRequest -Uri "https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"

# 命令提示符 / cmd.exe（系统自带 curl.exe，Win10 1803+ 默认含）：
# curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

<!-- INSTALL:END -->

---

## 它能做什么

### Agent 执行

- **并行 Subagent**：把独立任务派给多个子 agent 同时跑，主对话只留结论。侧栏 Subagents 面板汇总所有子任务，点开任一条可在右侧抽屉查看它的完整对话和产出。每个子任务带预算与轮次上限，超出即停。
- **Workflow 编排**：用 chain、parallel 等模板把多个 subagent 组成有状态工作流，上游输出自动传给下游，中断后可从断点恢复。侧栏 Workflows 面板显示每个节点的状态。
- **Todo 与 Goal**：Agent 会把任务拆成 todo 清单逐项完成；需要长时间运行的目标走 goal 模式，先定验收标准和预算，达成后自动收尾。
- **定时任务**：Agent 可以创建 cron 或 interval 定时任务，到点自动唤醒会话执行，适合定时提醒、周期巡检、定时跑批。任务支持暂停、删除和手动触发一次。
- **上下文管理**：会话变长时 Agent 可以自主压缩上下文（同模型生成摘要，尽量命中前缀缓存），接近阈值会主动提醒。输入框旁悬停即可查看当前上下文占用。
- **会话操作**：⌘G 从最近的回复分叉出新会话，⌘J 把当前上下文交接给新会话，⌘I 导入已有会话。输入框支持 / 命令、# 引用会话、$ 引用文件、@ 派 subagent。所有会话以 JSONL 格式落盘，点击标题栏文件名即复制路径，pi 生态工具可以直接读取。

### 执行过程可见

- **实时对话流**：思考、工具调用、文件编辑逐步流出；每轮结束折叠成一行摘要（耗时、思考与工具次数），点开可查看完整过程。
- **Trace 视图**：以台账形式列出会话的全部执行记录，支持按类型筛选和全文搜索，也可以只看上下文边界，检查压缩发生在哪里、哪些内容进入了上下文。
- **任务状态条**：todo 和 goal 的进度以状态条形式固定显示在对话流中。
- **结构化问答**：Agent 需要确认时弹出表单，可以包含多个问题、选项和自由输入，答案按结构回传给 Agent。
- **后台任务**：耗时较长的命令可以转到后台执行，结束后自动通知并继续处理；抽屉中有专门页面集中查看输出。

### 工作台

- **文件树**：侧栏文件面板，大目录下依然流畅，改动过的文件带 git 标记。
- **终端**：抽屉内置终端，每个会话独立保留现场。
- **Git 与 worktree**：查看当前分支和文件变更；支持创建、切换、清理 worktree，让多个任务在不同目录并行进行。
- **浏览器面板**：抽屉内置浏览器，可以直接查看 Agent 操作网页的过程。

### 设置与控制

- **系统提示词**：在设置中整段替换 Agent 的系统提示词，手动保存，修改前自动快照，可随时还原或恢复默认。
- **工具权限**：在输入框旁切换工具权限档位，从只读到全工具。
- **模型接入**：内置常用 provider 目录，填写 API key 即可使用；模型和思考档位在输入框旁切换，各 provider 的配额可在设置中查看。
- **设置中心**：包含 Provider、外观、技能、Agent、扩展、System Prompt、终端、预设、worktree、更新、系统、用量 12 个分区。
- **自动更新**：自动检测新版本，确认后重启升级。
## pi 扩展

taiji 的 Agent 能力通过 pi 扩展机制实现，源码在 [`extensions/`](extensions/)（21 个 `@zhushanwen/pi-*` 包 + `shared/` 共享库），其中 18 个随应用打包内置，开箱即用。以下 16 个扩展功能自足、可脱离 taiji 独立使用（全部经 npm 发布，也可 `--extension` 直接加载）：

| 扩展 | 用途 |
|------|------|
| [`pi-subagent-workflow`](extensions/universal/subagent-workflow/README.md) | 统一 subagent 执行 + 多 agent workflow 编排（parallel / chain 等有状态工作流） |
| [`pi-goal`](extensions/universal/goal/README.md) | `/goal` 持久目标驱动自治循环，证据验收 |
| [`pi-todo`](extensions/universal/todo/README.md) | AI 驱动的 todo 列表（会话持久化 + `/todos`） |
| [`pi-ask-user`](extensions/universal/ask-user/README.md) | 结构化多问题输入（分栏预览 + 内联编辑） |
| [`pi-permission`](extensions/universal/permission/README.md) | 四档权限模式（yolo / auto / approve / strict）+ 三层判定管道（AST / 规则 / AI 分类） |
| [`pi-scheduler`](extensions/universal/scheduler/README.md) | 定时任务调度（cron / interval，once / recurring） |
| [`pi-session-reader`](extensions/universal/session-reader/README.md) | 读取 / 查询 session 历史（树、家族、执行树、搜索、导出） |
| [`pi-session-manager`](extensions/universal/session-manager/README.md) | Agent 托管子会话（创建 / 发送 / 历史 / 状态 / 列表 / 中止） |
| [`pi-rename-session`](extensions/universal/rename-session/README.md) | 首轮对话后自动生成会话标题 |
| [`pi-smart-context`](extensions/universal/smart-context/README.md) | Agent 自决上下文压缩（compact_context 工具 + 双模式摘要接管 + 分档提醒） |
| [`pi-structured-output`](extensions/universal/structured-output/README.md) | 结构化输出（JSON Schema + Ajv 校验） |
| [`pi-pending-notifications`](extensions/universal/pending-notifications/README.md) | 跨扩展异步操作注册 / 查询（长任务期间防消息注入） |
| [`pi-base-tool-enhance`](extensions/universal/base-tool-enhance/README.md) | bash 工具增强（前台委托 pi 官方工厂 + 后台模式 + 工具错误审计） |
| [`pi-plan`](extensions/universal/plan/README.md) | 轻量 plan 模式 |
| [`pi-cache-probe`](extensions/universal/cache-probe/README.md) | 缓存前缀指纹采集 + 归因分析 |
| [`pi-cw-tool`](extensions/universal/cw-tool/README.md) | cw 2.0 runner 实操指南 + `cw_query` 只读查询工具 |

其余 5 个（`pi-agent-ext` / `pi-msg-id-mapper` / `pi-plugin-bridge` / `pi-system-prompt` / `pi-system-prompt-trace`）为 taiji 集成专用，离开 taiji 宿主无功能。18 个内置扩展 = 上表 16 个中的 13 个 + 这 5 个；`pi-plan` / `pi-cache-probe` / `pi-cw-tool` 未内置，经 npm 安装或 `--extension` 加载。扩展开发见 [docs/extensions/development-guide.md](docs/extensions/development-guide.md)。

## 快速开始（开发）

**前置条件**: Node.js >= 22.19（推荐 24，见 `.nvmrc`），pnpm >= 10

```bash
# 安装依赖（pnpm workspace 单步装完 apps/* + packages/* + extensions/*）
pnpm install

# 开发模式（Vite HMR + Electron 主进程）
pnpm dev

# 生产构建（electron-builder，产出 DMG/EXE/AppImage/manifest）
pnpm build

# 类型检查
pnpm --filter @taiji/frontend run typecheck

# ESLint
pnpm run lint

# extensions/ 下的 pi 扩展
pnpm extensions:typecheck
pnpm extensions:lint
pnpm extensions:test

# Playwright E2E
pnpm build:e2e && pnpm test:e2e
```

调试 dev app：`pnpm dev` 启动后 Electron 开 CDP 调试端口（按 worktree 名 hash 稳定派生，`node apps/electron/scripts/dev-instance.mjs --print` 查看本实例端口），可用 Playwright 连接截图 / DOM 快照 / 执行 JS（不抢焦点），详见 [AGENTS.md「前端调试」](AGENTS.md)。注意 runtime 源码不热重载（tsx 非 watch），改 runtime 后需重启 `pnpm dev`；renderer 走 vite HMR 自动生效。

### 环境变量

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `TAIJI_MOCK` | 设为 `1` 跳过 runtime 子进程启动，使用 Mock 数据 | — |
| `VITE_MOCK` | 设为 `true` 在 ws-client 层拦截所有 WS 消息 | — |
| `TAIJI_AGENT_DATA_DIR` | 自定义数据目录，与 pi 的 `~/.pi/agent/` 完全隔离（dev 模式强制 `~/.taiji-dev`，此变量不生效） | `~/.taiji` |

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 42 |
| 前端框架 | Vue 3.5 + TypeScript 5.8 |
| 状态管理 | Pinia 3 |
| 构建工具 | Vite 8 (renderer) + Vite lib mode (main/preload) |
| UI 组件 | @taiji/ui（内部组件库）+ reka-ui |
| 样式 | Tailwind CSS v3（太极纯灰 tokens，禁 scoped CSS 组件样式 / 禁 `@apply`） |
| 图标 | @lucide/vue |
| 国际化 | vue-i18n 10 |
| 后端通信 | ws (WebSocket) + pi 子进程 RPC |
| 打包 | electron-builder 26 |

## 发布

两条独立发布管线，通过 tag 前缀解耦：

| 管线 | 产物 | 触发 tag | Workflow |
|------|------|----------|----------|
| Electron 打包 | DMG / EXE / AppImage / manifest | `v*` | `release.yml` |
| npm 包发布 | `@zhushanwen/pi-*` 扩展 + 引擎 / SDK 包（`pi-rpc` / `subagent-core` / `subagent-engine-sdk` / `pi-subagent-cli` / `zcode-subagent-cli` / `session-delivery` / `extension-protocol`） | `npm-*` | `release-npm.yml` |
| npm 预发布 | dev dist-tag 测试版 | `dev-npm-*` 分支 / 本地 `npm-prerelease.sh` | `release-npm-dev.yml` |

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
