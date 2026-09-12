# ext-simplify-08：universal/scheduler 过度设计收敛（croner 依赖形态根修 + settled 合投语义根修）

> **一句话结论**：修复 scheduler 在独立安装形态下 cron 功能静默全灭并误报 Invalid 的依赖形态缺陷（croner 从 optional peer 移入 dependencies + 删运行时 import-probe 降级层）；对 M19 合投补偿机制裁决为方向 B——在 `packages/session-delivery` 内核把 onSettled 从「每批一次、只带首条 dedupeKey」根修为 per-message 终态回调，消除常规可达的「合批非首条任务 10 分钟后重复注入」缺陷，scheduler 侧防重 Map/TTL 保留但语义降为回收层异常兜底；low 级残留 API 群登记移交 code-simplify。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-scheduler`（v0.5.1）是 xyz-agent 的 universal 组 mandatory 扩展（`packages/shared/src/mandatory-extensions.json:10`，tier: feature）——session 级 AI 提醒器：agent 用 `schedule` 工具创建 interval/cron 定时任务，任务归属创建它的 session，到期时把 prompt 注入 owner session。非 force 任务经 `@xyz-agent/session-delivery` 投递内核的 park 队列投递（busy 入队等空闲），终态经 onSettled 回调记账。
- **C（冲突）**：2026-09-11 过度设计审计（M18/M19 + low 群）证实两处 medium 级问题：① croner（cron 解析库）被声明为 optional peer——npm 7+ 不自动安装 optional peer，README 明示支持的独立安装形态下 cron 功能静默全灭，且合法表达式被误报为 `Invalid schedule`（解析器缺失与表达式非法混用同一错误通道）；② 内核 settle 上报是「每批一次、composed 消息只携带首条 dedupeKey」的实装捷径，scheduler 用 Map+TTL+pending 重标三件套补偿——合批非首条任务收不到终态回调，10 分钟 TTL 过期后重投，同 prompt 重复注入（常规可达，非极端路径）。
- **Q（问题）**：如何让 cron 功能在全部受支持安装形态下确定可用且错误语义真实？如何让合批投递下每条任务精确记账、不重复注入，且 scheduler 不再需要理解内核合批内部才能写对？
- **A（答案）**：M18——croner 移入 dependencies 并静态 import，删除 probe 降级层，错误通道归一为「表达式无效」单一语义；M19——裁决方向 B（B1 形态）：内核 onSettled 改 per-message 回调（±10 行，单消息批次行为不变），scheduler 防重 Map/TTL 保留为终态回调丢失的回收层有界兜底。low 群移交 code-simplify。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 断言核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（npm ls 确认；本设计不新增 pi 行为断言）。所引行号均为 2026-09-12 实读值。审计四问记录真实路径 = `~/.pi/agent/tmp/session-view-01a09053-2429-7731-ae6a-eaea25dab63f.md`（审计附录索引把 scheduler 指到 `242e-*.md` 两文件，实读为 goal 包根与 ask-user 记录——索引错位，已按内容 grep 重新定位）。

---

## 1. 背景：被设计的系统是什么

**scheduler 解决的问题是「agent 需要在未来某个时刻被提醒/被触发做事」**：用户对 agent 说「每 10 分钟检查一次 CI」「明早 9 点提醒我 review PR」，agent 调 `schedule` 工具创建任务。任务以 append-only event sourcing 持久化在 owner session 的 JSONL 里（upsert/advance/toggle/delete 四种 op 经 `pi.appendEntry('pi-scheduler:task', op)` 落盘），session 重开时 replay 折叠恢复。

一次完整调度链路（本设计涉及的核心面）：

```
创建：schedule tool / /schedule 命令 → SchedulerService → SchedulerRuntime.addTask
       → parseSchedule（croner 解析 cron / 正则解析 interval）→ computeNextRunAt
调度：30s tick → 到期任务置 pending → dispatchTask
投递：force 任务 → backend.sendMessage 直投（绕过内核）
      非 force 任务 → delivery.send 入内核 park 队列（busy 时等待）
      → 内核 flush：整队出队合批 → port.send（pi.sendMessage followUp）
记账：内核终态 → onSettled 回调 → runtime.handleSettled 按 dedupeKey=task.id 反查
      → delivered：runCount+1 / nextRunAt 推进 / append advance；rejected：失败记账
```

两个安装形态（M18 的影响面边界）：
- **xyz-agent builtin**：esbuild bundle 后 staged 到 `apps/electron/resources/extensions/` 随应用打包，croner 被 inline（`scripts/bundle-extensions.mjs:30` 注释明确「web-tree-sitter、ajv、croner 等全部 inline」）——此形态 croner 恒可用。
- **独立 pi 安装**：README「简介与安装」节（:21-29）明示 `npm install @zhushanwen/pi-scheduler` 手动安装——此形态依赖解析走用户环境。

## 2. 设计目标

1. **cron 功能全形态可用**：独立安装与 builtin 两种形态下，cron 任务创建/触发行为一致；创建失败时错误消息真实反映失败原因（表达式无效 ≠ 解析器缺失）。
2. **合批投递精确记账**：多个任务同一 busy 窗口到期合批投递时，每条任务恰好注入一次、runCount/nextRunAt 各自精确推进、不再出现 TTL 过期后的重复注入。
3. **解除跨包 leaky abstraction**：scheduler 的记账正确性不再依赖「内核合批只上报首条 dedupeKey」这一内部实现知识；防重机制语义从「补偿内核缺陷」降为「终态回调丢失的回收层有界兜底」。
4. **残留 API 清扫**：审计 low 群（errorCode 死字段、handle 中转、void ctx 等 9 项）登记移交，不新增代码。

**In-scope**：`extensions/universal/scheduler/`（package.json + src）+ `packages/session-delivery/`（delivery.ts settled 回调语义 + types 契约注释 + 测试）。
**Out-of-scope**：session-delivery 其余机制（merge 窗口 / dedupe LRU / backoff / watch-dog——审计未判定过度）；subagent-workflow 与 runtime 的 delivery 装配（不消费 onSettled，零改动）；scheduler 的 event sourcing 存储层与 importer 迁移机制（审计四问记录判为本质复杂度保留；importer 退役里程碑登记为独立建议，见 §9.3）。

---

## 3. 现状：使用者眼里是什么样的

**本章结论：现状下使用者遭遇两类真实故障——独立安装形态 cron 功能静默全灭且误报表达式非法（F1）；多任务合批投递时部分任务被重复注入（F2）——且两者都被现状注释自认为「已知」。**

### 3.1 现状的真实样子（取自代码与实测）

**F1 场景（独立安装用户，M18）**：

```
$ npm install @zhushanwen/pi-scheduler   # 用户按 README 安装
# npm 7+ 语义：optional peerDependencies 不自动安装；本包 dependencies 仅
# session-delivery 与 extension-logger（package.json:51-54）→ croner 不在磁盘上
[agent] schedule { prompt: "check CI", schedule: "*/10 * * * *" }
[tool 返回] Invalid schedule: "*/10 * * * *". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).
# interval 任务（parseDuration 纯正则，不走 croner）一切正常——cron 功能静默全灭
```

传导链（实读）：`parsing.ts:68-79` 模块级缓存 + `getCroner()` 动态 import catch→null → `computeNextCronRunAt`（:108-125）`if (!croner) return undefined` → `parseSchedule`（:186-197）cron 分支 nextRun undefined → undefined → `service.ts:52-59` 返回 `INVALID_SCHEDULE`「Invalid schedule」。用户明明写了合法 cron，得到「表达式非法」——错误通道混同：解析器缺失 ≡ 表达式非法，全程零 warn。本机 workspace 因 pnpm v8+ 默认开启 auto-install-peers 且 node-linker=hoisted（.npmrc:9），根 node_modules 有 croner@9.1.0（实测 scheduler 目录下 `import('croner')` 成功）——开发环境恒可用，掩盖问题。

**F2 场景（合批重复注入，M19）**：

```
用户建了任务 A（每 5m 检查 CI）和任务 B（每 5m 轮询构建产物），agent 正在跑一个长任务：
tick N：A、B 相继到期 → delivery.send 入内核 park 队列（busy，不投）
agent run 结束 → settled 边沿 → 内核 flush → doSend 整队出队
  delivery.ts:377  inflightBatch = queue.splice(0)      ← A、B 合成一批
  delivery.ts:67-98 buildBatchPayload：composed 消息 spread 自 first → 只携带 A 的 dedupeKey
  delivery.ts:301  cfg.onSettled?.(composed, 'delivered') ← 每批仅一次
runtime.handleSettled：按 dedupeKey 反查命中 A → A 记账；B 无回调 → 不记账
10 分钟后（TTL 过期，runtime.ts:20-22/339-342）：B 的 nextRunAt 一直未推进、pending 重标
  → 重投入队 → 本次单独成批 → B 的 prompt 第二次注入 ✓ 但 A 的提醒内容用户已看过两遍中的 B 部分重复
```

runtime.ts:447-449 注释自认该「已知限制」；:52-53 注释自认 TTL「与旧 nextRunAt 未推进下 tick 重投等价」——即合批非首条的重复注入是现状的常规路径，不是极端窗口。

### 3.2 根因

**M18 根因：optional 标记自造故障形态 + 错误通道混同。**「运行时可能没有 croner」这一状态完全由 optional peer 声明自身制造（pi 不依赖 croner，实测 pi-coding-agent package.json 无 cron 相关依赖，宿主不提供；builtin 打包恒 inline，probe 恒成功，optional 零收益）。而 getCroner→computeNextCronRunAt→parseSchedule 三层 undefined 传播把「解析器缺失」折叠进「表达式无效」单一错误通道，读者须追三层才能定位。

**M19 根因：内核 settle 上报粒度是实装捷径，scheduler 以经验参数固化 workaround。**内核的投递单元是「批」（splice 整队、composed 合批消息），而 settle 上报沿用了投递单元——composed 消息 spread 自首条，天然只携带首条 identity。这是内核可改的设计决策（每条消息本就各自持有 dedupeKey，见 `packages/session-delivery/src/types.ts:38-46` DeliveryMessage）。scheduler 侧只能用 TTL（10min >> 合批窗口的经验参数）+ 防重 Map 补偿，且必须理解内核合批内部（「splice 全队」「composed 只带首条 key」）才能写对注释里的每句话。

## 4. 物理数据流（现状 dispatch → settled 链路）

> **合批（batch）** = 内核一次 port.send 投出的消息集合：busy 期间 park 队列积累多条、settled 边沿 flush 时 `queue.splice(0)` 整队出队形成（scheduler 未配 mergeWindowMs，合批与 merge 窗口无关）。就是 §3.1 F2 例子里 A、B 同批那个批。

```
runtime.tickScheduler (每 30s)
  │ step2: now >= nextRunAt → task.pending = true
  │ step3: dispatchTask
  │   ├─ dispatchTaskInner :341-342 TTL 拦截（queuedInDeliveryAt 窗口内 → return false 防重复入队）
  │   └─ dispatchViaDelivery :374-398
  │        delivery.send({dedupeKey: task.id}) → 内核 queue.push
  │        queuedInDeliveryAt.set(task.id, now) + 计速率 + task.pending = false
  ▼
内核（packages/session-delivery/src/delivery.ts）
  flush → scheduleFlush → doSend :372-380
    inflightBatch = queue.splice(0)          ← 合批形成点
    attemptSend → buildBatchPayload :67-98   ← composed = spread(first)，非首条 identity 在此丢弃
    port.send(composed) → pi.sendMessage
  onSendOk :294-303
    settleChecked(...)（sendChecked 腿，scheduler 不用）
    cfg.onSettled?.(composed, 'delivered')   ← 每批一次，只带首条 key ★断头点★
  ▼
runtime.handleSettled :451-468
  queuedInDeliveryAt.delete(composed.dedupeKey)   ← 只有首条任务的防重标记被清
  tasks.get(dedupeKey) → onDispatchSuccess（runCount/nextRunAt 推进 + append advance）
  非首条任务：无回调 → 标记留存 → TTL 10min 过期 → 重投（重复注入）→ 终获回调记账
```

终态数据流（方向 B 落地后）：`cfg.onSettled?.(composed, ...)` 一处变为「对 inflightBatch 每条消息各调一次 `onSettled(msg, outcome)`」——非首条任务在 ★断头点★ 获得各自终态回调，TTL 过期重投路径从常规路径降为「回调丢失异常」的兜底路径。

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径

```
独立安装用户（修复 M18 后）：
$ npm install @zhushanwen/pi-scheduler    # dependencies 自动带上 croner ^9.0.0
[agent] schedule { prompt: "check CI", schedule: "*/10 * * * *" }
[tool 返回] Task "check CI" (a3f2c1d8) created. every 10m (cron), expires 7d, no-force
           Next 5 runs:
             1. in 10m ...

合批场景（修复 M19 后）：
任务 A、B 同一 busy 窗口到期，agent run 结束：
  内核 flush 合批投出 A+B → onSettled 逐条回调 → A、B 各自记账推进
用户视角：A 的 prompt 注入一次、B 的 prompt 注入一次（合批 content 以 --- 分隔一次性可见）
schedule_control list：两个任务 runCount 均 +1，nextRunAt 各自推进到下个周期
10 分钟后：无任何重复注入
```

### 5.2 失败路径（带恢复指引）

- **cron 表达式真错**（如 `*/10 * * *`，4 字段）：normalizeCronExpression 返回 undefined → `Invalid schedule: "*/10 * * *". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).` → 👉 按 message 提示修正表达式或改用 duration 重发 schedule 调用。此错误通道在终态下语义唯一：表达式无效（解析器不可能缺失）。
- **任务到期但被限流**（>6 次/分钟）：dispatch no-op → `Task <id> not dispatched (disabled, rate-limited, or already queued for delivery).` → 👉 `schedule_control run <id>` 稍后重试，或等待下个调度周期自动重试（at-least-once 语义不变）。
- **终态回调丢失异常**（内核 bug / pi 事件丢失，预期 <0.1%）：防重标记 TTL 10min 过期后放行重投（at-least-once），可能重复注入一次 → 👉 排查看 `~/.pi/agent/logs/`（XYZ_AGENT_DEBUG=1）delivery warn 记录；此即 D1 保留 TTL 的兜底职能。

## 6. 关键决策与权衡

**本章结论：2 个 medium 决策（M19 方向 B、M18 croner 移 dependencies）+ 1 个 low 群处置决策（移交 code-simplify）。**

### 6.1 D1：M19 合投补偿机制裁决（选定：方向 B，B1 形态——内核 per-message settled 根修 + scheduler 防重兜底保留）

- **采用**：①`packages/session-delivery/src/delivery.ts` 的 `onSendOk`（:294-303）与 `onSendFail` 达上限分支（:323-331）中 `cfg.onSettled?.(composed, outcome)` 改为对批次内每条消息各调一次 `cfg.onSettled?.(msg, outcome)`（`types.ts:102` 契约注释同步改为 per-message 语义）；单消息批次行为不变（循环一次，msg 即原消息）。②scheduler 侧 `queuedInDeliveryAt` Map + TTL + pending 重标拦截**全部保留**，注释从「合批非首条无终态回调的补偿」改写为「入队未终态窗口防重复入队 + 终态回调丢失的回收层有界兜底」；`handleSettled`（runtime.ts:447-449）「已知限制」段删除。
- **被否**：
  - **方向 A（机制保留 + constraints.json 登记跨包债务）**——把一个常规可达的正确性缺陷（F2：每次合批非首条都重复注入）和「必须理解内核合批内部」的认知税登记为永久债务，换零跨包成本。三个月后回看：runtime.ts 里「已知限制」注释仍在、用户仍会看到重复注入，而根修本身只有 ±10 行且单消息批次是等价变换。若用 A，§3.1 F2 场景原样保留，§5.1 合批场景的「无重复注入」不成立。
  - **方向 B2（根修 + 防重移交内核 dedupe + 周期 key 全删 scheduler 侧 Map）**——审计「修后本机制整体删除」的完整形态。实读证伪其前提（见审计修正①）：防重 Map 承担的「入队未终态窗口防重复入队」职能（busy parked 期间每 tick 重标 pending，U4-PARK_GATE.test(5) 回归锚定）独立于 settled 粒度，删除它须改用内核 dedupe + 周期唯一 key（`taskId@nextRunAt`）承接——净复杂度不降（key 编码解析 + LruSet maxKeys 调参 + 被吞 send 对 scheduler 不可见三个新面），scheduler 从「理解合批内部」变为「理解 dedupe LRU 内部」，耦合未减。若用 B2，§4 图中 TTL 拦截框替换为内核 dedupe 吞判，行为等价但排障面跨包。
- **证据**：delivery.ts:372-380（splice 整队）/ :67-98（composed spread first）/ :301、:329（onSettled 每批一次）——内核行为实读；runtime.ts:20-22/48-54/339-342/443-468（三件套 + 已知限制注释）；onSettled 生产消费方全仓唯一 = scheduler（`grep -rn onSettled packages/ extensions/ apps/` 生产代码仅 scheduler/index.ts:111 配置 + runtime.ts:451 消费；runtime 侧 `session-delivery-registry.ts:118-144` buildHandle 不配 onSettled、subagent-workflow `pi-host.ts:216` 仅转售 createDelivery、subagent-core notify-ledger.ts:318 仅注释提及）；session-delivery 既有测试的 onSettled 断言全部单消息形态（delivery-receipt.test.ts 5 处，行为不变）。改动不触碰的既有契约（副作用归属核查）：`sendChecked` 挂账腿（settleChecked）不动、`dispose` 丢弃队列不触发 onSettled 的契约不动（delivery.ts:532-536，scheduler 场景由 session 替换时 runtime 与防重 Map 同废覆盖）、port.send 仍发 composed 合批消息（GUI 合批渲染不受影响，仅 settle 上报粒度变化）。
- **效果**：目标 2（F2 消除）、目标 3（leaky abstraction 清偿——记账正确性由内核契约保证，TTL 不再承担合批补偿主职能）；§5.1 合批场景成立。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| B1 内核 per-message + scheduler 兜底保留（选） | settle 粒度 = 记账单元，契约正确化；后续任何记账消费方免理解合批内部 | 低-中：内核 ±10 行 + 1 新测试 + scheduler 注释改写；跨 2 包同 PR | 单消息批次等价变换（测试锁定）；onSettled 调用次数 1→N 仅影响唯一消费方且 handleSettled 按 key 独立记账幂等 | ✅ |
| A 保留 + 债务登记 | F2 缺陷与认知税永久化；TTL 经验参数（10min >> 合批窗口）持续承担正确性 | 零（1 条 constraints 登记） | 用户可感知重复注入常驻；内核若重构合批实现，scheduler 注释知识失效 | ❌ |
| B2 根修 + dedupe 承接全删 | 同 B1 内核面；scheduler 面耦合从合批内部换为 dedupe LRU 内部 | 中：内核同 B1 + scheduler key 编码 + dedupe 配置 + 测试重写 | 被吞 send 不可见、LRU 逐出新调参面 | ❌ |

**审计修正（实读 vs 审计快照）**：
1. 审计称根修后「本机制整体删除」——**不成立**。防重 Map 的「入队未终态窗口防重复入队」职能独立于 settled 粒度（per-message 回调只在投递终态后到达，parked 等待窗口内无任何回调），B1 下 Map/TTL 保留、仅语义降级。
2. 审计将根修位置表述为「runtime 侧 session-delivery（packages/runtime/src/services/session/ 一带）」——实读内核在独立包 `packages/session-delivery/src/delivery.ts`；runtime 侧 registry 不消费 onSettled，本改动对 runtime 零影响。

### 6.2 D2：M18 croner 依赖形态（选定：移入 dependencies + 静态 import 删 probe 层）

- **采用**：①`package.json`：croner 从 peerDependencies+optional（:37/:47-49）移入 dependencies（`"croner": "^9.0.0"`）；pi 与 typebox 的 optional peer 不动（宿主确实提供——pi binary 提供 typebox，bundle external 清单佐证）。②`parsing.ts`：删 `cronerModule` 缓存与 `getCroner()`（:68-79，约 -12 行），改顶层 `import { Cron } from 'croner'`；`computeNextCronRunAt`/`computeNextCronRuns`/`parseSchedule`/`computeNextRunAt`/`computeNextRuns` 去 async 同步化（表达式无效的 try/catch 保留——那是合法的无效检测）；调用方 runtime.ts:100/:151/:418 与 service.ts:52/:76 的 `await` 对同步值无害，可保留（零行为差异）也可顺带去 await，由实施按 diff 最小原则定。
- **被否**：
  - **peer 去 optional 保留**——npm 7+ 会自动安装非 optional peer，独立安装形态修复；但 peer 语义表达「与宿主共享同一实例、版本须对齐」，croner 是包自用纯库（无共享状态、pi 不提供、无版本协同需求），语义错位仍在；且 probe 降级层必须保留（防理论缺失场景），leaky abstraction 与三层 undefined 传播未除。
  - **保持 optional + probe 失败时 warn + 错误消息区分**（审计最小备选）——自造故障形态保留，双错误通道（「解析器不可用」+「表达式非法」）让 parseSchedule 返回类型与 service 错误分支都变复杂；builtin 形态下 warn 是永不触发的死代码。
- **证据**：package.json:35-54（optional peer + dependencies 现状）；README.md「简介与安装」（独立安装是明示支持路径）；`scripts/bundle-extensions.mjs:30`（builtin inline，probe 恒成功）；pi-coding-agent 依赖清单无 croner（实测，宿主不提供）；静态 import node_modules 包在 pi 加载器下有既有先例——同包 tool.ts:1 静态 `import { Static, Type } from 'typebox'`；esbuild 对非 external 依赖 inline（croner 在 inline 清单），静态 import 对打包形态零影响。
- **效果**：目标 1（全形态可用 + 错误语义真实）；§5.1 独立安装成功路径成立。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| dependencies + 静态 import（选） | 依赖语义正确（自用库）；probe 层与降级分支整体删除；错误通道归一 | 低：package.json 2 处 + parsing.ts -12 行 + 同步化机械改 | 全安装形态 croner 确定存在（dependencies 是 npm 语义保证）；同步化是纯机械 diff | ✅ |
| peer 去 optional | 修复安装但语义错位留存，probe 税继续缴 | 低 | leaky abstraction 未除，三层 undefined 传播仍在 | ❌ |
| optional + warn 区分错误 | 故障形态自留，双通道复杂化 | 最低 | builtin 下 warn 死代码；独立安装 cron 仍全灭（仅不再误报） | ❌ |

### 6.3 D3：low 群处置（选定：登记移交 code-simplify，批量一次清扫）

审计 low 项均为 code-right（无 contested），移交 code-simplify 在实现阶段批量执行；其中两项涉及「二选一」裁决，在本设计内定案：

| # | 位置（实读） | 内容 | 处置方向 |
|---|---|---|---|
| L1 | service.ts:11-24 + 写点 :56/:67/:70/:114/:117/:121/:128/:131/:146/:149/:155 + tool.ts:80 | ServiceErrorCode 6 值枚举 + errorCode 字段零读点（W4 throw 后消费通道已删，tool.test.ts:28-29 注释自认）；service.ts:66 `message.startsWith('Task limit reached')` 字符串前缀自耦合分类 | **裁决：删除**（不恢复消费通道——W4 已用 throw 协议反向落定）；连带删前缀分类与 tool.ts:80 写点。D2 实施会顺带改造 parseSchedule 签名，L1 与 D2 同批做可省一次重复触碰 |
| L2 | backend.ts:38/:105-110/:161 + runtime.ts:76 + index.ts:116 | delivery handle 经 backend set/get 中转（backend 自身不用） | SchedulerRuntime 构造器增 `delivery?: DeliveryHandle` 参数直传，删 backend 三处 |
| L3 | runtime.ts:68/:73 | 构造器 ctx 参数 `void ctx` 即弃（gate 已移交内核） | 删参数；9 个测试文件同步改 |
| L4 | runtime.ts:334-337 | `task.force \|\| !this.delivery` 的无 handle 直投分支生产死（唯一装配点 index.ts:85-116 无条件注入） | **裁决：删分支 + 装配后断言**；测试「直投不受 idle 影响」用例改由 force 路径覆盖 |
| L5 | runtime.ts:27 + replay.ts:18 | HISTORY_LIMIT=20 双写、注释互指 | 单点导出（types.ts），两侧 import |
| L6 | tool.ts:34-42/:59-87 + index.ts:181/:203 | 工厂柯里化 `(getService())(params)` 两段调用 | 改直传参普通函数 `handleSchedule(service, params)` |
| L7 | types.ts:85-87 + parsing.ts:168-197 + service.ts:52 | ParseScheduleResult 单字段包装 `{ spec }` | 直接返回 `ScheduleSpec \| undefined`（D2 同步化时顺带） |
| L8 | types.ts:78-81 | SchedulerStore.version 死字段（importer 只读 tasks） | 删或加「形状忠实」注释，code-simplify 定 |
| L9 | importer.ts:27 等测试专用导出 + scripts/verify-scheduler-e2e.cjs:49 | 导出面即测试面（getLegacyStorePath/computeNextCronRuns/executeScheduleCommand/SentMessage/MockSchedulerBackend）；e2e 脚本 EXTENSION_PATH 指向旧路径 `extensions/scheduler`（实际 `extensions/universal/scheduler`）脚本已失效 | 导出收敛 code-simplify 定；**失效 e2e 脚本建议删除或修路径**（独立小项，不属于本设计验收面） |

### 6.4 探针清单（⛔ 实施期门）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | 内核合批 N 条 → onSettled 恰 N 次、各自 dedupeKey/outcome 正确；单条批次行为与现状逐字节等价 | session-delivery vitest 新用例（2 条 send → flush → 断言 onSettled 调用序列）+ 既有 delivery-receipt/delivery-inflight 套件零改动全绿 | ⛔ M1 合入前 | 失败 → 内核改动 revert（scheduler 侧仅注释改写，revert 零成本）回方向 A 形态并重审 D1 |
| P2 | 独立安装形态 croner 可解析且 cron 建任务成功 | `npm pack` 后在干净临时目录 `npm install <tarball>` → node `import('@zhushanwen/pi-scheduler/src/parsing.js')` 断言 croner 解析成功；或直接临时目录装包后按 §8 V1 走 pi CLI 实测 | ⛔ M2 合入前 | 失败（npm 依赖未随包发布等）→ 核对 files 字段与 peer/dependencies 残留声明；仍失败则回退方案 3（optional + warn）并重审 D2 |
| P3 | pi CLI 实装下 onSettled per-message 回调真实到达（非仅 mock 层成立） | §8 V3 场景先行小规模预演（双 interval 任务 + 长 prompt 占忙 + settle 后数注入条数） | ⛔ M2 合入前 | pi 侧 settled 事件粒度异常（理论不涉及——回调源是内核内部状态，非 pi 事件）→ 按 P1 降级路径处理 |

## 7. 实现机制（把终态落到代码层）

**本章结论：改动收敛在 session-delivery 2 文件 + scheduler 2 文件 + low 群移交面，内核净增约 +5/-5 行，scheduler 净删约 -30 行（probe 层 + 注释）。**

| 文件 | 动作 | 要点 |
|---|---|---|
| `packages/session-delivery/src/delivery.ts` | 改 | `onSendOk`（:294-303）：`settleChecked` 后对 `delivered`（原 inflightBatch）逐条 `cfg.onSettled?.(m, 'delivered')`；`onSendFail` 达上限分支（:323-331）：置空前捕获 batch 逐条 `onSettled(m, 'rejected')`；文件头「核心行为」注释补 per-message 语义 |
| `packages/session-delivery/src/types.ts` | 改 | `DeliveryConfig.onSettled`（:102）契约注释改 per-message（「批次内每条消息各获一次终态回调，msg 为该条原始消息（非 composed）」）；类型签名不变 |
| `packages/session-delivery/tests/` | 增 | 合批 per-message 用例（2+ 条 → onSettled 调用序列断言）；既有套件零改动须全绿（单消息等价性回归锚） |
| `extensions/universal/scheduler/package.json` | 改 | croner 移入 dependencies；删 peerDependenciesMeta.croner（D2） |
| `extensions/universal/scheduler/src/parsing.ts` | 改 | 静态 import Cron；删 getCroner/cronerModule；解析链同步化 + ParseScheduleResult 解包装（D2+L7）；表达式无效 try/catch 保留 |
| `extensions/universal/scheduler/src/runtime.ts` | 改 | :20-22/:48-54 注释改写（TTL = 回收层异常兜底）；:443-449「已知限制」段删除（D1） |
| `extensions/universal/scheduler/src/service.ts` + `tool.ts` 等 | 删 | L1/L6 等 low 群（code-simplify 批量） |

错误规格不变量：`computeNextCronRunAt` 返回 undefined 的唯一语义 = 表达式无效（探针 P2 保证解析器恒在）；`send()` 不 throw、入队即返回（park 语义不变）；handleSettled 反查未命中静默返回（非 scheduler 消息 / once 已删）不变。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中」（跨包行为契约修正 + 依赖形态修复），用 4 个真实场景验收，每个回溯 §2 目标；单测仅回归辅助。**

### 8.1 改动规模

依赖形态修复（M18）+ 内核回调契约修正（M19）属「行为变更/接口调整」级，多场景验收。验证环境用本地 pi CLI（AGENTS.md 约定 extension 改动优先本地 pi CLI 实测：`pi --mode rpc --session-dir <dir> --approve --extension <path>` + stdin JSONL）。

### 8.2 验收场景

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | 独立安装形态 cron 可用 | 目标 1（M18） | `npm pack` 出 tarball → 干净临时目录安装 → 以该环境起 `pi --extension` → agent 建任务 `*/10 * * * *`（正例）与 `*/10 * * *`（4 字段负例） | 正例创建成功并回显 Next 5 runs；负例报 `Invalid schedule`（此时该消息语义真实——表达式确属无效）；`node -e "import('croner')"` 在该目录成功 |
| V2 | xyz-agent builtin 形态回归 | 目标 1（M18 打包形态不回归） | 本仓 `pnpm dev` 起应用，GUI 会话内建 cron 任务并等待触发一次 | 创建成功（esbuild inline 静态 import 后 bundle 产物含 croner）；到期注入正常；`apps/electron/resources/extensions/` staging 产物 grep 到 croner 内容 |
| V3 | 合批精确记账（M19 核心） | 目标 2 + 目标 3（F2 消除） | pi CLI 会话内建两个 1min interval 任务（A、B 不同 prompt）→ 发一个长 prompt 让 agent 持续 busy 跨两任务到期 → 等 run 结束 settle | A、B 的 prompt 各注入恰好一次；`schedule_control list` 显示两者 runCount 均 +1、nextRunAt 各自推进；此后观察 ≥12 分钟无任何任务被重复注入（反向验证现状 TTL 过期重投不复现） |
| V4 | 单任务与失败路径语义不回归 + 邻居通路表面不变 | 目标 2（不该变的不变） | 同会话单任务正常周期触发两轮；另建 once 任务后手动 kill 注入路径（临时改 port.send 抛错探针或在 dev 环境模拟 rejected）验证失败记账；邻居不变量：runtime 的 session-manager send 通路（session-delivery-registry，不消费 onSettled 的另一消费方）跑 packages/runtime vitest 既有 delivery 相关套件 + GUI 内经 session_manager send 向 session 投一条消息 | 正常轮每次注入一次、runCount 递增（onSettled 单条等价性）；rejected 轮 lastStatus=failed、once 任务不删（at-least-once）；V3 会话重开后任务状态与重开前一致（event sourcing 不受本改动影响）；runtime 通路投递行为与消息可见性无任何变化（内核改动对该通路零可观测影响） |

补充约束：V3 与探针 P3 共享执行产物；验收记录（注入条数 + JSONL 摘录）贴实施 PR。

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 探针门 | 跑 §6.4 P1（内核层 vitest）与 P2（独立安装形态） | ⛔ 门槛：D1/D2 前提实证，不通过不开工 |
| M1 内核根修（D1） | delivery.ts per-message settled + types 契约注释 + 合批用例；session-delivery 全套件绿 | §5.1 合批行为；V3/V4 前置 |
| M2 scheduler 依赖修复（D2） | package.json + parsing.ts 静态 import 同步化 + runtime.ts 注释改写；P3 预演 + V1-V4 | 目标 1/2/3 全量落地 |
| M3 low 群清扫（D3） | L1-L9 移交 code-simplify 一次批量 commit；`pnpm extensions:typecheck && extensions:lint && extensions:test` 三连绿 | 目标 4 |

M1/M2 分两个 commit（跨包契约修正与包内依赖修复分离，review 面清晰）；session-delivery 与 scheduler 版本按包纪律 bump（session-delivery 行为契约修正建议 minor）。

### 9.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| u1 内核 settled 契约 | M1 全部 | 独立可验收（vitest 合批用例 + 既有套件零改动绿）；先行落地使 M2 的注释改写有真实行为支撑 |
| u2 croner 依赖修复 | M2 的 package.json + parsing.ts | 独立于 u1 可验收（P2 探针 + V1）；与 u1 分 commit 避免跨包混review |
| u3 兜底语义注释 + runtime 测试核对 | M2 的 runtime.ts 注释 + U4 系测试回归跑 | 依赖 u1（注释描述的兜底语义以 per-message 契约为前提）；纯注释与回归核对，与 u2 同 commit 保持 scheduler 包内一致 |
| u4 low 群批量清扫 | M3 | L1-L9 均为机械清理，批量一次 commit 降低触碰成本；L1/L7 与 D2 联动项须在 u2/u4 间明确归属（建议 L7 随 u2、L1 随 u4） |

### 9.3 待验证检查点

- §6.4 探针 P1-P3 结果（设计阶段断言均有实读源码依据，纪律上以实跑为准）。
- pi CLI 安装器对 dependencies 的实际安装行为（审计与本文均按 npm 语义断言，pi 安装器未实测）——V1 覆盖。
- importer 一次性迁移机制的退役里程碑（审计四问记录建议）：不属本设计 scope，建议在 code-simplify 批量或独立 chore 中登记（如「大版本后删除 importer.ts + 迁移测试」），避免永久持有。
- 已接受代价汇总（四要素）：**TTL 异常兜底保留**——量级：仅终态回调丢失异常触发（预期 <0.1%），触发时最多一次重复注入；恢复路径：重投后记账自愈，排查看 delivery warn 日志；重审触发：若合入后观察到常规性重复注入（说明 per-message 契约未生效），立即回审 D1；显式判定：可接受（符合任务级回收层有界兜底原则）。

---

## 附录：变更历史

- v1（2026-09-12）：初稿。覆盖审计 M18（croner optional）、M19（queuedInDeliveryAt 合投补偿，裁决方向 B/B1）与 low 群 L1-L9 移交登记；含审计修正两条（M19「整体删除」断言、根修位置归属）与四问记录索引错位更正。
