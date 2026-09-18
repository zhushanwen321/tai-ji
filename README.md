<p align="center"><img src="docs/assets/logo/assets/qianwen/logo-square.png" width="96" alt="TaiJi logo" /></p>

<h1 align="center">太极 TaiJi</h1>

<p align="center"><strong>面向长时间、多任务协作的 AI Agent 桌面工作台</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> ｜ <a href="README_EN.md">English</a> ｜ <a href="https://github.com/zhushanwen321/tai-ji/releases">下载安装</a>
</p>

基于 Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台（macOS / Windows / Linux）。通过 [pi](https://github.com/badlogic/pi-mono)（npm 包名 `@earendil-works/pi-coding-agent`）的子进程 RPC 协议与各类 AI Agent 通信，提供多 session 管理、双 Panel split view、subagent/workflow 编排、目标驱动自治循环、定时调度等能力。18 个 Agent 扩展随应用打包内置，开箱即用。

<p align="center">
  <img src="docs/assets/screenshot/screenshot.png" alt="太极 TaiJi 主界面 — 侧栏多会话管理 + Agent 对话流：思考、工具调用、文件编辑全程实时可见" width="900" />
</p>

> 开发约定、关键规则与调试纪律见 [AGENTS.md](AGENTS.md)。

## 安装

当前最新版本：**v0.10.0**（[查看全部版本](https://github.com/zhushanwen321/tai-ji/releases)）。安装后 app 内会自动检测新版本，提示一键升级。

<!-- INSTALL:BEGIN -->
<!-- 本区块内的版本号由 .agents/skills/merge/scripts/update-readme-install.mjs 在每次正式发布后自动替换；区块外的版本号不会被打扰。 -->

### 国内下载（GitCode 镜像，国内直连实测约 15 MB/s）

镜像仓库：[gitcode.com/qq_18433817/tai-ji](https://gitcode.com/qq_18433817/tai-ji)

#### macOS（Apple Silicon）

```bash
# 下载并打开 DMG（也可到 Releases 页用浏览器下载 dmg，双击安装）
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg

# 若启动时提示「已损坏」或「无法验证开发者」，执行（curl 下载通常不需要，浏览器下载需要）：
# xattr -cr /Applications/TaiJi.app
```

#### Linux

```bash
# 下载、赋可执行权限并启动 AppImage
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

```powershell
# PowerShell（推荐；避免 curl 在 PowerShell 是别名导致的参数冲突）
Invoke-WebRequest -Uri "https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"

# 命令提示符 / cmd.exe（系统自带 curl.exe，Win10 1803+ 默认含）：
# curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

### 国外下载（GitHub）

仓库：[github.com/zhushanwen321/tai-ji](https://github.com/zhushanwen321/tai-ji)

#### macOS（Apple Silicon）

```bash
# 下载并打开 DMG
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg

# 若启动时提示「已损坏」或「无法验证开发者」，执行（curl 下载通常不需要，浏览器下载需要）：
# xattr -cr /Applications/TaiJi.app
```

#### Linux

```bash
# 下载、赋可执行权限并启动 AppImage
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

```powershell
# PowerShell
Invoke-WebRequest -Uri "https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"

# 命令提示符 / cmd.exe（系统自带 curl.exe，Win10 1803+ 默认含）：
# curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.0/TaiJi-0.10.0-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

<!-- INSTALL:END -->

---

## 核心能力

### 会话与工作台

- **多 session 管理** — 侧栏会话列表，⌘/Ctrl+N 新建；session 树状分支（fork / clone）为 pi 原生能力，可从任意 assistant 消息分叉（⌘/Ctrl+G fork、⌘/Ctrl+⇧+G fork 模式、⌘/Ctrl+J handoff）
- **双 Panel split view** — 单 Panel 为默认态，打开第二个 session 即分屏；支持 focus mode 聚焦当前会话
- **Overview** — 独立的多会话鸟瞰视图（卡片网格 + 筛选 + 后台 agent 聚合）
- **全局效率入口** — ⌘/Ctrl+K 全局搜索、⌘/Ctrl+I 导入会话、⌘/Ctrl+B 折叠侧栏、⌘/Ctrl+, 设置、⌘/Ctrl+[ ] 会话前进后退、⌘/Ctrl+⇧+P 预设切换；快捷键均可在设置中重录

### 对话流

- **流式渲染** — markdown 增量渲染、回合折叠、thinking 展开收起
- **GUI Widget 面板** — todo / goal 等以独立 widget 面板呈现，带统一 meta 头行（标题、状态点、进度 N/M、迷你进度条），Agent 侧状态与展示层单通道同步
- **结构化交互** — ask-user 多问题结构化输入（分栏预览 + 内联编辑）、JSON Schema 校验的结构化输出

### 文件 / 终端 / Git

- **文件树** — 虚拟化渲染（扁平可见行），大仓库下保持流畅；文件状态角标与行数统计
- **终端** — 命令式缓冲区渲染，版本化重放，会话级持久分区
- **Git** — 分支与变更状态展示，worktree 创建/切换/清理

### 模型与设置

- **Provider 管理** — 多 provider 配置、内置 provider 目录、API key 管理
- **配额展示** — 各 provider / 模型的用量配额查询
- **设置中心** — 全屏 overlay，覆盖 Provider / 外观 / 技能 / Agent / 扩展 / System Prompt / 终端 / 预设 / worktree / 更新 / 系统 / 用量 12 个菜单域
- **自动更新** — 周期检测新版本，确认后重启升级；Release Notes 中英双语

## pi 扩展

taiji 的 Agent 能力通过 pi 扩展机制实现，源码在 [`extensions/`](extensions/)（21 个 `@zhushanwen/pi-*` 包 + `shared/` 共享库），其中 18 个随应用打包内置，开箱即用。以下 16 个扩展功能自足、可脱离 taiji 独立使用（全部经 npm 发布，也可 `--extension` 直接加载）：

| 扩展 | 用途 |
|------|------|
| [`pi-subagent-workflow`](extensions/universal/subagent-workflow/README.md) | 统一 subagent 执行 + 多 agent workflow 编排（parallel / chain 等有状态工作流） |
| [`pi-goal`](extensions/universal/goal/README.md) | `/goal` 持久目标驱动自治循环，证据验收 |
| [`pi-todo`](extensions/universal/todo/README.md) | AI 驱动的 todo 列表（会话持久化 + `/todos`） |
| [`pi-ask-user`](extensions/universal/ask-user/README.md) | 结构化多问题输入（分栏预览 + 内联编辑） |
| [`pi-permission`](extensions/universal/permission/README.md) | 四档权限模式（yolo / auto / approve / strict）+ 审批管道 |
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

其余 5 个（`pi-agent-ext` / `pi-msg-id-mapper` / `pi-plugin-bridge` / `pi-system-prompt` / `pi-system-prompt-trace`）为 taiji 集成专用，离开 taiji 宿主无功能。扩展开发见 [docs/extensions/development-guide.md](docs/extensions/development-guide.md)。

## 架构

<p align="center">
  <img src="docs/assets/architecture.drawio.png" alt="TaiJi 架构：Electron 主进程 / Preload 桥接 / Runtime（Node.js 子进程）/ 渲染进程 / pi CLI 子进程" width="820" />
</p>

架构图源文件：[`docs/assets/architecture.drawio`](docs/assets/architecture.drawio)（PNG 为内嵌源导出，可在 draw.io 中打开继续编辑）。

五个核心模块：

| 模块 | 路径 | 职责 |
|------|------|------|
| **主进程** | `apps/electron/main/` | BrowserWindow 生命周期、runtime spawn/stop、全局快捷键（supervisor / window / gateway 三编排子系统） |
| **Preload** | `apps/electron/preload/` | `contextIsolation` 安全桥接，暴露 `window.electronAPI` |
| **前端** | `packages/renderer/` | Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + @taiji/ui（太极纯灰暗色设计系统） |
| **Runtime** | `packages/runtime/` | WebSocket 服务，三层架构（transport/services/infra），通过 pi RPC 协议与 Agent 通信 |
| **共享类型** | `packages/shared/` | 前端与 runtime 间的 TypeScript 类型定义（pnpm workspace） |

渲染进程有两条出口通道：**WS**（→ Runtime，业务/数据）与 **IPC**（→ Main，窗口/进程/OS 特权）。渲染进程不直接调 `window.electronAPI`，统一走 [`lib/ipc.ts`](packages/renderer/src/lib/ipc.ts) 门面。

---

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
| `TAIJI_AGENT_DATA_DIR` | 自定义数据目录（dev 模式默认 `~/.taiji-dev`，与 pi 的 `~/.pi/agent/` 完全隔离） | `~/.taiji` |

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

## 项目结构

```
├── apps/electron/            # Electron 壳
│   ├── main/                 # 主进程（supervisor / window / gateway / shortcuts）
│   └── preload/              # 安全桥接（electronAPI）
├── packages/                 # pnpm workspace 包
│   ├── renderer/             # Vue 前端（components / composables / stores / lib）
│   ├── runtime/              # Node.js Runtime（transport / services / infra + plugins）
│   ├── core/                 # 前端核心层（coordination / domain / extension-host / foundation）
│   ├── ui/                   # taiji ui 组件库（@taiji/ui）
│   ├── shared/               # 前后端共享类型
│   ├── dom-core/             # composer DOM 层
│   ├── mobile-renderer/      # 移动端渲染入口
│   ├── plugin-sdk/           # 插件开发 SDK（类型 + mock）
│   ├── extension-protocol/   # Extension GUI 渲染协议（TUI/GUI 双模类型）
│   ├── subagent-core/        # subagent 执行核心（跨引擎共享的编排 / 预算 / 通道层）
│   ├── subagent-engine-sdk/  # 引擎协议 SDK（NDJSON stdio 契约与引擎原语）
│   ├── pi-subagent-cli/      # pi 引擎 CLI（engine-protocol v1）
│   ├── zcode-subagent-cli/   # zcode 引擎 CLI（app-server RPC）
│   ├── pi-rpc/               # pi 子进程 RPC 共享层
│   ├── session-delivery/     # 会话消息投递内核（队列 / 批量 / 去重 / 门控 flush）
│   └── create-taiji-plugin/  # 插件项目脚手架
├── extensions/               # 21 个 @zhushanwen/pi-* pi 扩展源码 + shared/ 共享库
├── e2e/                      # Playwright E2E spec + 视觉基线（visual-baselines）
├── scripts/                  # 构建 / 验证 / 发布脚本（preflight / postbuild / verify-* / bundle-extensions）
├── resources/                # 内置插件与 statusline
├── docs/                     # 文档（架构 / 设计 SSOT / 扩展指南 / 测试 / ADR / 排查）
└── .agents/                  # 项目级 agent / skill（merge / review 等）
```

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
