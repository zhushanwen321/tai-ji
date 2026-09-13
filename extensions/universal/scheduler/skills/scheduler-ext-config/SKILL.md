---
name: scheduler-ext-config
description: "使用或排查 @zhushanwen/pi-scheduler（定时任务调度）时加载。说明任务创建/管理方式（/schedule 命令与 schedule 工具）、调度格式（interval duration 与 cron）、数据存储机制（session JSONL 的 append-only event sourcing，无独立配置文件）、旧版 store 迁移、运行限制。触发词：配置定时任务、scheduler 配置、定时调度、cron 任务、interval 任务、scheduler 存储、scheduler 数据在哪、定时任务排查、scheduler-ext-config。"
---

# scheduler 使用与存储指南

> @zhushanwen/pi-scheduler：定时任务调度扩展。任务到期时向当前 session 注入一条 message（`deliverAs: 'followUp'` + `triggerTurn: true`），唤醒 agent 开新一轮 turn 处理。

**重要前提**：scheduler **没有独立的配置文件**。任务通过命令/工具交互创建，数据以 append-only event sourcing 方式存储在 session JSONL 中（见下文「数据存储位置」）。排查「任务存哪 / 为什么 resume 后任务变了 / fork 后任务是否继承」都必须基于此模型理解，不要去找独立的 `scheduler.json`（那是已废弃的旧版格式，仅迁移探测时使用）。

## 如何创建/管理定时任务

两条入口，底层都走 `SchedulerService`（单一业务实现，无双轨）：

### 1. `/schedule` slash 命令（用户/AI 直接输入）

| 用法 | 作用 |
|------|------|
| `/schedule <schedule> <prompt>` | 创建 recurring 任务（默认） |
| `/schedule once <delay> <prompt>` | 创建一次性任务（执行一次后自动删除） |
| `/schedule cron '<cron表达式>' <prompt>` | 创建 cron 任务（**必须用引号**包裹，否则空格会被 tokenize 拆散） |
| `/schedule list` | 列出全部任务（按 nextRunAt 排序） |
| `/schedule on <id>` / `/schedule off <id>` | 启用 / 禁用某任务 |
| `/schedule rm <id>` | 删除某任务 |
| `/schedule run <id>` | 立即触发一次某任务 |

- 无参数 `/schedule`：当前返回「TUI 未实现」提示，用 `/schedule list` 查看任务。
- `on`/`off`/`rm`/`run` 的 `<id>` 支持命令补全（`getArgumentCompletions` 会列出 `id · name · schedule`）。
- cron 表达式含空格，**必须用单/双引号**包成一个 token，例：`/schedule cron '*/10 * * * *' 跑测试`。

### 2. `schedule` / `schedule_control` 工具（AI 调用）

- **`schedule`**（创建）：参数 `prompt`（必填，到期注入的消息）、`schedule`（必填，duration 或 cron）、`kind`（`once`/`recurring`，默认 `recurring`）、`name`（可选，缺省从 prompt 自动截取前 30 字）、`expires`（可选，默认 7 天；传 `"never"` 关闭过期）、`force`（可选，默认 `false`）。
- **`schedule_control`**（管理）：`action` = `list`/`toggle`/`delete`/`run`，`id`（toggle/delete/run 必填），`enabled`（toggle 必填）。
- 两个工具的返回都是结构化 `{content: [{type:'text', text}], details}`；业务失败以异常抛出（pi 只对 execute throw 置 `isError:true`，错误 message 作为 toolResult content 返回），不通过返回值表达失败。

> 创建/管理操作无需 agent idle——只有**到期 dispatch** 才受 idle/速率限制约束（见「运行限制与 dispatch 行为」）。

## 调度格式

`parseSchedule` 的分流规则：**输入不含空格 → duration（interval 模式）；含空格 → cron（cron 模式）**。

### interval（duration 字符串）

格式 `<数字><单位>`，单位不区分大小写、支持单复数：

| 单位 | 别名 | 毫秒 |
|------|------|------|
| `s` | `sec`/`second`/`seconds` | 1000 |
| `m` | `min`/`minute`/`minutes` | 60_000 |
| `h` | `hr`/`hour`/`hours` | 3_600_000 |
| `d` | `day`/`days` | 86_400_000 |

示例：`5m`、`2h`、`1d`、`30seconds`。正则 `/^(\d+)\s*(s|sec|...)$/i`（注意：含空格的输入在 parseSchedule 分流时一律走 cron 分支，duration 实际不允许空格，`5 m` 解析失败）。

### cron（cron 表达式）

- **5 字段**（分 时 日 月 周）：自动在最前面补秒字段 `0`，变成 6 字段。例 `*/10 * * * *` → `0 */10 * * * *`（每 10 分钟）。
- **6 字段**（秒 分 时 日 月 周）：原样使用。
- 其他字段数（<5 或 >6）视为无效。
- 底层用 `croner` 库（dependencies + 静态 import，解析器随包安装恒在盘；cron 解析失败即表达式无效，interval 不受影响）。
- 创建时即校验表达式有效性（算不出下次执行时间 → `INVALID_SCHEDULE`）；运行中表达式失效（极少见，如月份边界）→ 任务被停用并记 `lastError='cron expression invalid'`。

示例：`*/30 * * * *`（每 30 分）、`0 9 * * 1-5`（工作日早 9 点）、`0 0 * * *`（每天 0 点）。

## 数据存储位置（排查必读）

**当前版本采用 session JSONL 的 append-only event sourcing，没有独立数据文件。**

- 任务的所有变更以 custom entry 写入**创建该任务的 session 的 JSONL 文件**：
  - 调用 `pi.appendEntry('pi-scheduler:task', op)`，`customType` 固定为 `pi-scheduler:task`。
  - op 有四种：`upsert`（创建，携带全量 `TaskSnapshot`）、`advance`（recurring dispatch 成功后推进 `nextRunAt`）、`toggle`（启用/禁用）、`delete`（删除 / once 执行后 / 过期清理）。
- session 启动时（`session_start` 事件），`PiSchedulerBackend.loadTasks()` 调 `replayFoldEntries` 折叠当前 session 的全部 `pi-scheduler:task` custom entries，重放出当前任务状态。**append-only 不做全量 persist**——没有「保存」动作，每次操作即时 append。
- 因此「任务存哪」的答案是：**创建它的那个 session 的 JSONL 文件**。该文件位于 pi agent 目录下（`getAgentDir()` 读 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`；xyz-agent 数据目录隔离时指向隔离目录如 `~/.xyz-agent/...`）。

### owner 隔离（fork 行为）

- 每个 `upsert` op 顶层带 `ownerSessionFile`（创建任务时所属 session 的 JSONL 路径）。
- `replayFoldEntries` 重放时**过滤掉 owner 不是当前 session 的任务**（防 fork/branch 继承导致同一逻辑任务跨 session 重复触发）。
- 含义：在 session A 创建的任务，fork 出 session B 后，B 的 replay 看不到 A 的任务（owner 不匹配）。任务「归属」于创建它的 session。

### 为什么找不到 `scheduler.json`

当前版本**不写** `scheduler.json`。如果你在文档或旧讨论里看到 `scheduler.json`，那是指**已废弃的旧版 store 格式**（npm 0.1.1 及更早），仅用于一次性迁移探测（见下文「旧版数据迁移」）。不要试图手动编辑或查找该文件来管理当前任务。

## 旧版数据迁移

旧版（npm ≤ 0.1.1）用独立 store 文件，按 **cwd 隔离**存储：

```
<agentDir>/scheduler/<root>/<segments>/scheduler.json
```

- `<agentDir>` = `getAgentDir()`（候选 1）或 `~/.pi/agent`（候选 2，旧版硬编码）。
- `<root>` = cwd 根盘符 sanitize：mac/linux 的 `/` → `root`；Windows `C:\` → `c`（非字母数字转 `-`，trim 首尾，小写）。
- `<segments>` = cwd 去根盘符后的路径段，按 `path.sep` 拆分。例 cwd `/Users/foo/project` → `Users/foo/project`。
- 完整示例（mac）：`~/.pi/agent/scheduler/root/Users/foo/project/scheduler.json`。

**迁移机制**（`importLegacyStore`，session_start 时自动执行，无需用户介入）：

1. 双候选探测：优先 `getAgentDir()` 路径，不存在则 fallback `~/.pi/agent/scheduler/...`（兼容 xyz-agent 数据目录隔离前的旧版写入位置）。
2. 原子 rename `scheduler.json` → `scheduler.json.imported` 独占迁移；rename 抛 ENOENT 说明并发/崩溃已被别人处理，走 `.imported` 残留恢复。
3. 读取 `.imported`，逐任务 `appendEntry('pi-scheduler:task', upsert)` 写入当前 session（owner 归属当前 session）。
4. 删除 `.imported`：**新 session 首次 flush 前（尚未收到 assistant 消息）延迟删除**，由首个 `turn_end` / `session_shutdown` 确认 flush 后再删（防未 flush 即退出导致任务永久丢失 + 源文件已毁）。
5. 迁移失败（read/parse/append 异常）整体降级：`console.warn` + 不阻断 session 启动，`.imported` 保留供下次重试。

迁移是一次性的：迁移完成后旧 `scheduler.json` 已被 rename 走并删除，后续 session 不再有旧格式数据。

## 运行限制与 dispatch 行为

| 限制 | 值 | 含义 |
|------|-----|------|
| 每 session 任务数上限 | 50（`MAX_TASKS`） | 超出创建报错 `Task limit reached` |
| dispatch 速率 | 6 次/分钟（`RATE_LIMIT_PER_MINUTE`） | 滑动窗口计数，超出则当前 tick 跳过、下个 tick 重试 |
| tick 间隔 | 30 秒（`TICK_INTERVAL_MS`） | 每 30 秒检查一次到期任务 |
| 默认过期 | 7 天（`DEFAULT_EXPIRY_MS`） | 仅 recurring；`expires="never"` 关闭 |
| 历史记录 | 最近 20 条（`HISTORY_LIMIT`） | 每任务的执行历史 |

dispatch 触发条件（`dispatchTask`）：

- **非 force 任务**：走统一 session delivery 内核（park 模式）——到期即入队，agent 忙时消息 park 在内核队列，等 agent 空闲的 settled 边沿投递，scheduler 每 30s tick 触发一次 flush 兜底重试；不丢弃。
- **force=true 任务**：即使 agent busy 也立即触发（用于必须准点执行的场景）。
- dispatch 成功后：recurring 推进 `nextRunAt` 并 append `advance`；once 删除任务并 append `delete`；失败（`sendMessage` 抛错）记 `lastStatus='failed'` 不 rethrow，下个 tick 重试（transient 失败重试语义，不 append advance）。
- 注入的消息：`{content: task.prompt, customType: 'pi-scheduler:dispatched', display: true}`，`deliverAs: 'followUp'` + `triggerTurn: true`（排进 followUp 队列并唤醒 agent 开新 turn）。

## 任务数据结构

`ScheduledTask`（内存态，`types.ts`）核心字段：

- `id`：8 位 hex，自动生成。
- `name`：可读名称（用户指定或从 prompt 自动截取前 30 字）。
- `prompt`：到期注入的 message 内容。
- `kind`：`once` | `recurring`。
- `schedule`：`{mode:'cron', cronExpression}` | `{mode:'interval', intervalMs}`。
- `enabled`：是否启用。
- `force`：是否在 agent busy 时强制 dispatch。
- `createdAt` / `nextRunAt` / `expiresAt?`：时间戳（ms）。
- `runCount` / `lastRunAt?` / `lastStatus?`（`success`|`failed`）/ `lastError?`：执行统计。
- `history`：最近 20 条 `ExecutionRecord`（`{at, status}`）。
- `ownerSessionFile?`：归属 session JSONL 路径（fork 过滤用，非持久化业务字段）。
- `pending?`：运行时标记「到期待 dispatch」，非持久化（与 `enabled` 正交）。

持久化写入 session JSONL 的是 `TaskSnapshot`（剥离 `ownerSessionFile`/`pending` 后的 15 字段）。

## 示例

创建一个每 5 分钟检查构建状态的任务：

```
/schedule 5m 检查当前项目的构建状态，失败则报告原因
```

创建 2 小时后的一次性提醒：

```
/schedule once 2h 提醒我 review 这个 PR
```

创建每 30 分钟跑测试的 cron 任务（注意引号）：

```
/schedule cron '*/30 * * * *' 跑一次 vitest 并报告结果
```

创建工作日早 9 点的早会提醒（不过期、force）：

```
/schedule cron '0 9 * * 1-5' 早会时间到了，总结昨天进展和今天计划
```
（如需 force + 不过期，用 `schedule` 工具传 `force:true, expires:"never"`，命令行暂未暴露这两个开关）

列出并禁用某任务：

```
/schedule list
/schedule off abc12345
```

AI 通过工具创建（force + 永不过期）：

```
schedule({ prompt: "...", schedule: "1h", kind: "recurring", force: true, expires: "never", name: " hourly-check" })
```

## 备注

- **croner 依赖**：cron 模式依赖 `croner`（dependencies，随包自动安装 + 静态 import，2026-09 0.6.0 起；此前为 optional peer，独立安装形态下 cron 任务会静默失败）。cron 解析失败（`INVALID_SCHEDULE`）= 表达式无效，不存在「解析器未安装」形态。
- **数据目录隔离**：任务存储在 `getAgentDir()` 指向的 session JSONL。xyz-agent 通过 `XYZ_AGENT_DATA_DIR` / `PI_CODING_AGENT_DIR` 隔离实例时，任务随 session 落在隔离目录，与 `~/.pi/agent` 互不干扰。
- **无配置 schema 可编辑**：scheduler 的所有状态都由运行时命令产生，没有可手动编辑的配置文件。要「批量预置任务」只能在 session 内逐条创建（或迁移旧 store）。
- **TUI 管理器未实现**：无参 `/schedule` 当前只返回提示，任务管理请用 `list`/`on`/`off`/`rm`/`run` 子命令或 `schedule_control` 工具。
