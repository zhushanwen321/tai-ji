# 压缩待发消息展示统一与压缩中活动带（方案 2）

> 状态：v3，经两轮对抗式审查（round1 三审 2/4/0 MF → round2 聚焦复审 0/2MF 主审收敛；收敛轨迹 6→2 MF，报告见 `.tmp/tech-design/design-review-20260913-compactdefer{,-impact,-simplicity}.md`）。
> 视觉规格基线 = `docs/page-design/compact-defer-queue-spec.html`（用户裁决的方案 2 demo 已入库；`.tmp/compact-queue-demos/` 的 demo-1/3 为落选过程残留，不入库）。

## 1 背景与目标

### 1.1 现状问题（用户报告，2026-09-13）

1. **defer 消息展示位不一致**：压缩中（及 bash 占用等 defer 场景）经 composer 发送的消息，由对话流尾部的 `PendingBubble`（半透明用户气泡 + Clock）渲染；而 steer/followUp 消息统一显示在 composer-box 顶部队列区（`QueueBubble`：Zap=steer / Clock=followUp）。同为「发送后暂存等待」的消息，展示位与形态割裂，用户气泡形态还易被误读为「已发出的正式消息」。
2. **「压缩中」指示存在感不足**：`ActivityStrip` compacting 行为 hairline + size-3 spinner + text-xs + `py-1`（总高 ≈24px），在长压缩（小时级 bash 后手动压缩等）场景中过于低调，且不表达「待发消息会在压缩后自动送出」的队列联动信息。

### 1.2 目标

- defer 消息与 steer/followUp 统一收口到 composer 上方队列区：专属 Hourglass icon + 占用分档 chip（「压缩后」/「命令后」/「稍后发送」）区分三种排队语义，保留未提交条目的 × 撤销能力。
- 「压缩中」指示升级为通栏活动带（accent-soft 底、高度 ≈48px），并副文案联动待发队列计数（「完成后自动发送 N 条待发消息」），闭环「消息没丢」的感知。

### 1.3 Out of scope 与已接受代价

- `useCompactQueue` 的队列记账 / flush 逐条提交 / confirmDelivery 转态 / drain 回收逻辑零改动（纯展示层迁移）。
- 发送位四态路由（composer-shell sendRoute）、steer/followUp 行的展示样式、QueueBubble 的 `stripDeferMarker` 通路不动。
- **亮色主题不做逐主题视觉回归（显式判定）**：新增视觉面仅 `--accent-soft`（活动带底）与 `--info-soft`（chip 底）两个 token 组合，亮/暗主题下均由 CSS 变量自动跟随（style.css 亮色段已有两 token 定义）；量级 = 仅对比度观感风险，无功能性风险；恢复路径 = 后续如需校对走 docs/page-design 视觉规格修订入口；重审触发 = 亮色主题下用户反馈带/chip 可读性问题时补专项校对。

## 2 终态与机制

### 2.1 defer 行迁移：对话流 PendingBubble → composer 队列区

**双数据源归一规则（round 1 F1 裁决）**：「等待投递」语义存在两个数据源——本地 defer 队列（useCompactQueue 分区）与 pi `queue_update` 快照（steer 通道提交文本会镜像进快照，且 flush 提交后条目**不出队**、等确认帧才出队）。重叠窗口（flush 提交后 → message_end(user) 确认帧前）归一规则：

> **defer 行仅渲染未提交条目（`mode === undefined`）**。已提交条目的本地行隐藏，承接面分通道：**steer** 条目由镜像行（queue_update，Zap）承接展示；**send** 条目无承接行——send 不进 queue_update，flush-send 亦不做乐观 appendUser（与直发不同，useChat.ts:625），inflight 仅是确认匹配的记账计数（无视觉形态）——确认帧（message_end(user) echo）前该消息暂不可见，echo 到达即经 confirmDelivery → appendUser 转正常气泡入流（既有转态链路不变）。
>
> **提交尝试瞬态声明**：`setEntryMode` 先于 RPC await（useCompactQueue.ts:365/:368）——提交尝试窗口内 defer 行即隐藏；busy/传输错误回滚 mode 后行弹回（ms 级自愈）。回滚是既有 flush 记账「留队静默自愈」的显示投影，非双显/丢失，回滚后 × 撤销能力恢复。与 pi 既有队列条目的交叉时序沿用既有消费顺序约定（QueueBubble 现注释 + G-023），非本设计 delta。

- 反例重演（压缩中入队 2 条 D1/D2 → 压缩结束 flush）：D1 队首走 send → D1 defer 行隐藏、确认前无任何行（零行窗口，量级 = pi echo 延迟）；D2 走 steer → 队列区出现 D2 镜像 Zap 行、D2 defer 行隐藏 → **每条消息至多一行，无双行**。D1/D2 确认帧先后到达 → 镜像行消失/气泡入流、正常气泡逐一入流。VISIBLE_MAX 不再对同一消息计双份；defer chip 只出现在未提交行，「稍后发送」chip 与「已提交」tooltip 的矛盾不复存在。
- 被否谱系：~~镜像行按 DEFER_FLUSH_MARKER 与本地队列求差集隐藏、defer 行承接已提交态~~ —— 击穿反例：文本匹配脆弱（同文本多条目），且已提交行保留仍占 VISIBLE_MAX 位；~~显式接受双显示~~ —— 击穿反例：直接违背 §1.2「消息没丢」目标（同列表相邻双行）。
- **行为变化显式声明（两条）**：① 已提交条目不再展示「禁用 × + tooltip 已提交，等待投递」（现 PendingBubble 形态）。该态下用户本就不可撤（pi 无 clear_queue），仅信息呈现位置让渡给镜像行（steer）/放弃展示（send）；撤销能力范围不变（仅未提交条目）。② 已提交 send 条目存在确认前不可见窗口（量级 = pi echo 延迟，秒级内；现状由 PendingBubble 已提交禁用态遮盖；压缩全期队列可见性不受影响）。判定可接受——不可撤操作无交互损失，且 echo 后气泡即入流。

**QueueBubble 扩展**（维持「纯 props 展示 + emit」范式，M4 数据源唯一纪律）：

- 新增 props：`deferEntries: QueuedMessage[]`（**调用方已过滤为未提交条目**，入队序）、`deferChip: string`（占用分档 chip 文案，session 级单一值）、`deferHint: string`（hover title 分档文案，session 级单一值）。
- 新增 emit：`removeDefer(id: string)`。
- **根门改写（round 1 F2）**：根节点 `v-if="state && hasAny"` → `v-if="flatItems.length > 0"`——`state`（pi queue_update 快照）存在性不再是必要条件；纯压缩入队场景 `state === undefined` 时 defer 行必须可见。
- 展平顺序 = steering → followUp → defer（未提交 defer 恒在最后，与「最后投递」时序一致；flush 提交窗口内已提交条目已隐藏，不破坏该声称）。`VISIBLE_MAX=3` 与「+N」溢出口径覆盖三组总和。
- defer 行结构：Hourglass icon（`--info` 色，size 13px，与 followUp Clock 同色系）+ chip（text-2xs、`--info-soft` 底、`--info` 字）+ truncate 文本（`--text-xs`）+ 富内容 chip 徽标（segments 非 text 段 >0 时显 `+N`，逻辑自 PendingBubble.chipCount 迁移，title 复用 `chipBadgeHint`）+ hover ×（emit `removeDefer`；`mode === undefined`（未提交）行无禁用态——已提交条目不渲染，见归一规则）。行 title 用 `deferHint`（复用 `pendingHintCompacting/Bash/Settling/pendingHint` 文案 key）。
- **可见性口径变化显式声明（round 1 S1）**：defer 从对话流全量可见改为队列区 `VISIBLE_MAX=3` 截断 +「+N」。理由：composer 区纵向预算约束 + 与 steer/followUp 同一口径；补偿 = 活动带副文案始终报**未提交全量条数**（不截断，见 2.2），「还有 N 条没发」的感知由副文案兜底。

**Composer 接线**：

- `Composer.vue` 经 `useCompactQueue()` 单例取数：`deferEntries = computed(() => props.sessionId ? queue.peek(props.sessionId).filter(m => m.mode === undefined) : [])`（过滤口径与归一规则单点一致）；传给 QueueBubble 三个新 props。
- `deferChip` 分档（与 PendingBubble.pendingHint 同优先级 compacting > bash > 其他）：`chat.sessionPhase(sid)` compacting → `t('panel.deferQueue.deferChipCompacting')`；bash → `deferChipBash`；其余 → `deferChipFallback`。
- `deferHint` 分档复用现有 `pendingHint*` 四 key 的判定逻辑（自 PendingBubble 迁移）。
- `@remove-defer` → `queue.remove(props.sessionId, id)`（remove 对未知/已提交 id 本就 no-op，边界在 API 层）。

**MessageStream 移除对话流侧**：

- 删 `pending-bubble-list` 文档流块、`PendingBubble` 导入与渲染、`useSessionPendingEntries` 调用。
- 删组件文件 `PendingBubble.vue` 与 `PendingBubble.test.ts`；`useCompactQueue.ts` 尾部的 `useSessionPendingEntries` 导出随之拆除（其唯一消费方即 MessageStream）。
- **覆盖面 re-home（round 1 S3，round 2 MF-2 锚点修正）**：`PendingBubble.test.ts` 的占用分档 hover 文案用例与 × 撤销边界用例 → 迁移为 `queue-bubble-s8.test.ts` 的 defer 行分支（u1）；其 MessageStream 集成转态用例随文件删除，覆盖声明由 renderer 包 `__tests__/composables/panel/use-compact-queue.test.ts`（TC5/CD1：message_end(user) → core ① → confirmDelivery 出队 + appendUser 转态）与 `use-chat-compacted-flush.test.ts`（flush 触发面）+ u1 组件用例承接，不另建新集成用例。
- 不变量：`confirmDelivery → appendUser` 转态链路不动——确认帧到达后队列行/镜像行消失、正常用户气泡照旧入流（live ≡ reload 语义不受影响，defer 条目本就不落 pi entry）。

### 2.2 压缩中通栏活动带（仅 compacting 行，bash/thinking/settling 行维持现状）

- **结构（round 1 F5 裁决 + round 2 INFO 定性修正）**：compacting 行**摘除 `content-col`**（720px 封顶居中列原语，与通栏带直接冲突；hairline 视觉实为行内两条 `h-px` span，新结构 `border-y border-hairline` 整体替代）并**移除 `system-notice` 标记**（全仓零 CSS 定义的纯语义标记类——摘除属死标记清理，无样式影响；`notice-in` keyframes 不再复用）。新 class 集 = `-mx-5 flex items-center justify-center gap-2 border-y border-hairline bg-[var(--accent-soft)] px-5 py-[14px]`——`-mx-5` 抵消滚动容器 `px-5`，行全宽直承 tailEl，**任意面板宽（含 >720px）下通栏到面板边缘**，对齐 demo。实施注意：ActivityStrip 现 v-for 四行共用同一静态 class，须按 `row.kind` 条件化（compacting 行 band class，bash/thinking/settling 行保持原 class），`COMPACTING_NOTICE_HEIGHT` 的 `useConstantHeightAssert` 绑定仅挂 compacting 行。
- 内容居中：Loader2 `size-3.5 animate-spin text-accent` + 主文案（`--text-sm` `--neutral-fg`；manual →「压缩中」/ threshold·overflow →「正在自动压缩上下文」，key 不变）+ 「·」分隔 + 副文案（`--text-xs` `--neutral-mid`）`t('panel.message.compactingFlushHint', { count })`。
- 副文案数据源与口径：`useCompactQueue().peek(sid)` 过滤 `mode === undefined` 后计数（App 级单例，ActivityStrip 内 computed）——**只计未提交条目**，与 2.1 归一规则同口径：flush 提交后未确认条目不计入（它们已投递，承接形态分通道见 §2.1：steer 镜像行 / send 无行）；「已提交未确认 + 再压缩」边缘下副文案语义仍准确。`count === 0` 时副文案与「·」不渲染（活动带仍在，压缩状态本身独立成立）。
- 高度常量同步：`COMPACTING_NOTICE_HEIGHT` 24 → 48（14×2 padding + ≈20px 内容行；**border-y 2px 是否计入以 dev 断言实测校准为准**，`useConstantHeightAssert` 持续守卫漂移）。该常量的强绑定 DOM 注释（逐 class 记录现结构）随新结构同批改写。`EXECUTING_BASH_NOTICE_HEIGHT` 不动。

### 2.3 i18n（zh/en 同步新增，禁硬编码）

| key | zh | en |
|-----|----|----|
| `panel.deferQueue.deferChipCompacting` | 压缩后 | After compact |
| `panel.deferQueue.deferChipBash` | 命令后 | After command |
| `panel.deferQueue.deferChipFallback` | 稍后发送 | Later |
| `panel.message.compactingFlushHint` | 完成后自动发送 {count} 条待发消息 | Will send {count} queued message(s) when done |

复用不新增：`pendingHint*`（hover title）、`cancelQueued`、`chipBadge(+{count})`、`chipBadgeHint`、`compressing`、`autoCompressing`。~~`submittedAwaitingDelivery`~~ 随已提交行隐藏失去消费方——保留 key 不删（避免 i18n 文件 churn；若终态同步确认零消费方再清理）。

## 3 验收场景表

| # | 场景 | 真实流程步骤 | 通过标准 |
|---|------|--------------|----------|
| A1 | 压缩中入队即显队列行 | 真机 dev app 触发手动压缩（此前无任何 steer/followUp，`state === undefined`），composer 发送 1 条消息 | 对话流无 pending 气泡；composer 队列区出现 Hourglass +「压缩后」chip + 文本行（根门不含 state 存在性） |
| A2 | 撤销边界（仅未提交条目） | hover 队列行 | 未提交行：× 出现，点击行消失；已提交条目不渲染 defer 行（steer 由镜像行承接；send 条目确认帧前不可见），无双行。提交尝试瞬态（行先隐后弹回，见 §2.1 瞬态声明）不判违例，判据以稳态为准 |
| A3 | 混合队列顺序与溢出 | 已有 1 steer + 1 followUp，压缩中再入队 2 条 | 展平顺序 steer→followUp→defer；仅前 3 条可见 +「+1」；活动带副文案报未提交全量「2 条」 |
| A4 | 压缩中活动带 | 压缩进行中，宽面板（>720px）观察对话流底部 | 通栏 accent-soft 带触达面板边缘 + spinner +「压缩中」+「完成后自动发送 1 条待发消息」；撤销至 0 条后副文案消失、带仍在 |
| A5 | 压缩完成转态 | 等压缩完成 → flush → 确认帧 | 队列行/镜像行消失，对话流出现正常用户气泡；重开 session 对话流一致（live ≡ reload） |
| A6 | bash 占用分档 | `!` 长命令执行中经 composer 入队 | chip「命令后」，hover title「等待命令执行结束后发送」 |
| A7 | 自动压缩文案 | threshold 触发自动压缩 | 主文案「正在自动压缩上下文」，带形态同 A4 |
| A8 | flush 提交窗口无双行（round 1 F1 + round 2 MF-1 修正判据） | 压缩中入队 ≥2 条 → 压缩结束等 flush 提交、确认帧未齐的稳态窗口；**D1 用长任务提示词维持 run 活跃**（pi 在 run 循环边界才出队 steer，撑住 D2 镜像行的可观察窗口） | 无相邻双行（镜像行 + defer 行不并存）；steer 条目恰一行（镜像行）；send 条目确认前不可见、确认后气泡入流；确认逐一完成后行逐一消失。提交尝试瞬态（行先隐后弹回）豁免，不在本场景判据内 |
| A9 | split 双 panel 隔离（round 1 S4） | split 模式双 panel 各连不同 session，panel A 压缩入队 | 仅 panel A 队列区出现 defer 行与活动带副文案计数，panel B 不受影响 |

## 4 下一层拆分（unit 种子）

| Unit | 职责 | 领地（精确文件路径，根 = `packages/renderer/src/` 除非另注） | 依赖 |
|------|------|----------|------|
| u1 | composer 侧 defer 队列展示 + 全部新增 i18n key + 测试改造/re-home | `components/panel/QueueBubble.vue`（含头注「只读」声明修订）/ `components/panel/Composer.vue` / `i18n/locales/zh-CN/panel.ts` / `i18n/locales/en-US/panel.ts` / `__tests__/panel/queue-bubble-s8.test.ts`（只读契约用例收窄为 steer/followUp 行；defer 行新用例：根门 state=undefined 渲染、未提交 × emit、分档 chip/hover、+N 徽标；承接 PendingBubble 分档与撤销边界用例） | 无 |
| u2 | 对话流侧 PendingBubble 移除 + useCompactQueue 收尾 | `components/panel/MessageStream.vue` / `components/panel/message-stream/PendingBubble.vue`（删）/ `components/panel/message-stream/__tests__/PendingBubble.test.ts`（删）/ `composables/panel/useCompactQueue.ts`（拆 useSessionPendingEntries + 头注 3 处 PendingBubble 指称修订 :10/:19/:106） | u1（切换窗口不出现「双显示」或「无显示」） |
| u3 | 压缩中通栏活动带 + 高度常量 + 原语注释同步 | `components/panel/message-stream/ActivityStrip.vue` / `composables/panel/message-stream-layout.ts`（常量值 + 强绑定 DOM 注释）/ `components/panel/message-stream/__tests__/ActivityStrip.test.ts`（band 用例 + 本文件内 PendingBubble 注释清扫）/ `packages/shared/src/tailwind-preset.ts`（content-col 消费方清单注释，纯注释改动） | u1（消费 `compactingFlushHint` key） |
| u4 | 悬空引用清扫 + drift 机检（全注释/文档编辑，无逻辑改动） | `composables/panel/useMessageStreamFollowTriggers.ts`（:17/:147 触发矩阵 pending 表述）/ `composables/panel/useVirtuaFollow.ts`（:33）/ `__tests__/panel/composer-compact-queue.test.ts`（头注 3 处 :4/:5/:15，PendingBubble 指称改指 QueueBubble defer 行 / `queue-bubble-s8.test.ts` defer 行分支）/ `packages/core/src/domain/chat/store.ts`（:382 jsdoc）/ `docs/design/chat-pin-bottom-fix.md`（7 处，尾部块 SSOT 必扫）/ `docs/design/session-dead-structural-fixes.md`（:23/:328）/ `docs/testing/03-chat-flow.md`（悬空符号 = `pending-bubble-list` testid，:44/:401）/ `docs/design/adversarial-review-fixes.md`（:316）；显式豁免：`docs/page-design/archive/v3/fast-fork/spec.md`（archive 历史档案不改）。收尾跑 `node scripts/check-doc-symbol-drift.mjs`（机检候选集不含 PascalCase/普通驼峰/testid，本清单即权威） | u2（符号删除先行，清扫才有着落） |

领地互斥核对：`panel.ts` 仅 u1；`ActivityStrip.test.ts` 仅 u3（u2 不碰）；`useCompactQueue.ts` 仅 u2；u4 与 u2/u3 文件交集为空。u4 共 8 路径（+1 显式豁免不计入）但全部为 1-3 行注释/文档编辑（无逻辑），超出「≤5 文件」判据的部分属机械清扫，已在计划登记。

## 变更历史

- 2026-09-13 v1：初稿。方案来源 = 三 demo 用户裁决（方案 2），demo 文件 `.tmp/compact-queue-demos/`。
- 2026-09-13 v2：三审 round 1 全修（2+4 must-fix、3+4 suggestion 全部处置）。F1 → §2.1 双数据源归一规则（defer 行仅渲染未提交条目，被否谱系 2 条）+ A8 场景 + 副文案 count 口径改未提交；F2 → 根门改写声明；F3/INFO → u1 测试领地更名 queue-bubble-s8.test.ts + 只读契约收窄；F4 → 清扫清单补全（源码 4 面 + docs 5 面）+ 新拆 u4 清扫单元；F5 → §2.2 摘除 content-col/system-notice + tailwind-preset 注释同步；S1 → 可见性口径变化声明 + 副文案全量补偿；S2 → 亮色主题四要素补齐；S3 → 覆盖面 re-home 声明；S4 → A9 split 场景；主审 P1-4 → demo-2 入库 `docs/page-design/compact-defer-queue-spec.html`；主审 S3 → QueueBubble 头注归 u1、useCompactQueue 头注归 u2；~~`submittedAwaitingDelivery`~~ 消费方消失，key 暂留（终态同步复核）。
- 2026-09-13 v3：round 2 聚焦复审全修（主审 0MF/1S；影响审 2MF/2S）。MF-1 → 归一规则承接句按通道改写（steer=镜像行承接；send=无承接行、确认前不可见窗口显式声明——inflight 纯记账计数无视觉形态、flush-send 不做乐观 appendUser 源码证伪 v2 叙述）+ 反例重演/A2/A8 联动改写 + A8 补 D1 长任务可观测步骤 + 提交尝试瞬态声明（主审 S 吸收）；MF-2 → re-home 锚点修正（use-compact-queue.test.ts TC5/CD1 承接转态，use-chat-compacted-flush.test.ts 为 renderer 包 flush 触发面）；S-1 → u4 种子内联改写目标（composer-compact-queue.test.ts 3 处 :4/:5/:15）+ 03-chat-flow.md 标注 `pending-bubble-list` testid；S-2 → u4 计数修正 8 路径（+1 豁免不计入）；INFO → 「unde」残缺文本修正、system-notice 零 CSS 定性修正（摘除=死标记清理）+ v-for 按 row.kind 条件化实施注意、pi 既有队列交叉时序沿用既有约定加注。被否谱系新增：~~inflight 占位承接展示~~ —— 源码证伪（记账计数器无视觉形态）。
