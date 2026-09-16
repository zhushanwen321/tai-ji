# 对话流系统通知渲染升级（分隔线 Pro + background-bash 结构化 + 展开块内滚动）技术方案

> **一句话结论**：对话流 4 条系统通知（压缩完成 / 后台任务完成 / 压缩中 / background-bash 完成）的渲染问题不是「样式不够好看」，而是**信息结构缺失**——background-bash 是扩展日志原文直接上屏（无结构化 details）、bg-notify 边界行消化了通知本体却丢失了计数/成败/耗时、压缩中通栏带违反 DESIGN.md 通知族二分的横线分隔行规格。本设计按「底层 extension 补 details → shared 单点防御解析 → SystemNotice 增强重构 + message-turns 聚合投影」拉直数据链，视觉层落地用户已裁决的「方案一增强版」（加粗主文案 + 显化分割线），并把 thinking/bash 展开块统一收进 240px 块内滚动容器。
>
> **触及最高 P 级：P0**（对话流渲染、subagent/workflow 通知链——docs/FEATURE-PRIORITIES.md §2）。**风险分：9/10**（P 级基数 9；可逆性修正 0 = 全部改动可逆——details 为新增可选字段向后兼容、渲染层纯投影、无数据迁移无破坏性契约；新颖度修正 0 = 全部沿用仓内先例——`parseBgNotifyDetails` 防御解析、横线分隔行族、`max-h-80` 限高先例、`useTailScroll` 尾部追踪范式）。风险分由模块 P 级驱动而非改动不可逆性，dev-flow 资源倾斜按 9 继承。
>
> **当前层 → 下一层**：技术方案 → dev-flow 可实施单元（含验收条款的 impl-plan）。
>
> **修订记录**：R1（初版。按用户裁决跳过对抗式审查环节，直接交付供 dev-flow 使用）。

## 1 背景目标

**SCQA**：太极是 AI Agent 桌面工作台，对话流是用户观察 agent 工作的主界面。**C** 高负载 session（并发后台任务 + 长 thinking + 大输出）实测：4 条系统通知中 2 条信息残缺（background-bash 原文 `[background-bash] bt-3 finished (exit 0, 3m12s): pnpm test` 上屏；「后台任务完成 · 已继续处理」不说是哪个任务、成败、耗时），1 条形态违例（压缩中通栏 accent 带，DESIGN.md 通知族二分明确「压缩中提示」属横线分隔行），且 thinking/bash 展开无高度限制，一次长输出把对话流顶穿。**Q** 用户无法从系统通知快速读取「什么完成了、成功没有、花了多久」，回看历史时被超长展开块打断。**A** 按用户已裁决的方案一增强版落地：通知族统一为语义化横线分隔行（主文案加粗提色 + 分割线显化），background-bash 经 extension details 结构化，bg-notify 边界聚合出计数/成败/耗时，展开块统一块内滚动。

**系统是什么**（给不熟悉渲染链路的开发者）：对话流渲染三层——pi session JSONL / 实时事件 → runtime event-adapter 翻译 → core `applyEntry` 单一 reducer 产出 `Message` 数组（live ≡ reload，两路同一 reducer，AGENTS.md 规则 9）→ `message-turns.ts` 分组层把扁平消息分为 turn 项与 static 项（systemNotice / bashExecution）→ `MessageStream.vue` 按 kind 分发到 `Turn.vue` / `SystemNotice.vue` / `BashOutputBlock.vue`。系统通知的系统内来源有四类：pi 持久化 entry（compaction/branch/custom message）、runtime 合成的 liveOnly 消息（stream_warn）、core 分组层边界语义（bg-notify trigger turn）、壳层 transient 状态（ActivityStrip 的 occupancy 投影）。

**设计目标**：

1. **G1 通知信息完整**：4 条通知各自说清「主体 + 结果 + 关键数字」——background-bash 显示命令 + exit + 耗时；bg-notify 边界显示任务计数 + 成败 + 总耗时；压缩显示 tokens 钉右。
2. **G2 形态归一**：4 条通知全部落 DESIGN.md 通知族二分的「横线分隔行」族（静态元信息，无可交互入口），压缩中通栏带降级回归该族。
3. **G3 可读性增强**：按用户裁决增强——分割线 `hairline(0.05)` → `border-strong(0.13)` 两端渐隐、主文案 `text-xs/mid/400` → `text-sm/fg/550`、图标 13px/stroke 2.2，并同 commit 修订 DESIGN.md 规格行（设计文档同步纪律）。
4. **G4 数据链拉直**：background-bash 结构化走「extension details → 既有 details 透传管道 → shared 单点防御解析」，content 原文保留给 LLM，旧数据无 details 降级原文，零解析破窗。
5. **G5 展开块不撑爆对话流**：thinking / bash / 工具输出展开统一 240px 块内滚动（渐隐提示 + 行数信息条 + 展开全部逃生口 + streaming 自动吸底 + bash 命令头吸顶）。

**In-scope**：`SystemNotice.vue`（增强重构 + background-bash 分支）、`ActivityStrip.vue`（压缩中降级）、`message-turns.ts` + `Turn.vue`（bg-notify 边界聚合）、`Block.vue`（块内滚动）、extension `base-tool-enhance/notify.ts`（补 details）、`shared/message.ts`（解析 SSOT）、DESIGN.md 规格行修订、i18n 键增减、相关单测。

**Out-of-scope**（明确不做，含理由）：

- **todo/goal widget pill 形态变更与入流**——pill 现状可用，是否入流待用户另行裁决；本设计零触碰。
- **通知的可交互化**（点击查看完整输出/托盘面板）——可交互即被 DESIGN.md 通知族二分踢出横线分隔行族（转入通知卡片族），与 G2 冲突；留待后续单独设计。
- **`!` bash 气泡（BashOutputBlock）重构**——其 `--bash-output-max-height: 240px` 限高已存在，本设计只统一 trace 区展开块。
- **ForkNotice / RespawnNoticeBar / TurnProgressBar / QueueBubble**——分属通知卡片族 / warn 卡 / composer 域，不属本次 4 条通知范围。
- **workflow-result details 的成败/耗时提取**——其 details 无公共时间字段契约（仅 `__gui__` + run 元信息），本期只计入边界行计数（见 §3.3 D5）。

## 2 现状与问题分析

### 2.1 使用者视角的现状（真实例子，取自代码）

**① 压缩完成**（`SystemNotice.vue` resolveNotice：compactionSummary → Archive 图标）：

```
─── 📦 已压缩上下文（237.2K tokens） ───
```

tokens 混在文案里，扫读无法一眼定位数字；样式为 `text-xs neutral-mid` + 两侧 `h-px bg-border` 横线。

**② 后台任务完成**（`Turn.vue` trigger 起点行，Bell 图标 + `panel.message.turnTriggerBgNotify` = 「后台任务完成 · 已继续处理」）：

```
─── 🔔 后台任务完成 · 已继续处理 ───
```

数据链（`message-turns.ts` groupRenderInput 规则 2）：`subagent-bg-notify` / `workflow-result` 两类 custom message 被 `apply-entry` 覆写 `display:false`（`COMPLETE_NOTIFY_CUSTOM_TYPES` SSOT，消息本体不渲染），分组层 `isHiddenCompleteNotify` 命中后开一个 `trigger:'bg-notify'` 的空 turn 等 assistant 填实。**计数/成败/耗时在 `TurnGroup` 上没有任何载体**——`trigger` 是单值常量，连续多条通知折叠复用同一组（「连续边界折叠」注释），渲染层拿到的只有「发生过」这一个比特。

**③ 压缩中**（`ActivityStrip.vue` compacting 行：`-mx-5` 通栏 + `bg-[var(--accent-soft)]` + `border-y` + `py-[14px]` + 待发副文案）：

```
════════════ 🔄 正在自动压缩上下文 · 2 条待发将在压缩后提交 ════════════
```

DESIGN.md §6.1 通知族二分（2026-08-19 裁决）明确「横线分隔行 = 静态元信息（无可交互入口，**如 SystemNotice / 压缩中提示**）」——通栏带是 compact-defer-composer-queue 时期为承接待发副文案的升级形态，与裁决行矛盾；且瞬时状态占了全族最高视觉权重（通栏 + 底色 + 14px 行距）。

**④ background-bash 完成**（`SystemNotice.vue` 兜底分支：Archive 图标 + `normalizeContent(content)` 原文）：

```
─── 📦 [background-bash] bt-3 finished (exit 0, 3m12s): pnpm test --workspace extensions ───
```

生产端（`extensions/universal/base-tool-enhance/src/background/notify.ts:188-192`）content 是模板字符串拼接的日志行：`[background-bash] ${taskId} finished (exit ${code}, ${duration}): ${command}`，**sendMessage 不带 details**；图标还是压缩语义的 Archive 兜底。物理数据流：

```
extension notify.ts（poller 检测终态）
  │ pi.sendMessage({customType:'background-bash', content, display:true},
  │               {deliverAs:'steer', triggerTurn:true})        ← content 给 LLM 接力，无 details
  ▼
pi 进程 ──写──> session JSONL（custom_message entry）
  │ message_start                    │ 重开 replay
  ▼                                  ▼
event-adapter:865 details 窄化 ──> registry:747 重构 entry ──> applyEntry（同一 reducer 同一 case）
  │ deriveCustomMessageEntryMessage：customType/content/details/display 全透传（apply-entry.ts:460-475）
  ▼
core Message{role:'system', customType:'background-bash', details:undefined}   ← details 管道全程在，只是生产端没写
  │ groupRenderInput 规则 5（可见 system）→ static systemNotice 项
  ▼
SystemNotice 兜底分支：Archive 图标 + content 原文
```

**⑤ 展开块无高度限制**（`Block.vue`）：thinking 展开区是完整 `MarkdownRenderer` 无任何 max-height；bash 凹槽（`rounded-sm bg-bg-input`）输出区 `whitespace-pre-wrap` 无 max-height——**只有 `parsedJsonOutput` 享有 `max-h-80 overflow-auto`（Block.vue:178/197）**。一次 300 行 `pnpm test` 输出或数千字 thinking 全量直排，后续消息被顶出视口。

### 2.2 根因分析

- **R1（④）**：生产端没写 details，消费端只能显示 content——而 content 是写给 LLM 的日志行（triggerTurn:true 接力语义），不是写给人的。details 透传管道（event-adapter → registry → reducer → Message.details）**早已全通**（subagent-directive / workflow-result `__gui__` 均依赖此管道持久化），缺的是生产端写字段 + 消费端加分支。
- **R2（②）**：分组层把通知本体消化为边界语义时只保留了一个比特（`trigger` 常量），聚合载体从未被设计。
- **R3（①③）**：样式规格陈旧且③偏离了 DESIGN.md 裁决行，无信息分层（主/从/meta 同级同色）。
- **R4（⑤）**：限高只覆盖了 JSON 输出一个分支，普通文本与 thinking 两个大头漏网。

## 3 解决方案

### 3.1 终态（使用者视角）

同一高负载片段的终态对话流（成功路径）：

```
user: extensions 的全量测试挂后台跑，然后把 renderer 的 fg5 用例修绿
┌ THINKING · 先确认后台任务的 spawn 路径……                    （收起单行）
┌ Bash · pnpm vitest run --project renderer fg5 · 38s
│ ┌──────────────────────────────────────────────┐
│ │ pnpm vitest run --project renderer fg5        │ ← 命令头 sticky 吸顶
│ │  ✓ fg5-message-stream.test.ts (14) 211ms     ││ ← 240px 块内滚动，
│ │  …（滚动区，上下渐隐）                         ││   细滚动条
│ ├──────────────────────────────────────────────┤
│ │ 3–12 / 15 行                    展开全部 ↓    │ ← 信息条
│ └──────────────────────────────────────────────┘
assistant: fg5 的 14 条用例全绿了。
─── 📦 已压缩上下文 · 237.2K tokens ───        ← 主文案 text-sm/fg/550，线 border-strong 渐隐
assistant: 后台的 extensions 测试该出结果了——
─── ⌨ pnpm test --workspace extensions [后台] · exit 0 · 3m12s ───   ← 命令 mono 前置，exit 绿
─── ✓ 3 个后台任务完成 ●●● · 已继续处理 · 26m03s ───                 ← 计数+状态点+耗时
assistant: 全部通过。
─── 🔄 正在自动压缩上下文 [待发 2] ───          ← 通栏带降级为 spinner 分隔线
```

失败路径与恢复指引：

- **后台 bash 失败**（exit≠0 / 超时）：exit 文本哑光金（warn），超时显示「已超时」（复用 `bashTimeout`/`bashCancelled` i18n 键族）。用户恢复动作不变：让 agent 用 `bash_output <taskId>` 查全文重跑——content 原文仍含 taskId，LLM 接力不受影响。
- **bg-notify 含失败**：边界行图标换 warn 色 + 文案「N 个后台任务完成 · M 失败」；用户经侧边栏 subagents tab 定位失败任务（既有入口）。
- **展开全部后内容仍超长**：信息条按钮变「收起 ↑」，一键回滚限高；该展开态是块实例本地状态，virtua 回收/重开 session 后自然复位（不持久化，见 §3.3 D6 决策）。
- **旧数据渲染**：无 details 的 background-bash 历史 entry → 防御解析 null → 逐字节回到现状原文行（见 §3.3 D2 错误规格）。

### 3.2 多方案对比

三个候选已在 demo 轮全部实做出来（`~/.agent/diagrams/taiji-system-message-demos.html` 历史版本），用户现场裁决后本设计只记录结论与代价：

| 维度 | A 方案一增强版（分隔线 Pro） | B 单行通知条（卡片化） | C 终端语义（命令→终端块） |
|---|---|---|---|
| 长期架构合理性 | 横线分隔行单族演化，与 DESIGN.md 二分完全同构；G2 天然成立 | 引入第二实体形态，与通知卡片族（bg-soft）边界模糊，二分需重写 | 「命令产物 vs 过程注脚」二分有理，但新增终端块组件族，通知族变两族 |
| 短期实现成本 | **最低**：SystemNotice 单组件样式层 + 分支；无新组件 | 中：新 NoticeBar 组件 + 四路接入 + DESIGN.md 形态表重写 | 中：新 BgBashTermBlock + 同样的 details 改造 |
| 风险（分 + 来源） | **9/10**（P0 渲染面；改动全可逆） | 9/10（P0 渲染面 + 二分裁决重写外溢到 ForkNotice 族） | 9/10（P0 渲染面；新组件族维护面） |
| 被否后果（§2 例） | —— | 4 条连发时卡片连排，高负载对话流视觉重量显著上升（demo §3 实测观感） | background-bash 一条变双行块，但压缩/边界仍走分隔线——「命令 vs 状态」分流概念好，但为 1 条通知新增一族组件，Rule of Three 不足 |

**推荐 = A 方案一增强版（用户已裁决）**。推荐理由：① 单族演化零新组件，G2 构造性成立；② C 的「命令 mono 前置 + exit 钉右带色」精华被吸进 A 的结构化分隔行（demo 终版已融合）；③ DESIGN.md 只需修订样式参数行，不重写形态判据。

### 3.3 关键决策与权衡

**D1 background-bash 结构化 = 改底层 extension 补 details，content 不动**

- **选择**：`notify.ts` sendMessage 时附 `details`（schema 见下），content 模板字符串原样保留。
- **被否**：上层（runtime/renderer）正则解析 content——格式是 extension 内部模板字符串，文案漂移即静默打破；且 live（renderer）/reload（runtime mapper）两处正则需同步，双点漂移源。也否「改 content 为结构化文本」：content 是 `triggerTurn:true` 给 LLM 接力的载荷，改它影响 agent 行为且破坏旧数据可读性。
- **证据**（✅已测，代码核实非推测）：details 透传管道全程在位——event-adapter.ts:865 窄化 object → 广播；registry.ts:747 `details: payload['details']` 进重构 entry；apply-entry.ts `deriveCustomMessageEntryMessage` `details` 透传。先例：`subagent-directive` 的 details 持久化解析（parseSubagentDirective）、`workflow-result` 的 `__gui__` 经同一管道 reload 消费。
- **details schema**（`BackgroundBashDetails`，shared 登记）：`{taskId: string, command: string, exitCode: number|null, durationMs: number, endReason: 'natural'|'timeout'|'process-exit'}`。kill 路径不 sendMessage（notify.ts 既有语义），故无 killed 值；渲染映射：natural → `exit N · 耗时`，timeout → 「已超时」，process-exit → 「已终止」。
- **影响面**：event-adapter 托盘旁路只读 `customType`（:1540）零感知；pending-notifications 走 EventBus 独立通道零感知；LLM 消费 content 不变。

**D2 解析 SSOT 落 shared，防御 null → 渲染降级原文**

- **选择**：`packages/shared/src/message.ts` 新增 `parseBackgroundBashDetails(details: unknown): BackgroundBashDetails | null`，与 `parseBgNotifyDetails` 并列同款防御范式（必需字段缺失/类型异常 → null）。`SystemNotice.vue` 新增 background-bash 分支：parse 命中 → 结构化行（SquareTerminal 图标 accent + 命令 mono 主体 + 「后台」chip + exit/耗时钉右，exit 0 绿 / 非 0 warn）；null → 走现有兜底（Archive + content 原文），**旧 session 逐字节回到现状**。
- **被否**：解析放 renderer 本地——runtime 侧未来消费（如托盘 tooltip）会需要同一份窄化，放 shared 与既有三份 parse 同址，防字面量漂移。
- **错误规格**：

  | 失败形态 | 行为 | 恢复指引 |
  |---|---|---|
  | details 缺失（旧数据/第三方写入） | parse null → 原文行 | 无需动作，语义完整（原文含全部信息） |
  | 部分可选字段缺失（exitCode null） | 降级只显命令 + 「后台」chip | 同原文行可互证 |
  | content 非 string（畸形 entry） | normalizeContent 既有归一 | reducer 已兜 |

**D3 横线分隔行样式规格增强 + DESIGN.md 同 commit 修订**

- **选择**（用户裁决的增强版，demo §1 对照定稿）：

  | 变量 | 现状 | 增强 |
  |---|---|---|
  | 横线 | `h-px` 纯色 `bg-border`（两侧） | `h-px` `border-strong(0.13)` + 两端渐隐淡出（linear-gradient transparent→strong 18%→82%→transparent） |
  | 主文案 | `text-xs neutral-mid 400` | `text-sm neutral-fg 550` |
  | 从文案（「· 已继续处理」等） | 与主文案同级 | `text-xs neutral-mid 400` |
  | 图标 | 12px stroke 2.0 neutral-mid | 13px stroke 2.2；语义色仅 exit 0 绿 / 失败 warn 两处 |
  | meta（tokens/耗时/exit） | 混在文案内 | mono `text-2xs 500 tabular-nums neutral-dim` 钉右（exit 带语义色） |
  | 行距 | `py-1` | `py-1.5` |
  | chip（后台/待发 N） | 无 / 副文案拼接 | mono `text-3xs` + `border-strong` 描边 |

  不动项：静态无交互（二分合规）、`content-col` 宽度、`animate-notice-in` 动效、居中三段 flex 结构。
- **文档同步 [MANDATORY]**：DESIGN.md §6.1 通知族二分表的「横线分隔行」样式列同 commit 修订为上表（设计文档同步纪律 C-proc-10；`node scripts/check-doc-symbol-drift.mjs` 必须跑过）。
- **被否**：保持 `text-xs` 只加粗——用户实看 demo 后明确「字体加粗、分割线更显化」，规格行修订是用户裁决的直接落地。

**D4 压缩中通栏带 → spinner 分隔线（回归二分裁决行）**

- **选择**：ActivityStrip compacting 行从「通栏 accent-soft 带」降级为与 bash/thinking 行同构的 spinner 横线分隔行；待发副文案从长句（`compactingFlushHint` = 「2 条待发将在压缩后提交」）改为「待发 N」chip（新增 i18n 键 `compactingQueueChip`，zh+en；旧键随最后一处消费退役，同批清扫 zh/en）。bash/thinking/settling 行样式同步升 D3 增强规格（它们本就是横线分隔行族）。
- **连带面**（实施必须同批，否则 dev 断言红）：`COMPACTING_NOTICE_HEIGHT`（50 → 与 bash 行同高，实测值以实施期量取为准并同步 `message-stream-layout.ts`）、`useConstantHeightAssert` 期望、ActivityStrip 测试断言（`activity-strip-row-compacting` testid 保留，类名结构变）。
- **被否**：保留通栏带只改文案——DESIGN.md 裁决行明确压缩中提示属横线分隔行，通栏带是历史欠账，本设计还账（G2）。

**D5 bg-notify 边界行 = 分组层聚合投影 notifySummary**

- **选择**：`TurnGroup` 增加 `notifies?: Message[]` 载体——`groupRenderInput` 规则 2 分支在开/复用 trigger turn 时把隐藏通知消息压入该组 `notifies`（连续边界折叠复用组时累积追加，语义自然）；渲染层 `message-turns` 派生 `notifySummary{count, failedCount, durationMs?}`：
  - `count` = notifies 长度（无需解析，可靠）；
  - `failedCount` / 耗时：subagent-bg-notify 经 `parseBgNotifyDetails`（既有 SSOT）提取 status 与 startedAt/endedAt，`failedCount` = status ∈ {failed, cancelled} 或 closed 且 closedReason 失败族的条数；耗时 = `max(endedAt) − min(startedAt)`（全部缺失 → 不显耗时）；workflow-result 本期只计 count（details 无公共时间契约，§1 out-of-scope）。
  - 边界行（Turn.vue trigger 行）：图标 CheckCircle2（failedCount=0）/ TriangleAlert warn（>0）+ 主文案「N 个后台任务完成」（新增 i18n 键 `turnTriggerBgNotifySummary`，含 count；failedCount>0 追加「· M 失败」）+ 状态点列（count ≤ 8 逐点，done 绿 / failed 哑光金；>8 只显计数）+ 从文案「· 已继续处理」+ 耗时 meta。旧键 `turnTriggerBgNotify` 退役同批清扫。样式升 D3 增强规格。
- **等价性义务**：聚合逻辑只在 `groupRenderInput` 一处（全量/增量两路共享的分组 SSOT），不新增 reducer 字段、不动 apply-entry——live ≡ reload 构造性保持；`apply-entry-equivalence` 与 `custom-start-equivalence` 测试无需新差异类，message-turns 分组测试补 notifies 累积用例。
- **被否**：① 渲染层从 store 回扫隐藏消息聚合——分组层已消费过一次，回扫是第二份分组逻辑（漂移源，违反分组 SSOT 注释义务）；② 边界行显示任务名列表——单行装不下，列表属可交互卡片族，超 scope（§1）。

**D6 展开块统一块内滚动（BlockScrollBox）**

- **选择**：`packages/ui/src/features/chat/` 新增展示组件 `BlockScrollBox.vue`，三件套：
  1. **限高滚动**：`max-height: var(--block-scroll-max-height)`（新增 token = 240px，与既有 `--bash-output-max-height` 同量级、各自独立消费域），`overflow-y:auto` + `overscroll-behavior:contain` + 细滚动条（`scrollbar-width:thin` + webkit thumb `surface-hover`）。
  2. **渐隐提示**：上/下渐隐条仅在该方向可滚时显示（scroll 事件切 class，渐变底色按容器上下文区分——thinking 区 = `--bg`，bash 凹槽 = `--bg-input`）。
  3. **底部信息条**：mono `text-3xs neutral-dim`，mono pre 内容显「{from}–{to} / {total} 行」（行高 getComputedStyle 实测），markdown 内容显「约 {total} 行」（scrollHeight/行高估算）；右侧「展开全部 ↓ / 收起 ↑」（**@taiji/ui Button ghost，禁原生 button**——前端规范红线）；内容不超过限高时整条不渲染。
  - **接入点**（Block.vue 三处 + 一处删除）：① thinking 展开区 `MarkdownRenderer` 整体包入；② bash 凹槽输出区包入，**命令头移入 ScrollBox 内首位 + `position:sticky;top:0;background:--bg-input` 吸顶**；③ 非 bash 工具输出区（AnsiText/displayContent）包入，`GuiComponentRenderer` 输出不包（GUI 协议内容自管理高度）；④ 删除 `parsedJsonOutput` 的 `max-h-80` 局部限高，统一走 ScrollBox。
  - **streaming 吸底**：内容增长且用户未上滚时 `scrollTop = scrollHeight`（scroll 监听维护 wasAtBottom 标志；用户上滚后停吸、回底恢复）；展开全部态不吸底。沿用 `useTailScroll` 已验证的尾部追踪语义，但实现独立（该 composable 服务 header 尾行视口，机制不同不硬复用）。
  - **展开态 = 块实例本地 ref**：不进 store、不持久化——virtua 回收/重开即复位（与 Block 本地折叠态既有语义一致，Turn.vue v-memo 不含本地 ref 的先例注释已确认此模式安全）。
  - **既有交互零冲突**：copy 按钮在 ScrollBox 外层 `group/content relative` wrapper 上，层级不动；空输出占位行留在 ScrollBox 外。
- **被否**：① 全量展开 + 「回到顶部」按钮——对话流被顶穿的问题依旧；② 固定 10 行 clamp（line-clamp）——不支持横向滚动且 bash 宽表格需保留 `pre` 对齐（BashOutputBlock S8 注释的既有裁决：超宽内容走横向滚动）；③ 展开态入 store 持久化——重开复位是可接受代价，持久化徒增 per-session 分区面（ADR-0049 范式约束）。
- **探针**（准则 7）：⛔实施期门 P1——dev app 真实长输出场景量取「240px ≈ mono 12 行 / markdown 10 行」并回写 token 注释；⛔ P2——virtua RO 测高在展开全部高度突变时无抖动（fg5 现有 RO 注释声称自动接管，实施期真机验证，抖动则降级为展开时手动 scrollIntoView）。

**D7 todo/goal pill、通知可交互化不动**

- 见 §1 out-of-scope。登记理由：pill 现状已覆盖「有几个、现在做到哪」；可交互化与 G2 形态归一冲突，需另起设计裁决卡片族归属。

## 4 验收

> 真实环境：`TAIJI_DEV_BACKGROUND=1 pnpm dev` 起 dev 实例（数据目录 `~/.taiji-dev/`），browser-automation 经 CDP 连接（`node apps/electron/scripts/dev-instance.mjs --print` 查端口），真实 pi + 真实 LLM session。每个场景标注回溯目标。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|---|---|---|
| S1 | background-bash 结构化（G1/G4） | dev session 中让 agent 派发后台 bash（如 `sleep 2 && echo done`），等完成通知；随后 `bash_output` 确认任务真实终态；**重开该 session** | 通知行 = SquareTerminal + 命令 mono + 「后台」chip + `exit 0 · Ns` 钉右绿色；无 `[background-bash]` 协议头；session JSONL 对应 entry 含 details 五字段；重开后渲染逐字节一致（live ≡ reload） |
| S2 | 旧数据降级（G4） | 用实施前的旧 session（含原文 background-bash entry，无 details）重开 | 该 entry 渲染为现状原文行（Archive + 原文），无报错无空白 |
| S3 | bg-notify 边界聚合（G1） | dev session 派发 2 个后台 subagent（一个 sleep 短任务即可），等双完成后续跑 | 边界行 = ✓ 绿 + 「2 个后台任务完成」+ 两点绿 + 「· 已继续处理」+ 耗时 meta；kill 其中一个制造失败 → 图标 warn + 「· 1 失败」+ 失败点哑光金 |
| S4 | 压缩两态（G2/G3） | dev session 手动触发压缩（/compact 或长上下文自动阈值），压缩期间发 1 条待发消息 | 压缩中 = spinner 横线分隔行 + 「待发 1」chip（无通栏带）；完成后 = 「已压缩上下文」主文案加粗 + tokens 钉右；线显化、两端渐隐 |
| S5 | 块内滚动（G5） | dev session 执行长输出命令（`pnpm vitest run` 全量或 `seq 1 300`），展开 bash 块；再触发一次长 thinking 并展开 | 输出区 240px 限高、命令头吸顶、下渐隐可滚时可见、信息条行数正确、「展开全部」后全量且按钮变「收起」；thinking 同三件套；streaming 期间新输出自动吸底，手动上滚后停吸 |
| S6 | 视觉对照（G3） | browser-automation 截图 S1–S5 各通知，与 demo（`~/.agent/diagrams/taiji-system-message-demos.html` §2）并排人工比对 | 线色/字重/图标/钉右 meta/行距与 demo 一致；混合对话流中通知层级弱于正文、强于 trace 块头 |
| S7 | 回归零破窗（G1–G5 公共） | `pnpm run lint` + 受影响包 vitest + `node scripts/check-doc-symbol-drift.mjs` + `pnpm extensions:typecheck && pnpm extensions:test` | 全绿；DESIGN.md 修订与 SystemNotice 改动同 commit |

**e2e 影响面评估**（开发阶段按改动面执行，空载串行；PR/CI 不跑真实 LLM）：改动面 = `packages/ui/src/features/chat/**`、`packages/core/src/domain/chat/**`、`packages/renderer/src/**`、`extensions/universal/base-tool-enhance/**`、`packages/shared/**`。`node scripts/select-affected-e2e.mjs --base main` 预期圈定：**E2E-ELECTRON-01**（always，L1 P0 smoke——core/renderer scope 命中）、**E2E-VISUAL-01**（L1 像素轨，renderer scope 命中——chat 视觉变更需人工核对 pixel diff 报告并更新基线）、**E2E-EQUIV-01**（等价性双轨，core apply-entry scope 命中——message-turns 改动面；TAIJI_SKIP_REAL_PI=1 mock 轨）。无真实 LLM（L3）资产受影响。单测化路径：parseBackgroundBashDetails 防御矩阵、notifySummary 聚合、SystemNotice 分支渲染、BlockScrollBox 行为（fake timers + jsdom scroll mock）全部落 vitest 单测，不新增 e2e 资产（三态纪律 R2：触发条件 = 上述 scope，已命中既有条目，无需新登记）。

## 5 下一层拆分

实施顺序按依赖链编排（U1→U2→U3 为数据链，U4 随 U3 同 commit；U5/U6/U7 相互独立可并行）：

| 单元 | 内容 | justification | 独立验收 |
|---|---|---|---|
| **U1** extension 补 details | `extensions/universal/base-tool-enhance/src/background/notify.ts`：`buildNotifyDetails()`（schema 按 D1）挂进 sendMessage；单测覆盖 natural/timeout/process-exit 三形态 | 数据链源头，无它 U3 分支无米下锅 | extension 单测：details 五字段值与 task 终态一致 |
| **U2** shared 解析 SSOT | `packages/shared/src/message.ts`：`BackgroundBashDetails` 类型 + `parseBackgroundBashDetails()`；防御矩阵单测（null/非对象/缺字段/类型错/正常） | 单点窄化防字面量漂移，与既有三份 parse 同址（D2） | 单测全绿 |
| **U3** SystemNotice 增强重构 + 分支 | `packages/ui/src/features/chat/SystemNotice.vue`：D3 规格全量落地 + background-bash 分支（D2 降级链）+ compaction 文案/tokens 拆分钉右；i18n 键调整（zh+en）；testid 保留 `system-notice` 族 | 通知族主战场；分支依赖 U2 类型 | S1/S2/S4 后半 + 组件测试（分支渲染断言） |
| **U4** DESIGN.md 规格行修订 | §6.1 通知族二分表「横线分隔行」样式列按 D3 表重写 | **与 U3 同 commit**（设计文档同步纪律 C-proc-10，check-doc-symbol-drift 必跑） | 文档守卫绿 |
| **U5** ActivityStrip 压缩中降级 | `ActivityStrip.vue` compacting 行改 spinner 分隔行 + 待发 chip（新键 `compactingQueueChip`）；`message-stream-layout.ts` 常量同步；bash/thinking/settling 行同步 D3 规格；测试断言更新 | 瞬时状态形态归一（G2），独立于 U1-U3 | S4 前半 + ActivityStrip 测试绿 |
| **U6** bg-notify 边界聚合 | `message-turns.ts`：TurnGroup.notifies 载体 + groupRenderInput 规则 2 压入 + `notifySummary` 派生；`Turn.vue` trigger 行重写（图标/计数/点列/耗时，D5）；i18n 新键 `turnTriggerBgNotifySummary`，旧键退役清扫；分组测试补累积用例 | 信息黑洞填补（G1），分组 SSOT 单处改动保 live ≡ reload | S3 + message-turns 测试绿 + 等价性测试无新差异类 |
| **U7** BlockScrollBox 块内滚动 | 新组件 `BlockScrollBox.vue` + `--block-scroll-max-height` token + Block.vue 三处接入 + `max-h-80` 删除 + 命令头 sticky 迁移；jsdom 行为测试（限高/渐隐 class/展开切换）；探针 P1/P2 实施期执行 | 展开块收口（G5），独立于通知线 | S5 + 组件测试绿 + 探针回写 |

**文件改动地图**（按包聚合）：

```
extensions/universal/base-tool-enhance/
  src/background/notify.ts                    [U1] buildNotifyDetails + sendMessage 挂载
  src/__tests__/（notify 族测试）              [U1] 三形态 details 断言
packages/shared/
  src/message.ts                              [U2] 类型 + parseBackgroundBashDetails
  src/__tests__/（message 族测试）             [U2] 防御矩阵
packages/ui/src/features/chat/
  SystemNotice.vue                            [U3] 增强规格 + background-bash 分支
  BlockScrollBox.vue                          [U7] 新增
  Block.vue                                   [U7] 三处接入 + max-h-80 删除 + sticky 迁移
  Turn.vue                                    [U6] trigger 边界行重写
packages/core/src/domain/chat/
  message-turns.ts                            [U6] TurnGroup.notifies + 聚合 + notifySummary 派生
packages/renderer/src/
  components/panel/message-stream/ActivityStrip.vue   [U5] compacting 降级 + D3 同步
  composables/panel/message-stream-layout.ts          [U5] COMPACTING_NOTICE_HEIGHT 同步
  i18n/locales/zh-CN/** + en-US/**            [U3/U5/U6] 键增删（同批清扫退役键）
  style.css                                   [U7] --block-scroll-max-height token
docs/DESIGN.md                                [U4] 通知族二分样式列修订（随 U3 同 commit）
```

**待验证检查点**（设计期诚实登记，实施期落定）：

1. `COMPACTING_NOTICE_HEIGHT` 新值 = 实施期量取增强版分隔行实际高度后回写常量与断言（D4 连带面）。
2. 探针 P1（D6）：240px 在 mono/markdown 两上下文的实际行数，回写 token 注释。
3. 探针 P2（D6）：展开全部高度突变时 virtua RO 是否零抖动；抖动则降级手动 scrollIntoView 并回写本决策。
4. `failedCount` 对 `closed + closedReason` 失败族的枚举值清单 = 实施期以 `notifier.ts ClosedReason` 实装为准逐值归类（design 期不臆造枚举）。
5. 像素轨基线更新范围 = 以 E2E-VISUAL-01 diff 报告实际命中为准。
