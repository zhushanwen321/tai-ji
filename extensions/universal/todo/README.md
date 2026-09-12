# todo

轻量三态任务清单 — `pending` / `in_progress` / `completed`。支持 session 持久化、状态栏、单双列自适应 widget、`/todos` TUI 视图，以及延迟 steer 驱动任务推进。

## 设计定位

| 维度 | todo | goal |
|------|------|------|
| 状态机 | **刻意无约束**，任意状态自由流转（含反向） | 6 态状态机（active/paused/blocked/complete/budget_limited/cancelled） |
| 持久化 | 复用 Pi 的 toolResult entry（不调用 appendEntry） | appendEntry 主动写入 |
| 定位 | 多步骤工作的临时进度追踪 | 持久化目标驱动循环（完成需逐条对照 successCriteria） |

`in_progress` 非强制，`pending → completed` 直接跳转合法。

## 安装

```bash
pi install npm:@zhushanwen/pi-todo
```

## todo tool

### Action 与参数

| action | 参数 | 必填 | 行为 |
|--------|------|------|------|
| `list` | — | — | 返回全部 todo |
| `add` | `texts: string[]` | 是 | 批量追加，自动分配连续 ID，初始 `status=pending` |
| `update` | `id` + `status` 或 `text`；**或** `updates: Array<{id, status?, text?}>` | `id` 必填 | `updates[]` **优先于** single 的 `id/status/text` |
| `delete` | `ids: number[]` | 是 | 批量删除；**部分 id 缺失则整体拒绝**（原子性） |

- `status` 枚举：`pending` / `in_progress` / `completed`
- `add` 不接受 `status`（恒为 pending），不存在 `verifyTexts`（goal 侧的对应概念是 `successCriteria`）
- 全部 completed 后由 **auto-clear 机制**延迟 2 轮自动清空并重置 `nextId=1`（无手动 clear action）
- **add 时 auto-GC**：旧列表全部 completed 时，add 自动清空旧列表再新增（`nextId` 重置 1），开启新任务无需先手动清理
- **规模软上限**：建议 todo 总数不超过 10 个；add 后总数超过 10 时在结果中附加提醒（不拒绝，合并细粒度步骤或 delete 瘦身由模型自决）

### 错误处理约定

handler 失败**直接 `throw new Error()`**，不返回错误成功模式（见 CLAUDE.md「Tool 设计」）。常见错误：

| 触发 | 错误信息 |
|------|---------|
| `add` 缺 `texts` | `add requires texts parameter (non-empty array)` |
| `update` 缺 `id` | `update requires id parameter` |
| `update` 缺 `status` 和 `text` | `update requires at least status or text parameter` |
| `update` `text` 空串 | `text cannot be empty or whitespace-only` |
| `update` `status` 非法 | `status only accepts pending / in_progress / completed` |
| `update`/`delete` id 不存在 | `Todo #N not found` |
| `delete` 缺 `ids` | `delete requires ids parameter (non-empty array)` |

schema 为扁平 `Type.Object`（OpenAI 兼容）：字段全 Optional，缺失必填与双形陷阱（`text`/`texts`、`id`/`ids`）由 handler 运行时校验兜底。

## Steer 机制（延迟注入）

todo 的核心驱动力是「延迟一拍」的 steer：

```
agent_end 设置 pendingSteerMessage
        → 下一 turn 的 before_agent_start 消费（用户不可见，display:false）
```

两个子机制（handlers.ts）：

| 机制 | 触发 | 行为 |
|------|------|------|
| **completion-steer** | 首次全部 completed | 注入「检查交付质量」steer（一次性，`completionSteered` 防重） |
| **auto-clear** | 全部 completed 后再过 2 轮 | 自动清空 todos + 重置标记 |

`agent_end` 内：completion-steer **不短路**（继续往下），auto-clear 命中（`handled`）则短路 return。详见 `ARCHITECTURE.md`。

## 持久化机制

todo 扩展**自己不调用 `appendEntry`**。状态快照随 Pi 框架自动记录的 toolResult entry 落盘：

1. 每次 todo tool 调用，`execute` 返回的 `details.todos` / `details.nextId` 被 Pi 自动序列化为一条 `toolResult` entry
2. `session_start` / `session_tree` 时，`reconstructState` 回放**最后一条** todo toolResult 重建状态（纯读——Pi 的 getEntries 返回 filter-copy，splice 无效，不做 entry GC）
3. 向后兼容：`migrateTodo` 把旧五态（`verifying→in_progress`、`failed→pending`）和极旧的 `done:boolean` 降级映射到三态

## 三层渲染

| 层 | 触发 | 规则 |
|----|------|------|
| **status line** | 每次 tool execute / session 恢复 | 空列表不显示；全完成 `✓ c/t`（绿）；否则 `☑ c/t` |
| **widget**（侧边） | 有 todo 时 | ≤8 项单列；≥9 项双列（规避 Pi 的 10 行 widget 截断） |
| **tool result** | tool 返回时 | collapsed 显示前 5 项 + `... N more`；expanded 全显示 |

## 命令

`/todos` — 进入只读 TUI 视图（`TodoListComponent`，固定双列布局）。Escape / Ctrl+C 关闭。需 interactive mode。

## 文件结构

```
todo/
├── index.ts              # 工厂入口（re-export src/index.ts）
├── ARCHITECTURE.md       # 架构详图（文件依赖 + steer 时序 + 事件流）
└── src/
    ├── index.ts          # 工厂入口（创建 state + 注册 tool/command/event + makeRefreshDisplay）
    ├── state.ts          # TodoSessionState 会话状态接口 + 工厂
    ├── model.ts          # 纯函数数据层（类型/迁移/addTodos/updateTodos/format/buildGui）
    ├── tool.ts           # todo tool 注册 — 4 action + execute dispatcher
    ├── handlers.ts       # 5 事件处理器 + reconstructState + steer 双机制（autoClear/completion）
    ├── render.ts         # status line / widget / tool result 三层渲染
    ├── component.ts      # /todos 的 TodoListComponent TUI 组件
    ├── commands.ts       # /todos 命令注册
    └── __tests__/        # 单测（model 纯函数 + widget 布局 + steer/回放 + schema/detector/prompt 回归）
```
