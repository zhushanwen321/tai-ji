# scheduler

定时任务调度扩展：按 duration（`5m` / `2h` / `1d`）间隔或 cron 表达式，在指定时间向 agent 注入消息。支持一次性提醒（once）与过期策略（expires）。创建入口两路：**人侧 `/schedule` 命令打开创建表单**（表单异步打开，填表时长不受命令通道超时约束），**模型侧 `schedule` tool 直建**（不再弹确认表单；参数不完整时必须先向用户澄清——见「创建方式」）。任务随 owner session 持久化，resume 后继续触发。

## 产品定位

pi-scheduler 是 **session 存活期间的 AI 提醒器**——在 pi 进程运行、session 打开时，按计划向当前 session 注入消息。

**非系统级 cron**：

- pi 进程不开 = 不触发（与常驻后台的系统 cron daemon 不同，本扩展不是后台守护进程）
- 电脑睡眠 / 关机 = 不触发
- 不依赖系统 crontab，不注册任何开机自启

**任务归属创建它的 session**：任务物理存储在创建它的 session 的 JSONL 文件内，**只在 owner session 打开（继续对话 / resume）时才触发**。

> **这是设计决策，不是 bug（D9）**：本扩展定位是 **session 级 AI 提醒器**——任务归属创建它的 session，只在 owner session 存活时触发。如果你每天开新 session，昨天建的"明早检查 CI"任务今天不会响，除非你 resume 昨天创建该任务的那个 session。这不是"任务丢了"：任务随 session 持久化，session 不打开就不调度。**用户若发现「昨天建的任务今天没响」，这是预期行为**，请 resume 创建该任务的 session。

## 简介与安装

pi-scheduler 是 taiji 的 **mandatory 扩展**（`packages/shared/src/mandatory-extensions.json`，tier: `feature`）——taiji 启动时自动安装并启用，无需手动操作。

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
| `toggle` | 启用 / 停用 | enabled（enable 时若重算了 nextRunAt 则随 op 一并携带，防 resume 回退到过期值） |
| `delete` | 删除；once 触发后自动 delete | taskId |

- fork 出的 session 重放时按 `ownerSessionFile` 过滤，不加载、不执行继承的任务副本（原 session resume 照常）
- `session_shutdown` 停止 tick + 兜底执行延迟删除 cleanup（正常路径已由首个 turn_end 完成）——任务已 append 到 JSONL，无需额外写盘

## /schedule 命令用法

注册为 `/schedule`。无参数 → 打开创建表单（空草稿，默认 `循环 + 每天 09:00`）；带参 `<schedule> <prompt>` → 打开预填表单；第一个参数匹配子命令关键词则走子命令分支。命令 handler **异步打开表单后立即返回**——用户在表单里停留多久都不会触发命令通道的 60s 超时（会话级提醒器不该因为「用户想了两分钟」而报错）。

### 子命令

| 子命令 | 行为 |
|--------|------|
| `/schedule` | 打开创建表单（空草稿；默认循环 + 每天 09:00） |
| `/schedule <schedule> <prompt>` | 打开预填时间/提示词的创建表单（如 `/schedule 5m 'check build'`） |
| `/schedule list` | 列出所有任务（id、名称、调度、下次执行时间） |
| `/schedule on <id>` | 启用任务 |
| `/schedule off <id>` | 停用任务（推荐临时暂停用 off，不用 rm） |
| `/schedule rm <id>` | 删除任务 |
| `/schedule run <id>` | 立即执行任务 |

一次性（once）与 cron 的形态由**表单内**选择/填写（执行模式切换 + 自定义 cron 输入），不再有 `once` / `cron` 关键字子命令。任务 id 由 8 位 hex 自动生成，`list` 后从输出中获取。

### 引号转义

参数用 shell 风格引号解析（`tokenizeQuoted`，`src/commands.ts`）：

- 单引号 `'...'` 或双引号 `"..."` 内的内容作为一个 token，引号字符本身被剥离
- 含空格的多词参数（cron 表达式、prompt）**必须加引号**，否则会被拆成多个 token

例如 prompt `check build` 写成 `/schedule 5m 'check build'`（预填表单的提示词字段）。引号只包住含空格的那个参数本身，不要在外层再套引号（嵌套引号会拆出错误 token）。

### 子命令补全

输入 `/schedule ` 后 Tab 补全子命令关键词（list/on/off/rm/run）；`on`/`off`/`rm`/`run` 之后补全当前任务 id。

## schedule 语法

### duration（间隔调度）

`<数字><单位>`，数字与单位间不留空格，**大小写不敏感**：

| 单位 | 含义 | 乘数 |
|------|------|------|
| `s` / `sec` / `second` / `seconds` | 秒 | 1,000 ms |
| `m` / `min` / `minute` / `minutes` | 分 | 60,000 ms |
| `h` / `hr` / `hour` / `hours` | 时 | 3,600,000 ms |
| `d` / `day` / `days` | 天 | 86,400,000 ms |

例如：`5m`、`2h`、`1d`、`30seconds`、`2hours`。非法输入（裸数字、未知单位、空串、负值）解析失败：`schedule` tool 在预校验即报错（`Invalid parameters: unrecognized schedule "..."`，修正参数后重调）；`/schedule` 命令在 `json`/`print` 模式带参直建时报 `Invalid schedule: "..."`（rpc/tui 模式则由表单提交后报错）。

### cron（时间点调度）

标准 cron 表达式，支持 5 字段与 6 字段：

- **5 字段**（分 时 日 月 周）：自动补 `0` 秒字段（如 `0 9 * * 1-5` → `0 0 9 * * 1-5`）
- **6 字段**（秒 分 时 日 月 周）：原样使用

**含空格自动走 cron 分支**：schedule 输入中不含空格 → 按 duration 解析；含空格 → 按 cron 解析。因此 cron 表达式必须包含空格（正常写法天然如此），duration 不得含空格。

## 选项语义

任务创建与管理由两个 tool 承担：`schedule`（`prompt` / `schedule` / `kind` / `name` / `expires` / `model`）与 `schedule_control`（`action`: list / toggle / delete / run，附 `id` / `enabled`）。`schedule` 的参数即**创建参数**：调用直接创建任务，无确认表单（见「创建方式」）。下表为 `schedule` tool 的选项语义（`/schedule` 表单的 once / cron 形态对应 kind / 自定义 cron）：

| 选项 | 取值 | 语义 |
|------|------|------|
| `kind` | `recurring`（默认）/ `once` | recurring 每次触发后按 schedule 重算下次时间；once 触发一次后自动删除 |
| `name` | 字符串 | 任务可读名称，缺省从 prompt 自动生成（≤30 字原样，超长截前 27 字加省略号） |
| `expires` | duration 字符串 / `never` | recurring 任务的过期时间：`now + duration`；`never` 永不过期；缺省 7 天。**once 任务忽略 expires 参数**（触发即删，传不传都不生效） |
| `model` | scoped model id（`provider/model`） | 任务执行所用模型；缺省跟随会话当前模型 |

## 创建方式（触发反转）

两条路径，职责不同：

**人侧 `/schedule`**：打开创建表单（GUI 由 FormOverlay 的 ScheduleForm 渲染，TUI 由 `ScheduleCreateComponent`），用户在表单里自选模式/时间/模型/提示词后创建。命令 handler **异步打开表单后立即返回**——填表时长不受命令通道超时约束。模式矩阵：

| 形态 | 会话模式 | 交互 |
|------|---------|------|
| GUI 表单 | rpc | 统一表单协议（`uiFormInteract` + marker select 通道）：FormOverlay 弹出 schedule 表单，预填草稿经 initial 直传；命令立即返回，交互在回包窗口之外续跑 |
| TUI 表单 | tui | `ctx.ui.custom` 挂 `ScheduleCreateComponent`：模式 → 时间 → 模型 → 提示词 → 提交 五 tab 逐项确认，两段 Esc 取消 |
| 非交互 | json / print | 不做交互：带参 `<schedule> <prompt>` → 直建（成功看 session entry，`/schedule list` 可验）。无参或带参失败（非法表达式 / 缺 prompt）→ **抛错**（该模式 `ctx.ui.notify` 是 no-op、handler 返回值被丢弃，stderr 是唯一可见通道） |

**模型侧 `schedule` tool**：直接创建（无确认表单、无 headless「未经确认」附注）。参数不完整时必须**先经 ask-user / 对话澄清**，禁止猜测频率后静默创建（`promptGuidelines` 硬性条目）。创建成功的 tool result 含任务 id 与后续运行时刻，模型应复述给用户以便核对/撤销。

表单通道/协议的失败折叠（命令路径）：

| 态 | 触发 | 结果 |
|----|------|------|
| cancelled | 用户取消表单 | 不创建、无 toast（取消不是错误） |
| channel-error | RPC 交互通道不可用：select reject，或回包回显请求 payload（宿主不识别表单协议的旧组合） | `ctx.ui.notify(..., 'error')` 提示通道不可用 / 升级宿主；**本会话后续 `/schedule` 直接给同样提示，不重复试探** |
| non-json | 回包形状非法（非协议 JSON / 非 ScheduleFormResult）= 协议版本错配 | `ctx.ui.notify(..., 'error')` 提示协议版本错配 |
| abort | `session_shutdown`（quit/reload/new/resume/fork）→ 命令路径自持 AbortController abort | 不创建、无 toast（taiji 内切换会话不触发，表单保留且仍有效） |

取消/超时不是错误：不创建、无 toast。命令路径的错误出口统一按 mode 分流——rpc / tui 走 `notify(..., 'error')`（pi 会把 handler 异常折成 renderer 不消费的 `extension.error`，throw 在 rpc 下静默丢弃）；json / print 一律 `rethrow`。

### 文案与语言（L2 本地化）

命令反馈（创建/列表/启停/删除/用法/错误提示）与 TUI widget 文本、托盘标题均由扩展侧词典（`src/i18n.ts`）按当前界面语言渲染；语言经 `<dataDir>/ui-preferences.json`（runtime 写、扩展只读，见 data-source-registry 登记行）就地读取，文件缺失/损坏回落 `en-US`。`/schedule` 的 registerCommand.description 是注册期静态串、托盘标题随 widget 刷新（≤30s）跟进语言——两者切语言后不会立即热更（已接受滞后）。

模型可见文案（`schedule` tool 的 `description` / `promptGuidelines` / tool result）**保持英文**，不经 L2 词典——两受众不串（本地化不得污染 tool result）。

## 示例

**recurring 间隔任务**（`/schedule` 打开预填表单，确认后创建）：

```
/schedule 5m 'check build'
```

**交互创建**（无参打开空表单，表单里选每天 09:00）：

```
/schedule
```

**一次性提醒**：在 `/schedule` 表单里把执行模式切到「一次性」并选时刻。

**cron 任务**：在 `/schedule` 表单里选自定义 cron 并填表达式（如 `0 9 * * 1-5`）。

**非交互创建**（json/print 模式，无表单可开，带参直建）：

```
pi -p "/schedule 5m 'check build'"
```

**立即执行**（schedule_control tool 调用：马上 dispatch 现有任务）：

```json
{"action": "run", "id": "<task-id>"}
```

**永不过期**（`schedule` tool 调用：直接创建长期 recurring 任务）：

```json
{"prompt": "monthly report", "schedule": "1d", "expires": "never"}
```

## 限制与运行时行为

| 限制/行为 | 值 | 说明 |
|-----------|-----|------|
| 任务上限 | **50**（`MAX_TASKS`） | 超过抛 `Task limit reached (50)`，需先删除任务 |
| 触发频率上限 | **6 次/分钟**（`RATE_LIMIT_PER_MINUTE`） | 滑动 60s 窗口。`/schedule run` 超限返回 not dispatched（disabled, rate-limited, or dispatch in flight）；tick 自动 dispatch 超限静默跳过 |
| tick 间隔 | **30s**（`TICK_INTERVAL_MS`） | 到期任务在下一个 tick 被 dispatch；实际触发时间可能比计划晚最多 30s |
| 默认过期 | **7 天**（`DEFAULT_EXPIRY_MS`） | recurring 任务缺省 `expires` 时；`expires: 'never'` 关闭 |
| once 任务 | 触发后自动删除 | 不参与后续调度 |
| cron 失效 | 任务停用 + `lastStatus=failed` + `lastError='cron expression invalid'` | 不会用 `now()` 兜底导致每 tick 重触发死循环 |
| 忙时 dispatch | steer 直投（scheduler-steer-direct-dispatch） | busy 时消息插入当前 turn、idle 时开新 turn（`{deliverAs:'steer', triggerTurn:true}`），受理即记账不排队；同任务 in-flight 守卫防双投 |
| history | 保留最近 **20** 条执行记录 | 超出丢弃最旧；重放折叠时同样裁剪 |
| 持久化 | custom entry append 到 session JSONL（dispatch 成功后立即 append advance 记录执行） | 任务随 owner session 持久化，resume 后重放恢复，无需额外写盘 |
| 交付语义 | **at-least-once**（至少一次） | dispatch 成功后内存更新 nextRunAt 并 append advance；append 之前若进程崩溃可能重复注入一次（无精确一次保证，可接受） |
| 延迟写入窗口 | 新 session 首 turn 内建任务后进程崩溃可能丢失 | pi 延迟写入：首条 assistant 消息前不 flush。窗口窄、概率极低、无恢复手段 |
| 触发条件 | pi 进程需存活且 session 打开 | 电脑睡眠 / pi 进程未运行 = 不触发（非系统 cron，无后台守护） |

错误语义（无错误码；双受众分派——`message` 英文回退供 tool result / `messageKey`+`params` 供命令层词典渲染，见「文案与语言」）：`schedule` tool 创建时参数预校验失败（prompt 空 / schedule 非法）→ 直接 throw `Invalid parameters: ...`（修正参数后重调）；`/schedule` 命令 `json`/`print` 模式带参解析失败 → throw 词典文案（en: `Invalid schedule: "..."`）；`run`/`toggle`/`delete` 引用不存在的 id / `run` 时任务 disabled / rate-limited / 同任务在途 / 任务数超上限 → 命令层 toast 按词典本地化（en 示例：`Task <id> not found` / `Task <id> not dispatched (disabled, rate-limited, or dispatch in flight)` / `Task limit reached (50) — delete one first`）。表单交互的取消/abort 不是错误（不创建、无 toast）；通道失败/回包非法在 rpc/tui 走 `notify(..., 'error')`、在 json/print 走 throw——见「创建方式」。

## 数据存储位置

### 当前机制

任务存储为 custom entry，写入创建它的 session 的 JSONL 文件（统一 `customType: pi-scheduler:task`，`op` 字段区分 upsert / advance / toggle / delete）。任务物理归属于创建它的 session——`appendEntry` 把 entry 写入当前 session 的 JSONL，`getEntries()` 重放折叠恢复内存态。

### append-only

custom entry 物理追加到 JSONL，不修改、不删除——pi 依赖 JSONL 物理保留来维持 session tree 的 parentId 链。重放时 per-taskId 按 entry 顺序折叠得到当前态：

- `upsert` → 任务以快照覆盖（last-write-wins，含 ownerSessionFile / nextRunAt 初值）
- `advance` → 推进 nextRunAt、记录本次执行（at / status）
- `toggle` → 切换 enabled
- `delete` → 该任务标记消失（once 触发后自动 delete，重放即不见）

末态 = per taskId 全序列折叠的结果：最后一次 delete 之后若无后续 upsert 则任务不存在；advance / toggle 为增量 op，叠加在其 upsert 快照之上。

### 不进入 LLM context

pi 的 context 构建对 custom entry 无 case（被过滤）——任务数据零污染对话上下文，不影响 token / 模型上下文。

### 归属即结构性质

任务物理存在于创建 session 的 JSONL 内。**session 文件删除 = 任务消失**，无残留、无需 GC、无分片文件。fork 出的 session 不加载继承的任务副本（ownerSessionFile 过滤），subagent 也不受主 session 任务干扰。

### 旧版迁移

升级前任务存在 cwd 共享的旧 store（`~/.pi/agent/schedule/` 下按 cwd 路径展开的 `scheduler.json`；导入时同时探测 `getAgentDir()` 下的同形路径）。升级后首个检测到旧文件的 session 原子 `rename` 为 `scheduler.json.imported`，逐任务 appendEntry upsert 到自己的 JSONL，然后删除 `.imported`（⚠️ 删除时机依赖 flush：resumed session 已落盘可立即删；新 session（pi 延迟写入，entries 仅内存）延迟到首个 `turn_end`（该轮 message_end 已全部持久化，flush 必已发生）确认 flush 后删，`session_shutdown` 兜底；未 flush 保留 `.imported` 供崩溃恢复重导入，避免源文件销毁 + 数据未落盘的双重丢失）：

- **归属**：旧任务无 owner 信息，**归属首个完成导入的 session**（无更好近似）
- **过期任务立即触发**：导入后若 nextRunAt 已过期，**首个 tick 立即 dispatch**（once 立即注入、recurring 补跑）

### entry 累积

recurring 长期 session 的 scheduler entry 会持续累积（每次 dispatch append 一条 advance）。量级可控：约 250B/条，1h 任务运行一年约 8760 条 ≈ 2MB。且 custom entry 不进 LLM context，不影响 token / 模型上下文。**不做物理裁剪**（append-only 约束 + advance 是 nextRunAt 正确性的必要记录，不可省）。未来若成问题，方向是等 pi 提供 compaction hook，不是本 extension 自建裁剪。

## 依赖的 pi 行为清单

本扩展的存储方案（custom entry event sourcing）依赖以下 pi 源码行为。这些是**实测存在但非 SDK 契约承诺**的隐式行为，pi 升级后需逐条复核：

1. **`pi.appendEntry` / `ctx.sessionManager.getEntries()` 存在且 custom entry 不进 LLM context**：custom entry 在 pi 的 context 构建（`sessionEntryToContextMessages`）中无 case，被 flatMap 过滤，任务数据零污染对话上下文。若 pi 未来把 custom entry 纳入 context，会污染 token / 模型输入
2. **fork（`forkFrom`）全文件复制 custom entry**：forkFrom 是全文件复制（含被放弃分支的 entries，无 fork 点概念），不是 fork 点路径复制。本扩展靠 owner 过滤兜底两条复制路径。若 pi 改为按分支选择性复制，fork 隔离逻辑需重新评估
3. **`getEntries()` 返回全量 entries（不按当前分支过滤）**：实测 `getEntries()` 返回全部 fileEntries（session-manager.js:982-984），navigate 只改 leafId 指针不改 entries。因此任务不随 navigate 消失。若 pi 改为按 leafId / 分支过滤 getEntries，切换分支会导致任务丢失
4. **navigate / 切换分支不改任务 entries**：navigate 只移动 leafId 指针，不增删 custom entry，任务 entries 跨分支稳定存在。若 pi 未来在 navigate 时裁剪 entries，任务持久性会破坏

任一条行为变更都需重新验证 design 的 D1 / D2 断言与验收场景（尤其 resume、fork 场景）。

## 开发

```bash
pnpm test          # 运行全部 vitest 测试（等价 npx vitest run）
npx vitest run src/__tests__/<file>.test.ts   # 单个文件
```

测试策略：

- **依赖反转**：`SchedulerRuntime` 只依赖 `SchedulerBackend` 接口（`sendMessage` / `appendEntry` / `now`），不触碰 FS/pi。测试注入 `MockSchedulerBackend`（`src/__tests__/mock-backend.ts` 测试专用实现）实现零副作用测试
- **纯函数**：`parseDuration` / `formatDuration` / `parseSchedule` / `computeNextRunAt` / `computeNextRuns`（`src/parsing.ts`）无副作用，可直接断言
- **重放折叠**：custom entry 折叠协议（upsert / advance / toggle / delete，含 nextRunAt 重放恢复、fork owner 过滤）
- **直建流**：`handleSchedule` 预校验 / abort / 参数透传（`src/__tests__/tool-create-flow.test.ts`）；命令路径表单（无参 / 带参预填 / 取消 / 提交 / channel-error / non-json / echo / 模式矩阵 / 异步不阻塞 / json·print throw，`src/__tests__/commands-form.test.ts`）；交互生命周期（草稿构造 + AbortController 注册表，`src/__tests__/interaction.test.ts`）
- **旧 store 导入**：rename `.imported` 原子收敛（单成功者、崩溃恢复）

扩展内部结构：`backend.ts`（后端抽象）→ `replay.ts`（custom entry 重放折叠）→ `runtime.ts`（调度核心）→ `service.ts`（业务入口）→ `tool.ts`（tool 直建流）/ `commands.ts`（/schedule 命令适配层）→ `interaction.ts`（表单交互 / 协议错配 / AbortController 生命周期）→ `create-form-component.ts`（TUI 创建表单组件，由 `interaction.ts` 消费）→ `widget.ts`（双模状态栏 widget：GUI 结构化 meta + TUI 文本行）→ `i18n.ts`（L2 词典 / locale 读取 / 结果渲染）→ `importer.ts`（旧 store 导入）。
