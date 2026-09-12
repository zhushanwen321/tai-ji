<p align="center"><img src="docs/page-design/logo/assets/qianwen/logo.png" width="96" alt="TaiJi logo" /></p>

# TaiJi

[简体中文](README.md) | [English](README_EN.md)

An AI Agent desktop workbench (macOS / Windows / Linux) built on an Electron + Vue 3 + Node.js Runtime architecture.

It communicates with all kinds of AI Agents over the child-process RPC protocol of [pi](https://github.com/badlogic/pi-mono) (npm package `@earendil-works/pi-coding-agent`), providing multi-session management, dual-Panel split view, subagent/workflow orchestration, goal-driven autonomous loops, scheduled tasks, and more — designed for long-running, multi-task Agent collaboration. 13 Agent extensions ship bundled with the app, ready out of the box.

> For development conventions, key rules, and debugging discipline, see [AGENTS.md](AGENTS.md).

## Installation

Current latest version: **v0.9.13** ([view all releases](https://github.com/zhushanwen321/xyz-agent/releases)). After installation, the app automatically checks for new versions and offers a one-click upgrade.

<!-- INSTALL:BEGIN -->
<!-- Version numbers inside this block are replaced automatically by .agents/skills/merge/scripts/update-readme-install.mjs after each official release; version numbers outside the block are left untouched. -->

### Mainland China download (GitCode mirror, measured at ~15 MB/s over direct domestic connections)

Mirror repository: [gitcode.com/qq_18433817/xyz-agent](https://gitcode.com/qq_18433817/xyz-agent)

#### macOS (Apple Silicon)

```bash
curl -L https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg
```

You can also download the dmg from [GitCode Releases](https://gitcode.com/qq_18433817/xyz-agent/releases) in a browser and install it by double-clicking.

#### Linux

```bash
curl -L https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

PowerShell (uses Invoke-WebRequest to avoid the parameter conflicts caused by curl being an alias in PowerShell):

```powershell
Invoke-WebRequest -Uri "https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

Command Prompt (cmd.exe; requires the system-bundled curl.exe, included by default since Windows 10 1803+):

```cmd
curl -L https://gitcode.com/qq_18433817/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

### International download (GitHub)

Repository: [github.com/zhushanwen321/xyz-agent](https://github.com/zhushanwen321/xyz-agent)

#### macOS (Apple Silicon)

```bash
curl -L https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg
```

#### Linux

```bash
curl -L https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

PowerShell:

```powershell
Invoke-WebRequest -Uri "https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

Command Prompt (cmd.exe):

```cmd
curl -L https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.18/TaiJi-0.9.18-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

> On macOS, if the app is reported as "damaged" or "cannot verify the developer" on launch, run (usually unnecessary for curl downloads; needed for browser downloads):
>
> ```bash
> xattr -cr /Applications/太极.app
> ```

<!-- INSTALL:END -->

---

## Core Capabilities

### Sessions & Workbench

- **Multi-session management** — session list in the sidebar, ⌘/Ctrl+N to create; session tree branching (fork / clone) is a native pi capability, letting you branch from any assistant message (⌘/Ctrl+G fork, ⌘/Ctrl+⇧+G fork mode, ⌘/Ctrl+J handoff)
- **Dual-Panel split view** — a single Panel is the default state; opening a second session splits the view. Focus mode is supported to concentrate on the current session
- **Overview** — a standalone bird's-eye view across sessions (card grid + filtering + background agent aggregation)
- **Global efficiency entry points** — ⌘/Ctrl+K global search, ⌘/Ctrl+B collapse sidebar, ⌘/Ctrl+, settings, ⌘/Ctrl+[ ] session back/forward, ⌘/Ctrl+⇧+P preset switching; all shortcuts can be remapped in settings

### Conversation Flow

- **Streaming rendering** — incremental markdown rendering, turn collapsing, thinking block expand/collapse
- **GUI widget panels** — todo / goal and similar state render as dedicated widget panels with a unified meta header row (title, status dot, N/M progress, mini progress bar); Agent-side state syncs to the presentation layer over a single channel
- **Structured interaction** — ask-user multi-question structured input (split-pane preview + inline editing), structured output validated by JSON Schema

### Files / Terminal / Git

- **File tree** — virtualized rendering (flattened visible rows) that stays smooth on large repositories; file status badges and line counts
- **Terminal** — command-style buffer rendering, versioned replay, session-level persistent partitions
- **Git** — branch and change status display; worktree create/switch/cleanup

### Built-in Extensions (13, bundled with the app)

| Extension | Purpose |
|------|------|
| `pi-permission` | Four permission modes (yolo / auto / approve / strict) + a three-tier approval pipeline |
| `pi-subagent-workflow` | Unified subagent execution + multi-agent workflow orchestration (stateful workflows such as parallel / chain) |
| `pi-goal` | `/goal` persistent goal-driven autonomous loop with evidence-based acceptance |
| `pi-todo` | AI-driven todo list (session persistence + `/todos`) |
| `pi-ask-user` | Structured multi-question input tool |
| `pi-structured-output` | Structured output (JSON Schema + Ajv validation) |
| `pi-scheduler` | Scheduled task scheduling (cron / interval, once / recurring) |
| `pi-session-reader` | Read / query session history (trees, family, execution tree, search, export) |
| `pi-rename-session` | Auto-generate session titles after the first conversation round |
| `pi-pending-notifications` | Cross-extension async operation registration / query (prevents message injection during long tasks) |
| `pi-agent-ext` | Internal commands (host-triggered reload `/__xyz_reload__` + on-demand system prompt fetch for the Trace view `/__xyz_get_system_prompt__`) |
| `pi-system-prompt` | System prompt injection (AGENTS.md / settings append sections) |
| `pi-msg-id-mapper` | client UUID ↔ user entry ID mapping |
| `pi-system-prompt-trace` | Writes an xyz:system-prompt trace entry whenever the system prompt is established or changes |

Of these, 6 infrastructure-grade ones (`pi-pending-notifications` / `pi-session-reader` / `pi-structured-output` / `pi-agent-ext` / `pi-system-prompt` / `pi-msg-id-mapper`) are always resident and cannot be disabled; the other 8 can be disabled in settings. In addition, 3 packages are published to npm and can be installed as needed: `pi-cw-tool` (cw 2.0 runner hands-on guide + the read-only cw_query query tool), `pi-model-switch` (model recommendation switching), and `pi-plan` (lightweight plan mode). `pi-unified-hooks` is deprecated (marked deprecated on npm); its capabilities have been superseded by `pi-base-tool-enhance` (bash background mode + configurable timeout + tool error auditing).

### Models & Settings

- **Provider management** — multi-provider configuration, built-in provider catalog, API key management
- **Quota display** — usage quota queries per provider / model
- **Settings center** — full-screen overlay covering 11 menu domains, including Provider / extensions / skills / terminal / presets / worktree / system updates
- **Auto update** — periodic checks for new versions; after confirmation the app restarts to upgrade. Release Notes are bilingual (English / Chinese)

## Architecture

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

Five core modules:

| Module | Path | Responsibility |
|------|------|------|
| **Main process** | `apps/electron/main/` | BrowserWindow lifecycle, runtime spawn/stop, global shortcuts (supervisor / window / gateway orchestration subsystems) |
| **Preload** | `apps/electron/preload/` | `contextIsolation`-secured bridge exposing `window.electronAPI` |
| **Frontend** | `packages/renderer/` | Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui (TaiJi pure-gray dark design system) |
| **Runtime** | `packages/runtime/` | WebSocket service with a three-layer architecture (transport/services/infra); communicates with Agents over the pi RPC protocol |
| **Shared types** | `packages/shared/` | TypeScript type definitions shared between frontend and runtime (pnpm workspace) |

The renderer process has two outbound channels: **WS** (→ Runtime, business/data) and **IPC** (→ Main, window/process/OS privileges). The renderer never calls `window.electronAPI` directly; all access goes through the [`lib/ipc.ts`](packages/renderer/src/lib/ipc.ts) facade.

### Why Electron

1. **Rendering stability** — Chromium's CSS/layout output is identical to Chrome DevTools, with none of the WebView2/WebKit platform differences
2. **Visual sharpness** — font rendering, subpixel anti-aliasing, and GPU compositing behavior are fully controllable, giving consistent cross-platform results
3. **Ecosystem maturity** — a complete toolchain: electron-builder, DevTools extensions, crash reporting, and more
4. **Native Node.js capabilities** — the main process uses Node APIs directly (child_process, fs, net); no Rust backend process or FFI needed

### Dual Extension Mechanisms

TaiJi has two independent extension mechanisms:

**pi Extension** — runs inside the pi child process, loaded via the `--extension` argument; extends Agent capabilities (tools, commands, event hooks). Source lives in this repo under `extensions/` (17 `@zhushanwen/pi-*` packages + the `shared/` library), 13 of which are esbuild-bundled into the app. Development docs:

- [Extension Development Guide](docs/extensions/development-guide.md) — single source of truth: structure, lifecycle, publishing
- [Extension Conventions](docs/extensions/extension-conventions.md) — binding conventions you must follow
- [Local Development & Debugging](docs/extensions/local-dev-guide.md) — `XYZ_EXTENSION_PATHS` live link, log inspection
- [GUI Protocol Integration](docs/extensions/gui-protocol-guide.md) — retrofitting TUI extensions for TUI/GUI dual mode
- [Glossary](docs/extensions/glossary.md) / [Agent Authoring Guide](docs/extensions/agent-authoring-guide.md)

**Plugin System** — a plugin sandbox running on the xyz-agent Runtime side; extends UI and host capabilities (tools, hooks, slash commands, status bar items, message decorations, settings forms). Two-level isolation for trusted and sandbox plugins (Worker Thread / separate forked child process) — a single plugin crash does not affect other plugins or the main process. Develop against [`packages/plugin-sdk`](packages/plugin-sdk/) (types + mock), scaffolded by `create-xyz-plugin`.

## Quick Start (Development)

**Prerequisites**: Node.js >= 22.19 (24 recommended, see `.nvmrc`), pnpm >= 10

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

Debugging the dev app: once `pnpm dev` is running, Electron opens `--remote-debugging-port=9222`; connect with Playwright for screenshots / DOM snapshots / JS execution (without stealing focus) — see [AGENTS.md "Frontend Debugging"](AGENTS.md). Note that runtime source code is not hot-reloaded (tsx runs without watch), so restart `pnpm dev` after changing runtime code; renderer changes take effect automatically via vite HMR.

### Environment Variables

| Variable | Purpose | Default |
|------|------|--------|
| `XYZ_MOCK` | Set to `1` to skip runtime child process startup and use mock data | — |
| `VITE_MOCK` | Set to `true` to intercept all WS messages at the ws-client layer | — |
| `XYZ_AGENT_DATA_DIR` | Custom data directory (dev mode defaults to `~/.xyz-agent-dev`, fully isolated from pi's `~/.pi/agent/`) | `~/.xyz-agent` |

## Tech Stack

| Layer | Technology |
|----|------|
| Desktop framework | Electron 42 |
| Frontend framework | Vue 3.5 + TypeScript 5.8 |
| State management | Pinia 3 |
| Build tooling | Vite 8 (renderer) + Vite lib mode (main/preload) |
| UI components | xyz-ui (in-house component library) + reka-ui |
| Styling | Tailwind CSS v3 (TaiJi pure-gray tokens; scoped CSS component styles and `@apply` are forbidden) |
| Icons | @lucide/vue |
| Internationalization | vue-i18n 10 |
| Backend communication | ws (WebSocket) + pi child-process RPC |
| Packaging | electron-builder 26 |

## Project Structure

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

## Release

Two independent release pipelines, decoupled by tag prefix:

| Pipeline | Artifacts | Trigger tag | Workflow |
|------|------|----------|----------|
| Electron packaging | DMG / EXE / AppImage / manifest | `v*` | `release.yml` |
| npm package publishing | `@zhushanwen/pi-*` + `@xyz-agent/extension-protocol` | `npm-*` | `release-npm.yml` |

## Documentation Index

| Document | Content |
|------|------|
| [AGENTS.md](AGENTS.md) | Development conventions, key rules, debugging and release discipline |
| [PRODUCT.md](PRODUCT.md) / [ARCHITECTURE.md](ARCHITECTURE.md) | Product positioning / architecture overview |
| [docs/standards.md](docs/standards.md) | Coding standards and architecture standards |
| [docs/page-design/](docs/page-design/) | Design SSOT (`v6-tokens.css` TaiJi pure-gray atomic values + `v6-master-spec.md` paradigm) |
| [docs/extensions/](docs/extensions/) | Full set of pi extension development guides |
| [docs/feature-map/](docs/feature-map/) | Feature planning and phase status |
| [docs/testing/](docs/testing/) + [TEST-STRATEGY.md](TEST-STRATEGY.md) | Test strategy and per-feature test manuals |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Troubleshooting guide |

## License

Private
