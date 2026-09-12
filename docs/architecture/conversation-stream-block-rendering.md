# 对话流 Block 渲染顺序重构

> **一句话结论**：对话流里每个 block（text/thinking/toolCall）的显示位置应由 `contentBlocks` 数组的稳定顺序决定，而不是由"是否末位 assistant"这个会随 streaming 翻转的派生量决定；本次取消"末位 filter"，所有 text 全 inline 就地渲染、统一正文样式、始终可见（不进折叠区），thinking/toolCall 受折叠控制——这是一次明确的产品设计语义变更（从"最终回答突出、过程文字折进执行流程"转为"全 inline 统一"，对齐 ChatGPT/Claude 业界范式），需同步更新 v6 spec。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 对话流把一条 AI 回答渲染成若干 block（文字 / thinking / 工具调用），按回合（turn）分组展示。v6 spec（`v6-spec-content.html`）是 UI 验收 SSOT。
- **C（冲突）**：① streaming 时 block 会在屏幕上突然跳位——先出现的文字块，会在工具块出现后瞬间被挪到别处；② 现状用"末位 assistant"区分"最终回答"（正文样式突出）与"过程文字"（暗色小字折进执行流程），但"末位"是个会随 streaming 翻转的派生量，正是跳变根因。
- **Q（问题）**：怎么让每个 block 一旦出现就待在它该在的位置，整个 streaming 过程零跳变，且给出一个不依赖"末位推断"的文字呈现模型？
- **A（答案）**：block 位置只认 `contentBlocks` 顺序这一个稳定来源；所有 text 全 inline 就地、统一正文样式、始终可见（不进折叠区）；thinking/toolCall 作为执行细节受折叠控制；TurnSummary 退化为操作栏。这是一次产品设计语义变更，同步更新 v6 spec §12.6。本文展开。

---

> **层性质声明**（准则 10）：本次设计的**当前层 = 渲染架构方案 + 产品语义变更**，**下一层 = 组件接口 + 代码改动 + spec 更新清单**。不跨到"逐函数实现"层。
>
> **层敏感准则**（准则 5/6/7）：本次涉及 streaming 数据流与运行时渲染行为，三条全部 P0 适用。
>
> **产品语义变更声明**：本设计推翻 v6 spec §12.6 与 `Block.vue` 注释确立的"中间文字折进执行流程、最终回答在底部突出"意图，转为"全 inline 统一"（对齐 ChatGPT/Claude/Cursor 范式）。变更理由与 spec 同步计划见 §6.3。

---

## 1. 背景：对话流渲染管线是什么

**对话流渲染管线负责把 pi（AI 后端）吐出的事件流变成屏幕上可见的 block 序列。** 一个使用者在 panel 里看到的一轮 AI 回答，背后经历：pi 推送事件 → runtime 转译 → 前端 store 累积 → 组件渲染。

核心数据结构（`packages/shared/src/message.ts`）：

```ts
export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | Segment[]          // 文本内容（assistant 是字符串）
  status: 'streaming' | 'complete' | 'error'
  toolCalls?: ToolCall[]               // 工具调用
  thinking?: ThinkingBlock[]           // 思考块
  contentBlocks?: ContentBlock[]       // 有序内容块，记录到达顺序 ← 设计上的顺序 SSOT
}
```

> **术语：turn（回合）**。一轮对话 = 一个 user 提问 + 其后连续的 AI 回答。`toRenderItems()`（`message-turns.ts`）把扁平 `Message[]` 按 user 切分成 `MessageTurn`，一个 turn 的 `assistants` 数组可能含**多条** assistant message（原因见 §3.3）。

> **术语：block（内容块）**。一条 assistant message 内部，按产出顺序的原子展示单元：text / thinking / toolCall。`contentBlocks` 数组记录顺序，`expandAssistantBlocks()`（`message-turns.ts:158`）据此解成 `OrderedBlock[]` 渲染列表。

> **术语：trace 折叠 / showTrace**。`Turn.vue` 把"执行细节"（thinking/toolCall）放在可折叠 trace 区，由 `showTrace = sessionActive || isExpanded(turn.index)` 控制显隐。对话进行中或手动展开时显示，完成后默认折叠。

> **术语：v6 spec（UI SSOT）**。`docs/page-design/v6-spec-*.html` 是项目逐组件 UI 验收基准。其中 `v6-spec-content.html §12.6` 定义 TurnSummary。本次设计变更需同步更新该 spec（§6.3）。

本次设计聚焦：**一条 assistant message 内部 block 的渲染位置决策、文字呈现模型、与 trace 折叠/v6 spec 的关系**。

---

## 2. 设计目标

**改造后，使用者在对话流里：**

1. **block 零跳变**：任何 block 一旦出现，在它所属 message 的整个生命周期里位置不变（streaming 中、完成后、重连后都不变）。
2. **顺序符合直觉**：block 按真实产出顺序自上而下排列，与"读对话"的自然阅读顺序一致。
3. **重连前后一致**：streaming 中途断线重连、或关闭重开 session，看到的 block 顺序与文字可见性与不断线时完全相同。
4. **文字呈现统一稳定**：所有 text 全 inline 统一正文样式（消除"最终回答 vs 过程文字"的两级视觉层级与"末位"概念），样式变化只跟随稳定的 assistant 生命周期状态（streaming→complete），不随兄弟 message 到达翻转。
5. **回答始终可见**：text 作为回答内容始终可见（不论 trace 折叠与否）；执行细节（thinking/toolCall）保持可折叠。

**In-scope**：
- `Turn.vue` 的 block 渲染顺序决策（"末位 filter"）与 text 可见性边界
- 文字样式统一（全 inline 正文样式，§6.2）
- `TurnSummary.vue` 职责收窄（去内容化，仅操作栏）
- streaming 光标归位
- **v6 spec §12.6 同步更新**（§6.3）

**Out-of-scope**（显式声明不做，防 scope creep）：
- 不改 pi 事件协议（`event-adapter.ts` noop 策略保留，见 §6.6）
- 不合并"一个 turn 多条 assistant message"（§6 决策 D，A 落地后评估）
- 不改 `contentBlocks` 数据结构本身（它已是正确 SSOT，问题在消费端）
- 不改 compact / fork / handoff（读 `Message.content`，本次保留该字段与数据角色）
- **不解决"闪烁"问题**（`[DEBUG finalize]` 追的是另一病灶，§3.3 澄清同根不同病）

---

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子

使用者向 AI 发一句"读一下 a.ts 然后告诉我内容"。AI 的典型回答是"先说话、再调工具、再总结"。**当前渲染会把这一轮拆成两条 assistant message**（a1 = 说话 + 工具调用，a2 = 总结），它们属于同一个 turn：

```
┌─ turn ─────────────────────────────────────┐
│ [user] 读一下 a.ts 然后告诉我内容            │
│ ┌─ TurnMeta（始终可见）──────────────────┐  │
│ │ ┌─ trace 区（v-if="showTrace"，折叠）──┐ │  │
│ │ │ <a1 block> <a2 block>               │ │  │
│ │ └────────────────────────────────────┘ │  │
│ │ ┌─ TurnSummary（始终可见）──────────────┐│  │
│ │ │ <最后一条 assistant 文字·正文样式> +操作栏││  │
│ │ └────────────────────────────────────┘ │  │
│ └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**现状有两级文字样式 + 两处文字渲染位**（本次变更的核心对象）：

| 文字角色 | 渲染位置 | 样式（核实自代码） | 来源 |
|---|---|---|---|
| **最终回答**（末位 assistant） | TurnSummary（始终可见） | `text-base` / `leading-7` / streaming `neutral-mid`→完成 `neutral-fg` | `TurnSummary.vue:8-9` |
| **过程文字**（非末位 assistant） | Block.vue text 分支（受 showTrace 折叠） | `text-sm` / `leading-relaxed` / 恒暗色 `neutral-mid` | `Block.vue:47` |

决定文字去向的核心逻辑（`Turn.vue`）：

```js
// Turn.vue:129
const showTrace = computed(() => sessionActive.value || isExpanded(props.turn.index))
// Turn.vue:167-171 — 末位 filter：末位 text 挪出 trace（去 TurnSummary），非末位 text 留 trace
const traceBlocksByAssistant = computed(() => {
  return props.turn.assistants.map((a, i) => {
    const blocks = expandAssistantBlocks(a)
    return i === lastAssistantIdx.value
      ? blocks.filter((b) => b.kind !== 'text')
      : blocks
  })
})
```

> **术语：末位 filter**。上面 `.filter((b) => b.kind !== 'text')`——把"末位 assistant"的 text 从 trace 剔除交 TurnSummary 渲染（正文样式），非末位 text 留 trace（过程样式、受折叠）。设计意图："末位=最终回答要突出，非末位=过程说明要折叠"。**这个意图本身是 v6 spec 与 Block.vue 注释确立的刻意设计，不是事故**（`Block.vue:45` 注释"draft §4 Output Text 中间：折进执行流程"；`v6-spec-content.html §12.6` 定义 TurnSummary 为"对话流最核心交互入口"、容器含正文文字）。

### 3.2 怎么出错：block 跳变的根因时刻

**失败模式 A（主症）：新 message_start 到达，末位翻转，text 在 trace↔summary 间跳变。**

| 时刻 | pi 事件 | turn.assistants | a1 是末位? | trace 区 | TurnSummary | 使用者看到 |
|---|---|---|---|---|---|---|
| T1 | a1 流文字 "我先读文件" | `[a1]` | 是 | `[]`（a1 text 被 filter） | "我先读文件" | 底部出现文字 |
| T2 | a1 收到工具块 | `[a1]` | 是 | `[工具]` | "我先读文件" | 工具在 trace、文字在底部 |
| T3 | `message_start(a2)` | `[a1,a2]` | **否** | `[a1 文字, 工具]`+`[]` | a2 文字 | **a1 文字瞬间从底部跳进 trace，落到工具上方，且样式从正文突变为暗色小字** |

T2→T3 瞬间，a1 文字块**位置跳变 + 样式跳变**双重突变。

**失败模式 B：重连后顺序可能不一致。** streaming 按"前端事件到达顺序"填 `contentBlocks`；持久化（`message-converter.ts`）按"pi content array 顺序"填。两者常见场景一致，但**顺序语义不同源**——深层风险在此（§11 待验证登记统一方案，不只依赖"实践一致"）。若走 `expandAssistantBlocks` fallback（`contentBlocks` 为空，固定顺序 `[text,thinking,tool]`），边界态会错位。

> **失败模式 C（filter 的派生症状，非独立病灶）**：v-for key 含数组下标 `bIdx`（`Turn.vue:39`）。末位翻转时 text 被插回数组首部推高 `bIdx`，Vue 重建 DOM 加剧跳动。**根因仍是 filter**：三个 contentBlocks 填充点均 append-only 不前插（§7.1），无 filter 则 `bIdx` 本就稳定，移除 filter 即消除，无需独立修复（§6.5）。

### 3.3 为什么一个 turn 会有多条 assistant message + 闪烁是另一个问题

**多 assistant**：pi 一个 agent 循环 = N 个 turn，每个 assistant turn 开始 emit `message_start` → 前端建新 streaming assistant（`registry.ts:116`）；pi 的 `message_end` 在 `event-adapter.ts:652` 是 `NULL_EVENTS` 不转发 → 每条 assistant 持续 streaming 到 `agent_end` 的 `message.complete` 一次性收口。所以"说话→调工具→总结"必然 ≥2 条 assistant 并存。这是失败模式 A 的触发前提。

> **澄清"同根不同病"**：`registry.ts` 的 `[DEBUG finalize] 场景A诊断` 日志追的是**另一个问题——"同一回合中间闪烁已完成"**，根因是 `message_end` noop 抹平了每条 assistant 的真实完成时刻（谁提前收口丢失）。它与本文的"text 去哪"**同根**（多 assistant 并存 + `message_end` 抹平状态）但**不同病**：移除末位 filter 不解决闪烁，闪烁需独立方案。本设计不声称解决闪烁。

---

## 4. 根因 + 物理数据流

### 4.1 根因

**病灶 1（主因）：block 的显示位置依赖"兄弟元素是否存在"，而非自身稳定属性。** "末位 filter" 用 `i === lastAssistantIdx` 决定 text 去哪，而 `lastAssistantIdx` 随 `message_start` 翻转。一个 block 的位置不应因另一个 message 的出现而突变——违反 UI 元素位置契约。

**病灶 2：同一份文字的双重表示 + 视图靠 filter 协调。** `Message.content`（字符串）与 `contentBlocks`（结构化数组）是同一份文字的两种表示；两个渲染位（TurnSummary 读 content / trace 读 contentBlocks）靠 filter 避免重复。filter 一旦失效（末位翻转）就跳变。
> **长期终点形态**（本次不实现，仅明示方向）：终点是 `contentBlocks` 成为内容+顺序双 SSOT，`content` 降为派生视图（compact/fork/handoff 可由 contentBlocks 派生）。本次保守保留 `content` 数据角色不变（§7.1），只消除"双重渲染"这个**症状**；双表示本身保留。不讲终点会误导后来者以为双表示已解决。

> **contentBlocks 本身不是病灶**：它本就是为顺序渲染设计的正确 SSOT。问题在消费端 `Turn.vue` 没直接信任它，叠加了"末位推断"。

### 4.2 物理数据流图（pi 事件 → 屏幕像素）

```
pi SSE 事件流
  │ message_update{text_delta} / tool_execution_start / message_start{assistant}
  │ (注：pi content block 级事件 text_start/toolcall_start 在 event-adapter.ts:106 全 noop)
  ▼
event-adapter.ts → 前端 message.* 事件
  ▼
chat store contentBlocks (顺序 SSOT，三个填充点均 append-only + text 幂等守卫)
  ▼
expandAssistantBlocks() (message-turns.ts:158) ← 信任 contentBlocks 原序解出 OrderedBlock[]
  ▼
Turn.vue traceBlocksByAssistant ← ★病灶 1：叠加"末位 filter"，破坏稳定顺序
  ├──→ trace 区 (v-if=showTrace)：thinking + toolCall（末位 text 被剔除）
  └──→ TurnSummary (始终可见)：末位 assistant.content（正文样式）+ 过程文字在 trace（暗色样式）
```

**关键论断**：`contentBlocks → expandAssistantBlocks` 这段顺序稳定正确（✅ 探针 P-stable）。跳变 solely 发生在 `Turn.vue` 末位 filter 这一步。

---

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径（全 inline 统一 · block 零跳变 · 回答始终可见）

**核心设计（方向 Y，已裁决）**：所有 text 全 inline 就地渲染、**统一正文样式**（`text-base`/`leading-7`）、始终可见（不进折叠区）；thinking/toolCall 作为执行细节受 showTrace 折叠。彻底消除"末位"概念与两级视觉层级。

trace **展开态**（对话进行中 / 手动展开）：

```
T1: a1 流文字 "我先读文件"（正文样式·streaming 暗色）█
T2: a1 收到工具块 → 工具追加在文字下方，文字不动
    [始终可见] a1: "我先读文件"（正文）
    [折叠区]   a1: 工具(read)
T3: message_start(a2) → a2 在 a1 下方继续，a1 文字位置/样式都不动
    [始终可见] a1: "我先读文件"（正文）
    [折叠区]   a1: 工具(read)
    [始终可见] a2: "内容是..."（正文·streaming 暗色）█
```

trace **折叠态**（完成后 / 重开历史）：

```
[始终可见] a1: "我先读文件"（正文·完成全色）
[始终可见] a2: "内容是..."（正文·完成全色）
（thinking/toolCall 隐藏）
[操作栏] 复制/复制MD/fork/handoff
```

**全程零跳变**：text 位置 = 它在 `contentBlocks` 里的位置；样式 = 正文级，颜色只跟随**所属 assistant 的生命周期状态**（streaming→`neutral-mid`，complete→`neutral-fg`，单调不翻转）。a1 从不会被重新插到别处，也不会从正文突变为暗色小字。

> **样式稳定性关键**：颜色绑定"assistant status"（`streaming`/`complete`），而非"是否末位"。assistant status 单调变化（streaming→complete，在 `agent_end` 收口），不随兄弟 message 到达翻转。因此 a2 出现不会改变 a1 颜色——只有 `agent_end` 时全 turn 一起 complete 才整体由暗转亮，是全局一致的语义反馈。

### 5.2 失败路径（带恢复指引）

**F1：某条 assistant 的 `contentBlocks` 异常缺失（手工数据 / 旧持久化）。** `expandAssistantBlocks` 走 fallback（`message-turns.ts:178` 固定顺序 `[text,thinking,tool]`），仍能渲染，顺序可能与流式时不同。👉 重新加载会重建。

**F2：markdown 跨块断裂？** 👉 **由幂等守卫保证不会发生**（by guard 非 by construction）：单 message 最多 1 个 text 块（`ContentBlock.text.refId` 恒 `'text'`，三个填充点 `registry.ts:263` / `message-converter.ts:100` / `streaming-state-machine.ts:56` 均有 `.some(b=>b.type==='text')` 守卫）。`ContentBlock[]` 类型本身允许多 text，单 text 靠守卫维持——**新增第四个填充点必须带同款守卫**，否则多 text 块会导致 `expandAssistantBlocks` 重复 push 完整 content。

---

## 6. 关键决策与权衡

### 6.1 决策一：text 块的渲染位置（主决策）

| 方案 | 长期架构合理性 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. text 全 inline 就地、始终可见（不进折叠区）** | ✅ 位置只认 contentBlocks，by construction 稳定；消除病灶 1/2；回答常驻 | 低 | 极低 | **✅ 选** |
| B. text 进折叠区（v1 方案） | ❌ showTrace=false 时所有文字消失（致命回归） | 低 | **致命** | ❌（审查否决） |
| C. filter 条件改 message 级稳定态 | ❌ 仍依赖派生判断，streaming→complete 仍翻转一次 | 低 | 中 | ❌ |
| D. 前端合并多 assistant 为单 message | ✅ 消除"末位"概念 | 高（改数据模型，影响 compact/fork/retry） | 高 | ❌（A 落地后评估） |

**被否若用**：B → 回答消失；C → 仍跳一次；D → scope 失控，且 A 落地后 D 价值降低（A 让渲染对 message 数量免疫，D 要解决的问题已被 A 化解）。

**减法优先**（准则 8）：A 是砍掉 filter + 把 text 移出折叠区，不加新机制。

### 6.2 决策二：文字样式模型（产品语义变更）

| 方案 | 长期架构合理性 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **Y. 全 inline 统一正文样式**（已裁决） | ✅ 彻底消除"末位"概念；对齐 ChatGPT/Claude/Cursor 范式；最干净 | 低（Block.vue text 分支升级样式 + spec 更新） | 低 | **✅ 选** |
| X. 保留视觉层级（末位正文 / 过程暗色） | ⚠️ 样式层仍依赖"末位"判断（虽不影响位置），保留派生状态；a1 末位翻转时样式渐变 | 中 | 中 | ❌ |

**选 Y 的理由**：① 彻底消除"末位"概念（位置、样式都不再依赖它），by construction 稳定；② 业界范式；③ 减法优先（砍掉"视觉层级区分"这个 clever 机制，少一处派生状态 = 少一处失败面）；④ "最终回答突出"在多 assistant turn 里语义模糊（哪个算"最终"本身就是猜）。

**样式统一细节**：
- 所有 text 统一到正文级：`text-base` / `leading-7`（现 TurnSummary 正文样式）。
- 颜色跟随**所属 assistant status**：streaming→`neutral-mid`，complete→`neutral-fg`（单调，不翻转）。
- `Block.vue` text 分支样式从 `text-sm/leading-relaxed/neutral-mid` 升级为正文级；需接收所属 assistant 的 streaming 状态以决定切色（稳定属性，非末位判断）。

### 6.3 决策三：TurnSummary 去内容化 + v6 spec 同步（产品变更落地）

**产品语义变更**：本设计推翻 v6 spec §12.6 与 Block.vue 注释确立的"中间文字折进执行流程、最终回答底部突出"意图，转为"全 inline 统一"。理由：工程稳定性（消除跳变根因）+ 业界范式 + 减法。

**TurnSummary 改动**：

| 项 | 现状 | 改造后 |
|---|---|---|
| 文字渲染 | MarkdownRenderer（末位正文） | **删除**（文字全 inline 到 turn 内容区） |
| streaming 光标 | TurnSummary 内 | 移到 turn 内容区末尾 `streaming-tail`（§6.4） |
| 操作栏（copy/fork/handoff） | 保留 | **保留**，根 `v-if` 从 `summaryText` 改 `lastAssistant`（纯工具 turn 将新出现操作栏，预期行为变更） |

**v6 spec §12.6 同步更新**（纳入改动清单）：
- 容器定义：从"TurnSummary 含正文文字 + streaming 切色"更新为"TurnSummary 仅 hover actions 操作栏；文字全 inline 在 turn 内容区，统一正文样式"。
- 新增说明：text 全 inline 模型（位置认 contentBlocks、样式统一正文、颜色跟 assistant status）。
- §12.6 的 streaming cursor 描述迁移到 turn 内容区 `streaming-tail`。

### 6.4 决策四：streaming 光标位置与显隐

**位置**：turn 内容区末尾独立 `streaming-tail` 元素（一个元素跟在所有 block 后，不受 block 增删影响；兑现 `Block.vue:46` 注释声称却从未落地的设计）。

**显隐条件**（审查 MF6）：单一 `v-if="isStreaming"` 不够（工具运行时 `isStreaming` 仍 true，会与工具 loader 并存）。正确条件：
```
showStreamingCursor = isStreaming && 最后一个可见 block 不是 running tool
```
基于 contentBlocks 末项类型，稳定，不随 message_start 翻转。工具运行时光标隐藏（工具自带 loader）。

### 6.5 不做：独立的 v-for key 稳定化

v1 曾列此项。审查 MF2/MF3 否决：① 提议的 key 用了 `OrderedBlock` 不存在的 `refId` 字段；② contentBlocks 三处均 append-only 不前插，移除 filter 后 `bIdx` 本就稳定。失败模式 C 是 filter 派生症状，移除 filter 即消除，无需独立修复。本次不改 key。

### 6.6 不改 event-adapter 的 content block 级 noop 策略

pi `text_start/toolcall_start` 在 `event-adapter.ts:106` 是 noop。无需改：前端"事件到达顺序" = pi content array 顺序（工具执行必在 LLM 输出完整 tool_use 之后）。改 noop 牵动 runtime 协议层，scope 远超本次，无收益。

---

## 7. 实现机制（把终态落到代码层）

### 7.1 数据层（基本不变）

- `Message.contentBlocks`：保持顺序 SSOT。**三个填充点**均 append-only + text 幂等守卫：`registry.ts:263` / `message-converter.ts:100` / `streaming-state-machine.ts:56`。**新增第四填充点必须带同款守卫**（F2 防护）。
- `Message.content`：**数据角色不变**——仍是 text block 内容来源（`expandAssistantBlocks:163` `if (msg.content) push text`）。本次只改渲染位置（summary→inline）与样式（统一正文），不改数据角色。**streaming 必须继续填充 content**，否则 text block 被守卫丢弃。
- `expandAssistantBlocks()`：**不动**（已正确信任 contentBlocks 顺序）。

### 7.2 渲染层 + spec 改动清单

| 文件 | 改动 | 产出 |
|---|---|---|
| `Turn.vue` | ① 去 `.filter(b=>b.kind!=='text')`；② `v-if="showTrace"` 下沉到 Block 级（text 始终渲染，thinking/tool 受 showTrace：`v-if="blk.kind==='text' \|\| showTrace"`）；③ 末尾加 `streaming-tail` 光标（显隐 §6.4） | 位置稳定 + text 始终可见 + 光标归位 |
| `Block.vue` | text 分支样式从 `text-sm/leading-relaxed/neutral-mid` **升级为正文级** `text-base/leading-7` + 颜色跟所属 assistant status（需接收 streaming 状态 prop）；清理过时 `streaming` prop 注释 | 样式统一（决策二 Y） |
| `TurnSummary.vue` | 删 MarkdownRenderer + 光标；根 `v-if` 从 `summaryText` 改 `lastAssistant`；保留操作栏 | 去内容化（决策三） |
| `v6-spec-content.html §12.6` | 容器定义更新为"仅操作栏"；文字模型更新为全 inline 统一正文；cursor 描述迁移 | spec 同步（决策三） |
| v-for key | **不改**（§6.5） | — |

### 7.3 副作用与边界分析

| 关注点 | 影响 | 结论 |
|---|---|---|
| **折叠态文字可见性** | text 不进折叠区 | **解决**：折叠只隐藏 thinking/toolCall，所有 text 始终可见 |
| **最终回答视觉层级**（产品变更） | 取消"末位正文/过程暗色"两级 | **预期变更**：全 inline 统一正文（决策二 Y，已裁决）；失去"最终回答突出"层次，对齐业界范式 |
| **streaming 切色** | 从 TurnSummary 末位文字 → 所有 text 跟 assistant status | 稳定（status 单调），全局一致反馈 |
| Markdown 跨块断裂 | 单 message 最多 1 text 块 | **不会**（三处幂等守卫，F2） |
| MarkdownRenderer 实例数 | 末位 text 从 summary 挪 inline | **不变**（仍 1 次） |
| 操作栏门控 | 根 `v-if` `summaryText`→`lastAssistant` | **预期变更**：纯工具 turn 新出现操作栏 |
| streaming 光标与工具 loader | 光标显隐加"末项非 running tool"条件 | **解决**（决策四） |
| 历史消息（重连/重开） | message-converter 已填 contentBlocks | **一致**；text 始终可见 |
| compact/fork/handoff | 读 content | **不影响**（content 角色不变） |
| **v6 spec §12.6** | 容器/文字/cursor 定义变更 | **必须同步更新**（纳入清单） |
| 既有测试 | contentBlocks 填充测试不变 | Turn.vue 渲染断言需更新 + **新增零跳变回归测试**（§8） |
| **trace 折叠 stick-guard 通路** | 删 `<Transition>` 后 `StickGuardDepsKey` provide 落空（无 inject 方）、`useTraceTransition` hooks 零调用 → 孤儿 | **清理退役**：删除 `useStickGuard.ts` / `stick-guard-deps.ts` + barrel export + MessageStream provide + 3 处测试 mock。guarded 回归（完成时 trace 收缩 → scrollTop clamp → stickToBottom 翻 false）**结构上不可能**：`useVirtuaFollow` INVAR-M4-2′ 复合判据下，`onScroll` 翻 false 仅由「offset 递减 ∧ 距底 >40px」的用户上滑信号驱动（程序性写入回声 offset 递增不命中第一合取；clamp 回声 distance≤0 走恢复分支翻 true），且 force 后收敛抑制窗内暂停翻 false；权威定义见 §7.3.1（INVAR-M4-2 原文「onScroll 只单向翻真」已废止）。**已实测无回归**（真实 session + 探针验证，2026-08-12）：① 手动折叠（v-if 移除 thinking/tool block，scrollHeight 794→762）不触发 virtua `onScroll`；② 对话完成（isSessionActive true→false + trace 折叠 + watch scrollToBottom）无 `onScroll`、无 stickToBottom 翻真，`followIfStuck` rAF 重读 `stickToBottom=false` 时跳过滚动，界面停留在上滑位置（scrollTop 不变）。`pause/resumeStickGuard` 计数器已随删除退役（`useVirtuaFollow` 无 pause/resume 函数、无计数逻辑，勿据旧文档重建） |

### 7.3.1 INVAR-M4-2′ 权威定义（消息流交互全局不变量）

> **权威定义迁自 docs/design/chat-pin-bottom-fix.md §4.3 D7（该文档已删除，git 可追溯）；代码侧 SSOT 注释 = `packages/renderer/src/composables/panel/useVirtuaFollow.ts` 文件头。**

脱离锚定（`useVirtuaFollow` 的 `stickToBottom = false`）**只由用户输入信号驱动**，两条通路：

1. **wheel**：`onWheel deltaY < 0`（滚轮/触控板上滑）——恒即时生效，不受任何抑制窗约束（覆盖「已在顶部仍上滚」等不产生 scroll 事件的边缘）；
2. **onScroll 复合判据**：`offset 递减 ∧ 距底 > BOTTOM_THRESHOLD(40px)` → 翻 false——覆盖滚动条拖拽、键盘 PageUp/Home 等不产生 wheel 事件的上滑路径（旧 INVAR-M4-2 的 wheel-only 判据对这两类用户结构性失效：`stickToBottom` 恒 true，任何跟随触发都把人扯回）。

配套规则：

- **恢复分支**：距底 ≤ 40px → 翻 true，不受抑制窗影响；
- **收敛抑制窗**：`followToBottom(force=true)` 与 session 重建后开窗，窗内暂停判据 2 的翻 false（lastOffset 快照照常维护、恢复分支照常生效）；RO 静默 ≥120ms 关窗（测量收敛完成信号；不用「静默 ≥2 帧」——流式 markdown 渲染是 rAF 逐帧 trailing 节流，帧级增长间隙会误关窗），硬上限 1500ms；
- **lastOffset NaN 哨兵**：初始 / force / session 重建置 NaN，下一个 scroll 事件只建快照不判定——消除「重建归零回声与 force 写入送达先后」的时序分叉；
- **核心保护不变**：任何程序性跟随不得把用户扯回底部（跟随一律走 `followIfStuck` 的 rAF 内重读 stickToBottom guard）；force 是唯一例外（用户显式点「回到底部」）。

判据为何长成这样（两类被击穿的简化形态，防后人简化回归）：

- 程序性写入回声逐路径安全性：follow 原语写入目标恒为底部方向 → offset 递增，第一合取不命中；clamp 回声（scrollHeight 收缩后 offset 被夹到新真实底部）→ distance ≤ 0，走恢复分支；virtua `$fixScrollJump` 负向补偿 → offset 递减 ∧ distance 不变，仅在与「同窗未补偿的底部增长把 distance 顶到 >40」交集时命中——该交集几乎只在估算→实测收敛风暴期出现，由抑制窗罩住；
- 纯 distance 阈值双向化（`distance > 40 → false`）被击穿：scroll 事件回声异步送达且读实时 store 值，估算→实测收敛期回声可见 distance > 40 → 误脱离且静默（spacer 变化不标 unread，无浮层提示）；
- 纯复合判据无抑制窗被击穿：session 切换混合收敛期「底部增长顶起 distance + 顶部收缩负补偿」同窗共存 → 双合取命中 → 误脱离。

### 7.4 运行时行为断言与探针

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-single-text | 单 message 最多 1 text 块（三处守卫） | grep 三填充点 text push 均 `.some(b=>b.type==='text')` | ✅ by guard |
| P-stable | expandAssistantBlocks 输出 = contentBlocks 顺序 | 读 message-turns.ts:158-176 原序 push | ✅ |
| P-order | 前端到达顺序 = pi content array 顺序 | 工具执行在 LLM 输出完整 tool_use 后 | ✅（常见场景） |
| P-cursor | 光标已迁至 Turn.vue trace 容器末尾独立 `streaming-tail` 元素（显隐条件 §6.4） | grep `streaming-tail` 命中 Turn.vue（TurnSummary 已无 cursor 元素） | ✅ 已核实 |
| P-append-only | contentBlocks 三处 append 不前插 | 读三处均 `[...prev, new]` 尾追加 | ✅（支撑 §6.5） |
| P-no-jump | 改造后 T2→T3 零跳变（位置+样式） | §8 场景 1 录屏逐帧 + 组件测试 DOM 断言 | ⛔ 实施期 |
| P-fold-visible | 折叠态/重开 text 始终可见 | §8 场景 3 | ⛔ |
| P-style-stable | a2 出现不改 a1 样式 | §8 场景 1（颜色跟 status 不跟末位） | ⛔ |

---

## 8. 验收（真实场景 + 组件级回归护栏）

### 8.1 改动规模

**中等偏大**：行为变更（block 位置 + 文字呈现模型 + 样式统一）+ 产品语义变更 + spec 同步，涉及 3 组件 + 1 spec。需多个真实场景 + 组件级回归护栏。

### 8.2 真实场景验收（真实 pi，非单测非 mock）

| 场景 | 回溯 §2 目标 | 真实流程 / 数据 / 路径 | 通过标准 |
|---|---|---|---|
| **1. 说话→调工具→总结（主症）** | 1+2+4 | 真实 pi（`xiaomi-token-plan-cn/mimo-v2.5-pro`，禁 kimi）：发"读 src/index.ts 然后总结"。全程录屏逐帧看 block 位置+样式 | 全程无 block 改变位置；a2 出现不改 a1 位置/样式；文字统一正文级 |
| **2. 多工具连续调用** | 1+2 | 发"读 a.ts 和 b.ts"。a1(文字+工具1)→a2(文字+工具2)→a3(总结) | 工具按序稳定排列，文字穿插位置不变 |
| **3. 折叠态与重开文字可见性** | 3+5 | 场景1完成后①折叠 turn ②关闭重开 ③断线重连 | 三种情况所有 text 完整可见；thinking/toolCall 折叠态隐藏、展开态可见 |
| **4. thinking + 文字** | 1+2+5 | thinking 模型，发需推理问题。完成后折叠 | thinking 与文字按序；折叠后文字可见、thinking 隐藏；不跳位 |
| **5. streaming 光标显隐** | 1（含光标） | 场景1 streaming 中看光标 | 文字流式时光标在末尾；工具运行时隐藏，不出现"光标+loader"并存 |
| **6. 操作栏功能与门控** | 边界守护 | 场景1完成后点操作栏；测纯工具 turn | 四操作正常；纯工具 turn 出现操作栏（预期变更） |
| **7. 样式统一** | 4 | 场景1对比改造前后 | 所有 text 同正文级；无"正文/暗色小字"两级；streaming 暗→完成亮跟 assistant status |

> 依赖说明：pi 真实运行（RPC mode + 真实模型），无需 mock。

### 8.3 组件级回归护栏（DOM 断言，长期护栏）

录屏是一时证据，需 DOM 级回归测试长期锁定（项目测试规范要求"渲染 gate + 用户可见断言"）：

| 测试 | 验证 | DOM 断言 |
|---|---|---|
| **零跳变回归** | message_start 序列下 text 位置稳定 | mount Turn，模拟 a1→text→tool→message_start(a2)→text 序列，断言 a1 的 text DOM 节点**全程存在且位置不变**（appendChild-only，无重排） |
| **折叠态文字可见** | showTrace=false 时 text 不丢 | mount Turn（折叠态），断言所有 text block 的 DOM 节点存在；thinking/toolCall 节点不存在 |
| **样式统一** | 无两级样式 | 断言所有 text block 的 class 含正文样式（`text-base`），不含过程样式（`text-sm`） |

---

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付 |
|---|---|---|
| **M0** | Turn.vue（去 filter + v-if 下沉 + streaming-tail）；Block.vue（text 分支样式升级 + streaming prop）；TurnSummary.vue（去内容化 + v-if 改 lastAssistant） | §5.1 主路径 + 样式统一 |
| **M1** | v6 spec §12.6 更新；组件级回归测试（§8.3）；清理 Block.vue 过时注释；跑 §8 全部验收 | spec 同步 + 长期护栏 + 验收通过 |

纯前端 + spec 文档改动，无数据迁移。可逆（git revert 恢复）。

### 9.2 回填 main

本设计与 main 共享病灶（§3.1 代码一致）。注意：审查在 feat worktree 内，main 未独立核实（"逐字相同"基于设计者此前对比）。**回填前必须在 main 实跑 §8 场景 1 录屏确证**（Must-do）。建议 feat 验收通过后作为独立改动回填 main（main 开发者已埋 `[DEBUG finalize]` 日志在追相关闪烁）。

---

## 10. 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| unit-1：Turn.vue 渲染决策 | 去 filter + v-if 下沉 + streaming-tail | 主症根因，独立可验收（§8 场景 1/2/5） |
| unit-2：Block.vue 样式统一 | text 分支正文级 + streaming prop | 样式决策落地，独立可验收（§8 场景 7） |
| unit-3：TurnSummary 去内容化 | 删 MarkdownRenderer/光标 + v-if 改 lastAssistant | 与 unit-1 光标迁移同步 |
| unit-4：v6 spec §12.6 更新 | 容器/文字/cursor 定义 | 产品变更的 SSOT 同步，防 spec 失效 |
| unit-5：组件级回归测试 | 零跳变 + 折叠可见 + 样式统一 DOM 断言 | 长期护栏（§8.3） |
| unit-6：验收 | 跑 §8 全部场景 | DoR 门槛 |

unit-1/2/3 建议同一 PR（位置/样式/光标迁移需同步）。

---

## 11. 待验证检查点

1. **光标显隐的"最后块判断"边界**：最后一块是已完成（非 running）tool 时光标是否显示？倾向不显示（此时若有新 text 在流，新 text 成末块）。⛔ 实施期场景 5。
2. **pi content array 是否可能单 message 内多 text part**：靠三处守卫维持单 text，若 pi 发多 text part 守卫会拦住、content 合并单块。需实测确认 pi 不绕过守卫。⛔ 场景 2/4。
3. **两条 contentBlocks 填充路径顺序语义统一**（失败模式 B 深层）：streaming 按"事件到达顺序"、持久化按"pi content array 顺序"，两者常见场景一致但**不同源**。本次依赖"实践一致"，**未给统一方案**。建议后续：让持久化路径也按到达顺序重建（或让 streaming 路径对齐 content array index），消除边界态错位。⛔ 单独追踪。
4. **回填 main 时机与确证**：取决于 main 实跑 §8 场景 1 录屏（§9.2 Must-do）。

---

## 附录：变更历史

- v1：初稿。确立"取消末位 filter + 就地渲染 + TurnSummary 去内容化"方向。
- v2：经第一轮对抗式审查（7 Must-fix + 5 Suggestion），修正致命漏洞 MF1（text 移出 showTrace 折叠区始终可见，否则折叠/重开文字消失）、MF2/3（删无效 key 稳定化）、MF4（操作栏门控）、MF5（content 角色）、MF6（光标显隐）、MF7（多 text 改 by-guard + 纳入第三填充点）。
- v3：经第二轮审查（2 Must-fix + 3 Suggestion），补产品语义层：① 明示"全 inline 统一"是推翻 v6 spec §12.6/Block.vue 注释"中间文字折进执行流程"意图的设计变更，纳入 spec 同步（决策三）；② 文字样式统一到正文级、颜色跟 assistant status 不跟末位（决策二 Y，已裁决）；③ 病灶 2 补长期终点形态；④ "同源"改"同根不同病"、声明不解决闪烁；⑤ 新增组件级零跳变回归测试（§8.3）；⑥ 失败模式 B 深层（两路径顺序语义不同源）登记待验证。
