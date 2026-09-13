# scheduler

定时任务调度扩展：按 duration（`5m` / `2h` / `1d`）间隔或 cron 表达式，在指定时间向 agent 注入消息。支持一次性提醒（once）、强制触发（force）与过期策略（expires）。任务随 owner session 持久化，resume 后继续触发。

## 产品定位

pi-scheduler 是 **session 存活期间的 AI 提醒器**——在 pi 进程运行、session 打开时，按计划向当前 session 注入消息。

**非系统级 cron**：

- pi 进程不开 = 不触发（与常驻后台的系统 cron daemon 不同，本扩展不是后台守护进程）
- 电脑睡眠 / 关机 = 不触发
- 不依赖系统 crontab，不注册任何开机自启

**任务归属创建它的 session**：任务物理存储在创建它的 session 的 JSONL 文件内，**只在 owner session 打开（继续对话 / resume）时才触发**。

> **这是设计决策，不是 bug（D9）**：本扩展从 cwd 级定时器改为 **session 级 AI 提醒器**——任务归属创建它的 session，只在 owner session 存活时触发。如果你每天开新 session，昨天建的"明早检查 CI"任务今天不会响，除非你 resume 昨天创建该任务的那个 session。这不是"任务丢了"：任务随 session 持久化，session 不打开就不调度。**用户若发现「昨天建的任务今天没响」，这是预期行为**，请 resume 创建该任务的 session。

## 简介与安装

pi-scheduler 是 xyz-agent 的 **mandatory 扩展**（`packages/shared/src/mandatory-extensions.json`，tier: `feature`）——xyz-agent 启动时自动安装并启用，无需手动操作。

独立 pi 环境手动安装：

```bash
npm install @zhushanwen/pi-scheduler
```

安装后扩展在 pi 会话启动时自动装配（见下节），无需额外配置。

## 激活方式

扩展 factory（`src/index.ts`）监听 pi 的 session 生命周期事件，在 `session_start` 时装配完整调用链：

```
session_start
  ├─ PiSchedulerBackend（pi.sendMessage + 时间源 + appendEntry + getEntries）
  │    └─ SchedulerRuntime（内存态 + 30s tick 调度 + 限流）
  │         └─ SchedulerService（tool/command 唯一业务入口）
  ├─ runtime.loadTasks(replay(getEntries()))  ← 重放 session JSONL 的 custom entry 折叠恢复任务
  │                                             （仅 ownerSessionFile 匹配的加载，fork 副本被过滤）
  ├─ runtime.startScheduler()                  ← 启动 30s tick
  └─ 注册 scheduler widget（每个 tick 后刷新）
```

运行时每次状态变更会 append 一条 custom entry 到创建任务的 session 的 JSONL（统一 `customType: pi-scheduler:task`，`op` 字段区分）：

| op | 触发时机 | 携带数据 |
|----|---------|---------|
| `upsert` | 创建 / 更新任务 | task 全快照（含 nextRunAt 初值、ownerSessionFile） |
| `advance` | dispatch 成功后 | 推进后的 nextRunAt、本次执行 at / status |
| `toggle` | 启用 / 停用 | enabled |
| `delete` | 删除；once 触发后自动 delete | taskId |

- fork 出的 session 重放时按 `ownerSessionFile` 过滤，不加载、不执行继承的任务副本（原 session resume 照常）
- `session_shutdown` 停止 tick + 兜底执行延迟删除 cleanup（正常路径已由首个 turn_end 完成）——任务已 append 到 JSONL，无需额外写盘

## /schedule 命令用法

注册为 `/schedule` 命令。无参数时返回 TUI 未实现提示（用 `/schedule list` 查看任务）；第一个参数匹配子命令关键词则走子命令分支，否则尝试创建任务。

### 子命令

| 子命令 | 行为 |
|--------|------|
| `/schedule list` | 列出所有任务（id、名称、调度、下次执行时间） |
| `/schedule on <id>` | 启用任务 |
| `/schedule off <id>` | 停用任务（推荐临时暂停用 off，不用 rm） |
| `/schedule rm <id>` | 删除任务 |
| `/schedule run <id>` | 立即执行任务 |
| `/schedule once <schedule> <prompt>` | 创建一次性提醒（kind=once） |
| `/schedule cron <expression> <prompt>` | 创建 cron 任务 |

任务 id 由 8 位 hex 自动生成，`list` 后从输出中获取。

### 引号转义

参数用 shell 风格引号解析（`tokenizeQuoted`，`src/commands.ts`）：

- 单引号 `'...'` 或双引号 `"..."` 内的内容作为一个 token，引号字符本身被剥离
- 含空格的多词参数（cron 表达式、prompt）**必须加引号**，否则会被拆成多个 token

例如 cron 表达式 `0 9 * * 1-5` 含空格，必须写成 `'/schedule cron '0 9 * * 1-5' standup'`；prompt `check build` 同理写成 `'/schedule 5m 'check build''`。

### 子命令补全

输入 `/schedule ` 后 Tab 补全子命令关键词（list/on/off/rm/run/once/cron）；`on`/`off`/`rm`/`run` 之后补全当前任务 id。

## schedule 语法

### duration（间隔调度）

`<数字><单位>`，数字与单位间不留空格，**大小写不敏感**：

| 单位 | 含义 | 乘数 |
|------|------|------|
| `s` / `sec` / `second` / `seconds` | 秒 | 1,000 ms |
| `m` / `min` / `minute` / `minutes` | 分 | 60,000 ms |
| `h` / `hr` / `hour` / `hours` | 时 | 3,600,000 ms |
| `d` / `day` / `days` | 天 | 86,400,000 ms |

例如：`5m`、`2h`、`1d`、`30seconds`、`2hours`。非法输入（裸数字、未知单位、空串、负值）解析失败 → 创建任务报 `INVALID_SCHEDULE`。

### cron（时间点调度）

标准 cron 表达式，支持 5 字段与 6 字段：

- **5 字段**（分 时 日 月 周）：自动补 `0` 秒字段（如 `0 9 * * 1-5` → `0 0 9 * * 1-5`）
- **6 字段**（秒 分 时 日 月 周）：原样使用

**含空格自动走 cron 分支**：schedule 输入中不含空格 → 按 duration 解析；含空格 → 按 cron 解析。因此 cron 表达式必须包含空格（正常写法天然如此），duration 不得含空格。

## 选项语义

`schedule` tool 的 `kind` / `name` / `expires` / `force` 参数（`/schedule` 命令的 `once`/`cron` 前缀对应 kind）：

| 选项 | 取值 | 语义 |
|------|------|------|
| `kind` | `recurring`（默认）/ `once` | recurring 每次触发后按 schedule 重算下次时间；once 触发一次后自动删除 |
| `name` | 字符串 | 任务可读名称，缺省从 prompt 自动生成（≤30 字原样，超长截前 27 字加省略号） |
| `expires` | duration 字符串 / `never` | recurring 任务的过期时间：`now + duration`；`never` 永不过期；缺省 7 天。**once 任务忽略 expires 参数**（触发即删，传不传都不生效） |
| `force` | `true` / `false`（默认） | `true` 时即使 agent 忙（非 idle 或有 pending 消息）也强制 dispatch；`false` 时忙则延迟到下次 tick |

## 示例

**recurring 间隔任务**（每 5 分钟检查构建）：

```
/schedule 5m 'check build'
```

**一次性提醒**（10 秒后提醒）：

```
/schedule once 10s remind
```

**cron 任务**（工作日早 9 点站会）：

```
/schedule cron '0 9 * * 1-5' standup
```

**force 立即触发**（tool 调用：即使忙也执行）：

```json
{"prompt": "deploy staging", "schedule": "*/10 * * * *", "force": true}
```

**永不过期**（tool 调用：长期 recurring 任务不设 7 天默认过期）：

```json
{"prompt": "monthly report", "schedule": "1d", "expires": "never"}
```

## 限制与运行时行为

| 限制/行为 | 值 | 说明 |
|-----------|-----|------|
| 任务上限 | **50**（`MAX_TASKS`） | 超过抛 `Task limit reached (50)`，需先删除任务 |
| 触发频率上限 | **6 次/分钟**（`RATE_LIMIT_PER_MINUTE`） | 滑动 60s 窗口。`/schedule run` 超限返回 `DISPATCH_SKIPPED`；tick 自动 dispatch 超限静默跳过 |
| tick 间隔 | **30s**（`TICK_INTERVAL_MS`） | 到期任务在下一个 tick 被 dispatch；实际触发时间可能比计划晚最多 30s |
| 默认过期 | **7 天**（`DEFAULT_EXPIRY_MS`） | recurring 任务缺省 `expires` 时；`expires: 'never'` 关闭 |
| once 任务 | 触发后自动删除 | 不参与后续调度 |
| cron 失效 | 任务停用 + `lastStatus=failed` + `lastError='cron expression invalid'` | 不会用 `now()` 兜底导致每 tick 重触发死循环 |
| 忙时 dispatch | 非 force 任务经 session delivery 内核 park 模式：忙时消息入队等待（等 agent 空闲的 settled 边沿 / 下个 tick flush 投递），不丢弃 | force=true 绕过内核队列直投 |
| history | 保留最近 **20** 条执行记录 | 超出丢弃最旧；重放折叠时同样裁剪 |
| 持久化 | custom entry append 到 session JSONL（dispatch 成功后立即 append advance 记录执行） | 任务随 owner session 持久化，resume 后重放恢复，无需额外写盘 |
| 交付语义 | **at-least-once**（至少一次） | dispatch 成功后内存更新 nextRunAt 并 append advance；append 之前若进程崩溃可能重复注入一次（无精确一次保证，可接受） |
| 延迟写入窗口 | 新 session 首 turn 内建任务后进程崩溃可能丢失 | pi 延迟写入：首条 assistant 消息前不 flush。窗口窄、概率极低、无恢复手段 |
| 触发条件 | pi 进程需存活且 session 打开 | 电脑睡眠 / pi 进程未运行 = 不触发（非系统 cron，无后台守护） |

错误语义：创建时 schedule 解析失败 → `INVALID_SCHEDULE`；`run`/`toggle`/`delete` 引用不存在的 id → `TASK_NOT_FOUND`；`run` 时任务 disabled / rate-limited / 同任务已在投递队列（TTL 窗口内）→ `DISPATCH_SKIPPED`（message 含 `disabled, rate-limited, or already queued for delivery`）。

## 数据存储位置

### 当前机制

任务存储为 custom entry，写入创建它的 session 的 JSONL 文件（统一 `customType: pi-scheduler:task`，`op` 字段区分 upsert / advance / toggle / delete）。任务物理归属于创建它的 session——`appendEntry` 把 entry 写入当前 session 的 JSONL，`getEntries()` 重放折叠恢复内存态。

### append-only

custom entry 物理追加到 JSONL，不修改、不删除——pi 依赖 JSONL 物理保留来维持 session tree 的 parentId 链。重放时 per-taskId 按 entry 顺序折叠得到当前态：

- `upsert` → 任务以快照覆盖（last-write-wins，含 ownerSessionFile / nextRunAt 初值）
- `advance` → 推进 nextRunAt、记录本次执行（at / status）
- `toggle` → 切换 enabled
- `delete` → 该任务标记消失（once 触发后自动 delete，重放即不见）

末态 = per taskId 最后一个非 delete op 的结果。

### 不进入 LLM context

pi 的 context 构建对 custom entry 无 case（被过滤）——任务数据零污染对话上下文，不影响 token / 模型上下文。

### 归属即结构性质

任务物理存在于创建 session 的 JSONL 内。**session 文件删除 = 任务消失**，无残留、无需 GC、无分片文件。fork 出的 session 不加载继承的任务副本（ownerSessionFile 过滤），subagent 也不受主 session 任务干扰。

### 旧版迁移

升级前任务存在 cwd 共享的旧 store（`~/.pi/agent/scheduler/<cwd>/scheduler.json`）。升级后首个检测到旧文件的 session 原子 `rename` 为 `scheduler.json.imported`，逐任务 appendEntry upsert 到自己的 JSONL，然后删除 `.imported`（⚠️ 删除时机依赖 flush：resumed session 已落盘可立即删；新 session（pi 延迟写入，entries 仅内存）延迟到首个 `turn_end`（该轮 message_end 已全部持久化，flush 必已发生）确认 flush 后删，`session_shutdown` 兜底；未 flush 保留 `.imported` 供崩溃恢复重导入，避免源文件销毁 + 数据未落盘的双重丢失）：

- **归属**：旧任务无 owner 信息，**归属首个完成导入的 session**（无更好近似）
- **过期任务立即触发**：导入后若 nextRunAt 已过期，**首个 tick 立即 dispatch**（once 立即注入、recurring 补跑）

### entry 累积

recurring 长期 session 的 scheduler entry 会持续累积（每次 dispatch append 一条 advance）。量级可控：约 100B/条，1h 任务运行一年约 8760 条 ≈ 876KB。且 custom entry 不进 LLM context，不影响 token / 模型上下文。**不做物理裁剪**（append-only 约束 + advance 是 nextRunAt 正确性的必要记录，不可省）。未来若成问题，方向是等 pi 提供 compaction hook，不是本 extension 自建裁剪。

## 依赖的 pi 行为清单

本扩展的存储方案（custom entry event sourcing）依赖以下 pi 源码行为。这些是**实测存在但非 SDK 契约承诺**的隐式行为，pi 升级后需逐条复核：

1. **`pi.appendEntry` / `ctx.sessionManager.getEntries()` 存在且 custom entry 不进 LLM context**：custom entry 在 pi 的 context 构建（`sessionEntryToContextMessages`）中无 case，被 flatMap 过滤，任务数据零污染对话上下文。若 pi 未来把 custom entry 纳入 context，会污染 token / 模型输入
2. **fork（`forkFrom`）全文件复制 custom entry**：forkFrom 是全文件复制（含被放弃分支的 entries，无 fork 点概念），不是 fork 点路径复制。本扩展靠 owner 过滤兜底两条复制路径。若 pi 改为按分支选择性复制，fork 隔离逻辑需重新评估
3. **`getEntries()` 返回全量 entries（不按当前分支过滤）**：实测 `getEntries()` 返回全部 fileEntries（session-manager.js:980-982），navigate 只改 leafId 指针不改 entries。因此任务不随 navigate 消失。若 pi 改为按 leafId / 分支过滤 getEntries，切换分支会导致任务丢失
4. **navigate / 切换分支不改任务 entries**：navigate 只移动 leafId 指针，不增删 custom entry，任务 entries 跨分支稳定存在。若 pi 未来在 navigate 时裁剪 entries，任务持久性会破坏

任一条行为变更都需重新验证 design 的 D1 / D2 断言与验收场景（尤其 resume、fork 场景）。

## 开发

```bash
pnpm test          # 运行全部 vitest 测试（等价 npx vitest run）
npx vitest run src/__tests__/<file>.test.ts   # 单个文件
```

测试策略：

- **依赖反转**：`SchedulerRuntime` 只依赖 `SchedulerBackend` 接口（`sendMessage` / `appendEntry` / `now`），不触碰 FS/pi。测试注入 `MockSchedulerBackend`（`src/__tests__/mock-backend.ts`，ext-simplify-08 L9 自 `src/backend.ts` 迁出的测试专用实现）实现零副作用测试
- **纯函数**：`parseDuration` / `formatDuration` / `parseSchedule` / `computeNextRunAt` / `computeNextRuns`（`src/parsing.ts`）无副作用，可直接断言
- **重放折叠**：custom entry 折叠协议（upsert / advance / toggle / delete，含 nextRunAt 重放恢复、fork owner 过滤）
- **旧 store 导入**：rename `.imported` 原子收敛（单成功者、崩溃恢复）

扩展内部结构：`backend.ts`（后端抽象）→ `replay.ts`（custom entry 重放折叠）→ `runtime.ts`（调度核心）→ `service.ts`（业务入口）→ `tool.ts` / `commands.ts`（tool 与 /schedule 命令适配层）→ `widget.ts`（状态栏 widget）→ `importer.ts`（旧 store 导入）。
