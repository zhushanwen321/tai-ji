# todo 扩展架构

> 现状架构文档。对外契约见 `README.md`。
>
> 功能分级：P2（依据见 [docs/feature-priorities.md](../../../docs/feature-priorities.md) §6——面板能力，挂了主链路完整）。

## 1. 模块依赖

```
                    ┌─────────────┐
                    │  index.ts   │  工厂入口：创建 state + 注册全部
                    └──────┬──────┘
        ┌──────────┬───────┼────────┬──────────┐
        ▼          ▼       ▼        ▼          ▼
   ┌─────────┐ ┌────────┐ ┌──────┐ ┌───────┐ ┌──────────┐
   │ state   │ │handlers│ │ tool │ │render │ │ commands │
   └────┬────┘ └───┬────┘ └──┬───┘ └───┬───┘ └────┬─────┘
        │          │         │        │          │
        │    ┌─────┘    ┌────┘        │          ▼
        ▼    ▼          ▼             │     ┌──────────┐
      ┌─────────────────────┐         │     │component │
      │      model.ts       │◄────────┴─────┤  (TUI)   │
      │  (纯函数数据层)      │◄──────────────┤          │
      └─────────────────────┘               └──────────┘
```

- `model.ts` 是依赖底座（纯函数，无 Pi 运行时依赖），被 state/tool/handlers/render/component 引用
- `tool.ts` 依赖 `render`（renderTodoResult）+ `model` + `state`
- `commands.ts` 依赖 `component`（TUI 视图）
- `state.ts` 只依赖 `model` 的 `Todo` 类型

## 2. 会话状态（TodoSessionState）

闭包内创建，被 tool / handlers / commands 共享同一引用（原地修改）。

| 字段 | 类型 | 用途 |
|------|------|------|
| `todos` | `Todo[]` | 当前任务列表 |
| `nextId` | `number` | 自增 ID 计数器（auto-clear 清空或 add auto-GC 时重置为 1） |
| `userMessageCount` | `number` | **agent 轮次计数**（命名误导，仅在 `agent_start` 递增，非"用户消息数"）。auto-clear 延迟判定的基准 |
| `allCompletedAtCount` | `number\|null` | 首次全 completed 时的轮次锚点，用于 auto-clear 延迟判定 |
| `completionSteered` | `boolean` | completion steer 单次锁（防重复注入"检查交付质量"） |
| `pendingSteerMessage` | `string\|null` | **跨 turn steer 载体**：`agent_end` 写，`before_agent_start` 读 |

## 3. 事件生命周期

注册点：`index.ts` → `registerTodoEventHandlers(pi, state, refreshDisplay)`。

```
[session_start]  reconstructState + refreshDisplay    （冷启动 / 子会话，仅恢复）
[session_tree]   同上

  用户消息
    │
    ▼
[agent_start]           userMessageCount++             （轮次计数，唯一递增点）
    │
    ▼
[before_agent_start]    ① setStatus("todo", "📋 N pending")（有未完成时）
                        ② pendingSteerMessage 非空？→ 消费它（display:false，用户不可见）
                           否则 → buildBeforeAgentStartMessage（pending 注入 todo_context）
    │
    ▼
  agent 执行             （可能调用 todo tool）
                           executeTodoAction（tool.ts）:
                             handler 分派 → refreshDisplay（status line + widget 刷新）
    │
    ▼
[agent_end]             双机制判定 → 可能设置 pendingSteerMessage
    │
    └──► 下一 turn 的 [before_agent_start] 消费 pendingSteerMessage（延迟一拍）
```

**核心设计**：steer 延迟注入。`agent_end` 设置变量，**下一个** `before_agent_start` 消费，确保 steer 影响下一轮 agent 行为而非已结束的当前轮。

## 4. Steer 机制详解

### 4.1 `agent_end` 判定流程

```
if todos.length === 0 → return                       （无任务不处理）

handleCompletionSteer(state)   ← 不短路！继续往下
    条件: !completionSteered && todos 非空 && 全 completed
    动作: completionSteered = true
          pendingSteerMessage = "检查交付质量"

{handled, cleared} = handleAutoClear(state)
    if !全completed: allCompletedAtCount=null; return {false,false}   ← 未 handled，直接走完
    if allCompletedAtCount===null: allCompletedAtCount = userMessageCount
    if userMessageCount - allCompletedAtCount >= 2:
        清空 todos + nextId=1 + 重置标记; return {true,true}          ← handled 短路
    else: return {true,false}                                        ← handled 短路
if handled → (cleared 则 refreshDisplay) return
```

### 4.2 机制阈值

| 机制 | 常量 | 值 | 设计意图 |
|------|------|----|---------|
| auto-clear | `AUTO_CLEAR_DELAY_ROUNDS` | 2 | 全完成后给 2 轮缓冲（让 completion steer 有机会消费）再清空 |
| add auto-GC | （条件式，无常量） | — | 旧列表全部 completed 时 add 先清空旧列表再新增（`model.addTodos`），开启新任务即时刻清理，不等 auto-clear 的 2 轮缓冲 |
| over-limit reminder | `RECOMMENDED_MAX_TODOS` | 10 | add 后总数超过 10 → resultText 附加提醒（软约束不拒绝），引导合并细粒度步骤或 delete 瘦身 |

### 4.3 add 时 auto-GC（tool 层）

`handleAdd` 调用 `addTodos` 后，若返回 `autoCleared=true`（旧列表全部 completed 被清理），
同步重置 `allCompletedAtCount=null` + `completionSteered=false`——语义是「开启新任务周期」。
不重置会让上一任务的 `completionSteered=true` 屏蔽新任务全部完成时的质量检查 steer。

### 4.4 反直觉点

1. **`agent_end` 短路顺序不对称**：completion-steer 不 `return`，auto-clear 命中（`handled`）则 `return`。即使即将 auto-clear，本轮 completion steer 仍会先被置位。
2. **completion-steer 与 auto-clear 的竞态**：全 completed 后 completion-steer 先置 steer，但 auto-clear 可能在 steer 被 `before_agent_start` 消费前就清空 todos。下一 turn 消费 steer 时 todos 已空，"检查交付质量"steer 仍有意义。
3. **`userMessageCount` 命名误导**：实为 agent 轮次计数，只在 `agent_start` 递增。

## 5. 持久化与重建

todo **不调用 `appendEntry`**（全 src 零调用），复用 Pi 框架自动记录的 toolResult entry：

```
tool execute 返回 {content, details:{todos, nextId}}
        │
        ▼  Pi 框架自动序列化为 toolResult entry 落盘
```

tool result 不含 GUI 渲染字段（已移除）：状态展示由 widget 单一承载——RPC 模式走 `refreshDisplay` 的 `guiSetWidget` 推送（M17 对话流 widget 面板），TUI 模式走 `renderWidgetLines` 原生文本。

```
session_start / session_tree
        │
        ▼
reconstructState（纯读，H1：不修改 entries）:
  1. 遍历 getEntries()，顺序扫描所有 role=toolResult && toolName=todo 的 entry
  2. 每条快照的 details.todos 逐条过 migrateTodo（脏数据单条跳过，不中断回放），
     保留最后一条有效快照到 state（todos + nextId）
  3. nextId 缺失 → fallback max(id)+1 或 1
```

**为什么不做 entry GC**：Pi 的 `SessionManager.getEntries()` 返回 filter-copy，splice 对真实 entries 无效（H1 决策，steer.test.ts「TC10: 不修改传入的 entries」钉住）；旧 todo toolResult 留在 session 文件中无害。

**隐含前提**：所有状态变更必须走 todo tool（成立，因为只有 tool 能改 state.todos），故"最后一条 toolResult 快照"等价完整状态。

`migrateTodo` 向后兼容三路：
1. `status ∈ VALID_STATUSES` → 直接用
2. 旧五态：`verifying → in_progress`、`failed → pending`
3. 极旧：`done:true → completed`、`done:false → pending`

## 6. 渲染常量

| 常量 | 值 | 含义 |
|------|----|------|
| `WIDGET_MAX_LINES` | 9 | Pi 限制 widget 10 行，保守 -1 |
| `SINGLE_COLUMN_BUDGET` | 8（= `WIDGET_MAX_LINES - 1`） | ≤8 项单列，≥9 项双列 |
| `MAX_COLLAPSED_ITEMS` | 5 | tool result collapsed 显示前 5 项 + `... N more` |
| `FALLBACK_TERM_WIDTH` | 80 | 无 TTY 时的终端宽度兜底 |

## 7. 错误处理约定

handler 失败**直接 `throw new Error()`**，不返回错误成功模式（见 CLAUDE.md「Tool 设计」）。

- `model.ts` 纯函数：`addTodos` 校验失败直接 throw（C1：不静默 filter）；`updateTodos` 返回带可选 `error` 的 Result 对象（合法的函数式模式，不是"错误成功模式"）
- `tool.ts` 的 handler：`updateTodos` 拿到 error 时 `throw new Error(r.resultText)`，把友好文案交给 Pi 框架
- `TodoDetails` 接口**不含 `error` 字段**（已移除），`renderTodoResult` 无 error 分支
