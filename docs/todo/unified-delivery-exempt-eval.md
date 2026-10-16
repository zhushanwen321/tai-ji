# 统一消息投递重构：豁免类（scheduler / smart-context）迁移评估

状态：待用户裁决（评估结论：scheduler=不迁；smart-context=不迁）。两域维持现状通道，重审触发见文末汇总；steering mode 覆写复评（unified-delivery 设计 §7 检查点 4）结论 = 维持 one-at-a-time 不覆写。

评估依据：unified-delivery 设计（`.tmp/tech-design/unified-delivery.md` §9 非目标 5 / §3.9 / 附录 C）+ impl-plan 单元 u6-exempt-eval（A17）；port 接口以 u2 已交付实装为准（`extensions/shared/delivery-port`）。全部现状陈述以本仓实码与 pi 实装（`node_modules/@earendil-works/pi-coding-agent/dist`）为依据。

背景一句话：统一消息投递重构已建投递端口（delivery-port，`extensions/shared/delivery-port`——custom 通知通道的唯一执行者：受理前写投递日志（session entry）、注入直达 pi 原生 steer/followUp 队列、送达回执命中后 ack、pi 崩溃重启后差集重放）。scheduler 与 smart-context 是设计 §9 登记的两个豁免域（默认不迁），本评估按各自现状实码逐项核对迁移收益与代价。

## 一、scheduler：不迁

### 现状机制

- 到期投递：tick（30s）扫描到期任务 → `backend.sendMessage({ content: task.prompt, customType: '<前缀>dispatched', display: true }, { deliverAs: 'steer', triggerTurn: true })`（`extensions/universal/scheduler/src/runtime.ts:470-473`）——agent 忙时插入当前 run、空闲时开新 turn。
- 受理即记账：await 返回即推进（recurring 写 advance entry / once 写 delete entry，`runtime.ts:388-390`）；sendMessage 同步抛错 → failed 记账 + pending 保留 → 下个 tick 重试（`runtime.ts:374-376`）。
- 该形态是 2026-09-14 用户裁决（`docs/architecture/scheduler-steer-direct-dispatch.md`）：提醒类注入应立即 steer 打断、不需要「必达 + 合批 + 不打断」，据此整体删除投递中间层（防重标记 / TTL / settled 回调 / 内核队列，净删约 -150 行）。
- 调度记账（runCount / nextRunAt）走 scheduler 自有 append-only 存储，与投递通道解耦。

### port 后形态

dispatch 改为 `port.deliver({ payload: custom, timing: 'steer', id })`：受理前 appendEntry 写投递日志 → 内核受理 → `pi.sendMessage({ deliverAs: 'steer', triggerTurn: true })`（`extensions/shared/delivery-port/src/delivery-port.ts:220-229`）——注入参数与现状逐字一致；新增投递日志与 ack 两类 plain entry（不进 LLM 上下文）、送达回执（message_end + details.deliveryId 命中）、pi 崩溃重启后 session_start 差集重放、提交侧 compaction 等待。

### 行为变化

1. 注入形态零变化（同参数直达同一 pi API）；scheduler 的 customType 不在 port 默认合批组（subagent-bg-notify），按批组隔离规则恒逐条（`delivery-port.ts:24-25`）——与现状「无合批」一致。
2. 失败语义出现分叉需裁决：port 缺省 retain（留账重投）与 scheduler 既有「failed 记账 + 下个 tick 重试」构成双通道重试——选 forget 则耐久收益打折；选 retain 则「受理即记账」时点须从「sendMessage 返回」改为「deliver 返回 accepted」，并接受 port 层重投（scheduler 无感知，表现为提醒延迟送达而非丢失）。
3. 幂等键陷阱（迁移必须处理）：port 的 id 参与判重且已完结 id 恒吞（`extensions/shared/delivery-port/src/types.ts:40`）——taskId 每轮 dispatch 恒定，直接作 id 会从第二轮起被判重吞掉、该任务此后永不再提醒；须改为每轮唯一（taskId + runCount 之类）。
4. compaction 窗口行为变化：现状手动 compaction 窗口内到期的 dispatch 走 pi `sendCustomMessage` 的 triggerTurn 分支，该分支无 isCompacting 检查、直接 `_runAgentPrompt` 与进行中的 compaction 并发（pi 实装核实；unified-delivery 设计 §3.8 登记的危险形态）——port 提交侧 isIdle 等待可消除该窗口。

### 收益

1. 投递日志耐久：唯一改善 =「受理后、注入完成前 pi 崩溃」窗口从丢失变重投——窗口毫秒级 ∩ pi 单 session 崩溃低频，事件本身罕见。
2. compaction 防御顺带修复（见行为变化 4）。
3. 架构收敛（custom 注入唯一出口）。

### 成本

1. 与 2026-09-14 裁决方向相悖：该裁决核心 = 提醒类不需要必达、投递链与调度器同层；port 的「投递日志 + retain + 重放」是必达语义载体，迁移 = 给已裁决不需要必达的域重新引入一层投递中间层（刚净删约 -150 行删掉的机制换形态回来）。
2. 实际改动：backend 抽象改造 + 测试 mock 跟随 + 幂等键生成改造（行为变化 3）+ 失败语义裁决（行为变化 2）。

### 建议

**不迁**。提醒类丢失的代价已被 09-14 裁决显式接受（scheduler-steer-direct-dispatch 代价 b：丢一轮远小于 10min 级延迟）；唯一耐久收益窗口罕见，不抵「重新引入必达机制 + 幂等键改造 + 失败语义裁决」的代价。

### 附带发现（与迁移解耦，待独立裁决）

行为变化 4 的 compaction 直闯缺口是 scheduler 域内问题，不需要 port 迁移即可修复：dispatch 前查 `pi.isIdle()`（扩展 API 可用，port host 即经 `ctx.isIdle()` 接线），false 则 pending 保留等下个 tick 重试（与既有 rate-limit 跳过同型，backend 增加一个 isIdle 方法）。低频但后果是 pi 侧未定义行为，修复代价约数行——建议作为 scheduler 域内小修独立登记，不与波 5 绑定。

## 二、smart-context：不迁

### 现状机制

- 五类通知（compact-complete / compact-failed / threshold-reminder / model-switch / model-downshift，`extensions/universal/smart-context/src/notices.ts:28-33`）全部经 `sendSmartContextNotice`（`notices.ts:45-59`）：`pi.sendMessage({ customType: 'smart-context', content, display: true, details: { source } }, { triggerTurn: false, deliverAs: 'nextTurn' })`。
- nextTurn 通道语义（pi 实装 `sendCustomMessage` 分支，`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1746-1790`；`docs/pi-semantics.json` PS-06 登记）：消息入 `_pendingNextTurnMessages` 常驻至被消费；唯一消费点 = 用户驱动 prompt 走到的 `_runAgentPrompt` 注入段（注入后清空）；pi 无周期性/收尾性 drain——空闲期不注入、不自起 run、用户下一条消息必然带上全部待投通知。
- 该通道是 D4① 改造的产物（`notices.ts:2-21`）：结构性消除「通知自起 run 抢在用户消息之前提交」（故事 C 根因：压缩完成后通知 run 与用户消息同时 prompt()，后到者被 pi 以 `Agent is already processing` 拒绝）；「阈值提醒空闲期不立即生效」是已接受代价。

### port 后形态（假设迁移）

port 通道模型只有两档：`DeliveryTiming = 'steer' | 'followUp'`（`extensions/shared/delivery-port/src/types.ts:26`），且 `triggerTurn` 恒 true（`types.ts:117`、`pi-host.ts:44`）——nextTurn 不在枚举内。迁移只能走 steer 档：agent 忙时在下一轮边界注入（早于「下一次用户 prompt」）；agent 空闲时 triggerTurn:true 自起新 run。

### 行为变化

通道不等价，行为变化是语义回归而非等价迁移：

1. 空闲期通知自起新 run——直接回归 D4① 修复的故事 C（通知 run 与用户消息竞争 prompt 提交，后到者被 pi 拒绝）。
2. 忙期注入时点从「下一次用户 prompt」提前到「下一轮工具边界」——通知出现在 run 中间，与「随下一次 prompt 注入、作为上下文被消费」的语义不同。
3. 任务书核查项「nextTurn 语义能否由 timing=steer + 合批窗口等价承载」——**不能**：①合批窗口只对默认通道组（subagent-bg-notify）生效，smart-context 的 customType 属外部通道组，批组隔离规则下恒逐条、merge:true 不得覆盖（`delivery-port.ts:24-25`、`:347-350`）；②合批控制「一次出站几条」，不控制「注入时机 / 是否自起 run」——nextTurn 的核心语义（常驻至被消费、不自起 run、空闲不注入）在两档模型里无承载位置。

### 收益

1. 压缩结果两条（compact-complete / compact-failed，结果语义）获投递日志耐久：nextTurn 消息驻留 pi 内存，pi 崩溃即丢（崩溃前无用户 prompt 则从未注入）；port 后崩溃重启差集重放重投。
2. 提醒类三条（threshold-reminder / model-switch / model-downshift）耐久无价值：提醒不承载必须必达的结果，丢失可接受（`notices.ts:11-13` 已按 scheduler 2026-09-15 关闭的同类先例定性）。

### 成本

1. 等价迁移必须给 port 扩第三档（timing=nextTurn + triggerTurn:false）：波及 u2 刚定案的面（DeliveryTiming 枚举 / host.sendMessage 的 triggerTurn 约束 / pi-host 透传 / 投递日志重放对「常驻至消费」型消息的送达判定语义），并与设计 §3.9 两档注入时机的裁决冲突——通道模型重开。
2. 压缩结果的账本化（必达迁移）已有独立登记：pi-boundary-reliability 附录 B（`notices.ts:14-17` 引用；unified-delivery 设计 §1.3 Out 同口径）——归属该线推进，不属本波。

### 建议

**不迁**。收益（两条压缩结果通知的崩溃耐久）远不抵「通道模型重开 + 故事 C 回归」的代价；维持 nextTurn 通道现状，压缩结果耐久诉求归 pi-boundary-reliability 附录 B 登记线。

## 三、steering mode 覆写复评（设计 §7 检查点 4）

- 登记形态（设计 §3.9）：保持 pi 缺省 one-at-a-time（每个轮边界投 1 条）；`set_steering_mode('all')`（同边界全量出队）覆写登记为实施期可复评项，触发条件 = phase 2 collect（批量收取）需要批量插入语义。
- 复评结论：**维持 one-at-a-time，不覆写**。phase 2 collect 尚未立项；设计附录 C④ 已给 collect 的批量语义承载位置 = 提交侧合批窗口（60s 攒批合成一条 `{batch, items}` 单条注入）——「一次收取多个终态」经合批单条注入即可满足，不需要「多条独立消息同边界全量出队」；覆写是全局状态、影响全部 steer 消息（含用户文本），「交叉影响范围大于收益」的原始裁决理由不变。
- 复评触发条件具体化：phase 2 collect 立项、且其设计裁决明确「合批单条注入形态不满足消费契约、需多条独立消息同边界全量出队」时再评；collect 沿用合批窗口形态则本复评项关闭。

## 重审触发汇总

- scheduler：用户反馈「提醒打断重要任务」成为痛点（既有代价 a 触发，届时以 schedule 工具参数形态回归 after-run，非投递层机制）；pi 崩溃丢提醒实报成规模。
- smart-context：压缩结果通知崩溃丢失实报；port 契约因其他域扩展第三档注入时机时顺带复评。
- steering mode：见第三节触发条件。
- 附带发现（scheduler compaction 直闯缺口的域内小修）：独立立项裁决时处理，不随本评估联动。
