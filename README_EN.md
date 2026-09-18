<p align="center"><img src="docs/assets/logo/assets/qianwen/logo-square.png" width="96" alt="TaiJi logo" /></p>

<h1 align="center">TaiJi</h1>

<p align="center"><strong>An AI Agent desktop workbench for long-running, multi-task collaboration</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README_EN.md">English</a> | <a href="https://github.com/zhushanwen321/tai-ji/releases">Download</a>
</p>

TaiJi is an AI Agent desktop workbench (macOS / Windows / Linux) that puts multiple AI sessions in a single window: run several tasks in parallel, watch the AI think, edit files, and run commands in real time, and branch off to retry or fan out whenever you need. Built on the [pi](https://github.com/badlogic/pi-mono) agent kernel (npm package `@earendil-works/pi-coding-agent`), with 18 extensions bundled and ready out of the box.

<p align="center">
  <img src="docs/assets/screenshot/screenshot.png" alt="TaiJi main window — multi-session sidebar plus live agent conversation stream with thinking, tool calls, and file edits" width="900" />
</p>

> For development conventions, key rules, and debugging discipline, see [AGENTS.md](AGENTS.md).

## Installation

Current latest version: **v0.10.1** ([view all releases](https://github.com/zhushanwen321/tai-ji/releases)). After installation, the app automatically checks for new versions and offers a one-click upgrade.

<!-- INSTALL:BEGIN -->
<!-- Version numbers inside this block are replaced automatically by .agents/skills/merge/scripts/update-readme-install.mjs after each official release; version numbers outside the block are left untouched. -->

### Mainland China download (GitCode mirror, measured at ~15 MB/s over direct domestic connections)

Mirror repository: [gitcode.com/qq_18433817/tai-ji](https://gitcode.com/qq_18433817/tai-ji)

#### macOS (Apple Silicon)

```bash
# Download and open the DMG (or download it from the Releases page in a browser and install by double-clicking)
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg

# If the app is reported as "damaged" or "cannot verify the developer" on launch, run (usually unnecessary for curl downloads, needed for browser downloads):
# xattr -cr /Applications/TaiJi.app
```

#### Linux

```bash
# Download the AppImage, make it executable, and launch it
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

```powershell
# PowerShell (recommended; avoids the parameter conflicts caused by curl being an alias in PowerShell)
Invoke-WebRequest -Uri "https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"

# Command Prompt / cmd.exe (uses the system-bundled curl.exe, included by default since Windows 10 1803+):
# curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

### International download (GitHub)

Repository: [github.com/zhushanwen321/tai-ji](https://github.com/zhushanwen321/tai-ji)

#### macOS (Apple Silicon)

```bash
# Download and open the DMG
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-mac-arm64.dmg -o /tmp/TaiJi.dmg \
  && open /tmp/TaiJi.dmg

# If the app is reported as "damaged" or "cannot verify the developer" on launch, run (usually unnecessary for curl downloads, needed for browser downloads):
# xattr -cr /Applications/TaiJi.app
```

#### Linux

```bash
# Download the AppImage, make it executable, and launch it
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-x86_64.AppImage -o ~/TaiJi.AppImage \
  && chmod +x ~/TaiJi.AppImage \
  && ~/TaiJi.AppImage
```

#### Windows

```powershell
# PowerShell
Invoke-WebRequest -Uri "https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"

# Command Prompt / cmd.exe (uses the system-bundled curl.exe, included by default since Windows 10 1803+):
# curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.1/TaiJi-0.10.1-setup-x64.exe -o "%TEMP%\TaiJi-setup.exe" && "%TEMP%\TaiJi-setup.exe"
```

<!-- INSTALL:END -->

---

## What It Can Do

### Multiple sessions, one window

- **Session sidebar** — sessions grouped by project, with a green dot marking tasks that are still running; new session (⌘/Ctrl+N), search (⌘/Ctrl+K), and import (⌘/Ctrl+I) sit at the top of the sidebar
- **Branch & retry** — not happy with a reply? ⌘/Ctrl+G forks a new session from the agent's latest reply so you can try a different direction while the original stays intact; ⌘/Ctrl+J packages the current context and hands it off to a fresh session
- **Sidebar panels** — beyond sessions, switch to the file tree, subagent list, workflow status, and plugin panels right inside the sidebar
- **Global search** — one ⌘/Ctrl+K entry to search commands, project files, code symbols, and sessions

### An agent you can watch

- **Everything in real time** — thinking, tool calls, and file edits stream in as they happen; each working turn collapses into a one-line summary (duration / thinking rounds / tool calls) you can expand to replay the whole thing
- **Trace view** — flip from the conversation to a structured Trace and inspect exactly what the agent executed, entry by entry
- **Task & goal status strip** — the agent's todo list and set goals show live progress as a persistent status strip
- **Structured prompts** — when the agent needs a decision it presents a structured form (multiple questions, options, free-form input) instead of guessing back and forth in chat
- **Background tasks never drop** — long-running commands move to the background and notify you on completion, then processing continues automatically

### Files / Terminal / Git

- **File tree** — browse project files in the sidebar, smooth even on large repositories; modified files are marked right on the name
- **Built-in terminal** — expand a real terminal from the right side at any time; each session keeps its own state, ready when you switch back
- **Git panel** — current branch and file changes at a glance; create / switch / clean up worktrees so parallel tasks each get their own working directory without interference

### Models & control

- **Bring your own models** — a built-in provider catalog: paste an API key and go; switch model and thinking level right next to the input box
- **Live usage** — generation speed and remaining context shown inline while chatting; per-provider / per-model quotas available in settings
- **Tool modes** — switch the agent's tool permission level next to the input box, from read-only analysis to full tool access
- **Settings center** — full-screen overlay covering 12 menu domains: provider / appearance / skills / agent / extensions / system prompt / terminal / presets / worktree / updates / system / usage
- **Auto update** — periodic checks for new versions; after confirmation the app restarts to upgrade. Release Notes are bilingual (English / Chinese)

## pi Extensions

TaiJi's Agent capabilities are implemented through the pi extension mechanism; source lives in [`extensions/`](extensions/) (21 `@zhushanwen/pi-*` packages + the `shared/` library), 18 of which ship bundled with the app, ready out of the box. The following 16 extensions are self-sufficient and usable standalone outside taiji (all published to npm, or loadable via `--extension`):

| Extension | Purpose |
|------|------|
| [`pi-subagent-workflow`](extensions/universal/subagent-workflow/README.md) | Unified subagent execution + multi-agent workflow orchestration (stateful workflows such as parallel / chain) |
| [`pi-goal`](extensions/universal/goal/README.md) | `/goal` persistent goal-driven autonomous loop with evidence-based acceptance |
| [`pi-todo`](extensions/universal/todo/README.md) | AI-driven todo list (session persistence + `/todos`) |
| [`pi-ask-user`](extensions/universal/ask-user/README.md) | Structured multi-question input (split-pane preview + inline editing) |
| [`pi-permission`](extensions/universal/permission/README.md) | Four permission modes (yolo / auto / approve / strict) + three-layer decision pipeline (AST / rules / AI classifier) |
| [`pi-scheduler`](extensions/universal/scheduler/README.md) | Scheduled task scheduling (cron / interval, once / recurring) |
| [`pi-session-reader`](extensions/universal/session-reader/README.md) | Read / query session history (trees, family, execution tree, search, export) |
| [`pi-session-manager`](extensions/universal/session-manager/README.md) | Agent-managed child sessions (create / send / history / status / list / abort) |
| [`pi-rename-session`](extensions/universal/rename-session/README.md) | Auto-generate session titles after the first conversation round |
| [`pi-smart-context`](extensions/universal/smart-context/README.md) | Agent-driven context compaction (compact_context tool + dual-mode summary takeover + tiered reminders) |
| [`pi-structured-output`](extensions/universal/structured-output/README.md) | Structured output (JSON Schema + Ajv validation) |
| [`pi-pending-notifications`](extensions/universal/pending-notifications/README.md) | Cross-extension async operation registration / query (prevents message injection during long tasks) |
| [`pi-base-tool-enhance`](extensions/universal/base-tool-enhance/README.md) | Bash tool enhancement (foreground delegates to the pi official factory + background mode + tool error auditing) |
| [`pi-plan`](extensions/universal/plan/README.md) | Lightweight plan mode |
| [`pi-cache-probe`](extensions/universal/cache-probe/README.md) | Cache prefix fingerprint collection + attribution analysis |
| [`pi-cw-tool`](extensions/universal/cw-tool/README.md) | cw 2.0 runner hands-on guide + read-only `cw_query` query tool |

The remaining 5 (`pi-agent-ext` / `pi-msg-id-mapper` / `pi-plugin-bridge` / `pi-system-prompt` / `pi-system-prompt-trace`) are taiji-integration-specific and have no function outside the taiji host. The 18 bundled extensions = 13 of the 16 in the table above + these 5; `pi-plan` / `pi-cache-probe` / `pi-cw-tool` are not bundled — install via npm or load with `--extension`. For extension development, see [docs/extensions/development-guide.md](docs/extensions/development-guide.md).

## Architecture

<p align="center">
  <img src="docs/assets/architecture.drawio.png" alt="TaiJi architecture: Electron main process / preload bridge / runtime (Node.js child process) / renderer / pi CLI child process" width="820" />
</p>

Diagram source: [`docs/assets/architecture.drawio`](docs/assets/architecture.drawio) (the PNG embeds the editable source; reopen it in draw.io to edit).

Core modules:

| Module | Path | Responsibility |
|------|------|------|
| **Main process** | `apps/electron/main/` | BrowserWindow lifecycle, runtime spawn/stop, global shortcuts (supervisor / window / gateway orchestration subsystems) |
| **Preload** | `apps/electron/preload/` | `contextIsolation`-secured bridge exposing `window.electronAPI` |
| **Frontend** | `packages/renderer/` | Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + @taiji/ui (TaiJi pure-gray dark design system) |
| **Runtime** | `packages/runtime/` | WebSocket service with a three-layer architecture (transport/services/infra); communicates with Agents over the pi RPC protocol |
| **Shared types** | `packages/shared/` | TypeScript type definitions shared between frontend and runtime (pnpm workspace) |
| **pi CLI** | External dependency `@earendil-works/pi-coding-agent` | Agent execution core, spawned as a child process by the Runtime; communicates over RPC and loads the 18 bundled extensions |

The renderer process has two outbound channels: **WS** (→ Runtime, business/data) and **IPC** (→ Main, window/process/OS privileges). The renderer never calls `window.electronAPI` directly; all access goes through the [`lib/ipc.ts`](packages/renderer/src/lib/ipc.ts) facade.

---

## Quick Start (Development)

**Prerequisites**: Node.js >= 22.19 (24 recommended, see `.nvmrc`), pnpm >= 10

```bash
# Install dependencies (pnpm workspace installs apps/* + packages/* + extensions/* in one step)
pnpm install

# Dev mode (Vite HMR + Electron main process)
pnpm dev

# Production build (electron-builder; outputs DMG/EXE/AppImage/manifest)
pnpm build

# Type check
pnpm --filter @taiji/frontend run typecheck

# ESLint
pnpm run lint

# pi extensions under extensions/
pnpm extensions:typecheck
pnpm extensions:lint
pnpm extensions:test

# Playwright E2E
pnpm build:e2e && pnpm test:e2e
```

Debugging the dev app: once `pnpm dev` is running, Electron opens a CDP debugging port (stably derived from the worktree name; run `node apps/electron/scripts/dev-instance.mjs --print` to see this instance's port); connect with Playwright for screenshots / DOM snapshots / JS execution (without stealing focus) — see [AGENTS.md "Frontend Debugging"](AGENTS.md). Note that runtime source code is not hot-reloaded (tsx runs without watch), so restart `pnpm dev` after changing runtime code; renderer changes take effect automatically via vite HMR.

### Environment Variables

| Variable | Purpose | Default |
|------|------|--------|
| `TAIJI_MOCK` | Set to `1` to skip runtime child process startup and use mock data | — |
| `VITE_MOCK` | Set to `true` to intercept all WS messages at the ws-client layer | — |
| `TAIJI_AGENT_DATA_DIR` | Custom data directory, fully isolated from pi's `~/.pi/agent/` (dev mode pins `~/.taiji-dev` and ignores this variable) | `~/.taiji` |

## Tech Stack

| Layer | Technology |
|----|------|
| Desktop framework | Electron 42 |
| Frontend framework | Vue 3.5 + TypeScript 5.8 |
| State management | Pinia 3 |
| Build tooling | Vite 8 (renderer) + Vite lib mode (main/preload) |
| UI components | @taiji/ui (in-house component library) + reka-ui |
| Styling | Tailwind CSS v3 (TaiJi pure-gray tokens; scoped CSS component styles and `@apply` are forbidden) |
| Icons | @lucide/vue |
| Internationalization | vue-i18n 10 |
| Backend communication | ws (WebSocket) + pi child-process RPC |
| Packaging | electron-builder 26 |

## Project Structure

```
├── apps/electron/            # Electron shell
│   ├── main/                 # Main process (supervisor / window / gateway / shortcuts)
│   └── preload/              # Secure bridge (electronAPI)
├── packages/                 # pnpm workspace packages
│   ├── renderer/             # Vue frontend (components / composables / stores / lib)
│   ├── runtime/              # Node.js runtime (transport / services / infra + plugins)
│   ├── core/                 # Frontend core layer (coordination / domain / extension-host / foundation, etc.)
│   ├── ui/                   # taiji ui component library (@taiji/ui)
│   ├── shared/               # Shared frontend-runtime types
│   ├── dom-core/             # composer DOM layer
│   ├── mobile-renderer/      # Mobile renderer entry
│   ├── plugin-sdk/           # Plugin development SDK (types + mock)
│   ├── extension-protocol/   # Extension GUI rendering protocol (TUI/GUI dual-mode types)
│   ├── subagent-core/        # subagent execution core (engine-agnostic orchestration / budget / channel layer)
│   ├── subagent-engine-sdk/  # Engine protocol SDK (NDJSON stdio contract + engine primitives)
│   ├── pi-subagent-cli/      # pi engine CLI (engine-protocol v1)
│   ├── zcode-subagent-cli/   # zcode engine CLI (app-server RPC)
│   ├── pi-rpc/               # Shared pi child-process RPC layer
│   ├── session-delivery/     # Session message delivery kernel (queue / batch / dedup / gated flush)
│   └── create-taiji-plugin/  # Plugin project scaffolding
├── extensions/               # 21 @zhushanwen/pi-* pi extension sources + shared/ library
├── e2e/                      # Playwright E2E specs + visual baselines
├── scripts/                  # Build / verification / release scripts (preflight / postbuild / verify-* / bundle-extensions)
├── resources/                # Built-in plugins (statusline)
├── docs/                     # Docs (architecture / design SSOT / extension guides / testing / ADR / troubleshooting)
└── .agents/                  # Project-level agents / skills (merge / pr-cr-fix, etc.)
```

## Release

Two independent release pipelines, decoupled by tag prefix:

| Pipeline | Artifacts | Trigger tag | Workflow |
|------|------|----------|----------|
| Electron packaging | DMG / EXE / AppImage / manifest | `v*` | `release.yml` |
| npm package publishing | `@zhushanwen/pi-*` extensions + engine / SDK packages (`pi-rpc` / `subagent-core` / `subagent-engine-sdk` / `pi-subagent-cli` / `zcode-subagent-cli` / `session-delivery` / `extension-protocol`) | `npm-*` | `release-npm.yml` |
| npm prerelease | dev dist-tag test versions | `dev-npm-*` branch / local `npm-prerelease.sh` | `release-npm-dev.yml` |

## Documentation Index

| Document | Content |
|------|------|
| [AGENTS.md](AGENTS.md) | Development conventions, key rules, debugging and release discipline |
| [docs/PRODUCT.md](docs/PRODUCT.md) / [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Product positioning / architecture overview |
| [docs/STANDARDS.md](docs/STANDARDS.md) | Coding standards and architecture standards |
| [docs/DESIGN.md](docs/DESIGN.md) | Visual design authority (TaiJi pure-gray tokens and paradigm) |
| [docs/extensions/](docs/extensions/) | Full set of pi extension development guides |
| [docs/architecture/feature-map.md](docs/architecture/feature-map.md) | Feature planning and phase status |
| [docs/testing/](docs/testing/) + [docs/TEST-STRATEGY.md](docs/TEST-STRATEGY.md) | Test strategy and per-feature test manuals |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Troubleshooting guide |

## License

Private
