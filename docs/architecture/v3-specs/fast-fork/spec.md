# Fast Fork · 快速分叉（设计单元 spec）

> 层级 **L2 跨区联动** · 跨 Panel + Sidebar + Composer 三区 · 痛点1 主线
> 配套 draft：`draft-fast-fork.html`（终态交互 demo）
> 上游规范：`../panel/spec.md`（Panel 4 zone）、`../sidebar/spec.md`（Session List）、`../panel/draft-message-stream.html`（回合 action 行）、`../../design-tokens.md`（冷蓝暗色 SSOT）

## 0. 背景与问题

用户在长时间、多线探索的深度协作中，频繁需要"就 agent 回复里的某个点，单独开一条干净独立的追问线"。现有 fork 能力（`feat/event-adapter` PR #61 落地的 v1）在三处阻断了这个诉求：

| 阻断点 | 现状代码 | 后果 |
|---|---|---|
| **门控过严** | `packages/renderer/src/components/panel/message-stream/Turn.vue:248` `v-if="!isSessionActive && !isSubagentVirtualId(sessionId)"` | session 活跃（streaming/pending）时 fork 按钮根本不渲染，对话进行中无法 fork |
| **入口受限** | `Turn.vue:479` 固定取 `lastAssistant` | 只能从末条 assistant 消息分叉，无法就历史某条分叉 |
| **行为打断** | `useSidebar.ts:466-470` fork 后强制 `panel.split()` + `selectSession(standby)` | fork 后自动跳到新 session，打断主线思路 |
| **血缘不可见** | `packages/shared/src/session.ts:20-44` SessionSummary 无 parentSession/forkEntryId 字段；runtime 写了 JSONL（`services/session/session-fork.ts:141`）但 RPC 不回传，**且磁盘扫描链路（`session-file-utils.ts:16-35` 的 parseSessionHeader 只取 `{id,cwd,timestamp}`）根本不解析 parentSession** | 5+ 路后台分支散在侧栏扁平列表里无法辨认"哪个是从哪个 fork 的"。fork 出的 session 一旦 idle（通常立即 idle），侧栏走磁盘扫描路径，血缘永远拿不到 |

关键认知纠正（用户在 shape 阶段明确）：**fork 的主要目的是"在新线提问"，不是"开空白分支"**。空白 fork 是低频的。因此核心交互不是"fork 一个空白 session 后台待命"，而是 **Fork-to-Ask**：点 fork → composer 进 fork 模式 → 打字发送 = 原子地（fork 新 session + 作为首条 user message 发送），主线 session 完全不参与。

## 1. 本 spec 要收口的冲突

三套交互在现有 v1 fork 上互相打架，必须统一：

| 维度 | v1 现状 | 本 spec 裁决 |
|---|---|---|
| fork 按钮门控 | `!isSessionActive`（活跃时不显示） | **放开**：streaming/pending 均可 fork。runtime fork（`createForkedSessionFile`）全量读源 JSONL 快照，与 session 是否活跃基本无关（streaming 末尾 entry 有读取竞态风险，见 §10.4） |
| fork 入口 | 仅末条 assistant 的 hover 按钮 | **放开**：每条 assistant 消息 hover 都出 fork 按钮（含 streaming 态） |
| fork 默认行为 | split + 跳转到 standby | **改为"留在原线"**：不 split、不跳转，对话流插反馈行 + 侧栏静默新增 |
| fork 语义 | 单一空白 fork | **拆成两个按钮**：fork 提问（高频）/ fork 后台（低频），仿复制/复制 MD 并列 |
| session 血缘展示 | 不可见（扁平列表） | **当前 session 下方浮出"本会话的分支"小列表**（方案3，仅当前 session 可见，不碰全局扁平结构） |
| panel 硬上限 | 单/双状态机，无第三态 | **不突破**：5+ 路分支是"后台待命"而非"同时铺开"，panel 容器够用 |

## 2. 核心裁决 · 三层改动

### 层 ① Fork 入口层 — 放开门控 + 每条消息可 fork

**改动**：放开 `Turn.vue:248` 的 `!isSessionActive` 门控，让 streaming/pending 态也能 fork。

**每条 assistant 消息 hover 都出 fork 按钮**（不只末条），让用户能从历史任意消息分叉。pi 原生支持任意 entry fork，UI 只是没暴露。

**两组按钮并列**（仿复制/复制 MD 的并列结构）：

```
[复制 | 复制 MD] | [fork 后台 | fork 提问]
```

- `复制` / `复制 MD`：中性色（`--subtle` → hover `--fg`）
- `fork 后台` / `fork 提问`：accent 高亮（`--accent` → hover `--accent-hover` + `--accent-soft` 底），与中性复制按钮区分
- 中间用 `as-sep`（1px 竖线，`--border`）分隔两组
- 每个按钮带 `as-fork-kbd`（mono 小字 + surface-2 底）标快捷键

| 按钮 | 图标 | 快捷键 | 行为 | 频率 |
|---|---|---|---|---|
| **fork 后台** | GitFork | `⌘G` | 纯空白 fork 到后台，自动命名"分支 N" | 低频 |
| **fork 提问** | GitFork（加粗） | `⌘⇧G` | 进入 composer fork 模式，打字发送 = 原子 fork+ask | 高频 |

**不加 composer 内切换键**（shape 阶段用户裁决）：因为 composer 内打字时无法确定 fork 哪一段（fork 点是从 assistant 消息来的，不是从 composer 输入来的），所以 fork 模式的入口必须在 assistant 消息侧，不能在 composer 内。

### 层 ② Fork 行为层 — 不打断主线 + composer fork 模式

**纯 fork（⌘G / fork 后台按钮）行为**：
1. 点按钮 → 图标转 0.6s loading（视觉反馈）
2. fork 新 session（继承完整历史到分叉点，空白等输入）
3. **不 split、不跳转**，留在原线（去掉 `useSidebar.ts:466-470` 的 `panel.split()` + `selectSession(standby)`）
4. 对话流插反馈行："已 fork 到后台 · [分支名] · 查看"
5. 侧栏"本会话的分支"小列表静默新增（fresh 高亮 3.2s 后淡出）

**Fork-to-Ask（⌘⇧G / fork 提问按钮）行为**——高频路径：
1. 点按钮 → **composer 进入 fork 模式**
2. composer 视觉三重强化：accent 边框 + 3px accent-ring glow + 5% accent 底
3. composer 顶部浮出 chip 明示："将发到新分支 · 与主线隔离"（带 × 退出）
4. placeholder 切换："在新分支提问… 发送 = fork 新 session 并发送此条，主线不受影响"
5. 发送按钮变实心 accent，文案"fork 并发送"
6. 用户打字 → `⌘Enter` 发送 = **原子操作**：fork 新 session + 把这行作为新 session 的首条 user message
7. **发送后自动退出 fork 模式**，回主线 composer
8. 主线 session 完全不参与（不写入、不 streaming、不 split）
9. 反馈行："已在新分支提问 · [提问预览] · 查看分支"
10. 侧栏新增分支项，**标题用提问内容预览**（而非"分支 N"），与新建 session 命名规则一致

**Esc 退出 fork 模式**（清空输入 + 回主线）。

**去掉 ForkConfirmModal**：现在 `ForkConfirmModal.vue` 是一个 380px 两按钮确认框，对"随手 fork"心智是摩擦。低风险操作不该有确认步骤。直接 fork + 轻量反馈行。

### 层 ③ 后台分支管理层 — 血缘可见（方案3）⚠️ 前置依赖

**前置依赖**（痛点1 和痛点2 merge 的共同基础层）：
- `packages/shared/src/session.ts:20-44` 的 `SessionSummary` 类型**必须补 `parentSession?: string` 字段**
- runtime 的 `session.fork` RPC 响应**必须回传 parentSession**（现在 `session-fork.ts:141` 写了 JSONL 但不回传）
- 侧栏 SessionList 从扁平 cwd 分组扩展为"当前 session + 其分支子列表"

**方案3（已裁决）**：当前激活 session 正下方浮出"本会话的分支"折叠区。

**不碰全局扁平结构**——其他 session 仍按 cwd 扁平分组，只有当前 session 展开自己的分支。这避免了对 `SessionList.vue:10-34` 全局结构的破坏，也符合"5+ 路不同时看 = 后台待命"的心智。

**视觉规则**：
- 分支小列表容器：4% accent 底（`color-mix(in oklch,var(--accent) 4%,transparent)`）+ `--border` + `--radius` 圆角
- 不用左色条 accent（design-system §2 反模式：左色条+亮底是 AI slop）
- 折叠头：accent 色 + chev 图标 + "本会话的分支" + 计数
- 子项复用 `.si` 原子，但更紧凑（`padding 6px 8px`，`font-size 12px`）
- 子项带"分支 N"血缘 pill（accent-soft 底 + 9px mono）
- **新 fork 的子项标 `fresh`**：accent-soft 底 + inset accent-ring，3.2s 后淡出（`@keyframes fresh-fade`）

**分支命名规则**：
- fork-to-ask 的分支：标题用**提问内容预览**（取首条 user message 前 N 字符，与新建 session 命名一致）
- 纯后台 fork 的分支：自动命名"[源 session 名] · 分支 N"

## 3. 反馈行规范（SystemNotice 变体）

fork 成功后在主线对话流插一条反馈行，走 SystemNotice 变体：

| 元素 | 规范 |
|---|---|
| 容器 | `--info-soft` 底 + `--border` + `--radius` + `padding 7px 11px` |
| 图标 | GitFork（14px，`--info` 色） |
| 文案 | "已 fork 到后台 · [分支名]" 或 "已在新分支提问 · [提问预览]" |
| 分支名/预览 | `--fg` 加粗（`font-weight 550`） |
| 查看链接 | 右对齐，`--accent` 色 + hover accent-soft 底，点跳转到该分支 |
| 关闭 × | `--subtle` 色 + hover `--fg` + surface-hover 底 |
| 动效 | `notice-in` 200ms ease（从 -4px translateY 淡入） |

**不用 success-soft**（fork 不是"完成"而是"开了一条线"，info 更中性）。**不用 banner**（遵循架构约定 #3：错误/反馈进对话流，不占顶部 banner）。**不用左色条 accent**（design-system 反模式）。

## 4. Key States（完整状态清单）

| 状态 | 触发 | 用户需看到/感到 |
|---|---|---|
| **默认（非 fork 模式）** | 初始态 | composer 普通外观，placeholder"继续主线对话…" |
| **streaming 中 fork** | session 活跃时点 fork 按钮 | fork 按钮可见可点；点击后主线继续 streaming 不中断；反馈行"已 fork 到后台" |
| **composer fork 模式** | 点 fork 提问按钮 / ⌘⇧G | composer accent 三重视觉 + 顶部 chip + placeholder 切换 + 发送按钮变实心 accent |
| **fork 模式发送中** | fork 模式下 ⌘Enter | 原子执行（fork + ask），反馈行出现，composer 自动退出 fork 模式 |
| **fork 模式取消** | Esc / 点 chip × | 清空输入 + 回主线 composer |
| **纯 fork 成功** | ⌘G / fork 后台按钮 | 反馈行"已 fork 到后台" + 侧栏新增（fresh 高亮） |
| **fork-ask 成功** | fork 模式发送 | 反馈行"已在新分支提问" + 侧栏新增（标题为提问预览，fresh 高亮） |
| **fork 失败** | JSONL 读取错误 / RPC 失败 | 反馈行变 danger 色："fork 失败 · [原因] · 重试"（不用 banner，遵循架构约定 #3） |
| **后台分支列表空** | 当前 session 无分支 | 折叠区不显示（不渲染空容器） |
| **后台分支列表有项** | 至少 1 个分支 | 折叠区显示，默认展开，计数实时更新 |
| **fresh 高亮淡出** | 新 fork 后 3.2s | accent-soft 底 + ring 渐变到透明，避免长期视觉噪声 |
| **查看链接跳转** | 点反馈行/侧栏的"查看" | 跳转到该分支 session（此时才发生 panel 行为） |
| **源 session 已删除** | 反馈行指向已删 session | "查看"降级为纯文本（不可点） |
| **后台分支跑完（done）** | 后台 fork/fork-ask 的 session 完成 | 侧栏分支项状态点 running→done（绿）；**主线反馈行追加"分支 X 已完成 · 查看"**（轻量提示，不弹窗，避免用户轮询查看） |
| **后台分支出错/需关注** | 后台 session 报错或等用户审批 | 状态点 error/waiting（红/黄脉冲）；主线反馈行追加"分支 X 需关注 · 查看"；侧栏 session item 加未读角标（复用 draft-session-item §5 badge 机制） |
| **停止后台分支** | 侧栏分支项 hover"停止"action | 调 abort 中止该 session 的 pi 进程；分支状态 → stopped |

## 5. 交互模型（端到端流程）

### Fork-to-Ask 高频路径

```
hover assistant 消息
  → fork 提问按钮浮现（accent）
  → 点击 / 按 ⌘⇧G
  → composer 进入 fork 模式（三重视觉 + chip + placeholder 切换）
  → 用户打字
  → ⌘Enter 发送
  → 【原子操作】fork 新 session + 作为首条 user message 发送
  → 反馈行出现（"已在新分支提问 · [预览]"）
  → 侧栏"本会话的分支"新增（标题为预览，fresh 高亮）
  → composer 自动退出 fork 模式，回主线
  → 主线 session 全程不参与
```

### 纯后台 fork 低频路径

```
hover assistant 消息
  → fork 后台按钮浮现 / 按 ⌘G
  → 图标转 0.6s loading
  → fork 空白新 session
  → 反馈行出现（"已 fork 到后台 · 分支 N"）
  → 侧栏新增（自动命名，fresh 高亮）
  → 留在主线
```

### 查看分支

```
点反馈行的"查看" / 侧栏分支项
  → 跳转到该分支 session（此时才发生 panel 切换）
```

## 6. Content Requirements

| 文案位 | 默认（非 fork 模式） | fork 模式 |
|---|---|---|
| composer placeholder | "继续主线对话 · 想追问就点 fork 提问 或 ⌘⇧G" | "在新分支提问… 发送 = fork 新 session 并发送此条，主线不受影响" |
| composer chip | 无 | "将发到新分支 · 与主线隔离" + × |
| 发送按钮 | "发送" | "fork 并发送" |
| 反馈行（纯 fork） | "已 fork 到后台 · [分支名]" + 查看 | — |
| 反馈行（fork-ask） | — | "已在新分支提问 · [预览]" + 查看分支 |
| 侧栏分支标题（纯 fork） | "[源名] · 分支 N" | — |
| 侧栏分支标题（fork-ask） | — | 提问内容预览（前 N 字） |
| 侧栏分支 sub | "分支 N" pill + "刚刚 · 空白" / 时间 | "分支 N" pill + "刚刚 · 提问中" / 时间 |
| fork 模式退出 | Esc / chip × | — |

**i18n key 待定**（实现时补 `packages/renderer/src/locales/` 对应 key）。

## 7. 视觉规范（token 锚点）

所有值引自 `design-tokens.md` SSOT，不另造：

| 元素 | token / 值 |
|---|---|
| 复制按钮 | `color: --subtle` → hover `--fg` + `--surface-hover` 底 |
| fork 按钮 | `color: --accent` → hover `--accent-hover` + `--accent-soft` 底 |
| fork-ask 按钮 | 同 fork，`font-weight: 600`（强调高频） |
| as-sep 分隔 | `1px × 14px` + `--border` |
| as-fork-kbd | `10px mono` + `--subtle` + `--surface-2` 底 + 3px radius |
| composer 普通态 | `--bg-input` 底 + `--border` → focus `--accent` 边 |
| composer fork 模式 | `--accent` 边 + `3px --accent-ring` glow + `5% accent` 混底 |
| mode-chip | `--accent-soft` 底 + `--accent` 字 + `11px mono 600` |
| fork-notice | `--info-soft` 底 + `--border` + `--radius` + `--info` 图标 |
| fork-notice 分支名 | `--fg` + `font-weight 550` |
| fork-notice 查看 | `--accent` + hover `--accent-soft` |
| 分支小列表容器 | `4% accent` 混底 + `--border` + `--radius` |
| fresh 高亮 | `--accent-soft` + inset `--accent-ring`，3.2s 淡出 |
| branch-pill | `9px mono 600` + `--accent-soft` + `--accent` |

## 8. 实现锚点（给 worker 的精确改动点）

### 8.1 基础层（前置依赖，⚠️ 改动量中等，是痛点2 merge 的共同基础）

> **[HISTORICAL] 磁盘扫描链路必须一起改**：验证发现，仅改 SessionSummary 类型 + RPC 回传是不够的。fork 出的 session 通常立即 idle，侧栏 SessionList 走的是**磁盘扫描路径**（`scanPiSessions` → `parseSessionHeader`），不走 RPC active session 路径。不改磁盘链路 → 侧栏永远 filter 不到 parentSession/forkEntryId → 血缘小列表永远空。这批改动必须 active + 磁盘两条路径一起改，否则血缘功能 idle session 上失效。

**类型层**（`packages/shared/src/session.ts:20-44`）：
```typescript
// SessionSummary 类型补两个字段
parentSession?: string    // 父 session 的 sessionFile 路径；无父则 undefined
forkEntryId?: string      // fork 时的锚点 entry id（在源 session 里的哪条消息处 fork）；痛点2 merge 依赖
```

**Active session 路径**（runtime 内存态）：
- `packages/runtime/src/services/session/types.ts` 的 `IManagedSessionView` 加 `parentSession?` + `forkEntryId?` 字段
- `ManagedSession` 实现（同文件或 `session-lifecycle.ts`）加对应字段
- `session-service.ts:706` 的 `toSummary` 补两个字段输出
- `session-lifecycle.ts` 的 `forkSession` 创建 ManagedSession 时写入（parentSession = sourceFilePath，forkEntryId 来自 RPC 入参）

**磁盘扫描路径**（runtime 持久态，⚠️ 容易遗漏）：
- `packages/runtime/src/infra/pi/session-file-utils.ts:16-20` 的 `SessionHeader` 接口加 `parentSession?` + `forkEntryId?`
- `parseSessionHeader`（`session-file-utils.ts:24-35`）扩展读这两个字段（现在只取 `{id,cwd,timestamp}`）
- `ScannedSessionMeta`（`session-file-utils.ts:272` + `services/ports/session.ts:10` **两处定义**）加字段
- `scanSessionMeta`（`session-file-utils.ts:329`）提取时带上
- `scannedToSummary`（`session-scanner.ts:63-81`）补两个字段输出

**JSONL header 写入**（解法 A，存 forkEntryId）：
- `packages/runtime/src/services/session/session-fork.ts:39-46` 的 **`SessionHeaderEntry` 接口先加 `forkEntryId?: string` 字段**（当前只有 `parentSession?`，必须先扩接口才能写）
- 然后 `session-fork.ts:137-144` 的 `newHeader` 加 `forkEntryId: forkEntryId`（入参 `forkEntryId` 已在手，见 `useSidebar.ts:458` 的 `piEntryId` 一路传到 runtime）
- 现有 `parentSession: sourceFilePath` 保留不动
- **三处接口要同步加字段**（`forkEntryId?`）：`SessionHeaderEntry`（session-fork.ts:39）+ `SessionHeader`（session-file-utils.ts:16）+ `ScannedSessionMeta`（两处定义）。与 `parentSession` 的字段扩展完全同批

**侧栏 SessionList**（`SessionList.vue:10-34`）：
- 当前激活 session 渲染后，下方渲染其分支子列表（从 sessions 中 filter `parentSession === currentSession.sessionFile`）
- 其他 session 保持扁平，不变

**改动顺序与依赖**：
1. **类型层先行**（`shared/session.ts` 加两字段）→ 跑 `pnpm typecheck`，TS 会报出所有需补字段的位置（约 8-10 处），按报错逐个补
2. 类型层就绪后，**active 路径** 与 **磁盘路径** 与 **JSONL 写入** 三批可并行
3. 三处接口加字段（`SessionHeaderEntry` + `SessionHeader` + `ScannedSessionMeta` 两处）必须与字段使用同步，否则 TS 报错

### 8.2 Fork 入口层

**`packages/renderer/src/components/panel/message-stream/Turn.vue:248`**：
- 放开 `v-if="!isSessionActive && !isSubagentVirtualId(sessionId)"` → 改为 `v-if="!isSubagentVirtualId(sessionId)"`（去掉 `!isSessionActive`，保留 subagent 虚拟 id 排除）
- fork 按钮区从 1 个扩成 2 个（fork 后台 + fork 提问），中间加 `as-sep`

**每条 assistant 消息 hover 都出 fork 按钮**（不只 `lastAssistant`）⚠️ 有渲染层设计决策：

现状结构（验证发现）：
- `Turn.vue:222-223` action 行 `v-if="lastAssistant"`——只在末条 assistant 位置渲染
- `Turn.vue:187-200` 的 trace 结构把**末位** assistant 的 text 抽到 summary 位（`summaryText`，`Turn.vue:490-496`）渲染，**非末位** assistant 的 text 在 trace 内 Block 渲染（小字号 muted，作为过程性信息）

两条候选渲染方案（实现时裁决）：
- **方案 a（推荐）**：在每条 assistant 的 trace Block 内，于该 assistant 的 text 块下方挂 action 行。末位 assistant 的 action 行仍在 summary 位下方（现状）。需处理 trace 内过程性块的 action 行视觉降级（比 summary 位更 subtle）
- **方案 b**：每条 assistant 都显式渲染独立 summary 位（不抽到 trace 外），action 行各自挂。改动大但视觉统一

`onForkConfirm`（`Turn.vue:477-483`）固定取 `lastAssistant.value`，改为接受 entryId 参数：`function onFork(msg: Message)`，内部用 `msg.id` 调 `forkSession(sessionId, msg.id, ...)`

### 8.3 Fork 行为层

**`packages/renderer/src/composables/features/useSidebar.ts:466-470`**（`forkSession` 内）：
- 删掉 `panel.split()` + `selectSession(standby)` 4 行
- 保留 `session.appendSession(created)`（`useSidebar.ts:463`，新 session 加进侧栏列表但不激活/不 hydrate）
- fork 后留在原线，新 session "后台待命"，用户点"查看"时才 selectSession 才载入

**新增 `forkSessionAsk(content: string)`**（`useSidebar.ts` 内，原子 fork + 发首条 message）：
```typescript
async function forkSessionAsk(srcSessionId, fromMessageId, content) {
  const newId = await forkSession(srcSessionId, fromMessageId, { openInStandby: false })
  // fork RPC resolve 时新 session 的 pi 进程已 fully ready（lifecycle.forkSession 已 spawn + switchSession）
  try {
    await send(newId, parseSegments(content))
  } catch (e) {
    // ⚠️ 不是真原子：fork 成功 send 失败 → 自动回滚 fork（删除空白分支）
    // 不留空白分支（避免用户手动清理的摩擦，与删 ForkConfirmModal 的去摩擦意图一致）
    await sessionApi.remove(newId)       // 实际 API 名：remove（非 delete）
    session.removeFromList(newId)        // 实际 store 方法：removeFromList（非 removeSession）
    throw new ForkAskSendError(`提问发送失败，已取消 fork：${e.message}`)
  }
}
```
- 注意架构约定 #7：`send(newId, ...)` 显式传新 sessionId，不能误投主线
- **已核实**（代码层面）：`useChat.send()`（useChat.ts:166-193）不查 `isHydrated`，调 `ensureStreamSubscription`（:74 只查 streamSubscriptions.has，无则建）+ `chat.appendUser`；`appendUser`（chat.ts:490-504）用 `messages.value.get(sessionId) ?? []` fallback，即使 session state 未初始化也能写入。新 session 未 selectSession（未 hydrate）也能 send

**删除 `ForkConfirmModal.vue`**：
- `Turn.vue:271` 的 `<ForkConfirmModal>` 移除
- `Turn.vue:471-475` 的 `forkOpen` ref + `openFork` 清理
- fork 按钮 `@click="openFork"`（`Turn.vue:253`）改为直接 `@click="onFork(msg)"`
- 删 `ForkConfirmModal.vue` 文件 + i18n key `panel.forkConfirm.*`
- **真实使用仅 Turn.vue 一处**，但 **6 个测试文件 stub 了 ForkConfirmModal**，删除组件后须清理这些 stub（否则 stub 引用不存在的组件，测试可能 warn 或报错）：
  - `__tests__/panel/turn-skill-badge.test.ts:54`
  - `__tests__/panel/turn-working.test.ts:49,55,63`
  - `__tests__/panel/turn-pending-bubble.test.ts:47`
  - `__tests__/effects/tool-status-flip.test.ts:310,347`
  - `__tests__/effects/virtual-scroll-integration.test.ts:20`

**反馈行数据流 + 持久化语义**（⚠️ 审查 1-M3/1-M6 修正：区分两层语义）：

| 层 | 语义 | 持久化 | 重开 session 表现 |
|---|---|---|---|
| **血缘关系** | `parentSession` 字段（SessionSummary + JSONL header） | ✅ 持久化（§8.1 基础层） | 侧栏分支小列表可见（血缘靠这个，不靠反馈行） |
| **事件通知（fork-notice）** | "已 fork 到后台"这个实时事件 | ❌ **transient，不持久化** | **重开 session 不重新渲染历史 fork-notice**（避免事件通知堆满对话流） |

- fork-notice 走 **runtime 推送 + 前端 transient 渲染**（不走 custom_message 持久化）。runtime 在 fork 成功后经 WS 广播一条 `message.forkNotice` 事件给前端，前端 message-stream 在对话流临时插入反馈行（session 实例关闭即逝）
- **不违反架构约定 #7.5**：#7.5 要求"对话流状态必须重开可恢复"——但 fork-notice 不是对话流状态（不是 session 内容），是**跨 session 的事件通知**。真正需要持久化的血缘关系已由 parentSession 字段承担，重开 session 靠侧栏分支小列表找回
- compact 行为：fork-notice 是 transient，不写入 JSONL，不参与 compact，不受影响
- 后台分支完成/出错/需关注的追加通知（§4 新增状态）同理：transient 广播，不持久化

### 8.4 Composer fork 模式

**`packages/renderer/src/components/panel/Composer.vue`**（与 ComposerInput.vue 并列，非子目录）：
- 新增 `forkMode` ref（boolean）+ 记录 fork 来源 `{ srcSessionId, fromMessageId }`
- `enterForkMode(srcSessionId, fromMessageId)` / `exitForkMode()` 方法
- composer 容器 class 绑定 `fork-mode`（三重视觉：accent 边 + 3px accent-ring glow + 5% accent 底）
- composer 顶部 mode-chip（"将发到新分支 · 与主线隔离" + ×）
- `boxClass`（Composer.vue:247-254）加 forkMode 分支
- `placeholder`（Composer.vue:256-260）加 forkMode 文案切换
- `onSend`（Composer.vue:275-326）开头加 forkMode 分支调 `forkSessionAsk`，发送后 `exitForkMode()`
- Esc 监听：composer focus 时 forkMode 下 Esc 退出（注意与 SessionList/SideDrawer 的 Esc 冲突，composer focus 时应优先退出 forkMode）
- **切 session 时自动 exitForkMode**：避免 forkMode 残留到错误 session

**快捷键注册**（`packages/renderer/src/components/sidebar/Sidebar.vue:371-404` keymap）：
- 现有 `KeymapEntry`（`Sidebar.vue:363-369`）**需扩展加 `shift?: boolean` 字段**（当前只有 key/commandId/action）
- `matchOverrideKey`（`Sidebar.vue:385-404`）加 shift 守卫：`m.shift` 则要求 `e.shiftKey`，非 shift 则要求 `!e.shiftKey`（否则 ⌘G 和 ⌘⇧G 都命中 ⌘G）
- keymap 加两条：`{ key: 'g', action: () => forkFromLastAssistant() }` + `{ key: 'g', shift: true, action: () => enterForkModeFromLastAssistant() }`
- **⌘G/⌘⇧G 无冲突**（验证确认，grep `'g'` 无命中；现有 ⌘K/⌘N/⌘B/⌘[/⌘]/⌘,）
- **fork 点来源**（验证发现的空白）：全局 ⌘G 触发时无 hover 上下文，**默认从末条 assistant fork**（`lastAssistant`），与用户在 message-stream 末尾的视觉焦点一致
- **composer focus 时禁用全局快捷键**：在 keymap handler 开头加守卫 `if (forkMode.value || composerFocused) return`，否则 forkMode 下输入 g 会误触发 fork

### 8.5 后台分支小列表 + 分支自身血缘展示 + 后台分支管理

**当前 session 下方的分支小列表**（`SessionList.vue`）：
- 当前激活 session 下方渲染 `<ForkGroup>` 子组件
- ForkGroup 从 sessions filter `parentSession === currentSession.sessionFile`
- **ForkGroup 组件接口**：`defineProps<{ branches: SessionSummary[] }>()` + `defineEmits<{ select: [id: string]; stop: [id: string] }>()()`，折叠态内部 ref，fresh 高亮靠分支项的 `lastActiveAt` 与 freshTimestamp 比较
- 折叠/展开状态、fresh 高亮逻辑

**分支 session 自身的血缘展示**（⚠️ 审查 1-C2 修正：找回困难）：
- 不仅父 session 展开分支，**分支 session 在侧栏自身也显示血缘元信息**："↑ fork 自 [父 session 名]"
- 复用 SessionSummary.parentSession 字段（零额外数据成本），在 SessionItem 的 sub 行加一个小 pill 或前缀
- 解决场景：用户切到分支 B 工作时，想找分支 A，不必切回主线——分支 B 自身显示"fork 自主线"，用户知道回主线就能看到全部兄弟分支；重开 app 第二天，散落扁平列表的分支各自标着血缘，不会迷失

**后台分支管理 action**（⚠️ 审查 1-M4 修正：取消能力）：
- ForkGroup 内分支项 hover 增加"停止"action（running 态才显示）：调 abort 中止该 session 的 pi 进程
- 分支项状态点实时反映（running/done/error/waiting/stopped），用户不必切过去才知道状态

**后台分支完成通知的落点**（⚠️ 审查 1-C1 修正：观察层）：
- 后台 session 状态变更（→done/error/waiting）经 WS 广播到主线 session 所在 panel
- 主线 message-stream 的对应 fork-notice 反馈行追加"分支 X 已完成/需关注 · 查看"（transient，不持久化，见 §8.3）
- 侧栏 session item 加未读角标（复用 draft-session-item §5 badge 机制，区分"未读新消息"vs"后台需关注"用不同色）

## 9. 联动与依赖

| 联动点 | 说明 |
|---|---|
| **→ 痛点2 merge** | 本 spec 的基础层（parentSession + forkEntryId 字段 + 磁盘链路）是 merge 的前置依赖。merge 需要能知道分支血缘和 fork 锚点才能取差异 entries |
| **→ 痛点3 handoff** | handoff 独立方案（B+C+F 三件套 + 新建空白 session），不复用本 spec 的 fork 链路。但共享"structured-output + slash command + extension"架构 |
| **→ pi fork 能力** | runtime fork（`createForkedSessionFile`）自己读源 JSONL 截断，不调 pi fork RPC。本 spec 改的是 fork 行为（不 split）+ JSONL header（存 forkEntryId），不动 fork 截断逻辑 |
| **→ panel store** | 不改 panel store（单/双状态机保留），5+ 路分支靠侧栏管理而非多 panel |
| **→ 架构约定 #7（session 隔离）** | fork-ask 的首条 message 必须带新 sessionId，不能误投到主线。`message-dispatcher` 编排时注意 |
| **→ 架构约定 #7.5（持久化链路）** | fork-notice 是 transient 事件通知，不走持久化（§8.3 两层语义区分）。需持久化的血缘关系由 parentSession 字段承担 |

## 10. Open Questions（实现时再定）

1. **fresh 高亮持续时间**：demo 是 3.2s。实际产品可能应该是"直到用户点过一次该分支"才消，而非按时间。实现时观察用户行为再定
2. **反馈行的自动消失**：现在手动 ×。可能应自动消失（如 10s 后）。需观察是否会堆积影响阅读
3. **多级 fork 的递归**：A fork 出 B，B 再 fork 出 C——C 的 parentSession 指向 B。侧栏小列表只展示直接子分支还是递归全部？v1 倾向只展示直接子（一层），递归待用户反馈
4. **fork-ask 的首条 message 在新 session 的呈现**：是作为普通 user 气泡，还是带"从 [源 session] fork 并提问"的元信息头？倾向普通气泡（保持新 session 干净），元信息走 session header 的 parentSession 指示
5. **streaming 中 fork 的 JSONL 读取竞态**（已核实）：runtime fork（session-fork.ts:73 `readFile` 全量读）在源 session streaming 时可能读到 pi 正在 append 的不完整末行。**已确认 `parseJsonl`（jsonl.ts:39-42）跳过坏行不整体失败**，所以 fork 不会崩溃。但风险不在崩溃而在**静默丢失**：`⌘G` 默认从末条 assistant fork，若末条正在 streaming，fork 出的 session 会**静默丢失末尾不完整 entry**（无报错，内容残缺）。缓解方案（实现时选一）：(a) streaming 中用 ⌘G 时，fork 点回退到上一条完整 assistant（而非末条 streaming 中的）；(b) 反馈行明示"末条进行中，已从不完整状态 fork"，让用户知情决定是否重 fork
6. **forkEntryId 数据一致性**：parentSession 存源 session 文件路径。但活跃源 session 的 sessionFile 可能晚于 fork 落盘（pi 延迟写入，架构约定 #6）。fork 时源 sessionFile 可能还未落盘 → parentSession 写入的是 undefined 或临时值。需确认 fork 触发时源 sessionFile 是否已存在，若不存在用 sessionId 作血缘键替代

## 11. 反模式（本 spec 明确禁止）

- **❌ fork 后自动 split + 跳转**：打断主线，违背"后台待命"心智
- **❌ ForkConfirmModal 确认框**：低风险操作不该有确认步骤，摩擦太大
- **❌ 左色条 accent 标记血缘**：design-system §2 反模式（AI slop）
- **❌ 突破 panel 为 3+ 路同时铺开**：5+ 路是后台待命，不是同时看，panel 容器够用
- **❌ composer 内加快捷键切换 fork 模式**：无法确定 fork 哪一段（fork 点来自 assistant 消息）
- **❌ fork 模式发送后保持 fork 模式**：风险高，用户以为在主线打字实际在 fork，容易误发。必须发送后自动退出
- **❌ 反馈行用 banner / 顶部弹窗**：遵循架构约定 #3，反馈进对话流
- **❌ 自动回灌分支结论到主线**：在"后台试探"心智下，自动回灌是错的（试探大部分会被丢弃）。合并语义见痛点2 另行讨论
- **❌ fork-notice 作为对话流状态持久化**：事件通知（"已 fork"）是 transient，重开 session 不重新渲染历史通知。血缘靠 parentSession 字段持久化（§8.3 两层语义）。混在一起会导致事件通知堆满对话流、污染阅读、与 compact 逻辑打架

## 12. 验收 checklist

实现后必须满足：

- [ ] streaming/pending 态 fork 按钮可见可点
- [ ] 每条 assistant 消息 hover 都出 fork 按钮（不只末条）
- [ ] 两个 fork 按钮并列（fork 后台 + fork 提问），accent 高亮，中间 as-sep
- [ ] fork 后不 split、不跳转，留在原线
- [ ] 对话流插反馈行（info-soft 底，非 banner）
- [ ] composer fork 模式三重视觉（accent 边 + glow + 5% 底）+ chip + placeholder 切换
- [ ] fork-ask 发送 = 原子操作（fork + 首条 message），主线不参与
- [ ] fork-ask 发送后自动退出 fork 模式
- [ ] Esc 退出 fork 模式
- [ ] 侧栏当前 session 下方"本会话的分支"小列表（方案3）
- [ ] 新 fork 子项 fresh 高亮 3.2s 淡出
- [ ] fork-ask 分支标题用提问预览，纯 fork 用"分支 N"
- [ ] SessionSummary 带 parentSession + forkEntryId 字段
- [ ] **active + 磁盘两条路径都回传血缘**（active: IManagedSessionView + toSummary；磁盘: SessionHeader + parseSessionHeader + ScannedSessionMeta 两处 + scannedToSummary）—— 否则 idle session 血缘丢失
- [ ] JSONL header 写入 forkEntryId（`session-fork.ts:137-144` newHeader）
- [ ] fork 反馈行 transient 渲染（不持久化，重开 session 不重新出现历史通知）
- [ ] 后台分支完成/出错时，主线反馈行追加"分支 X 已完成/需关注 · 查看"（观察层，避免用户轮询）
- [ ] 分支 session 在侧栏自身显示"↑ fork 自 [父名]"血缘元信息（找回，不限父激活时）
- [ ] fork-ask 发送失败时自动回滚 fork（删除空白分支，不留摩擦）
- [ ] 后台分支可停止（侧栏 hover"停止"action，调 abort）
- [ ] ⌘G / ⌘⇧G 快捷键注册，无冲突
- [ ] ForkConfirmModal 已删除
- [ ] 反馈行"查看"点击跳转到分支 session

## 13. 配套 draft

- `draft-fast-fork.html` — 终态交互 demo，覆盖所有状态。可直接浏览器打开体验。包含：App 骨架 + 侧栏（含分支小列表）+ Panel（含 streaming 态 fork）+ composer（含 fork 模式）+ demo bar（触发按钮 + 重置）+ toast 反馈

## 14. 路线图位置

本 spec 是"session 工作树"心智层的第一块（类比 git branch）。按依赖排序：

```
基础层（本 spec §8.1）→ 痛点1 fork 体验（本 spec §8.2-8.5）
                        ↓
                     基础层就绪
                        ↓
              痛点2 merge（倾向 iii：分支结论贴入主线 composer，基础层就绪后再定）
              痛点3 handoff 桥接（handoff 产物加"在新 session 继续"，复用 fork 链路）
```
