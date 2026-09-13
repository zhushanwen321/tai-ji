---
name: rename-session-ext-config
description: "配置 @zhushanwen/pi-rename-session（会话自动重命名）时加载。含配置文件路径、RenameSessionConfig schema、ModelSelector ref 精确指定、触发模式三选一（first-prompt 首条请求 / first-stop 首 round 末 / agent-tool 工具自主）、maxTitleLength 约束、默认值、示例、生效时机、开关优先级（flag 覆盖）。触发词：配置重命名、rename 配置、自动标题、rename-session config、auto-rename 设置、触发时机、首 turn、first-prompt、agent-tool、开关不生效。"
---

# rename-session 配置指南

> @zhushanwen/pi-rename-session：按触发模式为会话生成标题——自动模式（first-prompt / first-stop）用独立小模型或会话主模型生成，agent-tool 模式注册 `rename_session` 工具由 agent 自主改名。

## 配置文件位置

`<agentDir>/config/rename-session-ext-config.json`

- `<agentDir>` = pi agent 目录（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- 文件缺失/坏 JSON 返回默认值，不抛错

## 触发模式（重要）

`mode` 三值互斥，默认 `first-stop`（现状行为，零迁移）：

| mode | 触发时机 | 标题来源 |
|---|---|---|
| `first-prompt` | 首条 user 消息发出即命名（不等回复） | 只基于 prompt 本身的 LLM 生成 |
| `first-stop`（默认） | 新 session 首个成功 round 末（round 最终 turn `stopReason === "stop"` 且成功 assistant 回复数 === 1） | prompt + 最终回复的 LLM 生成 |
| `agent-tool` | 不自动生成——注册 `rename_session` 工具，agent 在对话中自主调用 | agent 给定的标题（零额外 rename LLM 调用） |

行为边界：

- **自动模式一次性语义**：每个 session 最多自动重命名一次；已过触发窗口的存量 session 不会回溯重命名——开启后只对之后新建的 session 生效
- 工具中间轮（`stopReason === "toolUse"`）不评估；error/aborted/length 轮延迟到下一个成功轮再命名（first-stop）
- 首个成功 round 时 LLM 调用失败 → 静默跳过保留原标题，不重试（first-stop 有 error 轮延迟语义；first-prompt 触发窗口唯一，错过即无自动机会）
- **mode 求值时点**：事件面（自动命名分派）每次事件 live 读——切换对活跃 session 的自动命名即时生效；`rename_session` 工具注册面只在 pi 进程启动加载 extension 时求值一次——切换后已存活 session 的工具清单不回溯，残留工具被调用时 execute 内 live 守卫拒绝（错误文案含恢复指引）
- `rename_session` 工具改名**不走防覆盖守卫**——agent 显式调用等同手动 rename，允许覆盖任何既有名（含自动名/语义名）
- steering/follow-up 队列消息不满足「session 首条 user」判定，不会误触发（first-prompt）

> 改完配置「没看到 session 被重命名」的常见原因：当前 session 已过触发窗口（首条 user 已发出 / 首个成功 round 已完成）。新建一个 session 测试。

## Schema

```ts
interface RenameSessionConfig {
  enabled: boolean;        // 自动重命名开关，默认 false
  model: ModelSelector;    // 标题生成模型，默认 { type: "ref", ref: "" }（空 ref 跟随会话主模型）
  mode: "first-prompt" | "first-stop" | "agent-tool";  // 触发模式，默认 "first-stop"
  maxTitleLength: number;  // 标题最大长度（Unicode 码点），默认 50
  thinkingLevel: ModelThinkingLevel;  // 标题 LLM 的 thinking 级别，默认 "off"
}
```

### ModelSelector（仅支持 ref 精确指定）

| type | 形式 | 语义 |
|---|---|---|
| `ref` | `{type:"ref", ref:"provider/modelId"}` | 精确指定（需配 auth） |

不再支持 `fallback` / `available` / `scoped`。需要自动选模时请在调用方（如 permission 的 `"auto"`）自行基于 `ctx.modelRegistry` 实现。

**空 ref 语义（重要）**：`ref: ""` = 未配置 → **跟随会话主模型**（`ctx.model`，开箱即用）；非空但解析失败（无效 provider/model）才静默跳过 rename（日志 `model not available, skipping`）。

### maxTitleLength 约束

必须是**正整数**（`Number.isInteger && > 0`）。传小数（`50.5`）、0、负数、非数字都会回落默认值 50。截断按 Unicode 码点（不会截断多字节字符）。

### thinkingLevel 取值

标题 LLM 的 thinking 级别，枚举 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（pi 的 `ModelThinkingLevel`）。默认 `"off"`：直接透传给 llm-shared，由 llm-shared 映射为不传 reasoning（provider 默认行为）；`minimal`~`max` 透传给 reasoning（provider 不支持时静默忽略）。缺失或非法值回落 `"off"`。

## 默认值

```json
{ "enabled": false, "model": { "type": "ref", "ref": "" }, "mode": "first-stop", "maxTitleLength": 50, "thinkingLevel": "off" }
```

## 配置示例

固定用便宜模型生成标题（first-stop）：
```json
{
  "enabled": true,
  "model": { "type": "ref", "ref": "deepseek/deepseek-chat" },
  "mode": "first-stop",
  "maxTitleLength": 50,
  "thinkingLevel": "off"
}
```

首条请求即命名（不指定模型，跟随会话主模型）：
```json
{
  "enabled": true,
  "model": { "type": "ref", "ref": "" },
  "mode": "first-prompt"
}
```

交给 agent 自主命名：
```json
{
  "enabled": true,
  "mode": "agent-tool"
}
```

> [HISTORICAL] 原最高优先级的 `PI_RENAME_*` 环境变量覆盖层已删（全仓 0 生产 setter）——预置该前缀的环境变量不再有任何效果。rename-session 相关精简项裁决见原设计文档 rename-session-three-modes.md 附录 A（已删除，git 可追溯）。

## 配置生效时机

配置走 mtime+size 读时刷新（每个 `turn_end` / `message_end` 都重新 load）。改完 JSON 保存后，**下一个新 session 的触发窗口** 即按新配置生效（已过触发窗口的 session 不受影响）。`mode` 切换的存量 session 边界见上文「触发模式」行为边界。

## 排除项

subagent 子进程 session 不重命名（`isSubagentSession` 判定 session 目录）——子 session 是临时产物，重命名会产生噪音。如果你发现某个 session 没被重命名，先确认它不是 subagent session。

## 开关优先级（重要）

`enabled` 有三层来源，优先级从高到低（`src/pure.ts` `loadRenameConfig`）：

1. **`<agentDir>/auto-rename-enabled` flag 文件**（存在 = 开）：这是 xyz-agent runtime 的开关契约（SystemPage 开关 / 首启默认开启都写这个文件，live 检查每次事件生效）。**xyz-agent 用户不要手改 JSON 里的 enabled**——桌面端的开关状态存在 flag 文件里，手改 JSON 会被 flag 覆盖（flag 存在即视为开）。
2. **config 的 `enabled` 字段**（默认 false）：flag 不存在时生效，是原生 pi CLI 用户的开关（手改 JSON 或 `/auto-rename on|off` 命令）。
3. **默认值**（false）：以上两层均未设置时。

`/auto-rename on` 只创建 flag；`/auto-rename off` 写 config.enabled=false + 删 flag（双写同步）。旧版升级用户：旧 flag 文件保留不动，仍作为开关生效，无需任何迁移操作。

## LLM 调用特性（自动模式）

- 模型：空 ref 跟随会话主模型；非空 ref 独立选模（不搭便车主 session 模型）
- 独立精简 system prompt（<200 字符的 slug 词组约束 + 正反例 few-shot，非整个 agent prompt）
- 不传 tools（纯文本标题生成）
- fire-and-forget（不阻塞 turn_end / message_end handler）
- model 不可用 → 静默跳过（日志 `[rename-session] model not available, skipping`），不阻断主对话
