# ext-simplify-07：universal/todo 过度设计收敛（updateTodos 双错误协议统一 + low 群移交）

> **一句话结论**：删除 updateTodos 的「Result 双字段 + dispatcher 翻译」错误协议——校验失败改为与同包 addTodos / handleSingleUpdate / handleDelete 一致的直接 throw，UpdateResult 收敛为 `{ updatedTodos, resultText }` 两必填字段并去 export，包内错误通道归一为单一 throw 协议；模型可见错误文案仅两处微调（去冗余 "Error: " 前缀、id not found 对齐单条路径措辞），持久化与渲染链路零触及。low 群（双布尔返回值、completed 计数 4 处重复等 6 项）登记移交 code-simplify，不在本设计实施。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-todo`（v0.8.9）是 universal 组独立通用包——轻量三态任务清单（pending / in_progress / completed），`todo` tool 提供 list/add/update/delete 四 action，状态持久化复用 pi 框架自动记录的 toolResult entry details（不 appendEntry），配 agent_end → before_agent_start 延迟 steer、/todos 命令 TUI 视图、TUI 状态行 + widget 与 GUI widget 推送。8 个源文件约 670 行 src。
- **C（冲突）**：2026-09-11 过度设计审计证实本包整体健康（7 条「疑似本质复杂度」全部判保留），但 updateTodos 存在包内唯一的错误协议双轨：同一函数内 text 空串走 throw、其余 4 类校验走 `{error, resultText}` 双字段 Result，唯一调用方 handleBatchUpdate 拿到后立刻把 Result 翻译回 throw（`if (r.error) throw new Error(r.resultText)`）——error 字段全仓无第二读者，每处错误 return 同步写两遍文案，且 tool.ts / index.ts / ARCHITECTURE.md 三处注释为这套双轨背书。
- **Q（问题）**：如何在不改变工具对外行为（details 落盘形状、成功文案、渲染链路）的前提下，把包内错误通道收敛为单一协议，消灭双字段重复与翻译层，并把审计 low 群显式移交实现阶段批量清理？
- **A（答案）**：updateTodos 全 throw 化 + UpdateResult 收敛成功形状（方案对比见 §5 D1）；错误文案向包内既有措辞收敛（D2）；low 群登记移交 code-simplify（D4）。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务清单 + 测试改写清单），层敏感准则 5/6/7 按改动大小匹配适用（本设计为协议收敛级小改动，数据流与运行时断言以 by-construction 论证为主、真实场景探针为辅）。

**证据基线**：本文化引行号均为 2026-09-12 实读值（worktree feat-optimize-extensions-over-engineering）。**审计修正（行号微移，不影响决策）**：审计记 M4 为 `model.ts:172-213 / tool.ts:102-108`，实读为 UpdateResult 接口 `model.ts:165-169`、updateTodos 函数 `model.ts:171-227`（4 处双字段 return 在 :183-212）、handleBatchUpdate `tool.ts:102-107`；审计记 handleAutoClear `handlers.ts:104-121`，实读 `handlers.ts:97-114`；completed 计数 4 处实读为 `model.ts:89 / render.ts:44 / render.ts:115 / component.ts:53`（审计记录记 model.ts:140-142 / render.ts:68-72）。pi 断言无关（本设计不涉 pi SDK 行为假设）；npm ls 核对 pi 实装 0.84.4。

---

## 1. 背景：被设计的系统是什么

**todo extension 解决的问题是「多步骤工作的进度对模型与用户都可见、可续」**。模型经 `todo` tool 自主建单/更新；每次工具调用的最终列表快照随 pi 框架自动序列化的 toolResult entry 落盘（`details: {action, todos, nextId}`，**无 error 字段**——model.ts:22-26、ARCHITECTURE.md:154），session 重开时 `reconstructState`（handlers.ts:59-93）回放最后一条 todo toolResult 重建状态。展示面四条通道：模型侧文本（formatTodoList）、TUI 状态行（renderStatusText）、TUI widget / GUI widget（buildGui / renderWidgetLines）、/todos 全屏命令视图（TodoListComponent）。

**错误处理现状约定**（tool.ts:67-70 注释自述）：handler 失败直接 throw，把文案交给 pi 框架以工具错误展示；「model 层纯函数（updateTodos）返回 Result 对象（合法），由 dispatcher 在拿到 error 时 throw」。这套约定意味着 updateTodos 的 Result 在唯一边界处被无条件翻译回 throw——翻译层的成本由调用方与所有读者承担，收益没有第二消费者兑现。

## 2. 设计目标

1. **包内单一错误协议**：updateTodos 校验失败与 addTodos（model.ts:135/:141）、handleSingleUpdate（tool.ts:111-130）、handleDelete（tool.ts:150-165）同走 throw；handleBatchUpdate 不再做 error→throw 翻译。
2. **消灭双字段重复**：error / resultText 同一知识两次编码的局面消失；UpdateResult 收敛为成功形状 `{ updatedTodos, resultText }`（两字段必填），`resultText!` 非空断言（tool.ts:106）随之消失。
3. **行为零回归**：details 落盘形状、成功路径文案、四条渲染通道、steer / auto-clear 机制全部零变化；唯一有意文案变化 = 批量错误消息两处微调（见 D2）。
4. **low 群显式移交**：审计 low 项与四问记录遗留 low 点登记移交 code-simplify（D4 清单），不在本设计内实施。

**In-scope**：`extensions/universal/todo/`（src + tests + 包内 ARCHITECTURE.md 同步回写）。
**Out-of-scope**：
- 审计 M5（isGui 四分支跨包同构：本包 `index.ts:48-65` makeRefreshDisplay 的 isGui 分支 :52-63，与 goal 包 `goal/src/projection/widget.ts:231-263` updateWidget 同构）——该发现按索引归入 13 号设计（extension-protocol 下沉侧，修复点在 protocol 组合 helper），本设计不展开不实施；
- 审计判定保留的「疑似本质复杂度」（migrateTodo 历史迁移、扁平 schema + 双形陷阱检测、8 文件分层、双列布局、steer 双机制、component 宽度缓存、五条渲染通道整体）；
- D4 移交清单的实际执行（实现阶段由 code-simplify 批量处理）。

---

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子（取自代码）

一次批量更新失败的完整轨迹（模型视角）：

```
[模型] {"action":"update","updates":[{"id":1,"status":"completed"},{"id":1,"status":"pending"}]}
       ↓
[updateTodos] 重复 id 检测命中（model.ts:183-189）：
       return { updatedTodos: 原列表原样,
                error: "duplicate ids in updates",                    ← 字段 1：机器可读
                resultText: "Error: duplicate ids in updates" }       ← 字段 2：人类可读（多个 "Error: " 前缀）
       ↓
[handleBatchUpdate]（tool.ts:104）if (r.error) throw new Error(r.resultText)
       ↓
[pi 框架] 工具错误展示 "Error: duplicate ids in updates" 给模型
[state] 不变（error 分支返回原列表，语义 = 无突变）
```

同一函数内，另一类校验走的是另一条通道（model.ts:177-179）：

```
[模型] {"action":"update","updates":[{"id":1,"text":"   "}]}
[updateTodos] 直接 throw new Error("update item id 1: text cannot be empty or whitespace-only")
```

现状 5 条批量校验的通道与文案全表：

| 校验 | 通道（位置） | error 字段文案 | resultText 文案（= 模型实际看到的） |
|---|---|---|---|
| 批量项 text trim 后空串 | throw（model.ts:177-179） | — | `update item id N: text cannot be empty or whitespace-only` |
| updates[] 重复 id | Result（model.ts:183-189） | `duplicate ids in updates` | `Error: duplicate ids in updates` |
| id 不存在 | Result（model.ts:190-198） | `id N not found` | `Error: Todo #N not found` |
| 无 status 且无 text | Result（model.ts:199-205） | `update item for id N has neither status nor text` | 同 error 文案 |
| 非法 status 值 | Result（model.ts:206-212） | `invalid status: X` | `Error: invalid status 'X' for update item id N` |

成功路径：`Updated N todo(s)`（model.ts:223-226），handleBatchUpdate `return r.resultText!`（tool.ts:106）。

### 3.2 真实失败模式

- **F1（双字段漂移税）**：4 处错误 return 每处同步写两遍字段（model.ts:183-212），漏改一处即 error 与 resultText 文案漂移（「id 不存在」行已经分化：`id N not found` vs `Todo #N not found`）。error 字段全仓唯一读者是 tool.ts:104 的布尔判空——它作为「机器可读结构化错误」的设计意图零兑现。
- **F2（同函数双协议）**：updateTodos 内 text 空串走 throw、其余 4 类走 Result；包内其余全部错误路径（addTodos、handleSingleUpdate、handleDelete）都是纯 throw。读者必须同时掌握两套协议才能回答「这个校验失败后错误从哪冒出来」。
- **F3（双轨被文档固化）**：tool.ts:67-70、index.ts:19-20、ARCHITECTURE.md:152-154 三处明文记载「model 层 Result（合法）+ dispatcher 翻译 throw」——新增校验的开发者面对两个可选通道无所适从，双轨将持续繁殖。

### 3.3 根因

**「纯函数不 throw」的函数式洁癖遇上了唯一调用方是 throw 协议的边界。** updateTodos 以「返回 Result 是合法的函数式模式」（ARCHITECTURE.md:152 自述）设计，但它的生产调用方只有 handleBatchUpdate 一处（grep 全仓证实：src 内 `updateTodos` 引用仅 tool.ts:22 import / :103 调用与测试），而该调用方所在协议层（pi tool execute）的错误表达就是 throw——Result 在边界处被立刻拆成「布尔 + 消息」翻译回 throw，翻译层即全部成本。同一函数内的 text 空串校验后来按 CT5 决策改为 throw（model.ts:175 注释），双轨就此同框，且三处文档为既有形态背书而非纠偏。

### 3.4 物理数据流（M4 触点图）

```
模型 todo 调用 → executeTodoAction（tool.ts:179）→ handleUpdate → handleBatchUpdate（tool.ts:102）
                    ├─ 校验失败：现状 = UpdateResult{error,resultText} → 翻译 throw（tool.ts:104）
                    │            终态 = updateTodos 直接 throw（同一 pi 错误边界，throw 点上移一层）
                    └─ 校验通过：state.todos 突变 + details{action,todos,nextId} 随 toolResult 落盘
                                 （M4 零触及：details 无 error/resultText 字段，形状不变）
session 重开 → reconstructState 回放最后一条 todo toolResult details → 状态重建（M4 零触及）
```

## 4. 终态：使用者眼里将是什么样的

### 4.1 成功路径（与现状逐字节相同）

```
[模型] {"action":"update","updates":[{"id":1,"status":"completed"},{"id":2,"text":"B done"}]}
[工具返回] Updated 2 todo(s)
          [x] #1: A
          [~] #2: B done        ← content = 确认消息 + 全量列表，渲染不变
```

### 4.2 失败路径（带恢复指引）

```
[模型] {"action":"update","updates":[{"id":9,"status":"pending"}]}   ← id 9 不存在
[updateTodos] throw new Error("Todo #9 not found")                    ← 与单条路径 tool.ts:130 同款措辞
[pi 框架] 工具错误展示 → 模型恢复动作：todo list 重取有效 id 后重试
[state] 不变（throw 发生在任何突变之前——与现状 error 分支返回原列表语义等价）
```

错误规格终态表（与 §3.1 现状表逐行对应）：

| 校验 | 终态通道 | throw 文案 |
|---|---|---|
| text trim 后空串 | throw（不变） | `update item id N: text cannot be empty or whitespace-only`（不变） |
| 重复 id | throw（改） | `duplicate ids in updates`（去前缀） |
| id 不存在 | throw（改） | `Todo #N not found`（对齐单条路径措辞） |
| 无 status 且无 text | throw（改） | `update item for id N has neither status nor text`（去前缀） |
| 非法 status 值 | throw（改） | `invalid status 'X' for update item id N`（取 resultText 措辞去前缀） |

## 5. 关键决策与权衡

**本章结论：3 个设计内决策（D1 协议统一、D2 文案定案、D3 UpdateResult 收敛）+ 1 个移交登记（D4 low 群）。**

### 5.1 D1：updateTodos 错误协议统一（选定：方案 A 全 throw 化）

- **采用**：4 处 Result-error return 改为 throw；成功返回 `{ updatedTodos, resultText: "Updated N todo(s)" }`；handleBatchUpdate 收敛为三行（调 updateTodos → `state.todos = r.updatedTodos` → `return r.resultText`）。
- **被否**：
  - **方案 B（保留 Result，收敛单字段）**——无论 error-only 变体（调用方 `throw new Error(r.error)`，消息用内部措辞，模型可见文案降级且「Error:」前缀语义由谁提供变模糊）还是 discriminated union 变体（`{ok:true,...}|{ok:false,error}`，调用方必须窄化样板），都只消灭 F1 双字段、不消灭 F2 双协议：addTodos throw 与 updateTodos Result 仍在同一包并存，§3.2 的「读者必须懂两套」原样保留，三处背书注释还得改写成更复杂的窄化规则。
  - **方案 C（校验上移 handler，updateTodos 退化为纯 apply）**——把 4 类校验搬进 handleBatchUpdate（tool.ts 内 handleSingleUpdate 确有「校验在 handler」先例），同样达成单一 throw 协议，但校验知识搬层：model 层对非法输入失去防御（未来出现第二调用方即绕过校验），diff 面更大（校验逻辑 + 测试整体搬家）而行为收益与 A 完全相同。
- **证据**：调用方唯一性（grep `updateTodos` 全仓仅 tool.ts:22/:103 + 测试）；error 字段零读者（grep `.error` 于 src 仅 tool.ts:104 布尔判空）；包内 throw 先例（model.ts:135/:141、tool.ts:111-165）；测试现状已把 throw 视为一等通道（todo.test.ts:142 对 text 空串断言 `toThrow`）。
- **效果**：目标 1/2 成立；§4.2 失败路径成立；F1/F2/F3 一并消除。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A 全 throw 化（选） | 包内单一错误协议；by construction 无翻译层；与包注释约定「handler 失败直接 throw」一致化 | 低：model.ts 4 处 return 改 throw + tool.ts 三行化 + 测试 4 用例改写 | 模型可见文案两处微调（D2 独立裁决，量级一行措辞） | ✅ |
| B Result 收敛单字段 | 双字段消灭但双协议永续；union 变体引入窄化样板 | 中：接口重设计 + 调用方窄化 + 测试保持 | F2/F3 保留，背书注释需改写为更复杂规则 | ❌ |
| C 校验上移 handler | 单一协议达成；但 model 层防御缺口 | 中高：校验 + 测试整体搬家 | 第二调用方绕过校验的隐患 | ❌ |

**被否若用**：用 B，§4.2 失败路径变成「handleBatchUpdate 窄化 → 取 error 字段 → throw」三步样板，且新读者仍需先读 ARCHITECTURE.md 的「何时用哪套协议」说明才能动手；用 C，model.ts 的 updateTodos 退化为无守卫的 map，批量校验散进 tool.ts 与单条校验为邻——两类校验（批量作用域 vs 单条作用域）在 handler 层混杂。

### 5.2 D2：错误文案定案（选定：取 resultText 措辞，去冗余前缀，对齐单条路径）

- **采用**：throw 文案 = 现 resultText 措辞去掉冗余 `"Error: "` 前缀（错误形态由 pi 工具错误通道表达，前缀是现状双字段时代的拼接残留）；「id 不存在」对齐包内既有单条措辞 `Todo #N not found`（handleSingleUpdate tool.ts:130、handleDelete tool.ts:164 同款）。这是本设计唯一有意的模型可见变化。
- **被否**：保留 `"Error: "` 前缀（最小 diff 但保留拼接残留，且与单条/delete 路径的无前缀文案不一致）；改用现 error 字段的内部措辞（`id N not found`——从未展示给模型，作为对外文案是措辞降级）。
- **证据**：单条路径无前缀文案已在生产使用（tool.ts:130/:164），模型对其重试行为正常；两条文案差异本身就是 F1 漂移的实例。
- **效果**：目标 3 的「唯一有意文案变化」被显式定义并可验收（V1 观察点）；终态错误规格表（§4.2）成立。

### 5.3 D3：UpdateResult 收敛形状 + 去 export（并入 M4 同一改动面）

- **采用**：`interface UpdateResult { updatedTodos: Todo[]; resultText: string }`，两字段必填；去 export（改为包内类型）。全仓证实零外部导入（grep `UpdateResult` 仅 model.ts 定义，测试只 import 函数不 import 类型）。
- **被否**：保留 export——它是四问记录发现 8 指出的「无消费导出」，读者会误以为跨模块契约点；且 M4 本就重写该接口，保留 export 等于让 code-simplify 二次触碰同一接口。
- **效果**：`resultText!` 非空断言（tool.ts:106）随之消失；目标 2 完整达成。发现 8 的 UpdateResult 部分就此关闭，其余部分（ValidStatus / AddResult / RefreshDisplayFn）留 D4 移交。

### 5.4 D4：low 群处置——移交 code-simplify（非 contested，直接登记移交）

**移交清单**（实现阶段批量执行；每项给出实读位置与指令，行号 = 2026-09-12 实读值）：

| # | 位置 | 内容 | 移交指令 | 联动同步 |
|---|---|---|---|---|
| L1 | handlers.ts:97-114（函数）、:173-178（唯一生产调用点） | handleAutoClear 返回 `{handled, cleared}` 双布尔；实读证实 handled:false 与 handled:true+cleared:false 在调用点行为逐字节相同（都不刷新不 return 差异） | 收敛为单返回值（语义 =「是否已清空」），调用点改 `if (handleAutoClear(state)) refreshDisplay(ctx);` | steer.test.ts:71/:77/:86/:93/:235/:246 形状断言改写；ARCHITECTURE.md:86/:103 的 `{handled, cleared}` 与 `handled` 表述同步 |
| L2 | model.ts:89、render.ts:44、render.ts:115、component.ts:53 | completed 计数 `filter(status==="completed").length` 4 处重复 | 抽 `todoProgress(todos): {completed, total}` 单一来源；4 个消费点的展示格式（N/M / ✓ N/M / N/M completed）各自保留，只收敛计数口径 | 无文档提及 |
| L3 | render.ts:56-66（renderWidgetItem）vs render.ts:144-152（buildTodoListText 内联） | item 行 status→视觉映射双实现；唯一差异 = 非完成态文本 `fg("text")` vs `fg("muted")` | 参数化共用以 renderWidgetItem 为基，颜色差异作参数显式传入（零视觉变更）；是否统一颜色由实施时视觉比对另定，默认保留参数 | 无 |
| L4 | tool.ts:74 vs tool.ts:213 | `"No todos"` 空列表三元表达式重复 | executeTodoAction 改复用 handleList | 无 |
| L5 | handlers.ts:150 vs render.ts:41-51（renderStatusText；授权写入方 = index.ts:51） | before_agent_start 绕过 renderStatusText 直写 `📋 N pending`，同一 "todo" status 槽两种格式同 turn 交替闪烁 | handler 的 setStatus 改复用 renderStatusText（仅改文案来源，不触及 setWidget，零时序变化）；格式统一为 N/M | 无 |
| L6 | handlers.ts:24（RefreshDisplayFn 自用）vs tool.ts:181-183/:237、index.ts:48（内联同签名）；model.ts:30（ValidStatus）、:118-122（AddResult） | 半吊子类型导出：单点别名存在却三处内联；两类型 export 无包外/测试消费 | RefreshDisplayFn 统一四处签名引用（或全部降内联）；ValidStatus / AddResult 去 export（UpdateResult 部分已由 D3 关闭） | 无 |

> 审计主清单登记的 todo low 项为 L1 / L2 两条；L3–L6 来自本包四问记录（审计附录 sa-62d5504b）的遗留 low 点，未入主清单，随本表一并移交，避免临时记录文件清理后失散。

### 5.5 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | throw 化后批量校验失败经 pi 工具错误通道展示、state 不变、会话不中断 | 验收 V1 实测（真实 pi CLI 触发 not found 错误） | ⛔ V1 | 现状 handleBatchUpdate 已在同一边界 throw（tool.ts:104），终态仅把 throw 点上移一层、pi 侧边界不变——by construction 成立；若实测发现 pi 对不同栈深的 throw 展示有差异（无机制依据），回退方案 B 并重审 D1 |
| P2 | 旧会话回放零影响 | 验收 V2 实测（重开 session 状态一致） | ⛔ V2 | 不适用：details 组装代码（tool.ts:219-223）与 TodoDetails 形状（model.ts:22-26，无 error 字段）零触及，纯类型层 + 错误通道改动 |

## 6. 实现（文件改动地图）

| 文件 | 动作 | 要点 |
|---|---|---|
| `src/model.ts` | 改 | updateTodos 4 处 Result-error return 改 throw（文案按 §4.2 终态表 / D2）；UpdateResult 收敛 `{updatedTodos, resultText}` 两必填 + 去 export（D3）；UpdateResult 与函数头注释同步 |
| `src/tool.ts` | 改 | handleBatchUpdate（:102-107）三行化，删 `if (r.error) throw` 翻译与 `resultText!` 断言；:67-70 错误处理约定注释改写（删除「Result 对象（合法）」双轨背书，改为包内单一 throw 协议表述） |
| `src/index.ts` | 改 | :19-20 头注释的错误处理一句同步（与 tool.ts 新表述一致） |
| `src/__tests__/todo.test.ts` | 改 | 4 个 error 分支用例（:145-171）改 `expect(...).toThrow(...)` + 新文案断言；5 处成功用例 `error` toBeUndefined 断言（:123/:136/:206/:213/:226）删除；其余用例（trim、completed 无拦截等）不动 |
| `ARCHITECTURE.md` | 回写 | :152-154 错误处理段改写为单一 throw 协议 + UpdateResult 新形状（同 commit，文档同步纪律） |

包版本 patch bump（universal 组独立 npm 包；对外行为等价、仅错误文案两处微调，无 API 面变化）。

## 7. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「小」（协议收敛、行为等价），3 个真实场景简化验收，全部可在本地 pi CLI 完成；单测与三连检查仅作回归辅助与合入门禁，不计入验收。**

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | 真实 pi CLI：批量更新成功 + 失败 + 错误后状态完好 | 目标 1/2/3；探针 P1 | `pnpm --filter @zhushanwen/pi-todo build` 后 `pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <dist 路径>`，stdin JSONL 发 prompt：让模型建 2 个 todo、批量更新标记第 1 个 completed，再故意更新不存在的 #9 | 成功轮返回 `Updated 1 todo(s)` + 全量列表（与现状同构）；#9 轮以工具错误返回且文案为 `Todo #9 not found`；随后 list 显示 2 条 todo 且第 1 条 completed（错误未污染 state）、会话继续可用 |
| V2 | 旧会话回放零回归 | 目标 3；探针 P2 | V1 结束后以同 `--session-dir` resume 重开该 session，再发一条消息让模型 list todo | 状态行 N/M 与 list 结果与关闭前一致（reconstructState 回放 details 正常，M4 未触及落盘形状） |
| V3 | 负面行为：渲染链路不变 | 目标 3 | V1 全程观察 TUI 状态行与 widget（或 RPC 下 host 侧 widget） | 状态行 N/M 格式与 widget 渲染与改动前一致（本设计零触及渲染文件；若观察到变化即回归） |

## 8. 实施

### 8.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | D1/D2/D3 主体 + 测试改写 + ARCHITECTURE.md 回写，单 commit；`pnpm extensions:typecheck && extensions:lint && extensions:test` 三连绿 | §4 终态；V1–V3 验收 |
| M2 | D4 移交清单 L1–L6 由 code-simplify 批量执行（独立 commit/PR，不阻塞 M1） | L1–L6 各项 + 各自联动同步 |

### 8.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| u1 = M1 | M4 主体（model.ts / tool.ts / index.ts / 测试 / ARCHITECTURE.md） | 协议收敛与测试改写必须同 commit 才能保持绿（4 个 error 用例与新协议强耦合）；单 commit 使「行为等价」可整体 review |
| u2 = M2 | L1–L6 移交执行 | 纯机械清理可批量；L1 涉及返回值形状变化需独立跑 steer 测试验收，与 u1 的验收面（V1–V3）正交，混入会扩大单次 review 面 |

### 8.3 待验证检查点（诚实标注）

- D2 去前缀文案对模型重试行为的实际影响：预期无影响（单条路径同款无前缀文案已在生产验证），V1 观察模型收到 `Todo #9 not found` 后是否正常转 list 重试。
- L3 颜色参数统一与否：移交 code-simplify 实施时视觉比对定，本设计默认保留参数（零视觉变更）。
- L5 改复用 renderStatusText 后 status 槽时序：仅改文案来源不触及 setWidget，预期零时序影响；实施时全量跑 steer.test.ts 确认。

---

## 附录：变更历史

- v1（2026-09-12）：初稿。覆盖审计 M4（medium，code-right）+ low 群移交登记（审计主清单 L1/L2 + 四问记录遗留 L3–L6）；M5 登记出范围（归 13 号设计）；审计行号微移已在证据基线标注。
