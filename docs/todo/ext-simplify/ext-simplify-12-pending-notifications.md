# ext-simplify-12：universal/pending-notifications 过度设计收敛（删 session 档死机器 + registry 现算化 + 导出面收敛）

> **一句话结论**：删除 W4 翻档后无任何消费类型的 session 档 TTL 机器（约 100 行，含分档常量 `PENDING_LIFECYCLE`——本设计裁决比审计多删这一个常量，理由见 D2），并把「内存 registry 第二份状态」整体现算化：查询工具与两个 listener 的落盘前置判断全部改为对 `getEntries()` 差集现算（与 goal/subagent-workflow 同一原语 `countActiveFromEntries`），session entries 成为唯一权威状态源，根治 bte 已记录的双状态分歧事故；具名导出面 14 → 5（default 出口不计）。协议写侧（事件 → appendEntry 落盘）保留不动。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-pending-notifications`（v0.6.0）是 xyz-agent 的 universal 组 builtin extension（mandatory-extensions.json 标记 tier=infrastructure，不可禁用）——为跨 extension 的长耗时异步操作（workflow/subagent/bash 后台任务）提供注册/查询机制：各运行方经 pi EventBus 广播 `pending:register/unregister`，本包监听并写入 session entries（`pi.appendEntry`），LLM 经 `pending_notifications` 查询工具读取活跃操作；goal（continuation 守卫）与 subagent-workflow（后代判定）直接 import 本包导出的 `countActiveFromEntries` 读 entries 差集。
- **C（冲突）**：2026-09-11 过度设计审计（候选 4，medium/7 分）证实两块净增偶然复杂度：① W4 生命周期翻档（subagent/workflow 从 session 档翻 process 档，2026-09-08 事故修复）后，session 档 TTL 机器（1h 过期清理、跨 session 补注销、shutdown 标 cancelled）服务 0/3 个现存类型——整块死代码以「待未来类型」名义留存，靠 4 处「勿删/勿误认」注释和 3 个「断言死代码是死的」测试用例防误读，且 `constraints.json` C-proc-13 ③ 已把「subagent/workflow 恒 process 档——禁回翻 session 档」登记为约束语义，赌的「未来 session 档类型」被自家约束封死；② 包内维护着 session entries 之外的第二份状态（内存 registry），唯一消费者是本包查询工具，而 goal/bte/subagent-workflow 全部直读 entries——双状态分歧已造成真实事故：bte 被迫绕开本包内存态、以 appendEntry 为权威写注销（`base-tool-enhance/src/background/pending-reconcile.ts:10-16` 明文记录 unregister listener 因内存态顺序反转被静默吞、对账失效）。
- **Q（问题）**：如何在不回归注册/查询主链路（协议写侧、goal 守卫、后代判定、bte 投影）的前提下，删掉无消费者的 session 档机器，并消除「哪份状态是权威」的持续分歧源？
- **A（答案）**：entries 单一权威源——查询工具与 listener 落盘前置判断全部对 `ctx.sessionManager.getEntries()` 现算（appendEntry 同步入账已从 pi 0.84.4 dist 实读证实），删内存 registry 五件套、session_start 重建、session_shutdown handler 与全部 session 档机器；死代码直接删（git 可找回，推翻 W4「刻意留存」处置）。一次本地 pi CLI 真实场景验收（注册 → 查询 → 注销 → 重启续存 → fork 残留过滤）作为合入门。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改写清单 + SSOT 回写项）。

**证据基线**：pi SDK 断言全部核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4` 的 dist 编译产物（npm ls 确认 0.84.4）；文中行号均为 2026-09-11 实读值，与审计快照的差异已按实读修正（见 §6.5 审计修正记录）。

---

## 1. 背景：被设计的系统是什么

**pending-notifications 解决的问题是「后台异步任务的活跃状态对 LLM 不可见」**：主 agent 派出 workflow run / 后台 subagent / bash 后台任务后，这些任务的生命周期跨越多个 turn，LLM 需要随时知道「还有什么在跑」来决定是否等待。本包是这条链路的落盘与查询中枢，三个角色：

| 角色 | 做什么 | 现状实现 |
|---|---|---|
| 写侧（协议面） | 监听 `pending:register/unregister` 事件 → 追加 `pending:register` / `pending:unregister` custom entry 到 session JSONL | `src/index.ts` 两个 EventBus listener（:142-211） |
| 读侧（共享原语） | 从 entries 算 register − unregister 差集 = 活跃集合 | `src/state.ts` `countActiveFromEntries`（:177-190），goal / subagent-workflow 直接 import |
| 读侧（工具投影） | `pending_notifications` 查询工具（action=count/list）供 LLM 主动调用 | `src/index.ts`（:264-296），**现状读内存 registry，不读 entries** |

生命周期分档术语（state.ts 既有概念，D16）：**session 档** = 随 session entry 存活，带 1h TTL（U3）与跨 session 补注销（U4）、shutdown 标 cancelled（U11）；**process 档** = 随进程存活，无 TTL、跨 session/重启续存、shutdown 不清。W4 翻档（2026-09-08）把仅有的三个类型（subagent/workflow/bash）全部定为 process 档——原因是 session 档的 TTL 与跨 session 清理会静默清除可跑超 1h 的长任务注册，使 goal 守卫失明（事故放大器）。

关键消费链路（本次必须全部不回归的面）：

| 消费方 | 用法 | 证据 |
|---|---|---|
| goal continuation 守卫 | agent_end 时 `countActiveFromEntries(entries, {currentSessionId})`，count>0 则不发 continuation、改发等待通知 | `extensions/universal/goal/src/adapters/event-handlers/agent-end.ts:23,202,342` |
| subagent-workflow 后代判定 | agent_end 时经 core 端口问「有无活跃后代」，决定进程是否保持等 steer 唤醒 | `extensions/universal/subagent-workflow/src/host/pi-host.ts:36,211-212` |
| bte（base-tool-enhance） | bash 后台任务经 `pi.events.emit("pending:register/unregister")` **投影**状态到本包（零 import，peer 声明）；session_start 对账直接 `appendEntry` 补注销 | `base-tool-enhance/src/background/pending-reconcile.ts:126-136`；bte package.json peerDependencies |
| LLM | 调 `pending_notifications` 工具查询 | `src/index.ts:264-296` |

## 2. 设计目标

1. **entries 单一权威源**：本包内不再存在第二份 pending 状态——工具投影与写入侧判断与 goal/bte/subagent-workflow 读同一份 entries 差集；「落盘了什么」与「查询到什么」在结构上不可分歧。
2. **主链路零回归**：注册/注销落盘契约（entry 形态）、`countActiveFromEntries` 签名与行为、`pending_notifications` 工具 count/list 输出语义，全部与现状一致；写侧去重语义与现状**语义等价**，附带三条显式登记的边缘差异（fork 残留跨 session 注销口径、fork 残留同 id 重复注册口径、id 复用去重窗口——均被 per-session EventBus / id 全局唯一前提约束为理论窗口，见 §6.1 边缘差异登记）。
3. **删 session 档死机器**：PENDING_TTL_MS、isExpiredEntry、expiredToFlush、TTL 回填、session_start 补 flush 循环、session_shutdown handler 及其测试用例整体移除；分档常量 `PENDING_LIFECYCLE` 一并删除（D2 裁决）。
4. **导出面收敛**：npm 具名导出从 14 个收敛到 5 个（default 出口不计；唯一消费函数 + 其签名所需类型）。
5. **SSOT 同步**：C-proc-13 ③ 的读侧消费枚举随 rebuild 删除同批回写（C-proc-10 纪律）。

**In-scope**：`extensions/universal/pending-notifications/`（src + tests）、`packages/subagent-core/src/execution/engine/__tests__/conformance/registry-fork-filter.test.ts`（直穿 import 本包 src 的连带改写）、`docs/constraints.json` C-proc-13 ③ 措辞（+ `node scripts/render-constraints.mjs` 重新生成 md）、bte 包内一处注释行修正（`base-tool-enhance/src/background/pending-reconcile.ts:115`，E8）、docs/design 悬空引用/行为断言失实回写 4 文件（E9）、`scripts/check-doc-symbol-drift.mjs` DOC_MODULE_MAP 映射登记（E10）、`docs/design/ext-simplify-index.md` 13 号行跨设计协调注记（§6.4⑤ 批级锚点，设计交付时落地）。
**Out-of-scope**：
- 13 号设计文档（`ext-simplify-13-base-tool-enhance-protocol.md`）本身的任何修改——其 D5 计划新增注释的前提在本设计终态下失效，按 §6.4 协调约束由 13 号实施批自行按本文档终态调整措辞，本文档不予代改；
- bte 对账机制本身（registry 读取、kill(pid,0) 判据）——已核实非过度，其协议重构归 13 号设计（本设计仅触及一处注释行与 `docs/design/base-tool-enhance.md` 中引用本包被删符号的段落回写）；
- cw-tool 包——同单元审计结论为职责正交、无过度设计，不出现在本设计；
- EventBus 订阅的 unsubscribers 双重清理（pi 已自动退订 + 手工兜底）——审计四问记录判为「留观」的 12 行防御，本设计不动；
- goal / subagent-workflow / core 的任何改动（它们只消费 `countActiveFromEntries`，签名不变即零影响）。

---

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子（取自代码）

**使用者（LLM）视角**——一次后台任务从派生到完成的查询轨迹：

```
[主 agent] 派后台 subagent（subagent-core 发 emit "pending:register" {id:"bg-1",type:"subagent",name:"review"}）
[pending listener] 收事件 → 写内存 registry{bg-1: active} → appendEntry("pending:register",{id:bg-1,...,sessionId:当前})
[主 agent] 调 pending_notifications {action:"count"}
[工具] getActive(registry) → 内存态过滤 sessionId → 返回 "1 pending operation(s)"
[任务完成] emit "pending:unregister" {id:"bg-1"} → registry 标 completed → appendEntry("pending:unregister",{id:bg-1,...})
[主 agent] 再查 count → "0 pending operation(s)"
```

正常路径下内存态与 entries 同步推进，查询结果一致。**分歧发生在异常路径**（见 3.2 F2）。

**bte 视角**（双状态分歧的直接受害者）——它在 session_start 对账时必须绕开本包内存态，`pending-reconcile.ts:10-16` 的原文注释：

```
收尾写法（权威路径）：直接 pi.appendEntry("pending:unregister", {id, reason, status})
——不走 bus emit 作为权威：pending-notifications 的 unregister listener 落盘条件
是其内存 registry 该 id active（其 registry 只在自身 session_start rebuild 后非空），
两个 extension 的加载/派发顺序（CLI --extension 顺序用户可控）无保障，顺序反转时
emit 被静默吞、对账失效。差集消费方 goal 从持久化 entries 算差集……appendEntry 之外
尽力补一次 emit（listener 就绪时同步其内存视图，失败无害）。
```

**维护者视角**——session 档机器的死代码现场（state.ts:35-38 注释原文）：

```
[W4 session 档机器死代码处置] 翻档后三类型全 process 档——PENDING_TTL_MS / U3 / U4 /
U11 全体暂无消费类型。机制本体保留（registry 通用能力，session 档暂无消费类型，
留存待未来类型），勿误认清理仍在工作：本文件不再有任何类型的 TTL 清理或跨
session 注销在运行。
```

### 3.2 真实失败模式

- **F1（死机器维护税）**：session 档机器约 100 行服务 0/3 个现存类型——`state.ts:96`（PENDING_TTL_MS，自注「回填分支不可达」）、`state.ts:287-300`（isExpiredEntry，两检均被 process 档门槛短路→对现存类型恒 false）、`state.ts:311,332-334`（expiredToFlush 恒空）、`state.ts:372-380`（normalizeRegisterEntry 的 TTL 回填分支不可达）、`index.ts:161`（expiresAt 对现存类型恒 undefined）、`index.ts:230-235`（session_start 补 flush 循环永不执行）、`index.ts:246-261`（session_shutdown handler 对全部现存类型 `continue`，整体 no-op）。需要 4 处「勿删/勿误认清理仍在工作」注释防误读；测试专门断言死代码是死的（`__tests__/pending-notifications.test.ts:207-218`「U3 机器不可达」、`:220-233`「U4 不入 registry」、`:395-405`「U11 不再发生」）；困惑已外溢——bte `pending-reconcile.ts:115` 注释仍引用「pending 自身 TTL」（已不存在的清理）。
- **F2（双状态分歧事故）**：内存 registry 是 entries 的第二份状态，两份的写入口径不同——registry 只在「listener 收到事件」时更新且受 session_start rebuild 重置，entries 只在「落盘前置判断通过」时追加。bte 对账因加载顺序无法假设本包 registry 就绪，emit 的 unregister 被落盘前置判断静默吞掉（F2 事故），被迫以 appendEntry 为权威、emit 降级为「尽力补」（pending-reconcile.ts:133-136）。此外还有两个现状就存在的分歧窗口：① `safeAppendEntry` 落盘抛错（stale context）时内存态已更新而 entries 没有——工具投影显示活跃、goal 守卫读 entries 判不活跃，同一次注册两个读方结论相反；② bte 对账已直接落盘 unregister 后，任务收尾的 emit 到达，内存 registry 仍认为该 id active，再次落盘一条重复 unregister entry（差集语义下无害，但属噪音写入）。
- **F3（导出面虚胖）**：`src/index.ts:52-67` 导出 14 个具名符号（另有 default 出口不计入），包外生产消费仅 `countActiveFromEntries` 一项（goal agent-end.ts:23 + subagent-workflow pi-host.ts:36）；其余 13 个中 6 个类型（CountActiveOptions/CountActiveResult/PendingEntry/PendingRegistry/PendingStatus/PendingType）包外零引用，register/unregister/getActive/createRegistry/rebuildFromEntries 包外仅被 conformance 测试以 7 层相对路径**直穿 src/state.ts** 消费（绕过包导出面）；头注 :49-51 以「goal/subagent-workflow 直接 import 避免复制差集逻辑」为整块背书，并声称 PENDING_LIFECYCLE 有消费方「base-tool-enhance 启动时的 peer 版本检查」——实查 bte src 零引用，注释失实。
- **F4（赌注被自家约束封死）**：session 档机器的留存理由是「待未来 session 档类型」——但 state.ts:22-23 自想象的未来类型 scheduler 被明示走 process 档，且 C-proc-13 ③ 已登记「pending 注册表后台类型恒 process 档——禁回翻 session 档（1h TTL 与跨 session 补注销会静默清除长任务注册=守卫失明，2026-09-08 事故放大器）」。未来任何 session 档类型的引入都要先推翻这条约束——那将是一次显式设计决策，届时按当时需求重建机器即可，不需要现在养一套无消费者的机器。

### 3.3 根因

**两类复杂度同根：为不存在的需求维护机制。** W4 翻档是 2026-09-08 事故的正确修复，但翻档后留下了两具「尸体」：session 档机器（原 TTL/清理机制的壳）与内存 registry（原分档判定所需的物化层）。前者以「机制本体保留待未来类型」的名义豁免了删除；后者失去了存在理由——registry 最初承载 register/unregister 的去重与分档判定，翻档后判定退化为「无 TTL、跨 session 续存」的恒等语义，去重与差集计算 `countActiveFromEntries` 对 entries 单趟扫描即可完成（本包自己的 goal 消费方每 turn 都在这么做，`agent-end.ts:342`），唯一还读 registry 的只剩本包查询工具。双状态不是被设计出来的必要物化，而是翻档后没有跟着做减法的残留。

## 4. 物理数据流（现状 vs 终态）

> **entries 差集** = session JSONL 中 `pending:register` entry 的 id 集合减去 `pending:unregister` entry 的 id 集合（按 id 全局唯一前提），即活跃任务集合。就是 §3.1 例子里的 `{bg-1}`。

现状（两份状态，黑体为分歧点）：

```
各运行方（core/bte/subagent-workflow）
   │ pi.events.emit("pending:register"/"pending:unregister")
   ▼
┌─ pending-notifications listener（index.ts:142-211）────────────────┐
│ 落盘前置判断：查**内存 registry**（register 查重 / unregister 查 active）│←─ 判断依据与落盘目标不同源
│   ├─ 通过 → pi.appendEntry ──→ session JSONL（entries，唯一持久层）  │
│   └─ 不通过 → 静默吞（bte 事故路径）                                │
│ 同时 → register()/unregister() 更新**内存 registry** ←── 第二份状态   │
└────────────────────────────────────────────────────────────────┘
读取方分裂：
  goal / pi-host / bte 对账 ──→ 读 entries 差集（countActiveFromEntries）
  pending_notifications 工具 ──→ 读**内存 registry**（getActive + sessionId 过滤）
  session_start ──→ rebuildFromEntries 从 entries 重建 registry（index.ts:214-236）
```

终态（单一状态源，写侧判断与落盘同源）：

```
各运行方 ──emit──▶ pending-notifications listener（写侧，保留）
                     │ 落盘前置判断：对 getEntries() 现算（hasPendingId / isPendingActive）
                     ▼
                 pi.appendEntry ──▶ session JSONL（entries，唯一持久层 + 唯一状态源）
                                        │（appendEntry 同步入账：_appendEntry 同步 push）
读取方统一（全部 entries 现算）：
  goal 守卫 / pi-host 后代判定 / bte 对账 ──→ countActiveFromEntries（不变）
  pending_notifications 工具 ──→ countActiveFromEntries(getEntries(), {currentSessionId})（改）
  session_start ──→ 仅设置 currentSessionId（rebuild/flush 删除）
```

关键论断：**listener 落盘后、同一 listener 内及之后的任何 getEntries() 立即可见该 entry**——pi 0.84.4 dist 实装为同步链：extension 侧 `pi.appendEntry`（agent-session.js:2022-2028）同步调 `sessionManager.appendCustomEntry` → `_appendEntry`（session-manager.js:756-760，同步 `fileEntries.push` + `_persist` 同步 appendFileSync）→ `getEntries()` 即读 `fileEntries`。这条同步性是现算方案成立的物理前提（✅ 已实读 dist 源码证实，非推理；实施期 V1 场景复核）。

---

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径

对 LLM 与各运行方，终态交互与 §3.1 逐字相同（事件 → 注册 → 查询 → 注销 → 归零）——**写侧协议与工具输出语义零变更**。变化全部在机制层：工具回答「1 pending operation(s)」时读的是 entries 差集而非内存态；bte 对账直接 appendEntry 的注销在同一份 entries 里，工具、goal、对账三方看到的结果**构造性一致**（同一份扫描），§3.1 的「尽力补 emit 同步内存视图」退化为纯日志性质（本包 listener 收到后再次落盘前置判断会发现已注销、跳过，不再产生重复 entry——现状会）。写侧去重的三条理论窗口边缘差异见 §6.1 边缘差异登记——主链路交互（本节轨迹）与现状不可区分。

### 5.2 失败路径（带恢复指引）

- **查询结果与任务实况不符**（任务已死但 count>0）：process 档语义下死亡窗口的注销依赖各运行方收尾——subagent/workflow 残留由 core 注册对账 sweep 在下个 session_start 补注销；bash 残留由 bte session_start 对账收口（registry 终态或 `kill(pid,0)` 判死即补注销，pending-reconcile.ts:119-126 实读；registry 条目缺失等罕见路径保守不动作——:112-117，静态虚报限损）。排查：读 session JSONL 的 `pending:register/unregister` entry 序列确认差集；无需本包侧动作。
- **listener 收到畸形事件**（缺 id/非对象）：parse 失败静默丢弃 + `XYZ_AGENT_DEBUG=1` 时写 `~/.pi/agent/logs/` debug 日志（现状行为保留）。恢复：无需——entry 未落盘，无脏状态可清理（这也是现算化的附带收益：不存在「内存已收、盘上没有」的半状态需要修复）。
- **appendEntry 抛错**（stale context）：静默忽略（现状 safeAppendEntry 语义保留）。与现状的差异：落盘失败时工具查询同样查不到该注册（entries 没有）——不再出现「工具显示活跃但 goal 守卫认为无事」的分裂；后果是丢失一条注册记录，与现状落盘失败丢 entry 等价，恢复动作同现状（重新派任务或忽略）。

## 6. 关键决策与权衡

**本章结论：4 个决策——registry 现算化（D1）、session 档机器连分档常量一起删（D2）、导出面收敛 14→5（D3）、注释漂移随删除消解 + 跨包悬空面自闭环回写（D4）。**

### 6.1 D1：查询与写侧判断的权威源（选定：entries 现算）

- **采用**：① `pending_notifications` 工具 execute 改为 `countActiveFromEntries(ctx.sessionManager.getEntries(), { currentSessionId })`（闭包 `currentSessionId` 为空串——session_start 未到的防御场景——时不传基准，保持现状「宁放行不误逐」口径）；② register listener 落盘前置判断改为 `hasPendingId(entries, id)`（entries 中已存在该 id 的 register entry——无论注销与否——则忽略，等价现状内存 `operations.has(id)` 语义）；③ unregister listener 落盘前置判断改为 `isPendingActive(entries, id)`（单趟扫描：该 id 有 register 且无任何 unregister 则 active，等价现状内存 `status === "active"` 语义）；④ 删 PendingRegistry/createRegistry/register/unregister/getActive/rebuildFromEntries 与 session_start rebuild；⑤ session_start handler 缩为设置 `currentSessionId` 一行；session_shutdown handler 整体删除（对现存类型本就是 no-op）。写侧事件 → appendEntry 的协议面与 entry 形态逐字段保留；去重语义与现状等价（三条边缘差异见下方登记，均为主链路不可区分的理论窗口）。
- **边缘差异登记（「语义等价」声明的组成部分，三条均为理论窗口）**：
  1. **跨 session unregister 落盘口径**：现状 rebuild 对 fork 继承残留「跳过不入 registry」（state.ts:317-329「跳过不补注销」），残留 id 的 unregister 事件按 unknown id 静默忽略；终态 `isPendingActive` 查全量 entries（含 fork 继承的 register），同 id 事件若可达会在当前 session 补落一条跨 session 注销 entry。差异窗口 = 跨 session 事件可达——pi per-session EventBus（session 替换重建全新 bus，本包 index.ts:90-98 实装注释）使该窗口在真实链路不可达，差异理论性；方向良性（若未来可达，补落使差集更真实），与 W4「跨 session 落盘收口归 core sweep / bte 对账通道」的分工以此边界说明消解。V4a 场景以「子 session JSONL 无本包新写 entry」断言钉住该口径。
  2. **id 复用场景的 register 去重**：同 id register→unregister→register——现状进程内同样忽略（registry 保留 completed 条目，`operations.has(id)` 命中）；差异仅在重启后出现（rebuildFromEntries 差集只回填 active 项，completed 条目不入 registry → 现状放行第二次落盘且守卫不可见 = 盘上假数据）；终态 `hasPendingId`「无论注销与否」恒忽略。差异窗口 = 重启与 id 复用同时发生，id 全局唯一（时间戳+随机，state.ts:234-236 自注）使窗口纯理论；终态方向更优（少写噪音 entry、不产生守卫不可见的假数据）。
  3. **fork 残留同 id 的 register 去重口径**：现状 rebuild 对 fork 继承残留「跳过不入 registry」，同 id 的 register 事件若可达会放行落盘第二条 register entry 且入 registry 投影；终态 `hasPendingId` 查全量 entries（含 fork 继承的 register，无论其 sessionId），残留 id 的 register 事件恒忽略。差异窗口与边缘差异 1 同构（per-session EventBus 使跨 session 事件不可达），纯理论窗口；方向良性（终态少噪音写入）。V4a 断言（子 session JSONL 零本包新写）同时钉住该口径。（阶段 3 一致性审查补登）
- **被否**：
  - **方案 A（保留内存 registry，现状）**——双状态分歧已被 bte 事故证实为真实失败模式，且落盘失败窗口的分裂（工具见活跃、goal 守卫不见）在 registry 形态下无法根治，只能靠更多同步代码缓解——准则 8 的「by clever mechanism」反方向。若用它，§3.2 F2 的两个分歧窗口永续，bte 的「尽力补 emit」仪式（本可省的一跳）也要永久保留。
  - **方案 B（仅工具现算，写侧前置判断保留查内存）**——半吊子：读侧统一了但写侧判断仍依赖 registry，registry 机器（含 rebuild）删不掉，「第二份状态」还在，只是消费者从 2 处减到 1 处。若用它，§4 终态图里写侧仍是两份状态，D1 的根治效果减半而删除收益（约 -60 行）近乎不实现。
- **证据**：appendEntry 同步入账（dist agent-session.js:2022-2028 + session-manager.js:756-760 同步 push，✅ 实读）；goal 每 turn 对同一 `getEntries()` 全量差集先例（agent-end.ts:202,342——O(n) 扫描无热点问题）；bte 事故记录（pending-reconcile.ts:10-16）；`getActive` 包外零导入、`countActiveFromEntries` 消费方全走 entries（实跑 rg 证实）。
- **效果**：目标 1（单一权威源，构造性一致）、目标 2（主链路零回归——写侧契约与工具输出不变）；§5.1/§5.2 成立。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 现算（选） | 单一状态源；工具/goal/bte/对账四方同原语；删约 137 行物化层 + 2 个 listener 内机器 | 中：state.ts 删五件套 + 2 个小 helper 新增 + index.ts 三处改写 + 测试改写（含 conformance 连带） | 工具查询 O(1)→O(n)（见下方已接受代价 1）；写侧判断每次事件一次全扫（事件频率 = 任务生命周期事件，低频） | ✅ |
| A 保留 registry | 双状态持续缴税；bte 事故模式可复发 | 零 | F2 分歧窗口永续 | ❌ |
| B 仅工具现算 | 读侧统一、写侧仍两份 | 中（与现算几乎相同的测试改写面） | registry 机器残留，减法做一半 | ❌ |

**已接受代价（四要素量化）**：
1. **查询与写侧判断从 O(1) 变 O(n)**——量级：n = session entries 总数（长 session 数千至万级），JS 单趟扫描亚毫秒级；触发频率：LLM 低频调工具 + 任务生命周期事件（每次注册/注销各一次全扫），非 per-turn 热路径（goal 每 turn 全扫是既有先例）；恢复路径：无正确性影响，若未来实测有感知可加尾部增量索引（记 backlog，本次不做——准则 8 先减后加）；重审触发：工具调用实测 P95 超 10ms 或 entries 达十万级；显式判定：可接受。
2. **写侧判断读 entries 的时序假设**——依赖「appendEntry 同步入账」（§4 关键论断，✅ dist 实读）；恢复路径：若实施期 CLI 实测推翻同步性（源码证据被证伪的概率极低），D1 重审回退方案 A；重审触发：V1 验收场景出现查询计数滞后；显式判定：可接受（有源码级证据 + 验收门把关）。

### 6.2 D2：session 档死机器处置（选定：整体删除，含 PENDING_LIFECYCLE 常量——推翻 W4「刻意留存」登记）

- **采用**：删除 PENDING_TTL_MS、isExpiredEntry、expiredToFlush/RebuildResult、normalizeRegisterEntry 的 TTL 回填分支、session_start 补 flush 循环、session_shutdown handler、3 个「断言死代码是死」的测试用例；**并裁决比审计清单多删一项**：`PENDING_LIFECYCLE` 分档常量与其驱动的全部运行时分支（normalizeRegisterEntry 的 expiresAt 计算、PendingEntry.expiresAt 字段、写入侧 expiresAt 计算与条件展开）。删除后 PendingEntry 收敛为 `{id, type, name, status, registeredAt, sessionId}`，写入侧无条件省略 expiresAt 键——历史 session 文件中翻档前遗留的带 expiresAt 的 register entry 读取侧不再读该键，无需迁移（差集语义只读 id/sessionId/type/name/registeredAt）。
- **被否（推翻的登记）**：W4 交付时的处置是「机制本体保留（registry 通用能力，session 档暂无消费类型，留存待未来类型）」——登记实体为 state.ts:35-38、:92-95、:277-285 与 index.ts:238-245 的四段「勿删/勿误认」注释及 impl-plan（`docs/design/chat-domain-v1x-liveness-governance.impl-plan.md` §2 W4 单元）交付项「session 档死代码注释处置」。推翻理由：① 留存前提「未来 session 档类型」已被 C-proc-13 ③ 封死（F4）——真出现时必先推翻该约束，那是显式设计决策，届时按当时需求重建，现在养机器是纯负债；② 留存的维护税已实际发生（4 处防误读注释 + 3 个固化缺陷的测试用例 + bte 注释外溢引用）；③ git 历史可完整找回。
- **PENDING_LIFECYCLE 多删的理由**：三类型全 process 档后它是恒等映射（Record 全 process），运行时读方随机器删除后包外零生产消费（头注声称的 bte peer 版本检查实查不存在）；分档概念的存在前提（两档并存）已消失，「这些类型是 process 档」的知识由行为本身（无 TTL 清理/跨 session 续存=代码自然状态）+ `countActiveFromEntries`「刻意不校验 expiresAt」测试 + C-proc-13 ③ 承载，不需要一个无读者的常量复述。删除后「回翻 session 档」在代码上无落点，约束语义反而更硬。C-proc-13 ③ 的措辞锚定的是生命周期行为（「1h TTL 与跨 session 补注销会静默清除」的机理），不是该常量，语义不受删除影响。
- **证据**：`rg -n "PENDING_TTL_MS" -g '!**/pending-notifications/**'` 源码/测试面仅 conformance 测试（registry-fork-filter.test.ts:32,:63——E6 同批改写）；**docs/design 另有 4 文件 11 行符号引用**（chat-domain-v1x-liveness-governance.md :102/:126/:267/:270/:346、其 impl-plan :41、base-tool-enhance.md :175/:191/:326/:328、pi-session-start-handler-idempotency-audit.md :21）——属 C-proc-10 悬空引用，E9 同批回写（v1 证据句「仅 conformance 测试」失实，第 1 轮审查修正）；`rg "PENDING_LIFECYCLE"` 包外生产代码零命中（conformance 测试 :31,:74 为翻档事实断言——E6 随常量删除；docs 引用同入 E9 清单）；isExpiredEntry 唯一调用点 :332 为恒 false 死路径（实读）。
- **效果**：目标 3；§3.2 F1 消除；§5.2 的失败路径不再有「看似在清理实则永远不走」的误导分支。

### 6.3 D3：导出面收敛（选定：14 → 5）

- **采用**：`src/index.ts` 导出块收敛为 `countActiveFromEntries` + 其公开签名所需类型 `CountActiveOptions`/`CountActiveResult`/`PendingEntry`/`PendingType`（PendingType 因 `CountActiveOptions.types` 引用而保留）。`PendingStatus` 保留在 state.ts 内部（unregister entry 落盘契约的 status 字段类型 + mapReasonToStatus 返回值），不再 re-export。
- **被否**：保留 14 导出「方便未来消费方」——6 类型包外零引用、5 函数包外仅相对路径直穿（不经导出面），按想象消费者扩导出面是 speculative generality（准则 8 减法优先）。
- **证据**：`rg "from \"@zhushanwen/pi-pending-notifications\""` 生产命中仅 2 文件且均只 import countActiveFromEntries（实跑）；conformance 测试 import 的是 `.../src/state.ts` 相对路径，不经包导出面。
- **效果**：目标 4；跨包语义耦合面 13 → 1（保留面 = countActiveFromEntries + 4 个签名类型）。

### 6.4 D4：注释漂移处置（选定：包内随删除消解 + 跨包悬空面自闭环回写——v1「移交 13 号」方案被否）

- **采用**：① `index.ts` 头注两段随删除同批重写：:49-51 消费方声明（声称 PENDING_LIFECYCLE 有 bte peer 消费方——实查失实）与 :19-27 entry 契约段（expiresAt/flush 路径描述随 D2 失效）；② bte 侧 `pending-reconcile.ts:115`「pending 自身 TTL」漂移注释由**本设计同批修正**（E8，一处注释行）；③ 全仓文档面悬空引用（被删符号的 docs/design 引用共 4 文件 11 行，清单见 E9；bte.md :192 的「读取侧回填」行为断言失实非符号悬空、不在字面量扫描覆盖内，由 E9 一并点名列示）由 E9 同批按 C-proc-10 回写；④ `check-doc-symbol-drift.mjs` DOC_MODULE_MAP 补登记本组映射（E10），使 `PENDING_*` 族符号的后续悬空可机检。⑤ **跨设计协调约束（登记处，13 号文档不在本设计范围、不予代改）**：13 号设计（`ext-simplify-13-base-tool-enhance-protocol.md`）D5 计划在同文件（pending-reconcile.ts :135-141）补注释，内容以「pending 内存 registry 仅在其自身 session_start rebuild 后非空」为前提——本设计 D1 删除 registry/rebuild 后该前提失效（emit 到达时 listener 对 entries 现算发现已注销、恒跳过，不再是「窄窗口」）。13 号实施其 D5 时注释须按本文档终态改写（不得引用已删除的 registry/rebuild 机制）；本设计落地后实施 13 号时须回查该文件未引入引用已删机制的新注释。该约束已同步登记到 13 号实施批必经的批级锚点 `docs/design/ext-simplify-index.md` 13 号行（第 2 轮补登，落地于设计交付而非实施期——约束语义不依赖本设计代码落地），消除「约束只对读本文档者可见」的单向性。
- **被否**：
  - **v1 方案「跨包移交 ext-simplify-13」**——击穿反例（第 1 轮影响面审）：13 号设计无接收条目（其 E5 执行项不含 :115 修正），单向移交 = 静默漏修；且其 D5 计划的新注释以 registry/rebuild 存在为前提，与本设计删 registry 直接冲突——移交不仅不闭环，还把注释前提冲突留给对方设计的实施期。移交方案连同该反例记入被否谱系。
  - **v1 被否理由的修正登记**：v1 以「跨包一行改动也要走对方设计的审查面（边界纪律）」为由移交。修正：边界纪律的目的是避免 diff 混入他人设计未审查的改动；但在接收方无登记时「移交」不构成闭环，跨设计协调失败的真实成本（悬空引用静默入库 + 注释前提冲突）高于一处注释行与文档回写的跨包成本；且 docs/design 悬空引用回写是 C-proc-10 MANDATORY 纪律，不可寄希望于未承诺的他人批次。
- **证据**：`rg "PENDING_LIFECYCLE|pi-pending-notifications" base-tool-enhance/src`（排除测试）零命中（实跑）；bte 对账实现实读（pending-reconcile.ts 全文，本设计 V3 重演时复核）；13 号 D5 前提冲突为影响面审实读结论；`check-doc-symbol-drift.mjs` 映射表实读（10 条目无一覆盖本组，守卫候选集只抓蛇形大写与 get 前缀驼峰）。
- **效果**：目标 5 完整闭环——包内头注、跨包代码注释、文档面、守卫能力四处无悬空；13 号协调约束双登记（本文档采用⑤ + 批级入口 `ext-simplify-index.md` 13 号行注记，第 2 轮补登），双向实施顺序均有回查锚点——13 号实施批从其必经的批级索引即可见该约束，不依赖先读本文档。

### 6.5 探针清单与审计修正记录

**探针**（运行时行为断言的验证状态）：

| ID | 验证的行为 | 状态与探针 | 失败时的降级路径 |
|---|---|---|---|
| P1 | appendEntry 同步入账：listener 落盘后 getEntries() 立即可见（现算方案物理前提） | ✅ 已实读 pi 0.84.4 dist：agent-session.js:2022-2028 同步调 appendCustomEntry → _appendEntry 同步 push（session-manager.js:756-760）；实施期 V1 场景复核 | 若实测出现可见性滞后（源码证据被推翻）：D1 重审回退方案 A（保留 registry），其余决策不受影响 |
| P2 | 写侧前置判断现算与内存语义等价：重复 register 不二次落盘（单测层——真实 CLI 无构造入口，见 §8.2 依赖说明）、已注销 id 的 unregister 不落盘（单测 + V4b 真实场景） | ⛔ 实施期门：本包单测等价改写（U6/U8 场景 + 新增「bte 对账已落盘后收尾 emit 不重复落盘」用例）+ V4b 真实场景（对账尽力补 emit 构成的重复 unregister 输入） | 失败 → 核对 hasPendingId/isPendingActive 扫描语义与内存五件套的差异点，修 helper 而非回退方案 |
| P3 | 跨 session 残留过滤：fork 继承的父级注册不进工具投影（currentSessionId 基准） | ⛔ 实施期门：conformance 测试改写后语义覆盖 + V4a CLI fork 场景实测 | 失败 → 核对 filterActiveRegisters 的基准传参链（工具 execute → getSessionId()），基准断链时优先修传参 |

**审计修正记录**（20260911 审计快照 vs 20260911 实读，以实读为准）：
1. 审计称「impl-plan §5 有刻意留存登记」——实读 impl-plan §5 偏差登记表（17 条）**无**死代码留存条目；留存登记实体是 §2 W4 单元交付项「session 档死代码注释处置」（:41）+ 源码四段注释。本设计 D2 的推翻对象按实读定位。
2. 审计称导出面收敛「conformance 测试保持相对路径导入不受影响」——仅对 D3 单独成立；**D1/D2 删除 createRegistry/rebuildFromEntries/PENDING_TTL_MS 会打断 registry-fork-filter.test.ts 的 import（:31-35）与两个 describe（:72-90、:133-148）**，必须同批改写（E6），审计未列此连带面。
3. 审计未提 C-proc-13 ③ 措辞含「registry rebuild+工具投影」读侧枚举——rebuild 删除后 constraints.json 需同批回写（E7），否则 SSOT 引用已删机制。
4. 行号机械偏移：isExpiredEntry 审计 287-303 → 实读 287-300；session_shutdown 审计 246-259 → 实读 246-261；TTL 回填审计 371-381 → 实读 372-380。不影响语义。

---

## 7. 实现机制（把终态落到代码层）

**本章结论：改动收敛在 2 个本包源文件 + 2 个测试文件 + 1 个 SSOT 文档（净删约 220 行，本包源码 739 行的约 30%；新增 ≤ 30 行——两个扫描 helper + session_start 缩减），外加删除连带面：bte 一处注释行（E8）、docs/design 4 文件悬空引用/行为断言失实回写（E9）、守卫脚本映射登记（E10）。**

执行项表格（编号 / 位置 / 改动内容 / 性质）：

| # | 位置 | 改动内容 | 性质 |
|---|---|---|---|
| E1 | `src/state.ts` | 删 PENDING_TTL_MS（:96）、isExpiredEntry（:287-300）、RebuildResult/expiredToFlush（:222-227,:311）、rebuildFromEntries（:302-342）、回填分支（:372-380）、PENDING_LIFECYCLE（:40-44）及 PendingEntry.expiresAt 字段（:62）；normalizeRegisterEntry 简化（expiresAt 恒不产）；新增内部 helper `hasPendingId(entries,id)` 与 `isPendingActive(entries,id)`（单趟扫描，复用 scanPendingEntries 或同构实现）；文件职责头注（:1-15）随删除同步重写 | D2+D1 直接执行 |
| E2 | `src/state.ts` | 删 PendingRegistry/createRegistry/register/unregister/getActive（:99-137） | D1 直接执行 |
| E3 | `src/index.ts` | 两个 listener 落盘前置判断改 hasPendingId/isPendingActive 现算（:166,:198）；工具 execute 改 countActiveFromEntries 现算（:277-279）；session_start 缩为设 currentSessionId（:214-236）；session_shutdown handler 删除（:246-261）；写入侧 expiresAt 计算与条件展开删除（:153-161,:172-181） | D1+D2 直接执行 |
| E4 | `src/index.ts` | 导出块收敛 14→5（:52-67）+ 头注重写（:49-51 删失实的 bte peer 消费方声明；:19-27 entry 契约段的 expiresAt/flush 描述随 D2 重写） | D3+D4 直接执行 |
| E5 | `src/__tests__/pending-notifications.test.ts` | 删「断言死代码是死」三用例（:207-233,:395-405）与 rebuild/registry/shutdown 相关 describe（:195-272,:287-321,:394-412）；存余用例改写到 countActiveFromEntries 等价断言；runTool 的 mock ctx 与 appendEntryMock 联动（appendEntry 同步 push 进共享 entries 数组，模拟真实 SDK 同步入账）；新增「对账已落盘后收尾 emit 不重复落盘」用例 | D1/D2 直接执行 |
| E6 | `packages/subagent-core/.../conformance/registry-fork-filter.test.ts` | import 改写：PENDING_TTL_MS → 本地字面量常量（`10 * 3_600_000 + 1`，注释保留「远超旧 1h TTL」语义）；「PENDING_LIFECYCLE 翻档断言」describe 删除（历史使命完成）；「翻档后无 TTL 清理」「registry rebuild 投影」两 describe 改写为 countActiveFromEntries 等价断言（三类型超 TTL 仍 active / 跨 session 残留不进差集） | 审计修正 #2 连带，直接执行 |
| E7 | `docs/constraints.json` C-proc-13 ③ | 读侧消费枚举「countActiveFromEntries/subagent-workflow 后代判定/registry rebuild+工具投影/goal 守卫口径」→「…/pending_notifications 工具投影（entries 现算）/goal 守卫口径」；「禁回翻 session 档」机理表述保留；跑 `node scripts/render-constraints.mjs` 重新生成 md；顺带核实 `extension-dependencies.json` 对本包的 reason 描述（「pending-notifications 消费该事件并向用户发送完成通知」与现状不符——完成通知已由 subagent-workflow bg-notify-render 承担），失实则同批修正 | 审计修正 #3，C-proc-10 直接执行 |
| E8 | bte `src/background/pending-reconcile.ts:115` | 注释修正：删「pending 自身 TTL 之外的」措辞（引用本设计删除的 TTL 机器），改为如实口径——pending-notifications 已无任何 TTL 清理，差集残留由 next-session 对账重查收口（注释落点在 bte 文件内，措辞不得写「本包」以免被读成 base-tool-enhance） | D4 自闭环执行（v1 移交方案被否，见 §6.4 被否谱系） |
| E9 | docs/design 4 文件悬空引用 + 行为断言失实回写 | chat-domain-v1x-liveness-governance.md :102/:126/:267/:270/:346 与其 impl-plan :41（:270「机制本体保留」处置登记按 D2 推翻后口径更新；历史事故/决策段按守卫「反引号=现行符号」书写约定去反引号或标注已删除）；base-tool-enhance.md :175(D16)/:191/:192/:326/:328（:175/:191/:326/:328 为 PENDING_LIFECYCLE/PENDING_TTL_MS 引用改删除后口径，D16 标注分档常量已随本设计删除、process 档语义成为无条件代码自然状态；**:192「pending 读取侧归一化对缺失 expiresAt 回填 1h TTL」行为断言**随 E1 回填分支删除一并更新——该行位于「✅ 已核实」证据表、是 13 号设计的事实地基（13 号以 base-tool-enhance.md 为设计契约源），不含被删符号字面量故逃过符号扫描，失实前提会被 13 号后续实施者继承）；pi-session-start-handler-idempotency-audit.md :21（pending-notifications 行按 E3 终态重写：handler 缩为一行后无写操作，豁免依据由「rebuild 差集天然去重」改为「handler 无写操作，双派发天然无害」）。docs/design 外的 docs/ 目录第 2 轮修复时点经全部被删符号扫描仅 `docs/todo/subagent-workflow-sidebar-sync-plan-review-r9.md:5` 一处命中（历史审查报告快照，不回写，豁免登记见 §9.3；实施期按 §9.3 口径重扫） | C-proc-10 纪律（主审 MF-3 + 影响审 MF-2） |
| E10 | `scripts/check-doc-symbol-drift.mjs` | DOC_MODULE_MAP 补登记本组映射（chat-domain 两文档 → `extensions/universal/pending-notifications/src`），使 `PENDING_*` 族符号的后续悬空可机检。边界如实登记：守卫候选集只抓蛇形大写与 get 前缀驼峰，`rebuildFromEntries` 类普通驼峰不在候选集——此类悬空靠 E9 一次性清扫 + C-proc-10 流程纪律；本设计文档自身不登记（删除性设计以引用被删符号为正文职责，登记即恒红）。清扫/回护不对称（第 2 轮登记）：E9 清扫 4 文件中仅 chat-domain 两文档入映射获机检回护（2/4），base-tool-enhance.md 未入映射、其 `PENDING_*` 悬空不机检——扩映射经设计期实测受阻：登记后实跑守卫即红（:93 `getAgentDir`、:196/:333 `getEntries` 为 pi SDK 符号，不在本仓源码导出表），需新增外部符号白名单机制才能绿，该维护税与「E9 清扫后 PENDING_* 引用归零 + C-proc-10 纪律兜底」的残余风险不匹配，裁决不做 | 影响审 MF-2 兜底机制修正 |

错误规格不变量：listener 的 parse 失败静默丢弃、safeAppendEntry 的 stale-context 静默忽略、countActiveFromEntries 对 null/畸形 entry 的容错（S-10）全部保留；本包无新增失败路径（删除性改动）。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中-大」（删机制 + 查询路径实现变化但语义不变），用 5 个真实场景验收，每个回溯 §2 目标；单测与 typecheck 仅作回归辅助，不计入验收。**

### 8.1 改动规模

机制删除 + 查询/写侧判断实现路径重排（对外语义零变更）+ 跨包测试连带——属「行为面改动」级，多场景验收；回归兜底 = `pnpm extensions:typecheck && extensions:lint && extensions:test` 三连 + `pnpm --filter @zhushanwen/subagent-core test`（conformance 用例）。

### 8.2 验收场景

按 AGENTS.md 纪律在本地 pi CLI 实测（非 xyz-agent 桌面）：`pi --mode json --session-dir <tmp> --extension <本包路径> --extension <伴 ext 路径> --model <真实模型> --approve` + stdin JSONL。

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | 注册 → 查询 → 注销 → 归零（主链路 + P1 复核） | 目标 1、2 | 装本包 + subagent-workflow（真实事件源）：prompt 派一个后台 subagent 任务 → 任务运行中让 LLM 调 `pending_notifications {action:"list"}` → 等任务完成 → 再调 `{action:"count"}` | list 含该任务（type=subagent、name/id 正确）；count 从 1 变 0；session JSONL 中 register 与 unregister entry 各一条、无重复 |
| V2 | bte 后台 bash 投影一致性 + 伴生收口链（事故场景根治实证） | 目标 1 | 加装 base-tool-enhance，bare pi CLI 三段：① 投影主链路：`bash` 后台跑 `sleep 60` → 运行中查 count/list（含 bt- 任务）→ bash_output 确认完成 → 再查 count；② 进程内完成后的重启续读：`pi --resume` 同 session 重启再查 count；③ 伴生收口：另派一个仍在运行的后台任务（`sleep 300`）→ 对 pi 进程发 SIGTERM 优雅退出（exit-guard kill-tree 收殓全部后台任务）→ `pi --resume` 重启 → 立即查 count，并摘录 session JSONL 的 pending entry 序列 | ① 运行中 count≥1 含 bt- id；完成后归零；② 重启后仍为 0（entries 差集直读，不依赖已删除的 rebuild）；③ 重启后 count=0，且该 id 在 JSONL 中**恰一条** unregister entry——收殓期尽力 emit 落盘与 session_start 对账补落两条权威路径互斥（emit 先落盘则对账见差集已平即跳过），终态现算下对账后的尽力 emit 不产生第二条（现状 registry 形态的 F2② 窗口会产生重复） |
| V3 | 强杀续存与孤儿收口（process 档语义，bare pi CLI 前提） | 目标 2 | bte bash 后台长任务 `sleep 300` 运行中 → `kill -9` pi 进程（SIGKILL，exit-guard 不触发；bare pi CLI 无 runtime 收殓器，孤儿 bash 存活）→ `pi --resume` 重启 → 立即查 count → 等孤儿自然完成（同进程内等待）→ 再查 count → 再次 `pi --resume` → 再查 count | ① 重启后立即 count 仍为 1（无 TTL 清除；对账对「running+pid 活」保守跳过——pending-reconcile.ts:119-122 实读）；② 孤儿完成后**同进程内** count 仍为 1（本包无 TTL/无虚假清理；poller 只驱动本进程任务单例表，bash 同进程无收殓通道 = §5.2 既有显式边界，此处实证不回归）；③ 第二次重启后 count 归 0（孤儿死后 pid 判死，下一 session_start 对账补注销收口——pending-reconcile.ts 头注「下一 session_start 兜底」幂等语义） |
| V4 | 负面行为两连（不该发生的不发生） | 目标 2 | a) fork 过滤：父 session 有活跃注册时 fork 子 session → 子 session 查 count/list 并摘录子 session JSONL；b) 已注销 id 的重复 unregister：以 V2③/V3③ 对账链为真实触发源（对账 appendEntry 之后的尽力补 emit 天然构成「对已注销 id 再发 unregister」的输入，无需人工重放） | a) 子 session 计数**不含**父 session 的注册（currentSessionId 过滤生效，P3），且子 session JSONL 无本包新写 entry（fork 残留不补注销——落盘收口归 core sweep / bte 对账通道）；b) 不落盘第二条 unregister entry（现算前置判断发现差集已平、跳过） |
| V5 | 邻居系统不变量（goal 守卫 + 落盘面无污染） | 目标 2、5 | **改动前基线先行**：在改动前代码上跑同场景（真实 goal + 派后台任务），留存 session JSONL 的 goal:log entry 序列、defer/等待通知出现次数与文案、pending 查询输出作为比对基线；改动落地后同场景重跑 | goal 等待通知文案与触发时机与基线**逐项一致**（比对项：goal:log entry 序列、defer 通知次数与文案；countActiveFromEntries 签名未变，goal 零改动面）；JSONL 只含既有 `pending:register/unregister` 形态，无新 entry 类型、无写入堆积 |

依赖说明：V1-V5 均为真实 pi 运行时 + 真实模型 + 真实伴生 extension，无 mock；伴生收口链（exit-guard 收殓 / bte session_start 对账）在 bare pi CLI 真实链路验证，不经 xyz-agent 桌面中转层。原「同 id 重复 register」验收行移除（第 1 轮审查修正）：真实 CLI 下无构造入口——id 含时间戳+随机全局唯一（state.ts:234-236 自注），「构造二次派发」产生的是新 id；EventBus 无事件重放入口；手改 JSONL 后 resume 验证的是读侧 filterActiveRegisters 的 seen 去重，验不到写侧 hasPendingId 落盘前置判断。该负面行为降级为单测层覆盖（E5 的 U6 等价改写「重复 register 不二次落盘」用例 + P2 探针），验收表不保留不可执行场景。

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 包内原子改（E1-E5） | state.ts 收敛 + index.ts 现算化 + 本包测试改写，单 commit（state 与 index 接口联动 + 测试同批，避免红窗口）；三连绿 | §5 终态的包内部分；V1/V3/V4 可开始验证 |
| M2 连带面（E6-E10） | conformance 测试改写 + constraints.json 回写 + render-constraints（E6+E7，单 commit）；bte 注释行修正 + docs/design 悬空引用/行为断言失实回写 + 守卫映射登记（E8-E10，单 commit——E9 回写口径以 M1 删除后代码为基准，须排在 M1 之后） | 跨包测试绿 + SSOT/文档面/守卫能力一致；V2/V5 验证 |
| M3 验收 | V1-V5 真实场景跑通，产物（JSONL 摘录 + 查询输出）贴实施 PR | §8 通过 = 设计就绪落地 |

M2 与 M1 可同 PR 分 commit。13 号协调约束（§6.4 采用⑤，双登记：本文档 + `ext-simplify-index.md` 13 号行注记）：13 号实施批若先于本设计，其 D5 注释须按本文档终态口径书写；本设计落地后实施 13 号时，须回查 pending-reconcile.ts 未引入引用 registry/rebuild 的新注释。包版本 **minor bump（0.6.0 → 0.7.0）**：导出面收窄属破坏性变更面，0.x 阶段破坏性变更按 semver 惯例走 minor——与本仓 changeset 先例一致（本包 0.5.0 process 档引入、0.6.0 W4 翻档均记 Minor Changes，patch 仅用于无契约面变化的维护发布）；workspace 内消费方零改动（生产 import 仅 countActiveFromEntries 且保留），minor 是对 monorepo 外潜在消费者的诚实信号（v1 的 patch 裁决与自身「破坏性变更面」定性矛盾，第 1 轮审查修正）。

### 9.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| u1 state.ts 收敛 | E1+E2 | 纯函数层先行定形（helper 签名是 u2 的依赖）；typecheck 可独立验 |
| u2 index.ts 现算化 | E3+E4 | 依赖 u1 的 helper；写侧/读侧/导出面同文件原子改 |
| u3 本包测试改写 | E5 | 与 u2 同 commit 才能保绿（断言对象从 registry 换成 entries 差集）；单独拆会留红窗口 |
| u4 跨包连带 + SSOT + 文档回写 | E6+E7+E8+E9+E10 | 独立 commit 便于 review 跨包测试语义等价性、SSOT 措辞与回写内容；E6/E7/E8 与 M1 无序依赖（合入序下 M1 与 E6 两 commit 之间 subagent-core conformance 暂红——E5 的同 commit 保绿不跨包，PR squash 合并后无感），E9/E10 须在 M1 之后（回写口径以删除后代码为基准，先行会产生反向漂移） |
| u5 真实场景验收 | V1-V5 | M3 门；依赖 u1-u4 全部落地 |

### 9.3 待验证检查点（诚实标注）

- P1 的 CLI 层复核（V1）：同步性已有 dist 源码证据，纪律上仍以实跑为准；失败降级 = D1 重审。
- 文档悬空引用清扫**不依赖守卫兜底**（v1 此处押注的「pre-commit 按路径触发」失实，第 1 轮审查修正）：实读 `check-doc-symbol-drift.mjs`，DOC_MODULE_MAP 10 条目无一覆盖本组文档/源码路径，pre-commit 对本组永不触发；且守卫候选集只抓蛇形大写与 get 前缀驼峰，`rebuildFromEntries` 类普通驼峰本就不在候选集。清扫因此是显式执行项而非「若有则处理」，第 2 轮起口径显式化为：**rg 全部被删符号（PENDING_TTL_MS / PENDING_LIFECYCLE / rebuildFromEntries / createRegistry / isExpiredEntry / expiredToFlush / getActive / PendingRegistry；register/unregister 词面过通用不入枚举）× docs/ 全目录**，非仅「三个符号 × docs/design」（v2 口径存在符号集合盲区与目录范围盲区，第 2 轮修正）。扫描噪音判别：异系统同名符号（pi.getActiveTools / getActiveSummaries / statusline createRegistry / bte task-store getActiveTasks 等）按符号所属系统排除；行为描述级失实（不含被删符号字面量，如 bte.md :192）不在字面量扫描覆盖内，随 E9 清单点名列示。显式豁免清单：历史审查报告/快照类文档不回写——已知一例 `docs/todo/subagent-workflow-sidebar-sync-plan-review-r9.md:5`（expiredToFlush 出现在 R9 收敛轮审查报告的「本轮新增 read」实读记录中，记录的是审查时点源码事实，回写 = 篡改历史审查档案；其审查对象 sidebar-sync plan/design 文档经全量扫描不含任何被删符号，且该审查已收敛、执行窗口已过）。E9（docs/design 4 文件逐处回写，清单见 §7 执行项表）+ E10（DOC_MODULE_MAP 映射登记，使 `PENDING_*` 族后续悬空可机检）。
- V2③/V3③ 中 bte 对账在「本包 registry 已删」后的行为：bte 对账不依赖本包任何符号（直接 appendEntry，pending-reconcile.ts:126 实读），理论零影响；实施期以 V2③/V3③ 重启后查询实证。
- PendingEntry.expiresAt 删除与导出面收窄的 npm 外部消费影响（四要素）：**量级**——workspace 内零改动（生产 import 仅 countActiveFromEntries 两处且保留，实跑 rg 证实）；pi extension 由 pi 运行时加载、非 library 依赖形态，monorepo 外 library 级消费者无从证实、也无已知存在（已发布 14 个具名导出中 13 个本就零已知消费）；**恢复路径**——出现外部消费者报告时按 git tag（v0.6.0）回退或发过渡 re-export 版本；**重审触发**——npm 发布后收到指向被删符号的 issue/反馈；**显式判定**——接受，版本信号用 minor（§9.1，v1 的 patch 裁决作废）。

---

## 附录：变更历史

- v1（2026-09-11）：初稿。覆盖审计候选 4（C4-a 死代码区 Strong / C4-b registry 现算化 contested→裁决现算）+ 导出面收敛 + PENDING_LIFECYCLE 注释失实；两项审计修正（conformance 连带面、C-proc-13 回写项）+ 一项登记定位修正（impl-plan §5 → §2 W4 交付项）。
- v2（2026-09-11）：第 1 轮审查修复（逐条对照见文末修订记录）：V3 重写为强杀续存三步场景 + V2 增补伴生收口段、V4a 降级单测层、docs/design 悬空引用面补全为 4 文件 10 处并自闭环（E8-E10）、D4 推翻移交方案登记被否谱系 + 13 号协调约束、§5.2 bash 收口通道口径修正、npm 代价四要素补全 + 版本裁决改 minor、V5 增基线采集、D1 边缘差异登记两条、导出面计数修正（14 具名 + default）。
- v3（2026-09-11）：第 2 轮审查修复（纯 suggestion 轮，两报告均 0 must-fix；逐条对照见文末修订记录第 2 轮）：E9 清单补 base-tool-enhance.md:192 行为断言行、§9.3 清扫口径显式化（全部被删符号 × docs/ 全目录 + 历史快照豁免清单，R9 报告 :5 豁免登记）、13 号协调约束双登记（ext-simplify-index.md 13 号行注记 + §6.4/§9.1 校准）、E10 登记清扫/回护不对称与扩映射实测受阻证据、E8 措辞指代修正、docs/design 引用计数按行口径修正（11 行）、v1 日期笔误修正。
- v4（2026-09-12）：实施后阶段 3 一致性审查修复（dev-flow）：§6.1 边缘差异登记补第三条（fork 残留同 id 的 register 去重口径——终态 hasPendingId 全量扫描使残留 id register 恒忽略，与现状 rebuild 跳过语义存在同构理论窗口，per-session EventBus 不可达、方向良性；§2 目标 2 与 :149/:163 计数「两条」随之校准为「三条」）。终态行为零变更，纯登记完备性。

## 修订记录

### 第 1 轮（2026-09-11）

对照报告：主审 `ext-simplify-12-review.md`（3 must-fix + 1 suggestion）、影响面审 `ext-simplify-12-review-impact.md`（2 must-fix + 2 suggestion）。全修，无未修项。

**MF-主审-1（V3 场景通过标准在任一真实执行形态下矛盾）→ 实读两种退出形态后重写 V3，V2 增补伴生收口段。**
修法：动笔前实读 bte 三文件——正常退出（SIGTERM/exit）：exit-guard 遍历单例表 kill-tree 杀全部后台 bash 任务 + registry 写终态 + 尽力 emit（process-exit-guard.ts:62-101，不 appendEntry——pi API 已不可用），重启后 session_start 对账对差集未平条目补注销（pending-reconcile.ts:99-150）；SIGKILL：exit-guard 不触发，孤儿 bash 存活（bare pi CLI 无 runtime 收殓器），重启后对账对「running+pid 活」保守跳过（:119-122），孤儿死后由**下一次** session_start 对账收口（文件头注「下一 session_start 兜底」幂等语义）；poller 只驱动本进程单例表、不接管 registry 旧 running 条目（poller.ts:53-65）。据此 V3 重写为 kill -9 强杀形态（任务类型 = bte bash 后台、退出方式 = SIGKILL、bare CLI 前提均显式写明），通过标准改三步：①重启后 count 仍 1（续存 + 对账跳过）；②孤儿自然完成后同进程内 count 仍 1（无虚假清理，同进程无 bash 收殓通道 = 既有边界实证不回归）；③第二次重启后 count 归 0（对账兜底收口）。「自然完成后归零」不可达步骤删除；正常退出的伴生收口路径不丢失，移入 V2③ 显式验收（V2 原「重启后仍为 0」段验证的是进程内完成后续读，未触及对账——依赖说明原句「V2 的 bte 对账路径由重启后查询覆盖」与 V2 自身流程不符，一并修正）。
反例重演：①原反例「正常退出时 exit-guard 杀任务 + session_start 链伴生对账同步补注销 → 『立即查 count 仍含该任务』必失败，且那是事故修复的正确兜底」——消灭：V3 退出方式定为 SIGKILL（exit-guard 不触发），对账跳过前提（running+pid 活）写入通过标准；正常退出收口改由 V2③ 验证且断言与其兼容（count=0）。②原反例「SIGKILL 下孤儿无收殓 → 『自然完成后归零』不可达」——消灭：同进程断言改为「仍为 1」（边界实证），归零断言移到第二次重启后（机制实读支持：pid 判死 → isTerminalByRegistry → 补注销）。
重演中发现的第二处失实（按修复规则扫全文）：§5.2 原「bash 无补发通道」与 bte 对账实读矛盾——bash 残留由 bte session_start 对账收口（registry 终态或 pid 判死即补注销），已按实读修正（core sweep 不覆盖 bash 是 core 侧无 record/store；bte 对账有自身文件 registry 可查，两通道并存，registry 条目缺失的罕见路径保守不动作）。

**MF-主审-2（V4a 在无 mock 真实 CLI 下无构造入口）→ 移除验收行，诚实降级单测层。**
修法：确认三个构造候选均不成立——二次派发产生新 id（id 时间戳+随机全局唯一）、EventBus 无事件重放入口、手改 JSONL 后 resume 只验读侧 filterActiveRegisters 去重（非写侧 hasPendingId 判断，与场景意图不符）。V4 原 a) 行删除；V4 重排为 a) fork 过滤 / b) 已注销 id 重复 unregister（真实触发源 = bte 对账尽力补 emit）；P2/P3 探针行的场景引用同步改写（V4b→P2 场景、V4a→P3 场景）；E5 单测用例（U6 等价改写）承接重复 register 断言，依赖说明记录降级理由。
反例重演：对「保留 V4a 并给出构造路径」逐一重演三候选（见修法），均不可执行——场景不可执行即无法判 pass/fail，降级成立；重复 register 的去重保护不因此失去覆盖（E5 单测 + P2 实施期门）。

**MF-主审-3（D2 证据句失实 + docs/design 悬空引用无执行项承接）→ 证据句修正 + E9 执行项。**
修法：rg 实跑证实报告所列 4 处 PENDING_TTL_MS docs 命中属实；按修复规则扫全文扩展同模式清单——rebuildFromEntries 包外另有 idempotency-audit.md:21，PENDING_LIFECYCLE 包外另有 chat-domain :126/:267/:346、其 impl-plan :41、base-tool-enhance.md:175/:326——合并为 **4 文件 10 处**，新增 E9 执行项逐处承接（chat-domain:270「机制本体保留」处置登记按 D2 推翻后口径更新；idempotency-audit:21 豁免依据按 E3 终态重写）；D2 证据句改为实跑口径并标注 v1 失实。

**MF-impact-1（E8 移交不闭环 + 13 号 D5 注释前提冲突）→ E8 自闭环 + 协调约束登记。**
修法：E8 收回本设计执行（bte 一处注释行修正，In-scope 补登，M2 承接）；13 号设计文档按范围约束不予修改，改为本文档登记协调约束（§6.4 采用⑤ + §9.1）：13 号 D5 计划注释的「registry rebuild 后非空」前提在本设计终态下失效，其实施时须按本文档终态改写措辞，本设计落地后实施 13 号须回查。v1 移交方案连同击穿反例写入 §6.4 被否谱系（修复纪律 2）。
反例重演：对审查给出的另一选项「在 13 号设计文档补登记接收」重演——被范围约束排除（禁止修改 13 号文档），且单向依赖对方批次仍不闭环；对自闭环方案重演两种实施顺序：13 号先实施（其 D5 注释按约束以终态口径书写 → 无冲突）、12 号先实施（§9.1 回查锚点 → 13 号实施时调整措辞）——两序均闭合。

**MF-impact-2（守卫兜底机制失实 + 悬空清单漏 2 文件）→ §9.3 改写 + E9/E10。**
修法：实读 check-doc-symbol-drift.mjs 证实映射表 10 条目无一覆盖本组（报告属实），另证实守卫候选集只抓蛇形大写与 get 前缀驼峰（rebuildFromEntries 类普通驼峰本就不可机检——守卫能力边界如实登记，不过度声称）；§9.3「若有同批回写」改为显式执行项 E9（人工清扫回写）+ E10（DOC_MODULE_MAP 登记使 PENDING_* 族后续可机检；本设计文档自身不登记——删除性设计引用被删符号是正文职责）；清单补入 idempotency-audit.md:21 与 base-tool-enhance.md:175/:191/:326-328（并入 4 文件 10 处清单）。

**S-主审（V5「与改动前一致」缺基线采集）→ V5 前置基线步骤。**
修法：V5 流程补「改动前代码同场景跑一遍，留存 goal:log entry 序列、defer/等待通知次数与文案、pending 查询输出为基线」；通过标准改「与基线逐项一致（比对项列明）」。

**S-impact-1（两处跨 session 口径差异未登记，「零回归」声明下缺差异台账）→ §6.1 边缘差异登记两条 + 措辞校准。**
修法：① fork 残留跨 session unregister 落盘口径、② id 复用 register 去重窗口，逐条登记（含 per-session EventBus / id 全局唯一前提的窗口论证、方向良性判断、与 W4 分工登记的张力消解）；目标 2「去重语义一致」改为「语义等价 + 两条显式登记边缘差异」；§5.1 增「主链路交互不可区分」限定；V4a（fork）通过标准补「子 session JSONL 无本包新写 entry」落盘面断言钉住口径（采用审查给出的 V4b 断言选项，登记为主）。

**S-impact-2（npm 外部消费者四要素不全 + patch 裁决与自认矛盾）→ 四要素补全 + 版本改 minor。**
修法：核实仓内 changeset 惯例（本包 CHANGELOG：0.5.0 process 档引入、0.6.0 W4 翻档均记 Minor Changes，patch 仅无契约面维护）——与 semver 0.x「破坏性变更走 minor」一致，§9.1 patch 裁决作废改 minor（0.6.0 → 0.7.0）并写明依据；§9.3 末条按量级/恢复路径/重审触发/显式判定补全四要素。

**未修项**：无。两报告 INFO 级机械项不属 must-fix/suggestion 修复义务，按低成本顺手处理并在正文落位，列此备查：①§6.5 审计修正 #2/#3 的执行项编号引用（E9/E10→E6/E7，主审 INFO-1）；②导出面计数全文修正为「14 具名 + default 出口」（主审 INFO-2、影响审 INFO），ext-simplify-index.md 索引行同步；③V2 通过标准括号归因错位随 V2 重写消除（主审 INFO-3）；④index.ts:19-27 与 state.ts:1-15 头注同步重写补入 E4/E1（影响审 INFO）；⑤extension-dependencies.json reason 失实描述的顺带核实补入 E7（影响审 INFO）。

### 第 2 轮（2026-09-11）

对照报告：主审 `ext-simplify-12-review-r2.md`（0 must-fix + 2 suggestion + 5 INFO）、影响面审 `ext-simplify-12-review-impact-r2.md`（0 must-fix + 2 suggestion + 2 INFO）。suggestion 全修，无未修项；本轮无反例重演要求，涉及清单/断言的改动以实跑与实读自证（各条目内注明）。

**S-主审-1（E9 清单漏 base-tool-enhance.md:192 行为断言行）→ E9 条目补 ：192。**
修法：实读 bte.md :185-196 证实 ：192 与 ：191 同属「✅ 已核实（本设计的事实地基）」证据表相邻行，:192 断言「pending 读取侧归一化对缺失 expiresAt 回填 1h TTL（state.ts:250 normalizeRegisterEntry）——『写入侧省略』会被读取侧回填抵消，TTL 豁免必须两侧同改」；该回填行为正是 E1 删除项（normalizeRegisterEntry 简化为 expiresAt 恒不产），D2 落地后 ：192 失实。E9 的 base-tool-enhance.md 条目补 ：192，并注明漏因（不含被删符号字面量，符号字面量扫描天然扫不到）与风险（该表是 13 号设计的事实地基——实读 13 号文档 :7/:31/:48/:150/:180 证实其以 base-tool-enhance.md 为设计契约源，失实前提会被 13 号后续实施者继承）。
自证：rg 全 docs/ 证实 normalizeRegisterEntry 的行为断言类引用仅 bte.md :192/:328 两处（:328 已在 E9 清单），无第二处同类盲区。

**S-主审-2（§9.3「全仓」承诺与 E9「docs/design」清单口径不一致；docs/todo R9 报告 ：5 引用 expiredToFlush）→ 豁免登记 + 口径显式化收窄。**
修法：实读 docs/todo/subagent-workflow-sidebar-sync-plan-review-r9.md 头部定性为**历史审查报告快照**（R9 收敛轮，:7 自述「本报告只报告不修改任何文档」，expiredToFlush 出现在「本轮新增 read」实读记录，记录的是审查时点源码事实）——回写等于篡改历史审查档案，且其审查对象（sidebar-sync plan/design）经全量扫描不含任何被删符号、审查已收敛（0 must-fix 收敛轮）、执行窗口已过。裁决取主审给出的第二选项：不补入 E9 清单，显式豁免登记（§9.3）；§9.3「rg 三个删除符号全仓人工清扫」收窄为可执行口径「rg 全部被删符号（8 个枚举，register/unregister 词面过通用不入）× docs/ 全目录 + 显式豁免清单」，并补异系统同名符号噪音判别与行为断言级失实的扫描边界（主审 INFO-5 系统性根因同源，合并处理）。
自证：rg 8 个被删符号全 docs/ 重跑（排除本设计文档），真实命中 = docs/design 11 行 + R9 报告 ：5 一处，无其他漏网；其余同名命中（pi.getActiveTools / getActiveSummaries / pi-ext-036 createRegistry / bte task-store getActiveTasks 等）均为异系统符号，噪音判别规则已写入 §9.3。

**S-影响面-1（13 号协调约束可见性单向，§6.4「双向锚点」对 13 号实施批不成立）→ index.md 13 号行补协调注记 + 效果句校准。**
修法：协调约束句补登到批级入口 `docs/design/ext-simplify-index.md` 13 号行（覆盖发现列末尾「跨设计协调」注记：D5 注释前提「pending 内存 registry 仅在其自身 session_start rebuild 后非空」在 12 号终态下失效，实施 D5 时须按 12 号文档终态口径改写、不得引用已删除的 registry/rebuild 机制）——13 号实施批读取协调约束的固定位置是 13 号 §5.4（实读证实现有 E6×12 号/E9×03 号/E10×01 号三条条目均不含 D5 前提冲突），13 号文档不可改（范围约束），批级索引是其必经入口；约束语义不依赖本设计代码落地，故于设计交付时落地而非实施期。§6.4 效果句由「双向实施顺序均有回查锚点」校准为「双登记（本文档采用⑤ + 批级索引注记）+ 13 号实施批从必经批级索引可见」；§9.1 协调段同步标注双登记位置。
自证：index.md 13 号行注记与本文档 §6.4⑤ 为同一句约束的两个登记点，语义一致；仅动 13 号行，其余 15 行与表结构未触碰。

**S-影响面-2（E10「清扫 4 文件、回护 2 文件」不对称未登记）→ 边界登记句补不对称 + 扩映射实测受阻证据。**
修法：裁决取影响审给出的最低成本方案（边界登记补一笔）而非扩映射——设计期实测：把 base-tool-enhance.md 登记进 DOC_MODULE_MAP 实跑守卫即红（:93 getAgentDir、:196/:333 getEntries 为 pi SDK 符号，不在本仓源码导出表），需新增「外部符号白名单」机制才能绿；该机制成本（守卫脚本机制改动 + 白名单随引用增长的持续维护税、红-修循环打断实施者）与收益（E9 清扫后 bte.md PENDING_* 引用归零，未来重新引入属低概率且 C-proc-10 纪律兜底）不匹配。E10 行登记 2/4 回护不对称与实测证据，实施者不必重新踩「直接登记会红」的坑。

**INFO 处置备查**（不属 suggestion 修复义务，逐条列明）：
- 主审 INFO-1（「10 处」实为 11 行）：§6.2/§6.4 计数与行列举统一为按行口径（:326-328 → :326/:328）；修订记录第 1 轮与变更历史 v2 行属历史档案不回改。
- 主审 INFO-2（v1/v2 日期倒挂）：v1 行、证据基线、§6.5 审计修正记录三处「2026-09-12」统一改 2026-09-11——同源笔误一并修正（当天 09-11，未来日期的「实读」不可能成立）。
- 主审 INFO-3（index.md:22「PENDING_LIFECYCLE 注释失实」字样）：本轮不动 index.md 12 号行（本轮授权编辑范围仅 13 号行协调注记），留 E9 实施时顺手处理，处置不变。
- 主审 INFO-4（§9.2 u4「E6 与 M1 无序依赖」合入序语义不严格）：按低成本顺手原则补括号说明（M1 与 E6 两 commit 间 conformance 暂红、squash 合并后无感）。
- 主审 INFO-5（扫描盲区系统性根因）：与 S-主审-2 合并处理（§9.3 口径显式化）。
- 影响审 INFO（E8「本包」指代歧义）：E8 行修正文案改「pending-notifications 已无任何 TTL 清理」并注明落点文件语境限制。
- 影响审 INFO（机械计数口径）：与主审 INFO-1 同源，同批修正。

**未修项**：无。
