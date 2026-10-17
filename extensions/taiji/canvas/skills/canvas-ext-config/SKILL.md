---
name: canvas-ext-config
description: "使用或排查 @zhushanwen/pi-canvas（问题解决画布：六个 canvas_* deferred 工具，人机共编论证图）时加载。含 select 通道挂起等待 GUI 裁决的语义（无墙钟超时，裁决经事件通知回推）、宿主检测（canvas_unavailable_host 的两种成因）、events.jsonl/canvas.json 存储概览、排障入口（TAIJI_AGENT_EXT_LOG 日志位置与宿主要求）。触发词：画布、canvas、canvas_enter、canvas_edit、canvas_review、canvas_export、select 挂起、等待裁决、canvas_unavailable_host、画布日志、画布排障、events.jsonl、canvas.json。"
---

# canvas 画布使用与排障指南

> @zhushanwen/pi-canvas：问题解决画布的工具面。六个 `canvas_*` 工具（全部 deferred，需先 `tool_search` 检索激活）：`canvas_enter`（创建/打开）、`canvas_edit`（grow/patch/select/transition/comment-respond）、`canvas_read`、`canvas_review`（run/append/resolve）、`canvas_export`、`canvas_list`。画布是用户在 taiji GUI 里实时观看并裁决的人机共编论证图。

**本扩展无磁盘配置文件**——没有 `<agentDir>/config/canvas-ext-config.json`，行为不可经文件配置。它的「配置面」就是宿主注入的环境变量（见下文排障节）；不要去找或创建配置 JSON。

## 通道语义：select 挂起等待 GUI 裁决

每个 `canvas_*` 调用的路径：工具 execute 把调用转译为 `CANVAS_MARKER` 的 `{action, params}` 嵌套载荷，经 `ctx.ui.select` **挂起**，由 taiji runtime 的 marker 显式分支路由到 CanvasService；应答回来后经 `extension_ui_response` 按 id 精确解挂。

关键行为（agent 必须知道的三点）：

1. **调用会挂起等待，不是即时返回**：用户正在 GUI 画布上看图、圈选、写批注，应答要等 runtime 侧处理完才回来。这是设计内形态，不是卡死。
2. **无墙钟超时**：挂起不设时限（任务级正常路径不设限），任意晚的应答都会按 id 解挂。等待期间不要重试同一调用——重试会产生第二个挂起请求。
3. **用户的 GUI 裁决（圈选 / 否决 / 批注）以画布事件通知回推**：收到通知后**必须先 `canvas_read` 读当前状态再行动**（read-before-act 纪律），不要凭记忆编辑。

## 宿主检测：canvas_unavailable_host

画布工具只在 taiji GUI 托管的 pi 里可用。前置门在 select 之前（`isTaijiGuiHost` 谓词：`TAIJI_AGENT_EXT_LOG === "1"` 且 `ctx.mode === "rpc"`），不满足时直接返回结构化错误、不进入 select：

```
canvas_unavailable_host: 画布需要 taiji 宿主。…
恢复动作：在 taiji 桌面应用的会话中使用画布工具；纯 pi 环境请直接以对话方式规划。
```

成因两种：① 本来就在独立 pi CLI / TUI 里跑（画布不可用，属正常拒绝）；② env 泄漏或 mode 异常（在 taiji 里却报此错——检查 pi 进程 env 是否带 `TAIJI_AGENT_EXT_LOG=1`）。

## 错误闭环（失败可区分，按恢复动作重试）

工具报错分三类，全部 throw（isError 消息可见），agent 可据此决定重试或放弃：

| 错误形态 | 含义 | 处置 |
|---|---|---|
| `canvas <action>: cancelled or channel error` | 通道失败（取消/断连） | 重试一次；连续失败转排障节查日志 |
| `non-JSON response from runtime` / 「应答不是合法 JSON（runtime 契约漂移）」 | runtime 与 extension 版本错配 | 核对两侧同版本后重试 |
| `canvas <action> 被拒绝 [<错误码>] … 恢复动作：…` | 领域拒绝（不变量拦截，如 not_converged） | 按消息里的恢复动作修正后重试，不要原样重发 |

## 存储概览（只读理解用，agent 不直改文件）

画布按归属会话隔离（session-store-layout-inversion D4）：画布归属创建它的 session，一个 session 可有多张画布（1:N）。数据在 taiji runtime 数据目录 `<dataDir>/ext-sessions/<sessionId>/canvases/<canvasId>/` 下：

| 文件 | 角色 |
|---|---|
| `events.jsonl` | **唯一持久权威**：append-only 领域事件流，每行一个 JSON 事件（seq 从 1 起 per-canvas 单调）。状态疑义以此文件为准 |
| `canvas.json` | 加速快照 + 锚点（锚点 eventId ≤ 事件流末条，永不超前）。损坏时从 events.jsonl 全量重放重建 |
| `exports/` | 导出产物（planning-doc / requirement-card） |

`<dataDir>` 按环境：taiji dev = `~/.taiji-dev`，taiji prod = `~/.taiji`（`TAIJI_AGENT_DATA_DIR` 可隔离）。修改画布只经 `canvas_edit` / `canvas_review` 工具走领域校验，**禁止手改这两个文件**。

归属即隔离：`canvas_list` 只返回当前会话的画布；打开 / 读取 / 修改其他会话的画布一律被拒（错误码 `forbidden`，恢复动作 = 让用户切换到画布归属会话）。session 删除时该会话目录树（含其全部画布）随整树回收。

## 排障入口：扩展日志

文件日志由 pi-extension-logger 双开关分级写 `<agentDir>/logs/pi-canvas-YYYY-MM-DD.log`：

| 开关 | 行为 |
|---|---|
| `TAIJI_AGENT_EXT_LOG=1` | INFO 档落盘（taiji 托管环境 runtime spawn pi 时恒注入）+ 7 天保留期清理 |
| `TAIJI_AGENT_DEBUG=1` | DEBUG 全量（两变量同时注入按更详细的生效） |
| 均未注入 | no-op——零磁盘、无日志文件（裸 pi 默认即此） |

**宿主要求**：`TAIJI_AGENT_EXT_LOG=1` 在 taiji 里由 runtime 统一注入，无需手配；裸 pi 独立用户要文件日志须自己 export（但画布工具本身在裸 pi 下不可用，日志只有通道报错可看）。

`<agentDir>` 按环境（`PI_CODING_AGENT_DIR` 决定，taiji 隔离到 `<dataDir>/agent/`）：

| 环境 | 日志路径 | 画布数据 |
|---|---|---|
| 独立 pi CLI | `~/.pi/agent/logs/` | 不可用（canvas_unavailable_host） |
| taiji dev | `~/.taiji-dev/agent/logs/` | `~/.taiji-dev/ext-sessions/<sessionId>/canvases/` |
| taiji prod | `~/.taiji/agent/logs/` | `~/.taiji/ext-sessions/<sessionId>/canvases/` |

排障顺序：先看工具 isError 消息里的错误码与恢复动作（多数问题到此为止）→ 需要通道级细节再读当日 `pi-canvas-*.log`（marker 调用失败会带 action 名落日志）→ 数据疑义以 `events.jsonl` 为准核对。
