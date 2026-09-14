# TurnProgressBar 收编——常态信息并入 TurnMeta、观测条改 warn 告警条（remove-turn-progress-bar）精简设计

> 来源：用户 2026-09-14 截图反馈（Composer 上方「本 turn 已 1 分钟 已生成 207 字符」常驻条与对话流「已工作」行信息重复）。会话调研结论 = 设计输入，主 agent 固化成文；对抗式审查 round-1（2026-09-14，三审报告 `.tmp/tech-design/design-review-20260914-191023*.md`）3 must-fix + 9 suggestion 已全修，本文为 round-2 修订版。
>
> 速记码对照（原始裁定文档 session-dead-structural-fixes 为 transient 产物已不在库，裁定语义以本文就地复述为准）：**W6** = dead 优先级吞掉活跃 UI（session 错误态不渲染活跃指示）；**F-U1** = turn 锚守门（后台 turn 更替后切回，重落基线防陈旧计时/字符虚高）；**P-3** = warn 阈值 10min 的实测定值纪律（数据落地前禁收窄）；**D6** = ask_user 豁免态（等待输入期间警示不参与）；**D7** = 文案纪律（只陈述事实，禁判断词）；**Gate B** = 真机验收门。

> round-2 攻击核验记录（2026-09-14，详见三份报告 round-2 节；三审 0MF，唯一残留 suggestion 已回修于 §2.4/u2）：① §1.1 B1 裁决经「chars 可从 trace 正文读出」反例攻击后存活（内容 vs 聚合标量可见性不等价 + 全仓单点展示结构免疫重复形态）；② U6 反转依据链经全部 pending 状态空间穷举后闭合（唯一 overlay 缺席的 dead 态恰是旧 bar 同被 W6 排除的格子，无回退）；③ snapshot 2 字段经「可否再砍为 elapsedMs|null」攻击后确认为正确停刀点（warn 不可从 elapsed 派生 + 迭代候选 ActivityStrip elapsed 消费 raw 值）。

## 1 背景/目标

- 现状：Composer 上方常驻观测条 `TurnProgressBar.vue`（session-dead V5② 产物）展示「本 turn 已 N 分钟 · 当前 tool 已 M 分钟 · 已生成 X 字符」，warn（≥10min）时追加「中止此 turn / 继续等待」。对话流 turn 头部 `TurnMeta.vue` 已有「工作中/已工作 + elapsed + 时刻区间 + think/tool badge」。
- 问题：① turn elapsed 两处重复展示；② 常驻条占据 Composer 上方视觉位，信息价值低（elapsed 重复、单工具耗时与 chat-timestamp 后的 tool 块 header 耗时重复）；③ 但「已生成 X 字符」是 TurnMeta 没有的信息，直接删条会丢；④ warn 态的「中止/继续等待」是超时场景下唯一**主动提示**的应对入口（Composer stop 是常驻中止通道但不主动——超时语境下不会提示用户「该看看这个 turn 了」），不能丢。
- 目标：
  1. TurnMeta 增「已生成 X 字符」（工作中随流式增长、完成后定格），承接观测条的字符数信息
  2. TurnProgressBar 改 warn 告警条：仅超阈值时出现（警示色 + 本 turn 已 N 分钟 + 中止/继续等待），常态零视觉占用
  3. core `useTurnProgress` 随消费面收窄（删 chars/tool 派生），防死代码漂移
- Out-of-scope：warn 阈值定值（P-3 实测纪律，维持 10min）；TurnMeta 自身 5min/30min 分级配色（与 bar 的 10min 交互告警是不同关注点——视觉分级 vs 操作入口，维持现状）；ask_user 豁免的 warn 抑制语义（保留，仅删其分型文案渲染）；ActivityStrip（不在本设计范围）；**dispatching 空窗 elapsed 缺口**（发送→首条 assistant 落地期间旧 bar 是唯一 elapsed 面，改后该窗口无 elapsed 显示——显式接受：窗口通常秒级、>10min 有 warn bar 兜底、settling 段 TurnMeta 在场；后续迭代候选 = ActivityStrip thinking 行带 elapsed）；**sidebar 段 i18n 死键守卫盲区**（见 §2.4 与 §3-A8，候选 14 键的 triage + 清扫为独立 chore，不裹挟本 PR）。

## 1.1 方案对比与被否谱系

**被否方案 A：直接整行删除 TurnProgressBar**——击穿反例：warn 态「中止此 turn / 继续等待」交互无处落（超时场景唯一主动提示的应对入口丢失，§1 问题④）；ask_user 豁免的 warn 抑制载体同时消失（豁免语义只剩 core 内部计算，无 UI 侧存在）。故「删」只能删常态展示，warn 告警形态必须保留。

**分叉 B（字符数展示策略，round-1 主审 MUST-FIX 裁决点）**：

| | B1 完成态定格常驻（采用） | B2 仅工作 turn 期间显示，完成即隐 |
|---|---|---|
| 短期成本 | 每 turn 行 +1 span（约 8~15 字符行宽增量） | 无常驻增量；完成态需额外的条件渲染分支 |
| 长期架构 | TurnMeta 本就是 per-turn 事实聚合位（elapsed/时刻区间/think/tool badge 均常驻在场），chars 属同族**事实**而非状态；live≡reload 同一公式重派生，完成态可见性两态一致 | 降噪更彻底；但「已工作 5m」常驻而 chars 不在，同行信息割裂；B2 的降噪论据针对的是「状态重复」，对新增事实不成立 |
| 一致性 | 与 elapsed 常驻、badge 常驻同构 | 引入「有的常驻有的不常驻」的特例 |

**裁决：B1**。理由：TurnMeta 行的既有信息全部是常驻事实型（耗时/时刻/计数），chars 作为 per-turn 事实加入是同构扩展，不构成问题②所治理的「状态重复常驻」；每行密度增量有界。**显式判定**：接受常驻；**重审条件**：若真机使用观感噪（多 turn 长会话行密度不可接受），降级 B2 为机械回退（删完成态渲染分支，一行改动）。

## 2 终态/机制

### 2.1 TurnMeta 字符数（ui 层，per-turn 纯派生）

`useTurnElapsed` 扩展输出 `generatedChars: Ref<number>`（沿用同一秒级 tick 节拍：挂载算一次 / streaming 每秒重算 / 停表定格一次——**不随 delta 重算**）。性能画像：同为秒级低频重算（非每 delta），代价 = 每 tick 一次 `Σ normalizeContent(turn.assistants[].content).length` 字符串求和，O(turn 内容体积)/tick，量级有界可接受；历史 turn 实例滚动重挂载时各算一次（挂载即定格）。口径与旧观测条累计同函数（normalizeContent），跨 assistant 段整段计入。完成态从落盘内容重派生同值 → live≡reload 构造性成立（定格时机：`isStreaming` 翻转与 `message.complete` 权威内容同 effect 落位，定格重算读到权威内容）。`Turn.vue` 透传 prop，`TurnMeta.vue` 在 elapsed 后渲染 `· 已生成 X 字符`（v-if chars>0，i18n key `panel.message.generatedChars`，zh/en 双侧）。旧观测条「增量累计」机制（partition 字符基线）随之无消费方，见 §2.3 收窄。

### 2.2 TurnProgressBar warn 化（renderer 层）

渲染条件 `snapshot && snapshot.warn`（常态不渲染 DOM）。warn 态内容 = Clock 警示色 + 「本 turn 已 N 分钟」+「中止此 turn」（emit abort，Panel 既有 onProgressAbort → useChat.abort 链不动）+「继续等待」（snoozeWarn，本 turn 抑制后 bar 消失；用户仍可经 Composer stop 中止）。awaitingUser 分型文案删除（AskUserOverlay 在屏自明——overlay 覆盖 composer 位置且 U4 保证必渲染，分型文案的既有用户价值已由 overlay 承接）；awaitingUser 作为 core warn 抑制判据保留（§2.3）。组件名/文件名/testid `turn-progress-bar` 不变，**已接受代价四要素**：量级 = 命名语义错位（warn 告警条挂在 ProgressBar 名下；低，头注回写缓解误用）；恢复路径 = 机械 rename + testid 字符串替换（无门禁阻碍，3 个测试文件同步）；重审条件 = 该组件下次功能性改动时一并还名；显式判定 = 接受最小 diff。头注回写新语义。Panel.vue 挂载点与 dead 排除（W6：dead 优先级吞掉活跃 UI）不动，仅注释回写。

**既有回归锁定的反转登记**：`ask-user-inline.test.ts` U6 用例（session-dead V5② Gate B 回归锁定）当前断言「ask_user 等待期 bar 存活 + awaiting 分型渲染」——本设计反转该行为（ask_user 期 bar 不出现，§3-A5）。反转成立前提 = 分型文案的用户价值（解释「为何 turn 不动」）已由 AskUserOverlay 在屏承接；U6 重写为反向断言（ask_user 期间 `turn-progress-bar` 不渲染），随 u2 实施。

### 2.3 core `turn-progress.ts` 收窄

snapshot **7 字段 → 2 字段**：删 `toolName` / `toolElapsedMs` / `generatedChars`（消费方清零）；删 `active`（源码自认恒 true、「防语义漂移」= 想象未来，运行时零消费仅测试断言——null 快照即不活跃，字段是接口纯噪音）；删 `awaitingUser` **接口暴露**（分型文案删除后 bar 不再消费，降为 tick 内局部变量，作为 warn 计算输入保留：`warn = !awaitingUser && !snoozed && elapsed ≥ 阈值`——warn 抑制语义零变化，仅暴露面降级）。保留 `turnElapsedMs` / `warn`。分区删 `lastAssistantLen` / `generatedChars` 与 `accumulateChars()`；`lastAssistantId` 保留（F-U1 锚守门快路径判据）改由边沿回调维护（每边沿刷新，不再做长度差累计）；`startTurn`/`finishTurn` 去掉字符基线读写。`TURN_PROGRESS_WARN_THRESHOLD_MS` / snooze / 锚守门（F-U1）语义全部不动。收窄后不变量：**snapshot 公共接口 ≡ 运行时消费面**（可全仓 rg 机械验真）。

### 2.4 i18n 键增删（双侧对称）

新增 `panel.message.generatedChars`（`已生成 {chars} 字符` / `Generated {chars} chars`，round-2 后措辞以实现落地为准）。删除 `sidebar.turnProgress.*` 四死键：`generatedChars` / `toolElapsed` / `awaitingUser`（消费方随本设计清零）+ **`durationSec`**（warn 化后才死：bar 渲染蕴含 elapsed ≥ 600s，formatDuration 秒分支恒不可达——键与分支一并删，`durationMin`（10–59min）/ `durationHourMin`（≥1h）保留）。保留 `turnElapsed` / `abortTurn` / `keepWaiting`。u2 同步删 `formatDuration` 秒分支，删分支处留一行注释：**两分支正确性前提 = `TURN_PROGRESS_WARN_THRESHOLD_MS` ≥ 60s**（round-2 复审 S3：该阈值在 core 包、formatter 在 renderer 包，跨包耦合无机器守卫；P-3 重定值若跌破 60s 须同步恢复秒分支，否则 `totalMin = 0` 静默渲染「0 分钟」垃圾值）。

**守卫覆盖面（round-1 主审 MUST-FIX 裁决）**：`locale-key-usage-guard` 现只扫 `panel.*` / `settings.providerEdit.*`，被清理的 `sidebar.turnProgress.*` 在守卫盲区——本设计**不扩展守卫**（扩展需先 triage sidebar 段 14 个候选死键：`subagentFilter.*` / `update.upgradeFailed*` 疑似动态组装需逐个定性，真死键清扫属独立 chore）。sidebar 四键清零的验证 = 一次性全仓 rg（§3-A8），「sidebar 段无死键守卫」登记为残留风险（§1 Out-of-scope）。

## 3 验收场景表

| # | 场景 | 通过标准（真实流程/机器可判） |
|---|------|------------------------------|
| A1 | 常态零占用 | turn 生成中（<10min）DOM 无 `turn-progress-bar` testid |
| A2 | TurnMeta 工作中字符数 | streaming 中 TurnMeta 显示「已生成 N 字符」，秒级节拍增长；多 assistant 段（text→tool→text）跨段累计 |
| A3 | 完成定格 + live≡reload | turn 完成后字符数定格；同一 session 重开（reload 重派生）数值一致 |
| A4 | warn 告警条 | ≥10min 后 `turn-progress-bar` 出现：警示色 + 本 turn 已 N 分钟 + 中止/继续等待；点中止走 useChat.abort 链 |
| A5 | 继续等待 + ask_user 豁免 | 点继续等待 → bar 消失且本 turn 不再 warn；ask_user pending 期间 bar 不出现（warn 被抑制，豁免语义保留；U6 反转见 §2.2） |
| A6 | dead 排除保留 | session dead 态 bar 不渲染（W6 语义不回退） |
| A7 | core 收窄无回归 | core turn-progress 套件绿（elapsed/warn/snooze/锚守门用例保留适配）；snapshot 仅剩 `turnElapsedMs`/`warn` 两字段，全仓 rg 无已删字段引用 |
| A8 | i18n 死键清零（分守卫如实声明） | ①新增 `panel.message.generatedChars`：`locale-key-usage-guard` 绿（该守卫扫 `panel.*`，新增键受反向覆盖——真守卫）；②删除的 `sidebar.turnProgress.{generatedChars,toolElapsed,awaitingUser,durationSec}` 四键：全仓 rg 零命中（一次性验证，sidebar 段无守卫——残留风险已登记） |
| A9 | 全量回归 | renderer + ui + core 三包全量测试绿 |

## 4 下一层拆分

- **u1 core 收窄**：`packages/core/src/domain/chat/turn-progress.ts`（snapshot 7→2 字段、分区与 accumulateChars 退役、awaitingUser 降局部变量）+ `__tests__/turn-progress.test.ts`（删 active/awaitingUser/chars/tool 断言，awaitingUser 改经 warn/snooze 行为断言）（独立，DAG 根）
- **u2 renderer warn 化**：`TurnProgressBar.vue`（warn-only 渲染 + formatDuration 删秒分支〔删处留注释：前提 = `TURN_PROGRESS_WARN_THRESHOLD_MS` ≥ 60s，P-3 重定值跌破时须恢复〕+ 头注回写）/ `Panel.vue`（注释）/ `locales/*/sidebar.ts`（删四键，zh/en 对称）/ `__tests__/panel/turn-progress-bar.test.ts`（常态不渲染/warn 渲染/abort/snooze/ask_user 不出现）/ `turn-progress-composer-wiring.test.ts`（适配）/ `ask-user-inline.test.ts`（U6 重写为反向断言）（依赖 u1 snapshot 形态）
- **u3 TurnMeta 字符数**：`packages/ui/.../composables/useTurnElapsed.ts`（generatedChars 输出）/ `Turn.vue`（透传）/ `TurnMeta.vue`（渲染）/ `locales/*/panel.ts`（增一键，zh/en 对称）/ `__tests__/useTurnElapsed.test.ts`（Σ 口径/秒级节拍/停表定格/失焦停 tick 交互的 composable 级用例）/ `__tests__/TurnMeta.test.ts`（working/completed/zero 边界）/ `Turn.test.ts` 与 `__tests__/components/Turn.smoke.test.ts`（renderer 侧，透传适配）（独立于 u1/u2，可并行）
