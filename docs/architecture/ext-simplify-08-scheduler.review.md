# ext-simplify-08-scheduler 设计文档对抗式审查报告

> **审查对象**：`docs/design/ext-simplify-08-scheduler.md`（v1，2026-09-12）
> **审查方法**：over-engineering-audit skill（四问框架 + 反模式清单 + 豁免规则），默认怀疑方案不成立，逐条以当前源码核实
> **证据基线**：worktree HEAD `239b98336`（2026-09-13），所有 file:line 为本基线实读值。审计所引 01/02/03/09/12/14 六份已实施设计的对象（unified-hooks/system-prompt-trace/goal/smart-context/pending-notifications/shared-libs）均不触碰 scheduler 与 session-delivery 的本设计涉及面，已核实无交叉污染
> **审查纪律**：只读源码 + 写本报告，未修改设计文档与任何源码

# VERDICT: NEEDS-FIX (must-fix 1 / suggestion 4)

方案方向整体成立：M18（croner 依赖形态）与 M19（内核 per-message settled 根修，方向 B/B1）的现状问题陈述全部属实，审计修正两条（防重 Map 职能独立、根修位置归属）经源码复核成立，D1/D2/D3 无过度设计（四问全过，概念数净下降）。唯一 must-fix 是 D1 兜底语义的量级断言失实：TTL 兜底的触发来源被描述为「仅终态回调丢失异常（预期 <0.1%）」，漏掉「busy 持续超 10 分钟的 parked 慢投递」这一常规可达来源——它会使 §9.3 的重审触发器在长任务用户上常规误诊「per-message 契约失效」，直接破坏方案自设的「兜底被高频触发 = 正常路径 broken」监测口径。

---

## 1. 事实核对表

### 1.1 M18（croner optional peer）相关声称

| # | 设计声称 | 源码核实 | 判定 |
|---|---|---|---|
| 1 | croner 声明为 optional peer（package.json:37/:47-49） | `extensions/universal/scheduler/package.json:37`（peerDependencies `"croner": "^9.0.0"`）+ `:47-49`（peerDependenciesMeta optional） | 属实 |
| 2 | 独立安装形态是 README 明示支持路径（README:21-29） | `README.md:19-29`「简介与安装」节，`:26` `npm install @zhushanwen/pi-scheduler` | 属实 |
| 3 | 本包 dependencies 仅 session-delivery 与 extension-logger（:51-54） | `package.json:51-55` 实际三项：session-delivery + **`@zhushanwen/pi-ext-guards`** + extension-logger | **部分属实**（漏列 ext-guards；不影响「croner 不在 dependencies」的核心结论） |
| 4 | probe 降级层：模块级缓存 + getCroner 动态 import catch→null（parsing.ts:68-79） | `src/parsing.ts:68-79`（cronerModule 缓存 + getCroner）逐行一致 | 属实 |
| 5 | 三层 undefined 传播：computeNextCronRunAt（:108-125）→ parseSchedule cron 分支 → service 返回 INVALID_SCHEDULE | `parsing.ts:112-113`（`if (!croner) return undefined`）→ `parsing.ts:189-197`（cron 分支 nextRun undefined → return undefined）→ `service.ts:52-59` 返回 `Invalid schedule: "..."` | 属实 |
| 6 | 错误通道混同：解析器缺失 ≡ 表达式非法，全程零 warn | 传导链各环节均无 warn 分支；错误消息为统一 `Invalid schedule` 文案 | 属实 |
| 7 | interval 任务不受影响（parseDuration 纯正则） | `parsing.ts:25-33` 纯正则，不走 croner | 属实 |
| 8 | pi 不提供 croner（宿主不提供） | `node_modules/@earendil-works/pi-coding-agent/package.json` dependencies 无 croner（实测）；pi 提供 typebox 1.3.7（D2「typebox optional peer 不动」的前提同时核实） | 属实 |
| 9 | builtin 形态 croner 恒 inline（bundle-extensions.mjs:30） | `scripts/bundle-extensions.mjs:29` 注释「其余（…web-tree-sitter、ajv、croner 等）全部 inline」（:30 为注释块收尾行，行号差 1） | 属实 |
| 10 | 开发环境掩盖：根 node_modules 有 croner@9.1.0 | `npm ls croner` → `croner@9.1.0 extraneous`（物理存在）；.npmrc 未显式配 auto-install-peers，pnpm 8+ 默认 true + `node-linker=hoisted`（.npmrc:10，设计引 :9 为注释行） | 属实（机制描述正确，行号小偏） |
| 11 | scheduler 是 mandatory 扩展 tier: feature（mandatory-extensions.json:10） | `packages/shared/src/mandatory-extensions.json` 第 10 行 `@zhushanwen/pi-scheduler` tier `feature` | 属实 |
| 12 | 静态 import 在 pi 加载器下有先例（tool.ts:1 静态 import typebox） | `src/tool.ts:1` `import { Static, Type } from 'typebox'` | 属实 |
| 13 | croner 移入 dependencies 依赖面干净 | croner@9.1.0 `dependencies: {}`（零传递依赖），engines node>=18 | 属实（设计未明写零传递依赖，核实支持其方案） |

### 1.2 M19（合投补偿机制）相关声称

| # | 设计声称 | 源码核实 | 判定 |
|---|---|---|---|
| 14 | 内核 settle 上报「每批一次、composed 只带首条 dedupeKey」 | `packages/session-delivery/src/delivery.ts:301` `cfg.onSettled?.(composed, 'delivered')`（onSendOk :294-303 内，每批恰一次）；`:329` rejected 同型（onSendFail 达上限分支 :323-331）；`buildBatchPayload`（:67-98）多条时 `...first` spread（:76-77）只保留首条 identity（含 dedupeKey），`:68` 单条返回原消息 | 属实 |
| 15 | 合批形成点：busy parked 积压 + settled 边沿 flush 时 `queue.splice(0)` 整队（delivery.ts:372-380） | `delivery.ts:377` `inflightBatch = queue.splice(0)`（doSend :372-380）；busy gate（:399-406）有 subscribeSettled 装配时消息 park 等 settled 边沿 | 属实 |
| 16 | F2「合批非首条任务 10 分钟后重复注入」常规可达 | 推演全链路成立：非 force 任务入队（`runtime.ts:373-397`，dedupeKey=task.id :386，置标记 :393，nextRunAt 不推进）→ busy park → settled flush 合批 → onSettled 只带首条 key → 非首条无回调 → 标记留存（TTL 10min，`runtime.ts:22-23`）→ tick step2 按 `now >= nextRunAt` 重标 pending（:267-272）→ TTL 拦截失效（:340-341）→ 重新入队（:344）→ prompt 第二次注入。`runtime.ts:446-448` 注释自认「已知限制」、`:50-51` 注释自认 TTL 兜底「与旧 nextRunAt 未推进下 tick 重投等价」 | 属实 |
| 17 | scheduler 未配 mergeWindowMs（合批与 merge 窗口无关） | `index.ts:108-115` createDelivery config 仅 intent/busyPolicy/onSettled；`busyPolicy: 'park'`（:110） | 属实 |
| 18 | 防重三件套：Map + TTL + pending 重标（runtime.ts:20-22/48-54/339-342/443-468） | Map（:52）/TTL 常量（:22-23）/注释（:46-51）/拦截（:340-341）/handleSettled 清除（:450-467，delete 在 :453）——行号 ±2 内一致 | 属实 |
| 19 | onSettled 生产消费方全仓唯一 = scheduler | 全仓 grep：配置点仅 `scheduler/src/index.ts:111`、消费点仅 `runtime.ts:450` handleSettled；`packages/runtime/src/services/session/session-delivery-registry.ts:118-144` buildHandle 只配 intent 不配 onSettled；`subagent-workflow/src/host/pi-host.ts:216` 仅 re-export createDelivery；`subagent-core` 的 onSettled 是同名异义概念（ContinuationRoundHandlers，`conversation-continuation.ts:59` 签名 `onSettled(outcome: AgentOutcome)`，与 DeliveryConfig.onSettled 无关） | 属实（字面「生产代码仅 scheduler」漏提 subagent-core 同名异义符号，见 S1-d） |
| 20 | 既有 session-delivery 测试 onSettled 断言全单消息形态，「零改动全绿」可信 | `delivery-receipt.test.ts` 4 个用例（:38/:55/:72/:86 起）全部单条 send + `toHaveBeenCalledTimes(1)`；`delivery-inflight.test.ts` 8 处 onSettled 全单条（:212/:243/:274/:298/:317/:337/:356/:379）；单条批次 `buildBatchPayload` 返回原消息（delivery.ts:68），per-message 循环一次等价。设计称「delivery-receipt.test.ts 5 处」计数不准（实际 4 用例） | **部分属实**（结论成立，计数偏差） |
| 21 | 不触碰的契约：sendChecked/settleChecked 腿、dispose 不触发 onSettled、port.send 仍发 composed | `delivery.ts:300`（settleChecked 先于 onSettled，改动点在其后）；`:532-536` dispose 契约注释 + `:537-562` 实现不动；`attemptSend`（:263-280）port.send(composed) 不变 | 属实 |
| 22 | 审计修正①：防重 Map「入队未终态窗口防重复入队」职能独立于 settled 粒度，不可删 | `U4-PARK_GATE.test.ts:141` 用例(5)「到期任务 + 持续 busy 多 tick 不重复入队」锚定：parked 窗口内（busy、消息在内核队列、无任何回调）每 tick step2 重标 pending，per-message 回调只在投递终态后到达——职能独立成立 | 属实 |
| 23 | 审计修正②：根修位置在独立包 packages/session-delivery，runtime 侧 registry 不消费 onSettled | 核对项 19 | 属实 |
| 24 | types.ts:38-46 DeliveryMessage 每条各自持有 dedupeKey；:102 onSettled 签名 | `packages/session-delivery/src/types.ts:38-46`（dedupeKey :43）、`:102` | 属实 |
| 25 | B2 否决前提：scheduler 当前未开内核 dedupe | `runtime.ts:384-385` 注释「本 handle 未开 dedupe」+ `index.ts:108-115` config 无 dedupe 字段 | 属实 |

### 1.3 D3 low 群（L1-L9）声称

| # | 设计声称 | 源码核实 | 判定 |
|---|---|---|---|
| 26 | L1：ServiceErrorCode 6 值枚举（service.ts:11-24）+ errorCode 11 个写点零生产读点 + :66 前缀自耦合 + tool.test.ts:28-29 注释自认 | `service.ts:11-24` 枚举 + `:19-24` ServiceResult.errorCode；写点 :56/:67/:70/:114/:117/:121/:128/:131/:146/:149/:155 + `tool.ts:80`；生产读点零（grep 全仓：service.ts 外仅 tool.ts:80 写点与测试断言）；`:66` `message.startsWith('Task limit reached')`；`tool.test.ts:28-29` 注释「原 errorCode details 随 throw 不再产出」 | 属实（测试牵动面见 S3） |
| 27 | L2：delivery handle 经 backend set/get 中转（backend.ts:38/:105-110/:161 + runtime.ts:76 + index.ts:116），backend 自身不用 | `backend.ts:38`（接口可选成员）、`:105-111`（set/get）、`:161-163`（Mock）；`runtime.ts:74` 取用；`index.ts:116` 注入；backend 全文无自身使用 | 属实 |
| 28 | L3：构造器 ctx 参数 `void ctx` 即弃（runtime.ts:68/:73），9 个测试文件同步改 | `runtime.ts:66-72`（`:71` `void ctx`）；grep `new SchedulerRuntime` 测试文件恰 9 个 | 属实 |
| 29 | L4：`task.force \|\| !this.delivery` 无 handle 直投分支生产死（runtime.ts:334-337），唯一装配点无条件注入 | `runtime.ts:333-336` 分支；生产 `new SchedulerRuntime` 唯一在 `index.ts:120`，其前 `:85-116` 无条件 createDelivery + setDeliveryHandle（其余构造点全为测试） | 属实 |
| 30 | L5：HISTORY_LIMIT=20 双写（runtime.ts:27 + replay.ts:18） | `runtime.ts:28` + `replay.ts:18`（同为裸常量 20，runtime 侧注释互指 replay 侧） | 属实 |
| 31 | L6：工厂柯里化两段调用（tool.ts:34-42/:59-87 + index.ts:181/:203） | `tool.ts:34-40`/`:59-86` 工厂返回闭包；`index.ts:181` `createScheduleHandler(getService())(params)`、`:203` 同型 | 属实 |
| 32 | L7：ParseScheduleResult 单字段包装（types.ts:85-87 + parsing.ts:168-197 + service.ts:52） | `types.ts:85-87` `{ spec }`；`service.ts:52-63` 消费 `parsed.spec` | 属实 |
| 33 | L8：SchedulerStore.version 死字段（types.ts:78-81，importer 只读 tasks） | `types.ts:78-81`；grep importer.ts 无 version 读取 | 属实 |
| 34 | L9：测试专用导出面 + e2e 脚本失效路径 | getLegacyStorePath（importer.ts:30）生产零引用（仅 importer.test.ts；verify-scheduler-e2e.cjs :74-77 是自带的 CommonJS 复制实现非 import）；computeNextCronRuns 仅 cron/parsing 测试引用；executeScheduleCommand 仅 commands.test.ts（index.ts 只用 registerScheduleCommand）；`scripts/verify-scheduler-e2e.cjs:49` EXTENSION_PATH 指向 `extensions/scheduler` 旧路径（实际 `extensions/universal/scheduler`） | 属实 |

### 1.4 其他

| # | 设计声称 | 源码核实 | 判定 |
|---|---|---|---|
| 35 | scheduler 版本 v0.5.1 | `package.json:3` 已是 0.5.2（CHANGELOG：0.5.2 = guardStaleCtx crash-resilience 维护版，与本设计涉及面无交集，引用的代码行为全部与当前源码一致） | **部分属实**（版本标注滞后，无实质影响） |
| 36 | P3 声称「回调源是内核内部状态，非 pi 事件」 | onSettled 由内核 onSendOk/onSendFail 触发（挂钩 port.send 受理结果，delivery.ts:286-303），与 pi agent_settled 事件（仅驱动 flush 边沿，:221-230）无关 | 属实 |

---

## 2. must-fix 清单

### MF1：TTL 兜底触发条件描述失实——「仅终态回调丢失异常（预期 <0.1%）」漏掉「parked 等待超 10 分钟」这一常规可达来源

- **设计文档位置**：§5.2 失败路径第三条（「终态回调丢失异常（内核 bug / pi 事件丢失，预期 <0.1%）：防重标记 TTL 10min 过期后放行重投……此即 D1 保留 TTL 的兜底职能」）；§9.3 已接受代价汇总（「量级：仅终态回调丢失异常触发（预期 <0.1%）」）；§6.1 B1 风险列（「handleSettled 按 key 独立记账幂等」的「幂等」表述同源失实，见 S4）。
- **源码证据**：
  - `extensions/universal/scheduler/src/runtime.ts:340-341`——拦截条件 `queuedAt !== undefined && now - queuedAt < QUEUE_DEDUPE_TTL_MS`；`queuedInDeliveryAt` 仅在 `handleSettled`（`:453`，终态回调到达）或任务删除时清除。
  - `packages/session-delivery/src/delivery.ts:399-406`——busy 且有 subscribeSettled 装配时消息 park 等待 settled 边沿，不投递、无任何回调。
  - `extensions/universal/scheduler/src/index.ts:89-95`——scheduler 恒装配 subscribeSettled（park 模式成立）。
- **问题**：回调未到达不等于回调丢失。agent busy 持续超过 10 分钟时（xyz-agent 的长编码任务是常态场景，不是 <0.1% 异常），消息仍 parked 在内核队列、回调尚未有机会发生，TTL 已过期——tick step2 按 `now >= nextRunAt`（`runtime.ts:267-272`）重标 pending 后拦截失效，副本重新入队；settled 后两份同 prompt 合批注入。这是「投递等待时长超过防重窗口」的正常可达路径，与「内核 bug / pi 事件丢失」无关。per-message 根修（D1）**不能消除**这类重复注入——它只消除「合批非首条收不到回调」这一类。§5.1「10 分钟后：无任何重复注入」的绝对化表述仅在 busy 窗口 < 10min 时成立；B1 vs B2 对比也未披露 B1 保留此缺陷（B2 的内核 dedupe 恰能吞掉同 key 副本，虽然引入设计已列的其他代价）。
- **为什么必须修**：直接破坏方案自设的监测口径——§9.3 重审触发器「若合入后观察到常规性重复注入（说明 per-message 契约未生效），立即回审 D1」。长 busy 用户会常规触发 TTL 重投，按此触发器会被误诊为 per-message 契约失效并错误回退方向 A。这正是审查要求 B「兜底被高频触发 = 正常路径 broken 的信号」边界不清晰的实例：必须先能区分「TTL 窗口内正常等待」与「回调真丢失」，信号才有效。
- **建议修法**（设计层，不改方案方向）：
  1. §5.2 / §9.3 把 TTL 兜底触发条件改为完整两类来源：(a) 终态回调丢失异常（内核 bug / port.send 结果丢失，预期罕见）；(b) 投递等待超 10 分钟的慢投递（busy 持续超窗，长任务场景常规可达）。并注明 10min TTL 的本质是「重复注入风险与投递延迟」的权衡参数，非纯异常兜底。
  2. §9.3 重审触发器补区分手段：观察到重复注入时，先核对注入时间线（是否 busy 超窗期发生）与 delivery warn 日志（有无回调丢失迹象），确认属 (a) 类才回审 D1；(b) 类属已知接受行为。
  3. §5.1 合批场景的「无任何重复注入」与 V3 通过标准限定 busy 窗口 < 10min（或等效限定）。

---

## 3. suggestion 清单

### S1：事实精确性修正包（5 处小偏差，一次性修）

- **位置**：§1 背景 / §3.1 / §6.1 证据段。
- **内容**：(a) 版本标注 v0.5.1 → 0.5.2（核对项 35）；(b) §3.1「本包 dependencies 仅 session-delivery 与 extension-logger（package.json:51-54）」漏列 `@zhushanwen/pi-ext-guards`（:53，核对项 3）——不影响结论但「仅」字失实；(c) §6.1「delivery-receipt.test.ts 5 处」→ 实际 4 个用例（核对项 20）；(d) §6.1「grep -rn onSettled 生产代码仅 scheduler」建议补注 subagent-core 的 `ContinuationRoundHandlers.onSettled`（conversation-continuation.ts:59 / run-orchestration.ts:1311/:1487）为同名异义概念（AgentOutcome 签名），防实施者 grep 时误判消费方枚举有漏（核对项 19）；(e) .npmrc:9 是注释行，node-linker=hoisted 在 :10，auto-install-peers 是 pnpm 8+ 默认值而非 .npmrc 显式配置（核对项 10）。
- **非阻塞理由**：均为表述精确性问题，不改变任何论断方向。

### S2：V3 验收判定口径与 P2 探针主路径的可操作性

- **位置**：§6.4 P2、§8.2 V3。
- **内容**：(a) V3 用两个 1min interval 任务 + 观察 ≥12 分钟——观察期内每任务正常注入约 12 轮，「无任何任务被重复注入」需给出区分「正常下轮注入」与「同周期重复注入」的判定手段（按 nextRunAt 周期对齐 prompt 轮次，或缩短 interval 让轮次可辨认），并注明观察期内避免 >10min 连续 busy（否则撞 MF1(b) 类场景产生误判）。(b) P2 主探针「node `import('@zhushanwen/pi-scheduler/src/parsing.js')`」不可行：files 字段发布的 src 是 .ts 文件（package.json:29-34），裸 node 无法解析 TS；备选路径（临时目录装包后按 V1 走 pi CLI 实测）可行，V1 通过标准中的 `node -e "import('croner')"`（croner 是 JS 包）也可行——建议把 P2 主探针直接改为后者，删除不可行的 node-import-TS 路径。
- **非阻塞理由**：验收与探针均有可行备选路径，修正属降低实施期返工。

### S3：L1 的测试牵动面登记不全

- **位置**：§6.3 L1 行。
- **内容**：L1 删除 errorCode 时，`service.test.ts` 有 9 处 errorCode 断言（:25/:70/:81/:125/:134/:143/:162/:181/:193）需同步改写（断言对象本身被删，非迁就性改测试）。设计 D3 只列了 L3 的「9 个测试文件同步改」，L1 的测试改造面未列。code-simplify 批量时自然处理，但登记面宜完整，避免实施者误判改动范围。
- **非阻塞理由**：机械清理项，移交面归属明确。

### S4：per-message 化后「同 key 多副本」的行为差异未披露 +「幂等」措辞不准

- **位置**：§6.1 B1 风险列、§7 错误规格不变量。
- **内容**：`handleSettled` 并非幂等——同一 dedupeKey 的多条消息（MF1(b) 场景：TTL 过期产生的同 task 双副本同批投出）在 per-message 化后会各自触发回调：runCount 双计、nextRunAt 推进两次（任务跳过下一个周期，1min 任务无感、每日任务会跳一天）。现状（每批一次）下同批双副本只记账一次（非首条无回调）。两个行为各有缺陷（现状少记账 / 新行为跳周期），方向上不算劣化，但设计应披露该差异并在 §7 错误规格不变量中写明 handleSettled 的幂等性边界（「同 key 每条消息恰好一次回调时幂等；同 key 多条并存时逐条累计」）。
- **非阻塞理由**：罕见场景 + 行为差异方向不劣化，属披露完整性问题。

---

## 4. 已核实无问题（附证据快照，防后续重复怀疑）

1. **F1 触发路径（静默全灭 + 误报 Invalid）真实成立**。传导链逐环核实：parsing.ts:68-79（getCroner catch→null）→ :112-113（!croner → undefined）→ :189-197（parseSchedule cron 分支 undefined）→ service.ts:52-59（统一 Invalid schedule 文案，无 warn 分支）。npm 7+ 不自动安装 optional peer 是 npm 文档化语义；独立安装形态（README:26 明示）下 croner 确不在磁盘。开发环境掩盖机制（根 node_modules croner@9.1.0 extraneous + pnpm auto-install-peers 默认 + hoisted）实测吻合。
2. **F2 触发路径（合批非首条 10 分钟后重复注入）真实可达且为常规路径**。全链路推演见核对项 16；`runtime.ts:446-448` 与 `:50-51` 注释自认。busy park（内核 delivery.ts:399-406）+ settled flush 合批（:377 splice）+ composed spread first（:74-77）三个前提全部实测成立。
3. **onSettled 消费方枚举完整（session-delivery 语义下）**。全仓 grep 快照：配置点 1（scheduler/index.ts:111）+ 消费点 1（scheduler/runtime.ts:450）+ 内核定义 2（delivery.ts:301/:329、types.ts:102）+ runtime registry 0（buildHandle :118-144 仅 intent）+ subagent-workflow 0（pi-host.ts:216 纯 re-export）+ subagent-core 0（同名异义 ContinuationRoundHandlers，非 DeliveryConfig.onSettled）+ 测试若干。方向 B 的兼容性论证（唯一消费方 + 按 key 记账）成立。
4. **单消息批次等价变换成立**。buildBatchPayload 单条返回原消息（delivery.ts:68），per-message 循环一次与现状逐字节等价；既有 delivery-receipt（4 用例）/delivery-inflight（8 处）/delivery-settled/delivery-merge/payload/intent/warn/s5-anchor 套件中 onSettled 断言全单消息形态（合批断言只存在于 port.sendCalls 层面，不触回调次数），「既有套件零改动全绿」可信。scheduler 侧 U4-ONSETTLED / runtime.test / U4-PARK_GATE 均直接调 runtime.handleSettled（与内核解耦），M1 落地后零影响。
5. **方向 B 改动点定位正确、±10 行估计合理**。onSendOk（delivery.ts:294-303）`settleChecked` 后对 `delivered`（原 inflightBatch，:296）逐条化；onSendFail 达上限分支（:323-331）需在 `inflightBatch = []`（:326）前置前捕获——设计 §7 的「置空前捕获 batch」正确预见了这一点。sendChecked 腿（settleChecked :105-129）与 dispose 契约（:532-562）均不在改动面。onSettled 回调内再 send 的重入安全性：pump 在回调后执行（:302），无重入破坏。
6. **D2 与 universal 定位自洽**。croner 零传递依赖（deps: {}），移入 dependencies 使独立安装形态功能自足（强化而非破坏「独立通用包」定位）；peer 语义错位的否决论证成立（croner 自用纯库、pi 不提供、无共享状态）；builtin 形态 esbuild inline 不受依赖类别变化影响（bundle-extensions.mjs:29 注释清单）；typebox optional peer 不动的前提（pi deps 含 typebox 1.3.7）核实成立。
7. **B2 否决论证成立**。scheduler 当前未开内核 dedupe（runtime.ts:384-385 注释 + index.ts:108-115 config 无 dedupe）；承接防重需周期唯一 key 编码 + LruSet maxKeys 调参（LRU 逐出后旧 key 可再入的调参面）+ 被吞 send 对 scheduler 不可见三个新面，「净复杂度不降」的判断与源码结构一致。
8. **审计修正两条成立**。修正①：防重 Map 的防重入职能独立于 settled 粒度（U4-PARK_GATE.test.ts:141 用例(5)「busy 多 tick 不重复入队」锚定 parked 窗口拦截，该窗口内无任何回调可依赖）；修正②：根修位置在 packages/session-delivery（独立包），runtime 侧 registry 不消费 onSettled。
9. **L1-L9 全部属实且均为收敛/删除方向**（核对项 26-34）。四问核对：全部为概念数下降的机械清理，无新增抽象/扩展点，不构成过度设计；L1 测试改写属「断言对象已删」的跟随清理，不属「改测试迁就简化」。
10. **方案四问全过（C 部分结论）**。D1 per-message 契约：不是新增抽象而是修正契约粒度使记账正确（依据 = 已发生的真实缺陷 F2 + 唯一真实消费方，非想象未来；消除「须理解内核合批内部」的认知税 = 概念数下降）；保留 Map/TTL：职能真实（防重入 + 回收层有界上界兜底，符合全局架构约定的回收层四族可默认有界原则），唯一缺口是 MF1 的描述失实；D2：依赖语义正确化 + 删 probe 层（现状 probe 层自身是防御「自造缺失状态」的 abstraction inversion 味道，删除正确）；D3：纯删除。无 inner-platform / pass-through / second-system / Greenspun 信号；无当前真实调用方为 0 的新增能力。
11. **简化铁律通过**：D1+D2+D3 合计净删概念（croner 可缺失状态、合批内部知识、errorCode 通道、backend 中转、ParseScheduleResult 包装、柯里化工厂）约 -6，无「简化后更难懂」项；无改测试迁就项。
12. **event sourcing 存储层 + importer 判为本质复杂度保留（Out-of-scope）合理**。replay.ts 两步折叠（全量折叠 + fork owner 过滤）对应 fork 继承与 append-only 时序的真实问题域复杂度；importer 退役里程碑已登记（§9.3）避免永久持有。

---

## 附：审查覆盖与限制

- 覆盖：scheduler 全部 src 文件（package.json/parsing/runtime/service/tool/backend/types/index/replay/importer/README）、session-delivery 内核（delivery.ts/types.ts）与全部测试的 onSettled 形态、bundle-extensions.mjs、mandatory-extensions.json、.npmrc、pi-coding-agent 实装依赖清单、verify-scheduler-e2e.cjs、runtime session-delivery-registry、subagent-workflow pi-host、subagent-core 同名符号辨析。
- 限制：审计四问记录原文（`~/.pi/agent/tmp/session-view-01a09053-2429-*.md`）未直接复核（设计已声明索引错位并自行 grep 重新定位，本审查以当前源码为准全部重验，不依赖审计快照）；pi CLI 安装器行为未实测（设计 §9.3 已自认并以 V1 覆盖）。
