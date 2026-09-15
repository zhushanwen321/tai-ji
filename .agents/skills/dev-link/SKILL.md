---
name: dev-link
description: >-
  Use when 在 @zhushanwen/pi-* extension 的本地源码（live edit）与已发布版本
  之间切换。触发词："pi link"、"原版 pi"、"link local"、"dev link"、
  "切换到本地"、"symlink extension"、"unlink extension"、"restore npm"、
  "extension link"。
  不用于 安装新包或管理非 pi extension。
---

# Dev Link

管理 `@zhushanwen/pi-*` extension 在**本地源码（live edit）**与**已发布版本**之间切换。两种模式，按测试目标选——选错模式是常见错误（link 了但不生效）。

## 两种模式（关键区别）

| 模式 | 测试目标 | 机制 | 安装脚本 | 卸载脚本 |
|---|---|---|---|---|
| **pi 模式** | **原版 pi**（当前 pi CLI session、`pi` 命令直接跑） | symlink 到 `~/.pi/agent/extensions/`（globalExtDir，loader 自动发现）+ `pi uninstall` 清 npm 版 / `pi install` 重装（pi 原生命令管 settings + node_modules） | `pi-link.sh` | `pi-unlink.sh` |
| **taiji 模式** | **taiji dev**（Electron app，runtime 注入给 pi 子进程） | `TAIJI_EXTENSION_PATHS` 环境变量（`.env.dev-extensions`） | `link-local.sh` | `link-npm.sh` |

**一句话区分**：pi 模式让**你现在跑的这个 pi** 加载本地源码；taiji 模式只影响 **taiji app 的 dev 模式**（它 spawn 的 pi 子进程），当前 pi session 不读这个 env。

## pi 模式（原版 pi）

```bash
bash .agents/skills/dev-link/pi-link.sh subagent-workflow      # symlink 本地 + pi uninstall 清 npm 版
bash .agents/skills/dev-link/pi-unlink.sh subagent-workflow    # rm symlink + pi install 重装 npm 版（需联网）
```

**机制**：symlink 本地源码 → `~/.pi/agent/extensions/pi-<short>`（globalExtDir，loader 第 2 步扫描，pi-statusline 同模式）。同时 `pi uninstall` 清 npm 版（settings 条目 + node_modules 包），避免 globalExtDir symlink 与 npm 包两源并存。**另把 extension 的 `skills/*/` 每个 skill symlink 到 `~/.pi/agent/skills/`**（绕过 pi globalExtDir 不读 `pi.skills` 的限制，让 skill 进 available_skills）。unlink 时 `pi install` 重装 npm 版 + 删 skill symlinks（从 npm registry 下载，需联网）。

**生效**：新建 pi session（当前 session 已加载旧版，不重扫）。**注意 pi list 不显示** globalExtDir symlink——pi list 只列 `packages` 配置的，不列自动发现源，但 loader 会加载（正常现象）。

## taiji 模式（Electron dev）

```bash
bash .agents/skills/dev-link/link-local.sh cw-tool             # 加到 TAIJI_EXTENSION_PATHS
bash .agents/skills/dev-link/link-npm.sh cw-tool               # 移除
# 启动带 link 的 dev：
set -a && source .env.dev-extensions && set +a && pnpm dev
```

**机制**：`TAIJI_EXTENSION_PATHS` 经 `ENV_WHITELIST_PREFIXES`（`TAIJI_` 前缀）注入 taiji runtime → pi 子进程。改源码后 taiji 内新建 session 即生效（无需重启 app）。

**生效**：taiji dev 模式 + 新建 session。**当前 pi CLI session 不受影响**（不读这个 env）。

## 何时用哪个

- 改了 extension 源码，想**在当前 pi 直接验证**（派 subagent、调工具、跑 `pi` 命令）→ **pi 模式**
- 改了 extension 源码，想**在 taiji app 里端到端验证**（UI、Electron 流程）→ **taiji 模式**
- 不确定 → **pi 模式**（更直接，当前环境就是 pi）

## 查看状态

```bash
bash .agents/skills/dev-link/link-list.sh
```

智能检测（动态推导路径，不写死项目路径）：
- **pi 模式**（`PI_EXT_DIR/pi-*` symlink）：显示所有 link + target，标注归属 `[当前worktree]` / `[其他worktree: name]` / `[外部]`；悬空 symlink（worktree 删了未清）标 `✗悬空`
- **taiji 模式**（`.env.dev-extensions`）：从当前 git root 动态查找，检测路径存在性 + worktree 归属
- **PI_CODING_AGENT_DIR 不一致警告**：link 位置与运行时 agentDir 不一致时提示（pi 可能不加载）
- 路径 source `dev-link-lib.sh` 复用 `PI_EXT_DIR`，与 link 建立位置一致

## 包名格式

三种都支持：短名 `subagent-workflow` / pi-前缀 `pi-subagent-workflow` / npm 全名 `@zhushanwen/pi-subagent-workflow`。多包一次：`pi-link.sh goal todo ask-user`。

## 共享映射（dev-link-lib.sh）

四个安装/卸载脚本统一 `source` `dev-link-lib.sh`，**短名 → 事实的映射从本项目 `extensions/` 目录扫描构建**，SSOT = 各包 `package.json`：

```
extensions/<short>/package.json
  ├─ name           → npm 包名（如 @zhushanwen/pi-subagent-workflow）   ← 事实，不按命名约定拼
  ├─ pi.extensions  → 是否真 pi extension（库包如 llm-shared 没有该字段）
  └─ 目录本身        → 源码目录（symlink target / TAIJI_EXTENSION_PATHS 条目）
```

新增/改名包自动进映射，脚本零改动。pi 实装版 loader 识别 extension **不读目录名**——扫 globalExtDir 一层，靠目录内 package.json 的 `pi.extensions` 字段或 index.ts/js 识别，所以 symlink 目录名 `pi-<short>` 只是约定。

## 约束

- `.env.dev-extensions` 不进 git（taiji 模式，`.gitignore` 的 `.env.*` 覆盖）；pi 模式改 `~/.pi/agent/settings.json`（pi 自己管理）
- **两模式都需新建 session 生效**（运行中的 session 不重扫 extension 源）
- **pi 模式 `pi-unlink` 用 `pi install` 重装 npm 版**（从 npm registry 下载，**需联网**）；失败时检查网络/proxy
- **merge/删 worktree 前清理**：两模式 link 都指向 worktree 的 `extensions/` 源码，worktree 删了 pi 加载报 ENOENT。pi 模式 `pi-unlink.sh <pkg>`、taiji 模式 `link-npm.sh <pkg>` 清理
- **llm-shared 是库包不是 extension**（`extensions/shared/llm-shared`，package.json 无 `pi.extensions`），pi-link / link-local 都会自动跳过
- **已废弃包（package.json 带 `deprecated` 字段，如 unified-hooks）仍是合法 link 目标，脚本只打 ⚠ 警告不阻断**：unified-hooks 已被 base-tool-enhance 取代，残留安装会与新包双重拦截 bash——验证完尽快 unlink 并卸载
- 多 worktree：脚本用 `git rev-parse --show-toplevel` 定位 `extensions/`，worktree 切换后路径变，需在该 worktree 重新 link

## 常见错误

| 错误 | 原因 |
|------|------|
| pi 模式 link 后 pi 仍用旧版 | 当前 session 已加载旧版，**需新 session**；或没 remove npm（两源冲突，pi resolver 不知选谁）|
| taiji 模式 link 后 taiji 看不到 extension | 没 `source .env.dev-extensions`；或没新建 session |
| pi 启动报 ENOENT extension path | worktree 删了但 link 未清理 → 对应模式 unlink |
| link → unlink 往返后 extension 消失 | 现版用 `pi install`/`pi uninstall`（替代旧 backup 机制），unlink 重装 npm 版（需联网，失败检查网络） |
| **link 了但不生效（最常见）** | **模式选错**：想测当前 pi 却用 taiji 模式（`TAIJI_EXTENSION_PATHS` 当前 pi 不读）；想测 taiji 却用 pi 模式。按"何时用哪个"选 |
| source 报 command not found | 路径含空格未加引号；或 `.env.dev-extensions` 格式错 |
