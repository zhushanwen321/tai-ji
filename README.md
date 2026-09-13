<p align="center"><img src="docs/assets/logo/assets/qianwen/logo.png" width="96" alt="TaiJi logo" /></p>

# 太极 TaiJi

[简体中文](README.md) ｜ [English](README_EN.md)

AI Agent 桌面工作台（macOS / Windows / Linux），基于 Electron + Vue 3 + Node.js Runtime 架构。

通过 [pi](https://github.com/badlogic/pi-mono)（npm 包名 `@earendil-works/pi-coding-agent`）的子进程 RPC 协议与各类 AI Agent 通信，提供多 session 管理、双 Panel split view、subagent/workflow 编排、目标驱动自治循环、定时调度等能力，面向长时间、多任务的 Agent 协作场景。13 个 Agent 扩展随应用打包内置，开箱即用。

> 开发约定、关键规则与调试纪律见 [AGENTS.md](AGENTS.md)。

## 安装

当前最新版本：**v0.9.13**（[查看全部版本](https://github.com/zhushanwen321/xyz-agent/releases)）。安装后 app 内会自动检测新版本，提示一键升级。

<!-- INSTALL:BEGIN -->
<!-- 本区块内的版本号由 .agents/skills/merge/scripts/update-readme-install.mjs 在每次正式发布后自动替换；区块外的版本号不会被打扰。 -->

### 国内下载（GitCode 镜像，国内直连实测约 15 MB/s）

镜像仓库：[gitcode.com/qq_18433817/xyz-agent](https://gitcode.com/qq_18433817/xyz-agent)

#### macOS（Apple Silicon）

```bash
curl -L https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg
```

也可直接到 [GitCode Releases](https://gitcode.com/qq_18433817/xyz-agent/releases) 用浏览器下载 dmg 双击安装。

#### Linux

```bash
curl -L https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

PowerShell（用 Invoke-WebRequest，避免 curl 在 PowerShell 是别名导致的参数冲突）：

```powershell
Invoke-WebRequest -Uri "https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

命令提示符（cmd.exe，需系统自带 curl.exe，Win10 1803+ 默认含）：

```cmd
curl -L https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

### 国外下载（GitHub）

仓库：[github.com/zhushanwen321/xyz-agent](https://github.com/zhushanwen321/xyz-agent)

#### macOS（Apple Silicon）

```bash
curl -L https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg
```

#### Linux

```bash
curl -L https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

PowerShell：

```powershell
Invoke-WebRequest -Uri "https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

命令提示符（cmd.exe）：

```cmd
curl -L https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.20/TaiJi-0.9.20-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

> macOS 若启动时提示「已损坏」或「无法验证开发者」，执行（curl 下载通常不需要，浏览器下载需要）：
>
> ```bash
> xattr -cr /Applications/太极.app
> ```

<!-- INSTALL:END -->

---

## 核心能力

### 会话与工作台

- **多 session 管理** — 侧栏会话列表，⌘/Ctrl+N 新建；session 树状分支（fork / clone）为 pi 原生能力，可从任意 assistant 消息分叉（⌘/Ctrl+G fork、⌘/Ctrl+⇧+G fork 模式、⌘/Ctrl+J handoff）
- **双 Panel split view** — 单 Panel 为默认态，打开第二个 session 即分屏；支持 focus mode 聚焦当前会话
- **Overview** — 独立的多会话鸟瞰视图（卡片网格 + 筛选 + 后台 agent 聚合）
- **全局效率入口** — ⌘/Ctrl+K 全局搜索、⌘/Ctrl+B 折叠侧栏、⌘/Ctrl+, 设置、⌘/Ctrl+[ ] 会话前进后退、⌘/Ctrl+⇧+P 预设切换；快捷键均可在设置中重录

### 对话流

- **流式渲染** — markdown 增量渲染、回合折叠、thinking 展开收起
- **GUI Widget 面板** — todo / goal 等以独立 widget 面板呈现，带统一 meta 头行（标题、状态点、进度 N/M、迷你进度条），Agent 侧状态与展示层单通道同步
- **结构化交互** — ask-user 多问题结构化输入（分栏预览 + 内联编辑）、JSON Schema 校验的结构化输出

### 文件 / 终端 / Git

- **文件树** — 虚拟化渲染（扁平可见行），大仓库下保持流畅；文件状态角标与行数统计
- **终端** — 命令式缓冲区渲染，版本化重放，会话级持久分区
- **Git** — 分支与变更状态展示，worktree 创建/切换/清理

### 内置扩展（13 个，随应用打包）

| 扩展 | 用途 |
|------|------|
| `pi-permission` | 四档权限模式（yolo / auto / approve / strict）+ 三层审批管道 |
| `pi-subagent-workflow` | 统一 subagent 执行 + 多 agent workflow 编排（parallel / chain 等有状态工作流） |
| `pi-goal` | `/goal` 持久目标驱动自治循环，证据验收 |
| `pi-todo` | AI 驱动的 todo 列表（会话持久化 + `/todos`） |
| `pi-ask-user` | 结构化多问题输入工具 |
| `pi-structured-output` | 结构化输出（JSON Schema + Ajv 校验） |
| `pi-scheduler` | 定时任务调度（cron / interval，once / recurring） |
| `pi-session-reader` | 读取 / 查询 session 历史（树、家族、执行树、搜索、导出） |
| `pi-rename-session` | 首轮对话后自动生成会话标题 |
| `pi-pending-notifications` | 跨扩展异步操作注册 / 查询（长任务期间防消息注入） |
| `pi-agent-ext` | 内部命令（host 触发 reload `/__xyz_reload__` + Trace 视图现取 system prompt `/__xyz_get_system_prompt__`） |
| `pi-system-prompt` | 系统提示词注入（AGENTS.md / settings 追加段） |
| `pi-msg-id-mapper` | client UUID ↔ user entry ID 映射 |
| `pi-system-prompt-trace` | system prompt 建立或变化时写入 xyz:system-prompt 留痕 entry |

其中 6 个基础设级（`pi-pending-notifications` / `pi-session-reader` / `pi-structured-output` / `pi-agent-ext` / `pi-system-prompt` / `pi-msg-id-mapper`）常驻不可禁用，其余 8 个可在设置中禁用。另有 `pi-cw-tool`（cw 2.0 runner 实操指南 + cw_query 只读查询工具）、`pi-model-switch`（模型推荐切换）、`pi-plan`（轻量 plan 模式）3 个包经 npm 发布，可按需安装。`pi-unified-hooks` 已废弃（npm 标记 deprecated），其能力由 `pi-base-tool-enhance` 取代（bash 后台模式 + 可配置超时 + 工具错误审计）。

### 模型与设置

- **Provider 管理** — 多 provider 配置、内置 provider 目录、API key 管理
- **配额展示** — 各 provider / 模型的用量配额查询
- **设置中心** — 全屏 overlay，覆盖 Provider / 扩展 / 技能 / 终端 / 预设 / worktree / 系统更新等 11 个菜单域
- **自动更新** — 周期检测新版本，确认后重启升级；Release Notes 中英双语

## 架构

```
┌──────────────────────────────────────────────────┐
│                  Electron 主进程                   │
│  窗口管理 · Runtime 子进程生命周期 · 全局快捷键   │
└─────────────┬────────────────────┬────────────────┘
              │ IPC                │ spawn
              ▼                    ▼
┌──────────────────┐   ┌──────────────────────────┐
│   Preload 桥接    │   │   Runtime (Node.js 子进程) │
│ electronAPI 暴露  │   │  WebSocket Server (ws)    │
└────────┬─────────┘   │  pi RPC 适配 · 事件翻译    │
         │             └────────────┬───────────────┘
         │                          │ child_process RPC
         ▼                          ▼
┌──────────────────────────────────────────────────┐
│        渲染进程 (Vue 3 + Vite · 太极纯灰暗色)      │
│  Pinia 状态 · xyz-ui 组件 · ws-client · event-bus │
└──────────────────────────────────────────────────┘
```

五个核心模块：

| 模块 | 路径 | 职责 |
|------|------|------|
| **主进程** | `apps/electron/main/` | BrowserWindow 生命周期、runtime spawn/stop、全局快捷键（supervisor / window / gateway 三编排子系统） |
| **Preload** | `apps/electron/preload/` | `contextIsolation` 安全桥接，暴露 `window.electronAPI` |
| **前端** | `packages/renderer/` | Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui（太极纯灰暗色设计系统） |
| **Runtime** | `packages/runtime/` | WebSocket 服务，三层架构（transport/services/infra），通过 pi RPC 协议与 Agent 通信 |
| **共享类型** | `packages/shared/` | 前端与 runtime 间的 TypeScript 类型定义（pnpm workspace） |

渲染进程有两条出口通道：**WS**（→ Runtime，业务/数据）与 **IPC**（→ Main，窗口/进程/OS 特权）。渲染进程不直接调 `window.electronAPI`，统一走 [`lib/ipc.ts`](packages/renderer/src/lib/ipc.ts) 门面。

### 为什么是 Electron

1. **渲染稳定性** — Chromium 的 CSS/布局渲染结果与 Chrome DevTools 完全一致，不存在 WebView2/WebKit 的平台差异
2. **视觉锐利度** — 字体渲染、亚像素抗锯齿、GPU 合成行为完全可控，跨平台表现一致
3. **生态成熟度** — electron-builder、DevTools 扩展、崩溃上报等工具链完善
4. **Node.js 原生能力** — 主进程直接使用 Node API（child_process、fs、net），不需要 Rust 后端进程或 FFI

### 双扩展机制

太极有两套独立的扩展机制：

**pi Extension** — 运行在 pi 子进程内，经 `--extension` 参数加载，负责 Agent 能力扩展（工具、命令、事件钩子）。源码在本仓 `extensions/` 目录（17 个 `@zhushanwen/pi-*` 包 + `shared/` 共享库），其中 13 个经 esbuild bundle 后随应用打包内置。开发文档：

- [扩展开发指南](docs/extensions/development-guide.md) — 单一权威源：结构、生命周期、发布
- [扩展强约束](docs/extensions/extension-conventions.md) — 必须遵守的约定
- [本地开发调试](docs/extensions/local-dev-guide.md) — `XYZ_EXTENSION_PATHS` live link、日志查看
- [GUI 协议接入](docs/extensions/gui-protocol-guide.md) — TUI extension 的 TUI/GUI 双模改造
- [术语表](docs/extensions/glossary.md) / [Agent 编写指南](docs/extensions/agent-authoring-guide.md)

**Plugin System** — 运行在 xyz-agent Runtime 侧的插件沙箱，负责 UI 与宿主能力扩展（tools、hooks、slash commands、status bar items、message decorations、settings 表单）。trusted 插件与 sandbox 插件两级隔离（Worker Thread / 独立 fork 子进程），单个插件崩溃不影响其他插件或主进程。开发用 [`packages/plugin-sdk`](packages/plugin-sdk/)（类型 + mock），脚手架 `create-xyz-plugin`。

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
pnpm --filter @xyz-agent/frontend run typecheck

# ESLint
pnpm run lint

# extensions/ 下的 pi 扩展
pnpm extensions:typecheck
pnpm extensions:lint
pnpm extensions:test

# Playwright E2E
pnpm build:e2e && pnpm test:e2e
```

调试 dev app：`pnpm dev` 启动后 Electron 开 `--remote-debugging-port=9222`，可用 Playwright 连接截图 / DOM 快照 / 执行 JS（不抢焦点），详见 [AGENTS.md「前端调试」](AGENTS.md)。注意 runtime 源码不热重载（tsx 非 watch），改 runtime 后需重启 `pnpm dev`；renderer 走 vite HMR 自动生效。

### 环境变量

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `XYZ_MOCK` | 设为 `1` 跳过 runtime 子进程启动，使用 Mock 数据 | — |
| `VITE_MOCK` | 设为 `true` 在 ws-client 层拦截所有 WS 消息 | — |
| `XYZ_AGENT_DATA_DIR` | 自定义数据目录（dev 模式默认 `~/.xyz-agent-dev`，与 pi 的 `~/.pi/agent/` 完全隔离） | `~/.xyz-agent` |

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 42 |
| 前端框架 | Vue 3.5 + TypeScript 5.8 |
| 状态管理 | Pinia 3 |
| 构建工具 | Vite 8 (renderer) + Vite lib mode (main/preload) |
| UI 组件 | xyz-ui（内部组件库）+ reka-ui |
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
│   ├── shared/               # 前后端共享类型
│   ├── ui/                   # xyz-ui 组件库
│   ├── core/                 # 前端核心层（coordination / domain / extension-host / foundation）
│   ├── dom-core/             # composer DOM 层
│   ├── mobile-renderer/      # 移动端渲染入口
│   ├── plugin-sdk/           # 插件开发 SDK（类型 + mock）
│   ├── extension-protocol/   # Extension GUI 渲染协议（TUI/GUI 双模类型）
│   └── create-xyz-plugin/    # 插件项目脚手架
├── extensions/               # 17 个 @zhushanwen/pi-* pi 扩展源码 + shared/ 共享库
├── e2e/                      # Playwright E2E spec + 视觉基线（visual-baselines）
├── scripts/                  # 构建 / 验证 / 发布脚本（preflight / postbuild / verify-* / bundle-extensions）
├── resources/                # pi binary + 内置 statusline 插件
├── docs/                     # 文档（架构 / 设计 SSOT / 扩展指南 / 测试 / ADR / 排查）
└── .agents/                  # 项目级 agent / skill（merge / review 等）
```

## 发布

两条独立发布管线，通过 tag 前缀解耦：

| 管线 | 产物 | 触发 tag | Workflow |
|------|------|----------|----------|
| Electron 打包 | DMG / EXE / AppImage / manifest | `v*` | `release.yml` |
| npm 包发布 | `@zhushanwen/pi-*` + `@xyz-agent/extension-protocol` | `npm-*` | `release-npm.yml` |

## 文档索引

| 文档 | 内容 |
|------|------|
| [AGENTS.md](AGENTS.md) | 开发约定、关键规则、调试与发布纪律 |
| [docs/PRODUCT.md](docs/PRODUCT.md) / [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 产品定位 / 架构总览 |
| [docs/STANDARDS.md](docs/STANDARDS.md) | 编码规范与架构标准 |
| [docs/page-design/](docs/page-design/) | 设计 SSOT（`v6-tokens.css` 太极纯灰原子值 + `v6-master-spec.md` 范式） |
| [docs/extensions/](docs/extensions/) | pi 扩展开发全套指南 |
| [docs/architecture/feature-map.md](docs/architecture/feature-map.md) | 功能规划与阶段现状 |
| [docs/testing/](docs/testing/) + [docs/TEST-STRATEGY.md](docs/TEST-STRATEGY.md) | 测试策略与分功能测试手册 |
| [docs/adr/](docs/adr/) | 架构决策记录 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 问题排查指南 |

## License

Private
