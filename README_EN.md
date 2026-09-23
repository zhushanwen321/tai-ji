<p align="center"><img src="docs/assets/logo/assets/qianwen/logo-square.png" width="96" alt="TaiJi logo" /></p>

<h1 align="center">TaiJi</h1>

<p align="center"><strong>An AI Agent desktop workbench for long-running, multi-task collaboration</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README_EN.md">English</a> | <a href="https://github.com/zhushanwen321/tai-ji/releases">Download</a>
</p>

TaiJi is an AI Agent desktop workbench (macOS / Windows / Linux) that puts multiple AI sessions in a single window: run several tasks side by side, watch the AI think, edit files, and run commands as it happens, and fork a session to retry whenever a reply goes the wrong way. Built on the [pi](https://github.com/badlogic/pi-mono) agent kernel, with 18 extensions bundled and ready out of the box.

<p align="center">
  <img src="docs/assets/screenshot/screenshot.png" alt="TaiJi main window: multi-session sidebar and live agent conversation stream with thinking, tool calls, and file edits" width="900" />
</p>

> For development conventions, key rules, and debugging discipline, see [AGENTS.md](AGENTS.md).

---

## Quick Start

Current latest version: **v0.10.1** ([view all releases](https://github.com/zhushanwen321/tai-ji/releases)). After installation, the app automatically checks for new versions and offers a one-click upgrade.

<!-- INSTALL:BEGIN -->
<!-- Version numbers inside this block are replaced automatically by .agents/skills/merge/scripts/update-readme-install.mjs after each official release; version numbers outside the block are left untouched. -->

<details>
<summary><b>🇨🇳 Mainland China download (GitCode mirror, ~15 MB/s)</b></summary>

Mirror repository: [gitcode.com/qq_18433817/tai-ji](https://gitcode.com/qq_18433817/tai-ji)

**macOS (Apple Silicon)**
```bash
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.3/TaiJi-0.10.3-mac-arm64.dmg -o /tmp/TaiJi.dmg && open /tmp/TaiJi.dmg
```

**Linux**
```bash
curl -L https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.3/TaiJi-0.10.3-x86_64.AppImage -o ~/TaiJi.AppImage && chmod +x ~/TaiJi.AppImage && ~/TaiJi.AppImage
```

**Windows (PowerShell)**
```powershell
Invoke-WebRequest -Uri "https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.10.3/TaiJi-0.10.3-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

</details>

<details>
<summary><b>🌍 International download (GitHub)</b></summary>

Repository: [github.com/zhushanwen321/tai-ji](https://github.com/zhushanwen321/tai-ji)

**macOS (Apple Silicon)**
```bash
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.3/TaiJi-0.10.3-mac-arm64.dmg -o /tmp/TaiJi.dmg && open /tmp/TaiJi.dmg
```

**Linux**
```bash
curl -L https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.3/TaiJi-0.10.3-x86_64.AppImage -o ~/TaiJi.AppImage && chmod +x ~/TaiJi.AppImage && ~/TaiJi.AppImage
```

**Windows (PowerShell)**
```powershell
Invoke-WebRequest -Uri "https://github.com/zhushanwen321/tai-ji/releases/download/v0.10.3/TaiJi-0.10.3-setup-x64.exe" -OutFile "$env:TEMP\TaiJi-setup.exe" -UseBasicParsing; & "$env:TEMP\TaiJi-setup.exe"
```

</details>

<details>
<summary><b>❓ First launch issues?</b></summary>

- **macOS says "damaged" or "cannot verify developer"**: run `xattr -cr /Applications/TaiJi.app`
- **Linux AppImage won't start**: confirm `chmod +x` was run, or try `--no-sandbox`
- **Windows SmartScreen warning**: click "More info" → "Run anyway"

</details>

<!-- INSTALL:END -->

---

## Core Capabilities

### 🔄 Multi-session parallelism
Run multiple AI tasks at once. The sidebar shows live status for each session. Fork a new session from any reply, hand off context, or import an existing session at any time.

### 👁️ Fully visible execution
Thinking chains, tool calls, and file edits stream in as they happen. Each turn collapses into a one-line summary; click to expand the full process. The Trace view supports filtering by type and full-text search.

### 🤖 Subagents & Workflows
Dispatch independent tasks to subagents running in parallel, or compose multi-step workflows with chain/parallel templates. The task tray aggregates progress in real time; each subtask runs under a budget and turn limit.

### 🛠️ Workbench integration
Sidebar file tree (smooth on large directories + git badges), drawer terminal (per-session state), Git/worktree management, and a built-in browser pane.

### 🧩 21 built-in extensions
Agent capabilities are implemented through the pi extension mechanism, covering permissions, scheduled tasks, context compaction, structured output, and more. 16 are usable standalone outside taiji. See the [extension development guide](docs/extensions/development-guide.md).

---

<details>
<summary><b>📖 Full feature list (click to expand)</b></summary>

### Agent execution
- **Parallel subagents**: the task tray above the input box collects running subtasks; open one to read its full conversation and output in the drawer.
- **Workflow orchestration**: compose subagents into stateful workflows with chain and parallel templates. Interrupted runs resume from where they stopped.
- **Todo & goal**: the agent breaks work into a todo list and completes items one by one. Long-running goals run in goal mode with acceptance criteria and a budget.
- **Scheduled tasks**: cron or interval tasks that wake a session automatically at the scheduled time. Tasks can be paused, deleted, or triggered once manually.
- **Context management**: the agent compacts its own context when a session grows long and warns you as thresholds approach.
- **Session operations**: ⌘/Ctrl+G forks, ⌘/Ctrl+J hands off, ⌘/Ctrl+I imports. The input box supports `/` commands, `#` session refs, `$` file refs, and `@` subagent spawning.

### Watching the execution
- **Live conversation**: thinking, tool calls, and file edits stream in; each turn collapses into a one-line summary.
- **Trace view**: a ledger of every execution entry, filterable by type and searchable in full text. Context-only mode shows where compaction happened.
- **Status strips**: todo and goal progress stays pinned inside the conversation.
- **Structured prompts**: when the agent needs a decision it opens a form with multiple questions, options, and free-form input.
- **Background tasks**: long-running commands can move to the background and notify you on completion.

### Workbench
- **File tree**: sidebar file panel that stays smooth on large directories, with git badges on modified files.
- **Terminal**: a terminal built into the drawer, one per session, each keeping its own state.
- **Git & worktrees**: check branches and file changes; create, switch, and clean up worktrees for parallel tasks.
- **Browser pane**: a browser built into the drawer to watch the agent work through web pages.

### Settings & control
- **System prompt**: replace the agent's system prompt entirely from settings. Snapshots are taken before each edit.
- **Tool permissions**: switch permission levels next to the input box, from read-only to full access.
- **Models**: a built-in catalog of common providers; paste an API key to start.
- **Settings center**: 12 sections covering provider, appearance, skills, agent, extensions, system prompt, terminal, presets, worktree, updates, system, and usage.
- **Auto update**: new versions are detected automatically; confirm and restart to upgrade.

</details>

---

## Extension Ecosystem

TaiJi's Agent capabilities are implemented through the pi extension mechanism; source lives in [`extensions/`](extensions/) (21 `@zhushanwen/pi-*` packages + the `shared/` library), 18 of which ship bundled with the app.

The following 16 extensions are usable standalone outside taiji (all published to npm, or loadable via `--extension`):

| Extension | Purpose |
|------|------|
| [`pi-subagent-workflow`](extensions/universal/subagent-workflow/README.md) | Unified subagent execution + multi-agent workflow orchestration |
| [`pi-goal`](extensions/universal/goal/README.md) | `/goal` persistent goal-driven autonomous loop |
| [`pi-todo`](extensions/universal/todo/README.md) | AI-driven todo list |
| [`pi-ask-user`](extensions/universal/ask-user/README.md) | Structured multi-question input |
| [`pi-permission`](extensions/universal/permission/README.md) | Four permission modes + three-layer decision pipeline |
| [`pi-scheduler`](extensions/universal/scheduler/README.md) | Scheduled task scheduling (cron / interval) |
| [`pi-session-reader`](extensions/universal/session-reader/README.md) | Read / query session history |
| [`pi-session-manager`](extensions/universal/session-manager/README.md) | Agent-managed child sessions |
| [`pi-rename-session`](extensions/universal/rename-session/README.md) | Auto-generate session titles |
| [`pi-smart-context`](extensions/universal/smart-context/README.md) | Agent-driven context compaction |
| [`pi-structured-output`](extensions/universal/structured-output/README.md) | Structured output (JSON Schema) |
| [`pi-pending-notifications`](extensions/universal/pending-notifications/README.md) | Cross-extension async operation management |
| [`pi-base-tool-enhance`](extensions/universal/base-tool-enhance/README.md) | Bash tool enhancement |
| [`pi-plan`](extensions/universal/plan/README.md) | Lightweight plan mode |
| [`pi-cache-probe`](extensions/universal/cache-probe/README.md) | Cache prefix fingerprint collection |
| [`pi-cw-tool`](extensions/universal/cw-tool/README.md) | cw 2.0 runner + read-only `cw_query` tool |

The remaining 5 (`pi-agent-ext` / `pi-msg-id-mapper` / `pi-plugin-bridge` / `pi-system-prompt` / `pi-system-prompt-trace`) are taiji-integration-specific. For extension development, see [docs/extensions/development-guide.md](docs/extensions/development-guide.md).

---

## Development Guide

**Prerequisites**: Node.js >= 22.19 (24 recommended, see `.nvmrc`), pnpm >= 10

```bash
pnpm install          # Install dependencies
pnpm dev              # Dev mode (Vite HMR + Electron main process)
pnpm build            # Production build (DMG/EXE/AppImage/manifest)
pnpm lint             # ESLint
pnpm --filter @taiji/frontend run typecheck  # Type check
pnpm test:e2e         # Playwright E2E (requires pnpm build:e2e first)
```

Debugging the dev app: once `pnpm dev` is running, Electron opens a CDP debugging port (`node apps/electron/scripts/dev-instance.mjs --print` to see the port); connect with Playwright for screenshots/DOM snapshots/JS execution. See [AGENTS.md](AGENTS.md).

### Environment Variables

| Variable | Purpose | Default |
|------|------|--------|
| `TAIJI_MOCK` | Set to `1` to skip runtime child process startup | — |
| `VITE_MOCK` | Set to `true` to intercept WS messages at the ws-client layer | — |
| `TAIJI_AGENT_DATA_DIR` | Custom data directory (dev mode pins `~/.taiji-dev`) | `~/.taiji` |

---

## Tech Stack

| Layer | Technology |
|----|------|
| Desktop framework | Electron 42 |
| Frontend | Vue 3.5 + TypeScript 5.8 + Pinia 3 + Vite 8 + Tailwind CSS v3 |
| UI | @taiji/ui + reka-ui + @lucide/vue + vue-i18n 10 |
| Backend communication | WebSocket + pi child-process RPC |
| Packaging | electron-builder 26 |

## Release

| Pipeline | Artifacts | Trigger tag | Workflow |
|------|------|----------|----------|
| Electron packaging | DMG / EXE / AppImage / manifest | `v*` | `release.yml` |
| npm package publishing | `@zhushanwen/pi-*` extensions + engine/SDK packages | `npm-*` | `release-npm.yml` |
| npm prerelease | dev dist-tag test versions | `dev-npm-*` | `release-npm-dev.yml` |

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
