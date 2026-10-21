# evidence · 取证原语（树 / 日志 / grep / 截图）

本文件覆盖四个 capability id：

- `evidence.tree`（P0，所有 scenario 的收尾必用）
- `evidence.logs`（P0）
- `evidence.grep`（P0）
- `evidence.screenshot`（P0）

> **定位**：这四个不是「功能」，而是**证明手段**。每条断言都必须挂到至少一条通道
> （A=UI / B=协议 / C=进程·磁盘），C 通道的全部实现都落在本文件描述的路径公式上。
> 本文件的价值 = **路径公式有出处**（可被 grep 复核），而不是「记住一堆目录」。
>
> **通道声明**：本文件四个 id 的断言**全部是单通道 C**（树/日志/grep/截图文件）。
> 按 API-CONTRACT §0「断言跨 ≥2 通道」的纪律，它们**单独成立时属 `weak-anchor`**——
> 必须与 A（用户可见终态）或 B（协议真值）组合，才能构成一条完整断言。

---

## 0. 路径公式总表（先记这张，再谈四个 id）

`<dataDir>` = `getDataDir()`：读 `TAIJI_AGENT_DATA_DIR`，**缺省 `~/.taiji-dev`**
（非打包进程；打包 main 固定 `~/.taiji`）。出处
`packages/shared/src/paths.ts` 的 `getDataDir` + `DATA_DIR_ROOT_NAMES`。
**新代码/脚本禁止硬编码 `~/.taiji*`**——一律 `getDataDir()` 或从 doctor 的 `--json` 取。

| 用途 | 公式 | 出处（grep 锚点） |
|------|------|-------------------|
| 数据根 | `<dataDir>` | `paths.ts` `getDataDir()`；`apps/electron/main/supervisor/port-file.ts` 注释同款 |
| pi 宿主目录 | `<dataDir>/agent` | `paths.ts` `getPiAgentDir()` |
| pi 会话本体 | `<dataDir>/agent/sessions/<encodeCwd>/<ISO>_<uuid>.jsonl` | `paths.ts` `getPiSessionsDir()` + `encodeCwd` |
| **会话存储树** | `<dataDir>/ext-sessions/<sessionId>/` | `paths.ts` `getSessionStoreDir()`；**布局决策 = ADR-0151**（不是 ADR-0141——见报告） |
| 树·附件 | `…/<sid>/attachments/` | `getAttachmentsDir()` |
| 树·产物 | `…/<sid>/artifacts/` | `getSessionArtifactsDir()` |
| 树·图片缓存 | `…/<sid>/image-cache/` | `getImageCacheDir()` |
| 树·插件 KV | `…/<sid>/plugin-data.json` | `getSessionPluginDataPath()` |
| 树·后台任务 | `…/<sid>/background-tasks/` | `getSessionBackgroundTasksDir()` |
| 树·会话导出 | `…/<sid>/session-view.md` | `getSessionViewPath()` |
| 树·btw 线 | `…/<mainSid>/btw/` | `getSessionBtwDir()` |
| 树·画布 | `…/<sid>/canvases/<canvasId>/` | `getSessionCanvasesDir()` |
| 树·会话日志 | `…/<sid>/logs/pi-<date>.jsonl`（size 轮转 → `.1.gz`） | `getSessionLogsDir()` + `infra/logger.ts` 文件头 |
| 树·subagent | `…/<sid>/subagents/{sessions,records,model-switch}/` | `getSessionSubagent*Dir()` |
| 树·workflow | `…/<sid>/workflow/runs/` | `getSessionWorkflowRunsDir()` |
| 全局日志 | `<dataDir>/logs/runtime-<date>.log` / `main-<date>.log` / `plugin-crash-*.log` / `signal-forensics-*` | `infra/logger.ts`；`apps/electron/main/logs/main-logger.ts`（`main-<date>.log`） |
| 扩展开关态 | `<dataDir>/agent/disabled-packages.json` | `infra/pi/pi-extension-settings.ts` |
| pi 设置/模型 | `<dataDir>/agent/settings.json` / `models.json` / `auth.json` / `mcp.json` | `pi-paths.ts`；`models.json` 同目录 |
| taiji 私有配置 | `<dataDir>/config.json`、`<dataDir>/system-prompt.json`、`<dataDir>/pi-presets.json` | `services/system-prompt-config-helper.ts`、`services/preset-service.ts`（`getConfigDir()` = `<dataDir>`） |
| 扩展配置子目录 | `<dataDir>/agent/config/<pkg>-ext-config.json`（permission / network-proxy / providers 等） | `extensions/universal/permission/src/config.ts`、`services/network-proxy-config.ts`、`infra/pi/pi-paths.ts` |
| pi spawn 清单 | `<dataDir>/run/pi-spawn-markers.json` | `infra/pi/spawn-markers.ts` |
| 运行时端口 / token | `<dataDir>/runtime.port` / `<dataDir>/runtime-token` | `apps/electron/main/supervisor/port-file.ts`、`packages/runtime/src/index.ts` |
| 网络代理统计 | `<dataDir>/agent/network-proxy-stats.jsonl` | `services/network-proxy-config.ts` |
| 扩展日志 | `<dataDir>/agent/logs/<extName>-<date>.log` | `extensions/shared/extension-logger/src/index.ts` `fileLog()` |

**不入树（别找）**：pi 会话 jsonl 本体与紧贴 sidecar（`agent/sessions/`）、无 sessionId 的全局日志
（`logs/` 根）、`engines/`、`gen-stats/`、`agent/subagents/` 根下引擎级三件、extension 数据
（存 jsonl custom entry）。出处：AGENTS.md「数据目录布局：session 存储树」+ ADR-0151 豁免清单。

**遍历纪律**（写扫描脚本时）：树内一级目录名不是合法 sessionId 形态的，一律跳过
（孤儿扫描/前缀枚举/保留期清理同款）。`isPiSessionId` 同域校验：首尾字母数字、
中间 `[A-Za-z0-9._-]`、禁 `:`——`btw:<sid>` 这类虚拟 id 必须被拒。

---

## evidence.tree · 会话树取证

- **通道**：C（纯磁盘）
- **前置**：`requires: none`；输入 = `<dataDir>` + `sessionId`
- **用于**：每个 scenario 的收尾；`render.html-preview` / `render.image` / `session.delete` 强依赖

### 入口（用户 POV / 协议 / 副作用点）

- 无 UI 入口：这是**验收侧**读盘原语。
- 输入来源：`session.create` reply / `session.list` 的 `id` / UI 的 `panel-session-file`（文件名非 id）。
  **以协议返回的 sessionId 为准**，不要从文件名反推。
- 输出：树快照（目录层级 + 文件大小 + mtime）+ 关键文件内容摘要。

### 驱动

```bash
# 1) 树快照（不含内容）
find <dataDir>/ext-sessions/<sid> -maxdepth 2 -print | sort
# 2) 体积与 mtime（按域汇总）
du -sh <dataDir>/ext-sessions/<sid>/* 2>/dev/null
# 3) 关键文件存在性断言（按 capability 需要挑）
test -f <dataDir>/ext-sessions/<sid>/logs/pi-$(date +%F).jsonl && echo pi-log-ok
test -d <dataDir>/ext-sessions/<sid>/artifacts && echo artifacts-ok
```

> 脚本里用 `node:fs` 的 `readdir` 递归 + 白名单（只读，不写），不要 `rm` 任何树内路径。
> 删除会话是**产品动作**（UI 删除 → 整树进废纸篓），不是验收脚本的动作。

### 断言（期望终态 / 失败信号）

| # | 断言 | 能证明什么 | 失败信号 |
|---|------|------------|----------|
| 1 | 树根存在且一级目录名 = 合法 sessionId | 会话真的建立了（不是只有 UI 壳） | 树不存在 = pi 未 flush 或 session.create 走的是别的 dataDir |
| 2 | 目标域目录存在（`logs/` / `artifacts/` / `image-cache/` / `canvases/` …） | 该功能真的把产物落在会话树（ADR-0151 合规） | 产物落在项目目录/全局 logs = 落点违规（要么登记豁免，要么是缺陷） |
| 3 | `logs/pi-<date>.jsonl` 行数随对话增长 | pi 进程真的在跑且 stdout tee 生效 | 文件不存在 = pi 首次 flush 未发生（无 user/assistant 消息）或 tee 断 |
| 4 | 删除会话后整树消失（或进废纸篓） | 删除走「整树回收」单通道 | 树残留 = 级联未覆盖（残留域要登记） |
| 5 | 孤儿扫描：树内一级目录名非法形态被跳过（不误删） | 遍历纪律生效 | 误删 = 扫描实现没按 `isPiSessionId` 过滤 |

### 证据（怎么落）

- `attach('tree.txt', find 输出)`；`attach('tree-sizes.txt', du 输出)`；
- 需要内容时只取**头 N 行 + sha256**（`head -c 4096`），不要整文件入库（会话 jsonl 可能几十 MB）。

### 证不了

- **树内文件内容语义正确性**：树只能证明「有/没有/多大」，内容正确性要靠 grep/解析。
- **软删（mac 废纸篓）的可恢复性**：脚本只验「原路径不存在」；废纸篓里的条目不做断言。
- **非 mac 的硬删差异**：平台分支不验（验收机是 macOS）。

### Gotchas

- `logs/pi-<date>.jsonl` 的日期是**本地时区**的 `YYYY-MM-DD`；跨零点跑验收会切成两个文件。
- 文件是 `createWriteStream(flags:'a')` 常驻写流：进程活着时 tail 可能落后几行，
  断言「某行存在」要给条件轮询（`grep -q` 重试），不要 sleep 后一次性断言。
- 会话树**不含** pi 会话 jsonl 本体（在 `agent/sessions/`）；找历史消息别在树里找。
- `du -sh` 在某些域不存在时返回非零；脚本要容忍（`|| true`）。

---

## evidence.logs · 日志取证（runtime / main / pi / 扩展）

- **通道**：C
- **前置**：`requires: none`；实例已启动过（日志由进程产生）
- **用于**：`env.ready`（扩展装载 N）、`extension.load`、`interaction.permission`、
  `workspace.terminal`（世代/退出）、任何「UI 没现象」的排障

### 入口（用户 POV / 协议 / 副作用点）

四类日志，**归属不同，别混**：

| 类 | 路径 | 谁写 | 典型用途 |
|----|------|------|----------|
| runtime 主日志 | `<dataDir>/logs/runtime-<date>.log` | `packages/runtime/src/infra/logger.ts`（按天 + size 轮转） | 扩展解析 `resolved N extensions`、canvas/plugin/session 服务日志、RPC 错误 |
| main 日志 | `<dataDir>/logs/main-<date>.log` | `apps/electron/main/logs/main-logger.ts` | 窗口/监督器/runtime 重启、崩溃恢复 |
| pi stdout tee | `<dataDir>/ext-sessions/<sid>/logs/pi-<date>.jsonl` | `logger.ts` 的 `createPiSessionLog` | **pi 卡死时唯一证据**（逐行原样 JSONL） |
| 扩展文件日志 | `<dataDir>/agent/logs/<extName>-<date>.log` | `extensions/shared/extension-logger` | 单扩展行为（permission 决策、canvas 宿主判定、plan 状态机） |

补充：
- 全局崩溃类：`plugin-crash-*` / `signal-forensics-*` / `pi-crash-*`（无 sid 的落全局 logs，
  带 sid 的落树内 logs）。
- 保留期：`readLogKeepDays()`（shared）；过期清理只在启动时跑一次。
- 轮转：runtime 主日志 size 超限 → `.1`（单代）；pi tee → `.1.gz`（gzip 单代）。
  断言最新内容读**原路径**，历史代不保证存在。

### 驱动

```bash
DATE=$(date +%F)
# 1) 扩展装载判据（doctor 同源）
grep -h "resolved .* extensions from .* sources" <dataDir>/logs/runtime-$DATE.log | tail -1
# 2) 会话级 pi 事件（工具调用/结果、模型切换）
grep -c '"type":"toolCall"' <dataDir>/ext-sessions/<sid>/logs/pi-$DATE.jsonl
# 3) 某扩展的行为（需 TAIJI_AGENT_DEBUG=1 才有 debug 级）
ls <dataDir>/agent/logs/ 2>/dev/null
grep -n "denied via rpc" <dataDir>/agent/logs/pi-permission-$DATE.log 2>/dev/null
# 4) runtime 崩溃/重启痕迹
grep -n "\[runtime-context\]" <dataDir>/logs/pi-crash-*.log 2>/dev/null | head
```

### 断言（期望终态 / 失败信号）

| # | 断言 | 能证明什么 | 失败信号 |
|---|------|------------|----------|
| 1 | 末次 `resolved N extensions from M sources` 且 N ≥ 8 | 扩展解析阶段完成 | 无该行 = pi 尚未 spawn 或 resolver 抛错（doctor 会红） |
| 2 | `pi-<date>.jsonl` 有本轮 toolCall/toolResult | pi 真的执行了工具（不是前端伪造） | 只有 request 无 result = 工具挂起（审批/长任务） |
| 3 | runtime 日志无 `Unhandled extension_ui_request` 警告 | 协议 method 未漂移 | 出现 = pi 升级引入新交互 method，前端未实现（会挂死 pi Promise） |
| 4 | 崩溃后有 `pi-crash-*` / `plugin-crash-*` 且含 `[runtime-context]` 头 | 崩溃可归因（session/uptime/memory） | 无 crash 文件 = 崩溃证据丢失（tee/logger 未 init） |
| 5 | 扩展日志有该扩展的 INFO 行 | 扩展代码被执行过 | 无文件 ≠ 未装载（可能没打 INFO 日志）——**不能单独作为反向证据** |

### 证据（怎么落）

- `attach('runtime-grep.txt', grep -n <pattern> <log> | tail -50)`
- `attach('pi-tail.jsonl', tail -n 50 <pi log>)`（**只取尾部**，别整文件）
- 断言失败时把「最近 20 帧类型摘要」一并 attach（协议层 `waitFor` 已有该能力）

### 证不了

- **日志缺失 ≠ 功能没跑**：级别/过滤/未打日志都会造成缺失（尤其扩展日志默认 INFO 档）。
- **时间顺序的严格性**：多写流（main/runtime/pi）没有全局时钟同步，跨文件比较时间戳只能看量级。
- **轮转历史**：`.1` / `.1.gz` 只保一代，早期证据可能已被轮转掉。
- **`main-<date>.log` 的应用侧行为**：main 日志只覆盖窗口/监督器，不覆盖 renderer。

### Gotchas

- `TAIJI_AGENT_EXT_LOG=1` 由 runtime **恒注入**给 pi（`rpc-client.ts`），所以扩展的 INFO 级
  本来就有；只有 DEBUG 需要 `TAIJI_AGENT_DEBUG=1`。
- 日期是本地时区；`date -u` 会取错文件。
- runtime 日志里 `[extension-resolver]` 前缀是**解析**，不是**装载**（见 `extension.load`）。
- 日志文件可能正在被写：`grep` 读到半行是正常的，匹配用「包含」而不是整行等值。
- 全局 `logs/` 与树内 `logs/` 是两处；`pi-<date>.jsonl` 只在树内（无 sid 的极端防御才回落全局）。

---

## evidence.grep · 结构化检索（JSONL / 日志 / 源码）

- **通道**：C
- **前置**：`requires: none`
- **用于**：所有需要「从落盘事实里取一条可引用证据」的场景；也是 `shell.grep`（契约 §2 的旧名）的实现

### 入口（用户 POV / 协议 / 副作用点）

- 无 UI 入口。语义 = 「在**指定根**下按模式检索，输出**带文件与行号**的命中行」。
- **契约不一致提醒**：`API-CONTRACT.md` §2（vp CLI 清单）写的是 `shell.grep`，§6（capability
  id 清单）写的是 `evidence.grep`。本文件按 §6 命名，实现时两个名字都要能路由（见报告）。
- 检索根的白名单（按用途）：
  - 证据目录：`~/.agents/skill-data/verify-taiji/<worktree>/<runId>/`
  - 实例数据：`<dataDir>`（只读）
  - 仓库（源码/文档核对）：`<repo>`
  - **禁止**在 `~` 全盘 / `~/.taiji`（prod）上跑递归 grep。

### 驱动

```bash
# JSONL 里找某类 entry（pi 会话）
grep -n '"type":"message"' <dataDir>/agent/sessions/<encodeCwd>/*.jsonl | tail -5
# 会话树 pi 日志里找工具名
grep -n '"name":"ask_user"' <dataDir>/ext-sessions/<sid>/logs/pi-*.jsonl | head
# 日志里找协议告警
grep -n "Unhandled extension_ui_request" <dataDir>/logs/runtime-*.log | tail -20
# 源码核对 testid 出处（本 capability 文档自身的取证方式）
grep -rn 'data-testid="form-overlay"' packages/renderer/src
# 文档漂移核对（路径公式是否还被引用）
grep -rn "ext-sessions" docs packages/shared/src/paths.ts | head
```


> 实现建议（`scripts/lib/evidence.mjs`，**待实现**）：`node:fs` 递归 + 简单子串/正则匹配即可，
> 零第三方依赖（契约 §1）。**不要**依赖 `rg` 存在（验收机可能没有），但可以在有 `rg` 时加速。

### 断言（期望终态 / 失败信号）

| # | 断言 | 能证明什么 | 失败信号 |
|---|------|------------|----------|
| 1 | 命中行带 `文件:行号:` 前缀 | 证据可定位（人能复核） | 只有内容无位置 = 不可追溯 |
| 2 | 命中数 > 0 且 ≤ 上限（默认 200，超出截断并标注） | 结果可控（防日志风暴） | 无上限 = 大文件把证据撑爆 |
| 3 | 检索根在允许集合内 | 不越界（禁全盘 / 禁 prod） | 根是 `~` 或 `~/.taiji` = 违规 |
| 4 | 同一 pattern 在「源码」与「落盘证据」两侧都能命中（需要时） | 断言锚点有出处（不是编的） | 只在证据侧命中 = 锚点可能是臆造 |

### 证据（怎么落）

- `attach('grep-<slug>.txt', 命中行原文)`；同时在 `summary.jsonl` 记
  `{step, command, exitCode, stats:{hits}, channel:'C'}`。
- 命中 0 条时 **exit code 仍为 0**（grep 语义），由调用方按 `hits===0` 判失败——
  不要把「没搜到」变成脚本崩溃。

### 证不了

- **语义等价**：grep 只能证明「字符串出现」，不能证明「这条日志对应这次操作」
  （并发/多 session 会串）。要精确定位必须带 `sessionId` / `requestId` / `toolCallId` 过滤。
- **二进制/压缩文件**：`.gz` 需要先解压；grep 默认不读。
- **跨文件时间排序**：grep 输出按文件遍历序，不是时间序；需要时间序要用 `receivedAt` 字段自己排。

### Gotchas

- pi 的 JSONL 是**逐行 JSON**，一行可能 100KB+（含 base64 图片）：`grep -n` 输出会很长，
  落证据前先 `cut -c1-400` 截断。
- `--include`/`--exclude` 的 glob 在 macOS BSD grep 与 GNU grep 行为略有差异；
  脚本里用 `find ... -name` 显式控范围更稳。
- 中文/emoji 在日志里是 UTF-8 多字节：按字节 `cut` 可能切坏，用 `head -c` 后接 `iconv -c` 或
  直接按行截断。
- 不要在 `<repo>` 上跑无 `--include` 的递归 grep：`node_modules/` 会拖慢几十秒。

---

## evidence.screenshot · 截图取证

- **通道**：A（视觉，但落盘为证据文件）
- **前置**：`requires: none`；需要 `page`（CDP 连接，且页面 URL 属于本实例）
- **用于**：每个验收点的「动作 + 状态」证据；也是「应用身份可见」的唯一通道

### 入口（用户 POV / 协议 / 副作用点）

- 无 UI 入口；实现 = Playwright `page.screenshot()`（CDP 连接已有实例），
  落 `<runDir>/<name>.png`（`createEvidence().shot(page, name, {selector?})`）。
- 纪律（`API-CONTRACT.md` §1.4）：截图必须落 **runDir**，**绝不落实例数据目录**
  （清理会删掉它）。
- 身份要求（SKILL.md §4）：截图必须能识别出「这是 taiji 本实例」——窗口标题、两侧栏、
  会话名任一可见即可；纯组件截图（`selector`）要配一张全窗图。

### 驱动

```js
// 全窗（默认）：证明应用身份 + 当前整体状态
await ev.shot(page, 'askuser-form-multi')
// 局部：证明某个 testid 的终态（配合全窗图使用）
await ev.shot(page, 'change-set-card', { selector: '[data-testid="change-set-card"]' })
```

```bash
# 低层等价（不依赖 evidence 封装时）——CDP 直取
# playwright: page.screenshot({ path })；纯 CDP: Page.captureScreenshot
```

### 断言（期望终态 / 失败信号）

| # | 断言 | 能证明什么 | 失败信号 |
|---|------|------------|----------|
| 1 | PNG 存在且大小 > 10KB | 不是空白/损坏图 | 几 KB = 全白/全黑（页面未渲染完就截） |
| 2 | 全窗图能看到实例标识（标题/侧栏/会话名） | 证明「是本实例」而非旧代码/打包版 | 只有一片灰 = 截到了未加载页面 |
| 3 | 断言目标元素在截图前已 `expectVisible` | 截的是终态而不是中间态 | 截到 loading 态 = 缺条件等待 |
| 4 | 截图 + DOM 断言 + 磁盘证据三件套齐 | 三通道互证（SKILL.md §4 证明标准） | 只有截图 = 无法复核（不满足证明标准） |
| 5 | dispose 后 runDir 仍在且 PNG 完整 | 证据幸存（runner 硬要求） | runDir 被删 = 本次验收作废 |

### 证据（怎么落）

- 命名：`<feature>-<state>.png`（`askuser-form-multi` / `askuser-form-submitted`），
  一态一张，不要 `screenshot1.png`。
- 同时在 `report.md` 里写「这张图对应哪条断言」，否则截图会退化成装饰。

### 证不了

- **像素级视觉正确性**（颜色/字号/间距）：归 `e2e-visual` 基线轨；本层只看「结构/状态可见」。
- **动画中间态**：截图是瞬时采样，过渡帧不可复现；要验动效用录屏（本层不做）。
- **窗口外的系统 UI**（原生对话框、废纸篓）：截不到（Electron 截图只覆盖页面）。

### Gotchas

- **截太早**：SPA 首帧常是空白；先 `expectVisible` 目标再截。
- **截错实例**：CDP 连错（旧 worktree / 打包版）会得到「看起来一样但代码不同」的图。
  截图前必须核对页面 URL 属于本实例的 vitePort（SKILL.md §1 就绪判据 2）。
- **高分屏缩放**：macOS Retina 下 PNG 是 2x 像素；做像素比对时要注意 DPR。
- **弹层遮挡**：reka 弹层在 `<body>` 末尾，截 `selector` 时可能截不到浮层；
  浮层类证据一律用全窗图。
- **证据目录不在实例数据目录**：`<runDir>` = `~/.agents/skill-data/verify-taiji/<worktree>/<runId>/<feature>/`，
  清理实例不会带走它；收尾要做「证据幸存核对」（runner 职责）。
