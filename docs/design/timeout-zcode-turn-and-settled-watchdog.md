# zcode turn 超时根修与 settled-watchdog 标定修正（P0-1 + P0-4）技术设计

> **一句话结论**：把 zcode「一轮」的 300s 固定墙钟替换为「事件刷新的 idle 无进展检测（主判定，30min）+ 宽总上界（回收兜底，60min 先验值经 ⛔P-Z0 门标定，env 可调/可关）」并把超时后处置以**入口感知谓词**接入既有 D3 abort 链（超时入口以 session/stop 应答三态裁决升级，stop 失败 → killChain——不再死后烧 token）；settled-watchdog 从「错误对象上的 10min 固定窗」重锚定为两段式（中段无进展 30min + 收尾段固定 600s）——两者都以 `subagent-core-unbounded-wait-audit.md` 的回收层裁决框架为归属依据。

> **层声明**：当前层 = 技术方案（问题 → 机制决策）；下一层 = 实现任务单元（文件级拆分，见 §10）。套 doc-structure 层敏感调节表「可实现的接口/技术方案」行——准则 5/6/7 全部适用最严格档（运行时断言附探针、物理数据流图、错误配恢复指引）。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 的 subagent 体系有两条执行链——pi 引擎（spawn `pi --mode rpc` 子进程）与 zcode 引擎（常驻 ZCode app-server 进程，JSON-RPC 会话通道）。两者的任务级等待守护分别由 session-runner 的 watchdog 族与 zcode session-channel 的 turn 计时器承担。
- **C（冲突）**：zcode 侧给「一轮」挂了 300s 固定墙钟，但 zcode 的一轮 = 完整 agent 任务（内部 N 轮 LLM+工具循环）——2026-09 深诊实锤 21% 真实任务被误杀、死后 app-server 继续烧 token；pi 侧 settled-watchdog 的 10min 窗口标定在被测对象上测错了（探针测收尾段 <2ms，窗口却罩整轮执行）。
- **Q（问题）**：如何让 zcode turn 的等待守护与 settled 等待窗口既不误杀正常长任务、又能在真正挂死时收敛回收，并与规则 19「任务执行正常路径禁止自带墙钟」相容？
- **A（答案）**：idle 无进展检测为主判定 + 宽上界回收兜底（回收层「默认有界 opt-out」框架内的合法形态——上界对超阈值人群是显式接受的残余误杀面，非零误杀宣称），超时处置复用既有 D3 abort 链（入口感知谓词）；settled-watchdog 拆两段重锚定。本文展开机制、方案对比与验收。

---

## 1. 背景：被设计的系统是什么

**本章结论：两条执行链的「任务级等待守护」是本设计的对象——zcode 侧是一个挂在共享 app-server 会话上的 300s 计时器，pi 侧是一个挂在 chatMode 每轮上的 10min settled 硬上限。**

> **[v1.x 已收口注记]** 本节两条链路为设计时点（zcode 引擎仍内建 core、pi inproc session-runner 尚存）的现场快照：此后 zcode 引擎已随协议化外移至 `packages/zcode-subagent-cli`、pi inproc 引擎已随 chat 域协议 v1.x 收口删除（core `engine/engines/` 目录现不存在，commit `0df9ef8b3`）。下文文件锚点按成文时点保留为史实，现行引擎形态见 `subagent-engine-protocolization.md` §1 收口注记；守护机制语义（idle 主判定 + 宽上界 / settled 两段式）不变，现落点为 core 壳侧与引擎包内对应模块。

**zcode 引擎链路**（`packages/subagent-core/src/execution/engine/engines/zcode/`）：subagent 工具派发任务 → `ZcodeEngine.run`（app-server 常驻路径）→ `runAppServerAttemptsWithRetry`（`zcode-engine.ts:490`，现仅 schema 校验失败重试）→ `attemptAppServerTurn`（`:534`）→ `SessionChannel.runTurn`（`session-channel.ts:438`）——在共享的 ZCode app-server 子进程上 create/subscribe/send 一个会话，等待终态推送。一轮任务期间 app-server 内部自主跑完整的 agent 循环（多次 LLM 调用 + 工具执行），我方只消费事件流。

**pi 引擎 chatMode 链路**（`execution/`）：`session-runner.runSpawn`（首轮）与 `subagent-service.deliverMessage`（续聊轮）驱动 `pi --mode rpc` 子进程，等待每轮的 `agent_settled` 事件行（round 收尾信号）——`settled-watchdog.ts` 为这个等待挂 10min 固定硬上限，双挂载点 `session-runner.ts:2453` + `subagent-service.ts:1177`。

**关键术语**（后文反复使用，此处定义）：

- **turn / 一轮**：zcode 语境 = 一次 `runTurn`，对应 app-server 内一个完整 agent 任务（内部 N 轮 LLM+工具）；pi 语境 = 一个对话 round（prompt → agent_settled）。**同一词在两引擎的粒度差一个量级——这是 300s 事故的量级错配根源**（§4）。
- **settled**：pi 子进程 stdout JSONL 中的 `agent_settled` 事件行，表示「本轮收尾完成、进程回到空闲」。等待它的窗口 = prompt 发出到该行到达。
- **回收层**：`subagent-core-unbounded-wait-audit.md` §2 目标 3 的定义——处置「执行已不可推进」的全部通道，共四族（dispose / 上界 / kill / idle timer）。回收层允许默认有界（opt-out）；与之相对，**任务执行正常路径禁止自带墙钟**（AGENTS.md 规则 19）。本设计的全部新上界都必须论证自己落在回收层（§6 D1）。
- **D3 abort 链**：zcode 引擎既有的中止处置链（`zcode-engine.ts:600-637`）：`session/stop`（3s）→ 升级裁决（v1.1 起双入口分岔：用户取消入口 = grace 窗口确认 turn 终态（3s）超窗升级；超时入口 = stop 应答三态裁决，详见 §6 D3）→ 升级时 `conn.shutdown` 杀共享进程（SIGTERM→5s→SIGKILL）。现状只由用户取消（`ctx.signal`）触发。
- **假成功**：任务实际失败但 outcome 呈成功形态（exitCode=0、空 content）——status='error' 终态被吞掉时的产物（§3.2 缺陷 B）。

## 2. 设计目标

**本章结论：从使用者（派发 subagent 的宿主 agent 与最终用户）体验倒推五件事——不误杀、真挂死能回收、死后不烧钱、失败形态真实可分流、配置有出路。**

1. **正常长任务不被杀**：真实 zcode 任务（实测合法形态已到 541s，pi 给同类任务 30min 起步）全程流式执行不被超时机制中断；chatMode 单轮 >10min 的合法任务同理。**例外（carve-out，v1.1）**：总上界形态（默认 60min，⛔P-Z0 门标定）对超上界的极长任务是显式接受的残余误杀面（代价裁决见 D1 归属论证），env 可调/可关 + 文案附自救指引——「不被杀」指 idle 主判定对活跃事件流零误杀，不是全时间维度零上界。
2. **真挂死有界回收**：进程/协议静默 wedged（无事件）、收尾卡死、终态永不到达等形态都在有界时间内收敛为明确失败，不留永久 pending。
3. **判死后清理干净**：超时处置停掉 app-server 侧 turn（不再单方面 abandon 后任其对端继续烧 token）。
4. **失败形态真实**：status='failed' 终态不再假成功（真实协议枚举 success|interrupted|failed，无 "error"——P-Z2 实测修正，"error" 仅作容错分支保留）；超时族错误归类 `engine_timeout`（与 `engine_run_failed` 分流）；瞬时失败对齐 pi 的自动重试先例。
5. **配置有出路**：所有默认上界有 env 通道调整/关闭（替换「只能改源码常量」的现状）。

**In-scope**：zcode app-server 路径 turn 等待语义根修（P0-1）及其二阶联动（超时清理 / status 分流 / 错误归类 / 瞬时失败重试 / HARVEST_GRACE / spawn 模式对齐论证）；settled-watchdog 标定修正（P0-4）；文档回写义务。
**Out-of-scope**：streaming UI 10min（P0-2，另文档）；插件工具 30s（P0-3，另文档）；abort 链 3s+3s 连坐量级与 keep-alive 连坐（⚠️C 组暂缓项，仅登记）；`WATCHDOG_MS_PER_TURN`=5min 经验值重标定；watchdog 覆盖面推广到更多等待点。

## 3. 现状：使用者眼里是什么样的

**本章结论：一次真实的 zcode subagent 派发，300s 处被掐断、报「运行失败」、对端继续烧 token、且部分真失败被报成功——六条缺陷全部有代码与实测证据。**

### 3.1 现状的真实样子（一个被误杀的任务）

宿主 agent 调用 subagent 工具（`engine: zcode`）跑一个深诊任务。任务 200s 起持续流出 text_delta；第 300s，`session-channel.ts:507-518` 的计时器到点：

```
// session-channel.ts:507-518（现状实装）
const timeoutMs = opts.turnTimeoutMs ?? ZCODE_APPSERVER_TURN_DEFAULT_TIMEOUT_MS;  // 300_000，constants.ts:79
const timer = setTimeout(() => {
  turn.settled = true;
  this.activeTurns.delete(sessionId);
  rejectDone(new Error(`一轮未在 ${timeoutMs}ms 内观察到终态…恢复指引：跑 app-server 探针冒烟…或经 abort 链（session/stop）清场后重跑任务。`));
}, timeoutMs);
```

计时器从 send 一次起跳，**text_delta / telemetry 到达不刷新它**。被 reject 后 `runTurn` 的 finally 只做 `closeSession`（best-effort 1.5s）——错误文案建议的「abort 链清场」代码自己从不执行；engine 侧 catch 走 `failedAppServerAttempt`（`zcode-engine.ts:585`），错误前缀 `engine_run_failed`（`:1388`）。对端 app-server 对此一无所知，继续跑完整个任务。

**2026-09 深诊（T001）实测数据**（普查总报告 §0 起因案件）：

- 34 个真实任务，失败 7 个**全部**在 286-299s 撞 300s 线（21% 误杀率）；
- `sess_bdc0aff8`：我方 300s 判死，app-server 343s `turn.completed` 正常完成（死后 43s）；
- `sess_39cd51f9`：297s 判死，app-server **541s** 正常完成——判死后白烧 4 分钟 token；
- 死亡时刻 text_delta 仍在流（最多 576 个 delta / 72.8KB）——「活跃产出被判死」的直接证据。

pi 对照：同类任务 pi 引擎给 30min 起步（spawn watchdog = `max(30min floor, maxTurns×5min)`，`session-runner.ts:240-241`，opt-in）+ 裸缺省 keep-alive 无进展 30min（`:199`，stdout 活动刷新、fire 时复核存活后代）。

### 3.2 怎么出错（六条缺陷，MECE）

| # | 缺陷 | 证据 |
|---|---|---|
| A | **300s 固定墙钟误杀**：timer 从 send 起跳、流式 delta 不刷新；量级借用 pi「单 turn 5min」但 zcode 一轮=完整任务 | `constants.ts:79` + `session-channel.ts:507-518`；T001 七例 286-299s 撞线 |
| B | **status='error' 假成功**：`turn.terminal` 推送 status success/error 均算终态（`session-channel.ts:607-617` settle 不区分），而消费端 `parsedAppServerAttempt`（`zcode-engine.ts:1439`）不读 `terminal.status`——error 终态照走「parsed 成功」，空 content + exitCode=0 | `session-channel.ts:569`（final-frame 恒 settle success）+ `zcode-engine.ts:1439-1450` |
| C | **零重试**：`runAppServerAttemptsWithRetry` 只重试 schema 校验失败（`:503-506`）；连接崩溃/超时一次即终态。pi 同场景有双层自动重试：provider SDK 层（maxRetries 默认 2，429/5xx 退避）+ agent-session 层（maxRetries 默认 3，指数退避） | `zcode-engine.ts:490-506`；pi clone `settings-manager.ts:32`、`agent-session.ts:2814-2833`（`_prepareRetry`）——clone 版本 0.84.2 **落后实装 0.84.4**（引用仅作重试先例旁证，非承重 API；实施期对实装 dist 复核一次双层重试默认值，v1.1 标注） |
| D | **超时后不清理**：runTurn finally 仅 `closeSession`；杀 turn 的 `session/stop` 只在用户 abort 链存在（`:566-573`）——判死后 app-server 侧 turn 继续跑、继续烧 token | `session-channel.ts`（runTurn finally）；T001 死后 43s/4min 实测 |
| E | **错误归类漏分流**：超时走 `engine_run_failed`（`zcode-engine.ts:1388`），而杀链超时合成的 `engine_timeout` 前缀 SSOT 已存在（`kill-chain.ts:96-108`）——超时族混入运行失败族，下游（runtime extractor 透传 error 文本 → GUI）无法按前缀分流 | `zcode-engine.ts:1364-1388`；`kill-chain.ts:108` |
| F | **两条守护缺口**：① spawn 降级路径 `attemptOnce` 无任何 timer（`zcode-engine.ts:1035+`，CLI hang=永久 pending，靠宿主 dispose/cancel）；② settled-watchdog 不覆盖 zcode（watchdog 全在 pi spawn 链路） | `zcode-engine.ts:1035-1076`；`settled-watchdog.ts` 挂载点仅 session-runner/subagent-service |

### 3.3 settled-watchdog：标定错误的实锤（P0-4）

**settled-watchdog 的 10min 窗口测错了对象：探针测的是收尾段（<2ms），窗口却罩整轮执行。**

- 常量 `SETTLED_WATCHDOG_TIMEOUT_MS = 600_000`（`settled-watchdog.ts:43`），默认挂载、固定墙钟、事件不刷新、无运行时配置通道（唯一缓解=改源码常量——普查 ❌4 原文）。
- 定标依据探针 P-T2c 测的是 **agent_end→agent_settled** 间隔：6 轮真实会话全部 <2ms，显式 compact 30 万 tokens 40.1s（`probe/p-t2c-report.md`）。而窗口实际从 **prompt 发出**起算——`subagent-service.ts:1177` 挂载点注释自述「prompt 发出即起算（整轮含 turn 执行与收尾都在窗口内）」。
- 既有设计文档自认该风险：`subagent-core-unbounded-wait-audit.md:295`「>10min 的 chatMode 单轮会被回收」；impl-plan §5 偏差表「T2③ 窗口起算口径裁决」行登记「风险 = >10min 的 chatMode 单轮被误杀……如遇误杀调 `SETTLED_WATCHDOG_TIMEOUT_MS`」——**风险已兑现为普查 ❌4，登记待清账**（C-proc-10 回写义务，§6 D8/§10 U7）。
- 头注释的固定上界自辩（「窗口内任何输出都不能证明 settled 终将到达，刷新会让 wedged-but-chatty 无限续命」）**对收尾段成立、对整轮执行不成立**——整轮内的输出（LLM 流式、工具事件）是真实进展证据。这段论证将被两段式方案拆开归位（§6 D9）。

### 3.4 HARVEST_GRACE 的退化路径（联动项）

`shutdownRuntimeAndDisposeChannel`（`zcode-engine.ts:749-771`）：killChain 在 `exit` 事件 resolve 后，只等 1s（`ZCODE_APPSERVER_HARVEST_GRACE_MS`，`constants.ts:224`）`close` 事件——channel 的崩溃收割（`failAllTurns`，`session-channel.ts:335,345-353`）挂在 onClose 上。若 `close` 迟到/永不到达，1s 后 `channel.dispose()` 退订——**onClose 收割被跳过，在途 turn 从「快速崩溃收割」退化为挂满自己的 turn 预算**。300s 时代退化终点是 300s 墙钟；§6 根修后（idle 30min / 上界 60min 先验值，⛔P-Z0 标定）这条退化路径的代价放大 6-12 倍——必须联动设计（§6 D7）。

## 4. 根因 + 物理数据流

**本章结论：六条缺陷的共同根因是「量级错配 + 固定预算非无进展检测 + 判死后三不管」三连——即把「时间到了」直接当「执行已不可推进」的证据，而实测 21% 恰恰是可推进的活跃流。**

1. **量级错配**：zcode「一轮」= 完整 agent 任务（内部 N 轮 LLM+工具循环），却借用 pi「单 turn 5min」量级当总预算；pi 给同类任务 30min 起步。541s 的正常完成在 300s 线前必然被杀。
2. **固定预算非 idle 检测**：timer 从 send 一次起跳，事件流活跃不续命——「时间到了」与「不可推进」被划等号，违反 ADR-0047「静默 ≠ 卡死，活跃产出不得判死」。
3. **判死后三不管**：不 stop 会话（app-server 继续烧）、不重试（pi 有双层重试）、迟到的 `turn.completed` 因 settled=true 被丢弃——误杀之后没有任何止损动作。

settled-watchdog（P0-4）根因同族但独立成条：**标定对象错位**——「4 个数量级余量」的结论建立在错误被测对象上（收尾段 vs 整轮）。

### 物理数据流（zcode app-server 链路，修复对象）

```
subagent 工具调用（task: {engine:"zcode", task, …}——AgentTaskSpec 无任务级 timeout 字段，types.ts:70-100）
  → ZcodeEngine.run → runAppServerAttemptsWithRetry（zcode-engine.ts:490，仅 schema 重试）
    → attemptAppServerTurn（:534）
       ├─ ctx.signal abort 监听（:566-573）→ D3 abort 链（:600-637）     ← 现状只有用户取消能触发
       └─ SessionChannel.runTurn（session-channel.ts:438）
            → createSession / subscribe / send（connection.ts，单帧 15s 控制面超时）
            → 共享 ZCode app-server 子进程（常驻 HOME）内部自主跑 agent 循环
            ← 推送 session/event（payload.delta → text_delta 实时转发给宿主）
            ← 推送 v4/telemetry/event（stream.chunk / turn.terminal——终态权威）
            ← 终态后 session/read 兜底拉取全文（5s）→ session/close（1.5s best-effort）
            【守护眼：openTurn 的 turn 计时器（:507-518，300s 固定，事件不刷新）← 根修对象 §6 D1】
      ← done resolve（TerminalInfo{status, source}）/ reject（超时）
    ← parsedAppServerAttempt（:1439，不读 status ← 缺陷 B）/ failedAppServerAttempt（:1452，engine_run_failed ← 缺陷 E）
  ← AgentOutcome → record/通知 → runtime extractor（error 文本透传）→ GUI
```

### 物理数据流（pi chatMode settled 链路，P0-4 修复对象）

```
deliverMessage（subagent-service.ts:1177）/ runSpawn（session-runner.ts:2453）发出 prompt
  → pi 子进程 stdin → agent loop（LLM 流式 + 工具执行）
  → stdout JSONL 事件行：message_start/delta…/tool_call…/turn_end/agent_end/agent_settled
  → stdout pump 解析 → handleSdkEvent（agent_settled 到达 → disarm settled-watchdog）
  【守护眼：settled-watchdog 10min 固定窗（settled-watchdog.ts:43）罩 prompt→settled 全程 ← 重锚定对象 §6 D9】
  【互补通道：idle timer（agent_settled 后 arm，5min 空闲回收）——settled 不 arm 则它不挂，「三无窗口」正是 watchdog 存在的理由】
```

---

## 5. 终态：使用者眼里将是什么样的

**本章结论：正常长任务全程流式跑到自然终态；真挂死在 30min（静默）/60min（chatty）/600s（收尾卡死）内收敛为 `engine_timeout` 失败并附恢复指引；真失败不再假成功。**

### 5.1 成功路径（>10min 任务不再被杀）

```
[宿主 agent] subagent(task="深诊这个仓的构建链路并写报告", engine="zcode")
[引擎] createSession → send → 计时器组挂载：idle 30min（每个事件刷新）+ 总上界 60min（固定）
[app-server] 任务内部跑 17 分钟：LLM 流式（text_delta 持续流出→宿主实时可见）、工具执行、再流式…
[守护] 每个到达的事件刷新 idle 计时；总上界未到
[第 17min] turn.terminal{status:"success"} → read 兜底 → parsed outcome，任务完成
——修复前该任务在第 5min 被 reject；修复后全程无中断
——边界注记（v1.1）：合法任务总时长若超总上界（默认 60min，⛔P-Z0 标定）仍会被上界回收（F-2 形态 + env 自救指引）；idle 判定对活跃任务无时长上限
```

### 5.2 失败路径（每个错误配恢复指引）

**F-1 静默 wedged（无事件 30min）→ `engine_timeout` + 服务端止损**：

```
[守护] 连续 30min 无任何该 turn 事件 → idle 判死
[引擎] 触发超时入口 abort 链（D3 stop-outcome 三态裁决）：session/stop{sessionId}（3s）
  ├─ stop 有应答（成功=服务端接受停 turn / 协议性 error=会话已被 close 回收，控制面活）→ 止损确认，链终止（共享进程不杀）
  └─ stop 超时/连接级失败（控制面死，进程假死形态）→ killChain（SIGTERM→5s→SIGKILL）收割共享进程
[outcome] engine_timeout: zcode turn 连续静默 1800000ms（idle 判定，最后事件后）…止损路径：<stop 已送达 / stop 无应答已升级杀链>。
       👉 恢复指引：直接重跑本任务（瞬时故障已自动重试一次仍超时；重试在止损链终局后启动，无新旧任务双跑窗）；若持续出现，检查 ZCode 桌面端模型连通性或改用 engine: pi。
```

**F-2 chatty wedged（有事件无终态 60min）→ 总上界回收**：同 F-1 文案但标「总上界 60min 判定（⛔P-Z0 标定中）」+ 自救指引：「若本任务属合法超长任务（预期 >60min），重跑时设 `XYZ_ZCODE_TURN_MAX_TIMEOUT_MS` 为更大值或 `0` 关闭（关闭后 chatty 形态不再自动回收，静默 wedged 仍由 idle 层兜底——自行权衡）」。受影响人群量化预期：T001 34 任务最长 541s（≈9min），先验远离上界 6.6×（⛔P-Z0 以任务总时长分布定论）。

**F-3 status='error' 终态 → 不再假成功**：

```
[outcome] engine_run_failed: app-server 终态 status=failed（会话 sess_xxx）。errorCode: model_request_failed（terminal 帧透传）。服务端返回尾部：服务端返回尾部：
       …（read 兜底/delta 聚合的尾部内容）
       👉 恢复指引：错误内容来自模型/服务端；直接重跑，若持续出现核对 ZCode 桌面端凭据与模型配置（engine_credential_missing 同族排查）。
```

**F-4 瞬时失败 → 自动重试一次**：连接崩溃（onClose 收割；类型化形态 = `transient:"conn-closed"` 结构化标记——`!isAppServerRpcError(err) && !conn.alive` 判据，设计期预想的独立 `ChannelClosedError` 类未落地）或超时类失败 → 用新会话重跑一次（预算继承，不重置）；重试仍失败才终态化。文案附带「已重试 1 次」。**重试在止损链终局后启动**（stop 确认送达即启；stop 失败 → killChain 完成 + 连接惰性重建后再启——D6 时序，无新旧 turn 双跑窗）。

**F-5 chatMode 收尾卡死 → 600s 收尾段回收**：agent_end 已到、settled 600s 不到 → kill + 该轮失败终态化（保留既有 settledWatchdogFired 恢复指引形态，`session-runner.ts:2456-2460`）。

## 6. 关键决策与权衡

**本章结论：十个决策——D1 两层判定语义（根修核心）、D9 两段式重锚定（P0-4 核心），其余为配套联动与显式不动项。**

### D1：zcode turn 等待语义 = idle 主判定 + 宽上界回收兜底（选定）

- **采用**：`openTurn` 的单一 300s timer 替换为两个 timer：
  - **idle 无进展检测（主判定）**：`ZCODE_TURN_IDLE_TIMEOUT_MS` 默认 **30min**，该 turn 的任何事件（session/event delta、telemetry stream.chunk/turn.terminal）刷新计时；连续静默达阈值 → 判「执行已不可推进」。
  - **总上界（回收兜底）**：`ZCODE_TURN_MAX_TIMEOUT_MS` 默认 **60min**（先验值，⛔P-Z0 门标定任务总时长分布，失败按预定义路径上调——见 §11），从 send 起固定不刷新，兜「事件持续但终态永不到达」的 chatty-wedge 形态。
  - 两阈值均 env 可调、≤0 关闭（规则 19 opt-out；**关闭时 warn 日志明示后果——r3 复审 SG-5 补规格，A10① 断言依据**。注意与 settled 侧先例是刻意分歧：`XYZ_SUBAGENT_IDLE_TIMEOUT_MS` 先例 ≤0=非法回落且禁用后不认 env（lifecycle-manager.ts:57-78），本设计 ≤0=显式关闭语义，分歧显式登记）。fire 后动作统一走 D3（见 D2），channel 以带 `kind: "idle" | "ceiling"` 的类型化错误 reject。
- **归属论证（与规则 19 相容性，本设计核心论证；v1.1 重写消除自相矛盾）**：按回收层定义（unbounded-wait-audit §2 目标 3），回收层是处置「执行已不可推进」的全部通道。修复前的问题不是「存在上界」而是**判定语义错了**——它把「墙钟到点」直接当「不可推进」的证据（实测 21% 是可推进的活跃流）。修复后两层的断言**必须分开说清，不再合并为「正常路径永不判死」一句（v1 该句与上界行为矛盾，被审查击穿）**：
  1. **idle 主判定**：「连续静默 30min」才是「不可推进」的有效证据（ADR-0047 的逆否面）——活跃事件流永不被 idle 判死，对任意时长的活跃任务零误杀；
  2. **总上界**：处置 idle 覆盖不了的 chatty-wedge（回收层「上界族」合法成员，量级按任务级粒度校准）。**对超上界人群它是显式接受的残余误杀面**——形态上即被否 B 方案的墙钟，差别仅在：量级经 ⛔P-Z0 门标定（非拍脑袋）、env 可调/可关、文案附自救指引（F-2）。保留它的代价裁决 = chatty-wedge 不设上界时任务挂到宿主重启的进程级泄漏代价，高于极长任务被上界误杀的代价（T001 34 任务最长 541s，先验远离上界；P-Z0 定论）。
  先例：keep-alive 无进展 30min（idle 同构，同仓正面范本）+ settled-watchdog 固定上界（总上界同构，chatty-wedge 唯一可收敛形态的论证）+ pi spawn watchdog `max(30min, maxTurns×5min)`（任务级有界先例——zcode 无 maxTurns 概念，总上界即「无 maxTurns 可推导时」的任务级对应物）。
- **被否**：见下表三方案对比。
- **证据**：`session-channel.ts:507-518`（现状）、`:325-337`（事件订阅面——刷新信号源）、T001 541s 案例、`session-runner.ts:199`（30min 先例）、`session-runner.ts:240-241`（maxTurns 换算先例）、settled-watchdog.ts 头注释（固定上界论证）。
- **效果**：§5.1（>10min 不被杀）、§5.2 F-1/F-2（真挂死回收）；§2 目标 1/2/5。
- **被替换职责的归属**（300s 常量的文档化职责是「终态双保险之后的最后一道：全漂移/进程假死时不挂死任务」，`constants.ts:74-78` 注释）：全漂移（有事件流但终态协议永不到达）→ 总上界承接；进程假死/静默（无事件）→ idle 承接——两形态都有明确接手方，无被静默绕过的原职责。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 两层：idle 30min 刷新 + 总上界 60min 固定（选）** | 对齐本仓两个既有正面范式（keep-alive 无进展 / settled 固定上界），规则 19 双档全合规，静默与 chatty 两形态都收敛 | 中（openTurn timer 状态机重写 + engine 侧分流，无新模块） | idle 阈值未经本链路数据标定（⛔P-Z1）；总上界 60min 未经任务总时长分布标定（⛔P-Z0，降级路径预定义）且对超上界人群是残余误杀面（B 形态，v1.1 显式承认并配 env 出路 + 文案指引，非零误杀宣称） | ✅ |
| B 只把 300s 调大到 30min 固定墙钟 | 根因不除：仍是「墙钟到点=不可推进」，规则 19 四要素反模式一个不少 | 低（改一个常量） | pi 同类任务 30min 起步、T001 外推下一个 31min 正常任务必被杀——只是把误杀线后移 | ❌ |
| C 纯 idle 检测（无总上界） | 消灭墙钟最彻底，正常路径零上界 | 低-中 | chatty-wedge（周期 telemetry 无终态）永不回收——挂到宿主重启；settled-watchdog 头注释对固定上界的论证在 zcode 事件流同样成立 | ❌ |

**被否若用（B）**：§3.1 的 541s 案例活了，但形态同类的 pi 任务已观测 30min 起步——30min 墙钟下它死在第 30min，错误形态与 300s 完全相同，只是频次降低；量级错配根因仍在，规则 19 违规未解除。
**被否若用（C）**：若 app-server 出现「每 500ms 吐一条 stream.chunk 但 turn.terminal 永不到达」的 bug 形态，idle 永不触发、任务挂到宿主进程退出——正是 settled-watchdog 头注释反驳刷新语义的那个形态，只是搬家。

### D2：用户通道 = env + 既有 channel 接线点（选定）

- **采用**：`XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS` / `XYZ_ZCODE_TURN_MAX_TIMEOUT_MS` 两个 env（>0 覆盖、≤0 关闭、非法值 warn+回落默认，对齐 `XYZ_SUBAGENT_IDLE_TIMEOUT_MS` 先例）；channel 层 `SessionTurnOptions.turnTimeoutMs` 接线点（`session-channel.ts:268-269`，已存在）保留为引擎内部传参面（重试预算继承时使用，见 D6）。workflow 调用方既有的 per-call `timeoutMs`（abort 信号路径，`subprocess-agent-runner.ts:203` mergeTimeoutSignal）**保持不动**——它与 turn 级预算正交（取消语义 vs 等待守护）。
- **被否**：给 subagent 工具新增 `timeoutMs` 参数。ext-1 模块普查明示「subagent 工具没有任务级 timeoutMs（turn 执行时长无墙钟——**正确**），唯一超时参数是 idleTimeoutMs」；OR-1 先例证明 LLM 会对「跑久一点」生成任意大/小数值——LLM 面开放墙钟参数就是复刻「LLM 猜小值误杀」模式。同时被否「只靠 env 不留 channel 接线点」——重试预算继承（D6）需要引擎内传值，拆掉接线点后无处可传。

  | 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
  |---|---|---|---|---|
  | **env 通道 + 保留 channel turnTimeoutMs 接线点（选）** | 与 XYZ_SUBAGENT_* env 家族一致；不扩 LLM 面；per-engine 语义独立演化 | 低（两 env 解析 + 既有接线点不动） | 全局粒度，不能 per-task（workflow 调用方已有 abort 通道补位） | ✅ |
  | subagent 工具新增 timeoutMs 参数 | 推翻 ext-1 审计「无 timeoutMs=正确」先例；LLM 面引入猜值误杀面 | 高（tool schema→ExecuteOptions→AgentTaskSpec→三引擎各自声明语义） | LLM 误填小值（300s 直觉值）即刻复刻误杀；pi/zcode 语义分裂 | ❌ |
  | 只复用 workflow agent() timeoutMs（abort 通道）当 turn 预算 | abort=取消语义（D3 连坐杀共享进程），与「等待守护」正交概念被混载 | 低（已存在） | 超时被归类为取消；仅 workflow 调用方可用，subagent 工具直调无通道 | ❌（保持正交，不动） |

  **被否若用（工具参数）**：§5.1 的 17min 任务若被 LLM 顺手填了 `timeout: 300`（LLM 常见直觉值），误杀即刻复现——且 ext-1 审计确立的「无 timeoutMs = 正确设计」先例被推翻，pi/zcode 两引擎还得各自声明该参数语义。
- **证据**：`extensions/universal/subagent-workflow/src/interface/subagent-tool.ts`（参数面：agent/model/…/idleTimeoutMs，无 timeoutMs）；`AgentTaskSpec`（`engine/types.ts:70-100`，无 timeout 字段）。
- **效果**：§2 目标 5；不扩大 LLM 攻击面。
- **被否若用（工具参数）**：§5.1 的 17min 任务若被 LLM 顺手填了 `timeout: 300`（LLM 常见直觉值），误杀即刻复现——且 ext-1 审计确立的「无 timeoutMs = 正确设计」先例被推翻，pi/zcode 两引擎还得各自声明该参数语义。

### D3：超时触发清理 = 复用 D3 abort 链 + 入口感知谓词（选定，v1.1 重写）

- **采用**：channel 判死（idle/ceiling reject）后，engine 的 `attemptAppServerTurn` catch 分流触发**既有** `appServerAbortChain`，链体参数化扩展升级判据（`escalateOn: "turn-settled" | "stop-outcome"`，双入口分岔）：
  - **用户取消入口（`ctx.signal`，现状语义零改动）**：`escalateOn: "turn-settled"`——stop（3s）→ grace 窗口（3s）内 turn 落定即止（不杀共享进程）→ 超窗 killChain。此时 turn 尚 pending，`Promise.race([turn.then(…→true), delay])` 语义正确（现状无回归）。
  - **超时入口（v1.1 新接）**：`escalateOn: "stop-outcome"`——裁决点不在 turn（已 reject，race 恒真不可用——v1 击穿点），而在 **stop 请求应答三态**：①**成功应答** → 服务端接受停 turn，止损确认，链终止；②**协议性 error 应答**（如 session-not-found——有 error 应答帧本身即控制面活的证据；多因 runTurn finally 的 closeSession（1.5s best-effort）先行关闭了会话，见下方竞态推演）→ 链终止不升级（止损由 close 回收 + 服务端自治承担）；③**超时/连接级失败**（请求超时、写入失败、连接不可用——控制面死的证据）→ killChain 升级（**实施补记，ab5acefe7**：conn 已 finalize 的微窗口内短路不发 stop——防 `conn.request` 首行 `ensureStarted` 惰性重建已死进程，直接判连接级终局）（`conn.shutdown`：SIGTERM→grace→SIGKILL，幂等）。
  - 超时入口由 engine catch **await 链终局**（非 fire-and-forget：D6 重试时序依赖链终局信号，outcome 文案需含实际止损路径）；用户取消入口维持与 turn promise 并行推进的既有 fire-and-forget 语义（`:594-599` 注释）。三态判据的实现依据：`connection.request` 的 reject 形态可区分（error 应答帧 reject 携带 RPC code；超时/写入失败是连接级新 Error——`connection.ts:288-321`）。**判据边缘登记（r2 复审 INFO-2）**：error 应答帧的 code 非 number（畸形帧）时 `err.code=undefined` → 误判连接级 → 升级杀链——A.3 错误码表全为 number 正常协议不可达（出处 `zcode-engine-appserver-resident.md:289-291`，r3 复审 INFO-1 补指针），且误杀后果止于共享进程（killChain 本就是超时形态合法终局之一）；实装若要绝对干净可用「reject 出自 settlePending 的 error 帧形态」（message 前缀）双保险，非必须。
  - **与 closeSession 的竞态推演**（超时路径必经）：channel timer reject → runTurn finally 立即 `closeSession`（1.5s）→ engine catch 触发链 → stop。**健康进程形态**：close 先行成功关会话 → stop 大概率拿到协议性 error（会话已关）→ 不杀（正确：控制面健康、会话已被 close 回收；**协议性 error 不升级是三态判据的关键设计——若把「stop 报错」一律升级，健康形态会被误杀并连坐并发任务**，审查建议方向「stop 失败→直接 kill」未区分此形态，修正后采用）。**进程假死形态**：close 本身 1.5s 超时放弃（best-effort），stop 3s 超时 → killChain 可达（正确：控制面死，只有杀进程能止损）。
  - **双入口并发**（超时后用户立即 cancel）：两链实例并发，stop 重复发送无害（服务端幂等停同一会话），shutdown 幂等（`killChainPromise` 共享，`connection.ts:206-207`）。
- **反例重演（审查 M1 反例：idle 30min fire → reject → v1 链 race 恒真 → 恒走 `if (settled) return` → killChain 结构性不可达 → 假死进程永杀不掉、对端继续烧 token）**。修复后逐步推演（目标：把「stop 失败 → 升级 kill」推到真的可达）：
  1. idle 30min fire → channel `rejectDone(TurnTimeoutError{kind:"idle"})` → runTurn finally `closeSession`（假死形态下 1.5s 超时放弃，会话仍挂在服务端）→ throw；
  2. engine catch 识别 `TurnTimeoutError` → 调用 `appServerAbortChain(…, escalateOn: "stop-outcome")` 并 await；
  3. 链体：sessionId 已存在（send 已发出，不触发 create 竞态分支）→ `conn.request("session/stop", 3s)`；
  4. 假死进程无应答 → 3s 超时 reject（连接级失败证据）→ stop-outcome 入口**不进入 turn-settled race 段**，直接判升级 → killChain：`conn.shutdown({graceMs})` → SIGTERM → grace 无退出 → SIGKILL → 进程死 → `exit`/`close` 事件 → onClose → `failAllTurns` 收割在途 turn（本 turn 已 reject，`turn.fail` 的 settled 守卫使其 no-op）→ shutdown resolve；
  5. 链终局 → engine 合成 `engine_timeout` outcome（文案含「止损升级杀链（stop 3s 无应答，进程假死形态）」）→ 重试判定（D6 时序：链终局后启动）。
  killChain 真的可达，反例消灭。对照健康进程+模型挂起形态：步 3 stop 有应答（成功或协议性 error）→ 链终止 → 止损由 stop/close 承担 → 共享进程不杀（并发任务不受连坐）✓。
- **被否谱系（v1.1）**：
  - **v1 形态（fire-and-forget 复用链体、谓词不分入口）——击穿反例**：超时路径 turn 在进链前已被 channel timer reject，`Promise.race([turn.then(()=>true,()=>true), delay 3s])` 对已 reject 的 promise 恒立即 resolve true → 恒走 `if (settled) return`，killChain 永不触发（审查 M1，`zcode-engine.ts:622-633` 源码核实）。
  - **重铸 turn 等待（进链前把已 reject 的 turn 换成「等 stop 终态事件」的新 promise）——击穿反例**：终态推送的接收依赖泵归因，而超时后 closeSession 先行关会话 + `lookupTurn` 对无 sid 帧排除已落定 turn（与 S5 迟到 terminal 路由缺口同依赖）——观察面在结构上不可靠；且需改泵归因语义，改动面大于谓词参数化。
  - **超时路径独立编排 stop→wait→kill 第二套链——击穿反例**：与 D3 原被否②同族（重复造第二套：sessionCreated 竞态处理 / stop 调用 / shutdown 调用三段编排全要复制），违反减法准则；参数化复用以一个谓词参数达成同一效果且用户取消入口零回归。
  - **「stop 失败即升级 kill」（审查原始建议方向）——击穿反例**：未区分协议性 error（控制面活、会话已关）与连接级失败（控制面死）——健康形态下 closeSession 先行关会话后 stop 必报协议性 error，照此升级会误杀健康共享进程并连坐并发任务（见上方竞态推演，修正为三态后采用）。
- **被否（原条目保留）**：①维持现状（只 closeSession）——死后烧 token 的实锤形态；②超时专用清理链（stop 后等终态更久再杀）——见被否谱系第三条。
- **证据**：`zcode-engine.ts:566-573`（abort 链现挂载点）、`:600-637`（链体 + race 谓词——本条击穿点）、`connection.ts:288-321`（request 三态 reject 形态——三态判据实现依据）、`:324-326`（shutdown 后首个 request 自动重建）、`session-channel.ts`（runTurn finally closeSession 1.5s）、T001 死后 43s/4min 数据。
- **效果**：§2 目标 3 在两种形态下都成立（健康+挂起：stop 送达止损；假死：stop 失败 → kill 收割）；§5.2 F-1 文案的止损分岔成为真实行为。
- **边界**：killChain 杀共享进程连坐在途任务（既有 D3 裁决，接受——协议已不可信时连坐是设计裁决 D3 原文）；M2 修复后重试轮不再被连坐（D6 时序）。abort 3s+3s 连坐量级与 keep-alive 连坐仍是已登记的 ⚠️C 暂缓项，本设计不扩大其范围。

### D4：错误归类 = `engine_timeout` 前缀（选定）

- **采用**：idle/ceiling 超时的 outcome 错误前缀用 `engine_timeout:`（复用 `kill-chain.ts:96-108` 的文案 SSOT 形态：时长 + 判定类型 + 「可用 engine: pi 重跑」建议 + 本设计新增止损说明），与 `engine_run_failed` 分流。channel 的类型化错误（`TurnTimeoutError{kind}`）是分流判据，不经字符串匹配。
- **被否**：维持 `engine_run_failed` 归类（超时族混入运行失败族，GUI/统计无法分流）；以及在 GUI 层做字符串启发式分流（前缀 SSOT 已存在，无需二次发明）。
- **证据**：`zcode-engine.ts:1388`（现状归类）、`kill-chain.ts:108`（engine_timeout SSOT）、runtime `subagent-extractor` error 文本透传（`subagent-extractor.ts:296,604`）。
- **效果**：§2 目标 4 后半；§5.2 F-1。

### D5：status='error' 终态分流 = parsed 前消费 status（选定）

- **采用**：① channel 在 turn 上追加记录 `lastTerminalStatus`——`turn.terminal` 即使晚于 final-frame settle 到达（`session-channel.ts:569` 恒 settle success 的宽松终态先到、权威终态后到），也把 status 记下来随 `SessionTurnResult` 返回；② `parsedAppServerAttempt` 读权威 status → 合成 run-failed，message 附 read 兜底/delta 聚合的尾部内容（诊断信息不丢）+ 恢复指引（§5.2 F-3 文案）。**⛔P-Z2 实测协议修正（Gate B，2026-09-05）**：真实 app-server 的 `turn.terminal.status` 枚举为 `success | interrupted | failed` 三值（dist schema `f.enum`，无 "error"）；失败形态 = `status:"failed"` + `errorCode`/`errorMessage`（**错误详情只在 terminal 帧，read/delta 不携带**——「附 read 尾部内容」在真实形态取不到错误内容，必须透传 terminal 帧字段）；且 failed 无 final-frame 先到（final-frame 仅与 success 共存）。实施判据相应为 `status === "failed"` 分流（"interrupted" = 用户中断，不属引擎失败，不分流——宿主 abort 主路径场景下 turn 已被本地收口，terminal 帧仅记录；**已知边界**：服务端自发 interrupted（非宿主触发）现走 parsed 收口（成功形态），语义待评估，登记 impl-plan §7 残留）。设计原写的 "error" 二值假设系 fake 注入形态的以讹传讹，本行为 Gate B 门拦截的实例。
- **被否**：在 settle 时区分（把 status error 的 terminal 不当终态）——终态就是终态（`session-channel.ts:608` 注释「旧实证：不归类挂到超时」），不当终态会回到挂死；以及只信 final-frame（error 终态往往没有 final-frame，response 为 delta 聚合/空——正是假成功的成因）。
- **证据**：`session-channel.ts:607-617`（settle 传 status）、`:569,582`（final-frame 恒 success）、`zcode-engine.ts:1439-1450`（不消费 status）。
- **效果**：§2 目标 4 前半；§5.2 F-3。⛔P-Z2 验证 error 终态的事件序（final-frame 与 turn.terminal 的先后、read 是否携带错误信息），失败降级：只消费 source="turn.terminal" 的 status（final-frame 先到时以 read 尾部合成，覆盖面收窄但不假成功）。
- **D5① 后续修订（2026-09-10，commit `54899e349`）**：已落定 turn 的迟到 turn.terminal 日志按权威 status 分级——真机实证该形态唯一可达路径是 **success 终态常态迟到**（failed 无 final-frame 故永不进该分支），原无条件 warn 使每个成功任务必产一条零区分度 ERROR 级日志（经引擎 stderr → runtime `[rpc:stderr]` 全量 console.error 链路）。分级：success 静默（`lastTerminalStatus`/`lastTerminalError` 无条件入账不变）；interrupted 降 debug（SDK cli-entry stderr 兜底对 debug 跳过写入，对齐 CONSOLE_SINK 语义；`host/log` 反向请求全级别透传不变）；失败类（`isFailedTerminalStatus`，判据自 zcode-engine 收编 constants.ts 单源）与 unknown 保守 warn（假成功识破防御面保留）。settle 语义逐字不动；golden `_meta.synthesisNote` 补记真机帧序（final-frame 先落定为常态路径，failed = terminal 帧独到）。

### D6：瞬时失败重试一次 = 新会话重跑 + 预算继承（选定）

- **采用**：`runAppServerAttemptsWithRetry` 在 schema 重试之外扩展：末次 attempt 为 **timeout 类**（idle/ceiling）或**连接崩溃类**（onClose failAllTurns 的错误）失败且非用户 abort、非漂移码 → 用新会话重跑一次（attempt 本就每次新建会话，`:485-489` 注释）。预算继承（race-F3 先例）：显式设置了 turnTimeoutMs（env 或内部传参）时，重试轮的有效上界 = 剩余预算；剩余不足一个最小下限（如 5min）则不重试直接终态化。重试事实记入错误文案（「已重试 1 次」）与 journal。
- **被否**：①多次重试/指数退避——app-server 不是单次 LLM 请求，重跑一轮=整任务重算，成本远高于 pi 的 agent-session 重试（那是对单次 turn 的续跑），一次封顶；②漂移类也重试——漂移有专属降级链（R5 降级 spawn 重跑，`constants.ts:139-152`），语义已完备不动；③status='failed' 终态重试——不做（错误内容可能非瞬时，重跑浪费；**P-Z2 已落地**：真实枚举无 "error"、失败形态 = failed + errorCode/errorMessage，维持不重试裁决——错误详情多为凭据/服务端配置问题，重跑同因同果）。
- **证据**：pi 双层重试（`settings-manager.ts:32` 默认 3 次、`agent-session.ts:2814-2833` 指数退避、SDK maxRetries 默认 2）；race-F3「重试不重置预算」先例（orchestration/error-recovery 剩余墙钟折算）；`zcode-engine.ts:490-506`（扩展点）。
- **效果**：§2 目标 4；§5.2 F-4。

### D7：HARVEST_GRACE 联动 = dispose 收割兜底（选定）

- **采用**：`shutdownRuntimeAndDisposeChannel` 的 grace 到点、close 未到达时，先对 channel 在途 turn 主动执行**既有** `failAllTurns`（dispose 前），再退订——「退订 = 不会再有事件」在结构上蕴含「在途 turn 不应再等」。`ZCODE_APPSERVER_HARVEST_GRACE_MS`=1s 维持（它守护的 exit→close 正常窗口是毫秒级，1s 合法回收层兜底）；联动修复后，close 永不到达的病态形态由 dispose 收割在 1s+杀链内闭合，不再依赖 turn 自身预算。`dispose()` 收割幂等（activeTurns 已空则 no-op），与 onClose 收割不冲突（先到者赢，`turn.fail` 的 settled 守卫已存在）。
- **被否**：①只调大 HARVEST_GRACE——close **永不到达**时调多大都没用（病态形态是无限不是慢）；②维持现状——300s 根修后退化终点从 300s 变 30-60min，代价放大 6-12 倍。
- **证据**：`zcode-engine.ts:749-771`（现状）、`session-channel.ts:335`（onClose→failAllTurns 挂载）、`:340-343`（dispose 现仅退订）、`:345-353`（failAllTurns 既有）。
- **效果**：§3.4 退化路径闭合；§2 目标 2 的崩溃收割面。⛔P-Z3 验证注入 close 缺失时在途 turn 在 grace 窗口内被收割。

### D8：spawn 降级路径不动（显式决策）

- **采用**：spawn 路径 `attemptOnce` 维持无 timer 现状。归属论证：任务执行正常路径无墙钟正是规则 19 的期望形态（pi 引擎 run 主路径同构，sc-engine-orch 普查评「✅ 合规基线」）；回收通道 = 宿主侧 `ctx.onChildSpawned` 记账 + cancelBackground SIGTERM + dispose killAll（`zcode-engine.ts:1063-1066` 已接入）。T001 缺陷 F-① 的实质是「与 app-server 路径不对称」——根修后 app-server 路径收敛为「正常路径 idle 判定 + 回收层兜底」，spawn 路径本就是「正常路径零墙钟 + 回收层宿主兜底」，**两条路径在规则 19 下重新对齐**，不需要给 spawn 加 timer。
- **被否**：给 spawn 路径加 idle/上界 timer——为已合规的路径引入新运行时断言（准则 8），且 spawn 是降级兜底路径（R5 D2），流量极小收益不成比例。
- **证据**：`zcode-engine.ts:1035-1076`（attemptOnce 仅 abort listener）；sc-engine-orch 报告 pi-engine「run 主路径无任何墙钟 ✅ 合规基线」。
- **效果**：scope 收敛声明（§2 Out-of-scope 的 spawn 项以论证关闭）。

### D9：settled-watchdog 重锚定 = 两段式（选定，P0-4 核心）

- **采用**：单窗口拆两段：
  - **中段（prompt → agent_end）**：无进展检测，阈值 30min（新常量 `SETTLED_MID_ROUND_NO_PROGRESS_MS`，对齐既有 keep-alive 无进展检测先例的 30min 量级），**有效协议事件行刷新**（stdout pump 解析出的合法 JSONL 事件——message_*/tool_*/turn_end 等；LC-9 的 invalid 行不刷新，防调试噪音续命）；连续静默 30min → 判 wedged，kill + 该轮失败终态化。**残余误杀面（v1.1 登记，S4）**：与 keep-alive 先例不同（fire 时复核存活后代），中段静默 fire 直接 kill 无复核——chatMode 轮内一次 >30min 无 stdout 事件的长工具执行（长构建/子任务）会被判 wedged；标定与缓解挂 ⛔P-Z1（pi 侧 chatMode 轮内 gap 类比采样，长工具形态真实存在 → fire 前 get_state 复核或阈值上调）。现状 10min 全程窗对该形态更差（非回归）。
  - **收尾段（agent_end → agent_settled）**：固定硬上限，**维持 600s 常量值不变、锚点改挂 agent_end 之后**——P-T2c 实测收尾段 <2ms、compact 30 万 tokens 40.1s，按探针自身降级规则（P99×10 = 401s < 600s）600s 成立；事件不刷新（头注释对收尾段的固定上界论证**保留并归位**：收尾段内输出确实不能证明 settled 将到达）。
  - 配置通道：新 env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS`（>0 覆盖收尾段、≤0 关闭两段——关闭即回到「三无窗口」，warn 提示）；中段阈值 v1 不开 env（减法，保持与 keep-alive 同为常量）。
- **LC-1 三 wedged 场景的覆盖复核**（重锚定必须逐场景交代）：①pi 版本偏斜无事件（agent_end 永不到达）→ 中段静默 30min 回收 ✓；②post-run compact 卡死（agent_end 已到、settled 不来）→ 收尾段 600s 回收 ✓；③stdout 行损坏（settled 行被丢）→ 收尾段 600s 回收 ✓。两段合起来对三场景的覆盖不弱于现状，且中段对场景①的判定从「10min 固定」变为「30min 无进展」——修复了它误杀工作轮的缺陷。
- **被否**：三方案对比见下表。
- **证据**：`settled-watchdog.ts:43` 与头注释、`session-runner.ts:2453-2461` / `subagent-service.ts:1177`（挂载点）、`probe/p-t2c-report.md`、unbounded-wait-audit §7.2 T2-③ 边界自认（`:295`）、impl-plan §5「T2③ 窗口起算口径」风险行。
- **效果**：§2 目标 1（chatMode >10min 合法单轮不再被杀）+ 目标 2（三 wedged 场景全收敛）；§5.2 F-5。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **两段式：中段无进展 30min + 收尾段固定 600s（选）** | 判定语义与被保护对象逐段匹配（工作段=输出即进展；收尾段=固定上界唯一可收敛）；与本仓 keep-alive 范式同构；LC-1 三场景覆盖不降级 | 中（原语扩一个刷新入口 + 锚点改挂，挂载点两处同步） | 中段有效事件判定依赖 stdout pump 的合法行判别（已有 invalidLineCount 基建）；auto-compact 常态化触发后收尾段需复测 | ✅ |
| (a) 只重锚到 agent_end 之后（真收尾段短上界，无中段检测） | 标定对象终于对了；但 LC-1 场景①（agent_end 永不到达）失去回收覆盖——回到「三无窗口」原bug | 低 | pi 版本偏斜/启动即 wedge 的进程永久泄漏，直到宿主退出——正是 unbounded-wait-audit 要根修的 LC-1 原始形态 | ❌ |
| (b) 保留全程窗口但改事件刷新 | 一处改动最小 | 低 | 被 settled-watchdog 头注释自己的论证击穿：收尾段内「wedged 但仍有周期输出」的进程无限续命（LC-9 已证 stdout 可有调试行）——刷新让收尾段失去唯一可收敛形态；且刷新语义无法区分「工作段输出」与「收尾段噪音」 | ❌ |
| (c) 只加用户通道（env/参数）不动标定 | 有出路但没治病：默认行为仍是错误标定的 10min 全程窗 | 低 | 误杀照旧发生在没配 env 的所有用户身上——普查 ❌4 的批评（「唯一缓解=改源码常量」）只是换了个缓解形态 | ❌ |

**被否谱系**（供后续审查与回写引用）：全程固定 10min 窗（2026-09-01 定案形态）——击穿反例 = 2026-09-04 普查标定实锤（P-T2c 测收尾段 <2ms，窗口却罩整轮；>10min 合法 chatMode 单轮被误杀，登记 ❌4）；(a)/(b)/(c) 见表内击穿反例。两段式吸收了 (a) 的正确锚点 + (b) 的反驳论证（归位到收尾段）+ (c) 的配置通道。

### D10：回写义务（随修复同 commit，C-proc-10）

- **采用**：修复落地 commit 内完成三处回写：① `subagent-core-unbounded-wait-audit.md` §7.2 T2-③ 追加被否谱系（旧机制 + 击穿反例 = 2026-09-04 普查标定实锤）并改写边界句（「>10min 的 chatMode 单轮会被回收…调常量」段替换为两段式语义与 env 通道）；② impl-plan §5「T2③ 窗口起算口径裁决」行清账（风险兑现为普查 ❌4 → 修复见本文档，状态改已清账）；③ `settled-watchdog.ts` 头注释重写为两段语义（含 env 通道说明）。
- **被否**：只改代码不回写——正是 C-proc-10 纪律要防的「登记即债务、修复即清账」断裂（2026-08-31 流水线先例）。
- **证据**：AGENTS.md 设计文档同步纪律条目；impl-plan §5 该行现状「待回写」。
- **效果**：§10 U7；约束登记表的漂移守卫（check-doc-symbol-drift）随 commit 跑过。

## 7. 实现机制（把终态落到代码层）

**本章结论：改动集中在 zcode 引擎三文件 + settled-watchdog 原语与两挂载点（共六文件），无新模块、无新依赖。**

**新常量**（zcode 侧两常量落 `engines/zcode/constants.ts`；settled 侧 `SETTLED_MID_ROUND_NO_PROGRESS_MS` 与 `SETTLED_WATCHDOG_TIMEOUT_MS` 定义在 `execution/settled-watchdog.ts` 模块内原位（一致性审查 DE1 修正）——除中段阈值外均 env 可覆盖，D9 定案：中段阈值 v1 不开 env，保持与 keep-alive 先例同为纯常量）：

| 常量 | 默认值 | 语义 |
|---|---|---|
| `ZCODE_TURN_IDLE_TIMEOUT_MS` | 30min | turn 事件刷新的静默阈值（idle 主判定） |
| `ZCODE_TURN_MAX_TIMEOUT_MS` | 60min | turn 总上界（chatty-wedge 回收兜底） |
| `SETTLED_MID_ROUND_NO_PROGRESS_MS` | 30min | chatMode 中段有效协议事件刷新的静默阈值 |
| `SETTLED_WATCHDOG_TIMEOUT_MS` | 600s（值不变） | 收尾段固定上界（锚点改 agent_end 后） |

**session-channel `openTurn` timer 状态机**：两 timer 各自独立 clearTimeout/重挂；事件到达点（`handleSessionEvent` / `handleTelemetry`）统一调 `refreshIdle(sessionId)`——create 应答在 `openTurn` 挂 timer 之前到达（runTurn 先 createSession 后 openTurn），不参与刷新；任一 fire → reject `TurnTimeoutError{kind, lastEventAt, elapsed}`（类型化，供 engine 分流与文案）。`SessionTurnOptions` 扩展：`turnTimeoutMs` 语义收窄为「显式总上界」（缺省走 env→默认 60min；D6 重试预算继承用它传剩余值）+ 新增 `idleTimeoutMs` 字段（缺省走 env→默认 30min）——两个内部传参点，工具面不暴露（D2）。

**engine 分流**：`attemptAppServerTurn` catch 增加判别——`TurnTimeoutError` → **await `appServerAbortChain` 链终局后**（D3 明文：非 fire-and-forget——D6 重试时序依赖链终局信号；用户取消入口才维持既有 fire-and-forget 形态）+ `engine_timeout` outcome（D4）+ 进入重试判定（D6）；连接崩溃类（failAllTurns 错误标记）→ 同入重试判定；abort/漂移 → 既有路径不动。

**settled-watchdog 原语扩展**：`armSettledWatchdog` 语义改为「收尾段上界」（锚点：收到 agent_end 时 arm，settled/close 清）；新增 `armMidRoundNoProgress`（锚点：prompt 发出时 arm，有效协议事件刷新，agent_end 到达时 disarm 并交棒收尾段）。两挂载点（session-runner 首轮 / subagent-service 续聊）同步接两个原语；stdout pump 的合法行判别复用 invalidLineCount 同源解析结果。

**失败路径总表**（每个错误 → 处置 + 恢复指引，准则 6）：

| 错误形态 | 前缀/文案要点 | 止损动作 | 恢复指引 |
|---|---|---|---|
| idle 静默判死 | `engine_timeout`（含静默时长、最后事件时刻） | stop 三态裁决（成功/协议 error → 链终止；超时/连接级 → killChain，D3） | 重跑（已自动重试 1 次）；持续出现查 ZCode 连通性或 engine: pi |
| 总上界判死 | `engine_timeout`（chatty 判定标注） | 同上 | 同上；env 可调/关上界 |
| status=failed 终态（"error" 为容错分支） | `engine_run_failed`（terminal 帧 errorCode/errorMessage 透传优先，read 尾部兜底） | 会话已终态，无需止损 | 重跑；持续出现查凭据/模型配置 |
| 连接崩溃（重试后仍失败） | `engine_run_failed`（已重试 1 次） | 连接自动重建 | 重跑；probe 核对协议漂移 |
| 收尾段 600s 超时 | settledWatchdogFired（既有形态） | kill 层主 + 30s 升级 | 既有恢复指引（冷路径 resume 可续） |
| 中段 30min 静默 | 同上（标注 mid-round no-progress） | 同上 | 同上 |

## 8. 验收（真实场景，非单测）

**本章结论：改动规模 = 大（行为变更 + 接口调整），十一个真实场景覆盖五条目标（目标 1←A1/A6/A7/A10、目标 2←A2/A3/A8/A9、目标 3←A2/A11、目标 4←A4/A5、目标 5←A7/A8/A9，r3 复审 INFO-2 补行回溯），含行为不变负面验证（A6）与两止损分支各有的独立覆盖（A2/A11）；加速验证用 env 调小阈值验机制，另跑默认值真实场景至少各 1 例。**

| # | 场景 | 回溯 §2 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| A1 | 长任务不误杀（复现 T001 541s 形态） | 目标 1 | 真实 zcode 任务跑 >10min（大仓深诊/长报告，与 sess_39cd51f9 同类）；全程观察 text_delta | 任务自然终态 parsed；总时长 >300s 无中断；无 engine_timeout |
| A2 | 静默 wedged 回收 + killChain 止损（假死形态） | 目标 2/3 | 真实会话中途 SIGSTOP 挂起 app-server（事件流断）；观察 30min（或 env 调小至 60s 先验机制再跑 1 例默认值） | 30min（或缩阈值）内 `engine_timeout`；**killChain 路径可判定断言（r2 复审 MF 修正——SIGSTOP 冻结进程不处理请求不落盘，stop 送达证据在该形态结构性不可产生）**：stop 3s 超时后升级杀链（engine 日志链终局为连接级失败）→ 共享进程死亡（exit/close 事件）→ 判死时刻前后 app-server journal / SQLite usage 快照对比无新增 token 消耗（桌面端用量面板分辨率/刷新延迟不足，不作判据）；journal 检查顺带留意无重复 stop 副作用（D3 双入口并发，r2 INFO-1）；**outcome 文案止损路径为「stop 无应答已升级杀链」（D3 强制可观测面，r3 复审 SG-4 补——与 A11 对称）** |
| A3 | chatty wedged 由上界回收 | 目标 2 | fake app-server（既有 conformance 基建）周期吐 stream.chunk 无终态；env `XYZ_ZCODE_TURN_MAX_TIMEOUT_MS=60000` 加速 | 60s 内 `engine_timeout`（ceiling 判定）；文案含 chatty 标注与 env 指引 |
| A4 | status=error 不再假成功 | 目标 4 | 真实会话触发 error 终态（错误模型配置/失效凭据 send）；⛔P-Z2 先行确认事件序 | outcome 为 run-failed + 尾部内容可见；record/通知不呈成功形态（对照 S-B-1 先例：用户可感知面才是判据面） |
| A5 | 瞬时失败自动重试（无双跑窗） | 目标 4 | 真实任务执行中 kill 一次 app-server 进程（连接崩溃收割触发） | 引擎重建连接 + 新会话重跑一次；要么成功要么「已重试 1 次」的明确失败；不永久 pending；**无双跑窗断言（r2 复审 SG-6 补——D6/F-4 的负面断言落验收）：stop 在途 / killChain 完成前，app-server journal 不出现第二个 session/create 或新 turn 事件（重试严格在链终局后启动）** |
| A6 | 正常快任务行为不变（负面） | 目标 1 | 跑 3 个 <5min 常规任务 | 无重试、无 timeout 前缀、行为与修复前一致 |
| A7 | chatMode 长单轮不被 settled 误杀 | 目标 1 | conversation 模式派一个 >10min 单轮任务（修复前必被 10min 窗杀） | 该轮正常 settled；收尾段上界只在 agent_end 后计时 |
| A8 | 收尾卡死回收（负面：吞 settled 行） | 目标 2 | relay wrapper 滤掉 agent_settled 行（impl-plan S-B 已验证的注入通道）；env 调小 `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS=60000` 加速 | 60s 内 kill + 失败终态化（收尾段语义生效）；A7 证明该判定不影响工作段 |
| A9 | 中段无事件回收（负面：版本偏斜形态） | 目标 2 | relay wrapper 同时滤掉 agent_end 与 agent_settled；env 调小中段阈值 | 中段静默判定触发回收（场景①覆盖不降级） |
| A10 | env ≤0 关闭行为 + 超上界形态的用户可见逃生门（负面） | 目标 1 | ① `XYZ_ZCODE_TURN_MAX_TIMEOUT_MS=0` + `XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS=0` 下跑 wedged 模拟：确认无 timer 判死、warn 提示出现、另一层语义（idle 关闭后静默 wedged 无自动回收）如实呈现；①b 同法验 settled 侧 `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS=0`（r2 复审 SG-1 补，挂 M3）；② 以 env 缩小上界（如 60s）等价模拟 >60min 合法任务被上界回收：验证 F-2 文案 + env 自救指引足以引导用户调参重跑 | 关闭态无隐式判死、warn 明示后果；F-2 文案含 env 调整示例且重跑成功 |
| A11 | stop 送达止损分支（健康控制面 + turn 无终态形态） | 目标 3 | fake app-server（conformance 基建）注入「stop 应答成功、terminal 永不到达」——**用基建的 `hangOnly` 静默形态 + `stopBehavior:'none'`（r3 复审 SG-2 补：send 后静默才触发 idle；若沿用 A3 周期 chunk 形态会漂移到 ceiling 判定）**；env 调小 idle 至 60s（r2 复审 MF 补——F-1 两止损分支中 stop 成功送达分支此前零验收覆盖，A2 只覆盖 killChain 分支） | `engine_timeout` 发生且止损链**不升级**：fake state 文件（FAKE_STATE_FILE 流水）含 stop-recv 帧 + 共享进程存活（无 killChain 日志、进程不退）（r3 复审 SG-1 修正——fake 不产 usage 数据，快照断言在该场景恒真空转，改 state 流水证据）；outcome 止损路径文案为「stop 已送达」（对齐 D3 强制可观测面，r3 复审 SG-4 与 A2 对称） |

**依赖说明**：A1/A4/A5/A6/A7 走真实 ZCode 桌面端 + 真实模型；A3/A11 用 fake app-server（真实 app-server 无法注入 chatty-wedge / stop-送达+无终态形态，缺口如实标注——机制层等价；A11 的 FAKE_STATE_FILE 流水即其落盘证据，r3 复审 SG-3 补列）；A2 的 SIGSTOP 是真实进程信号非 mock。

## 9. 实施（迁移路径）

**本章结论：三阶段交付——先根修判定语义（最大风险面），再联动处置链，最后 settled 重锚定；每阶段可独立验收/回滚。**

| 阶段 | 内容 | 交付终态的什么 | 验收 |
|---|---|---|---|
| M1 | U1（idle+ceiling timer）+ U2（清理+归类） | §5.1 成功路径 + F-1/F-2 | A1/A2/A3/A6 + **A11（stop 送达止损分支，U2 链行为）+ A10①②（zcode 侧 env，U1）**（r2 复审 SG-1 补映射） |
| M2 | U3（status 分流）+ U4（重试）+ U5（dispose 收割） | F-3/F-4 + 崩溃收割闭合 | A4/A5（含无双跑窗断言） |
| M3 | U6（settled 两段式）+ U7（文档回写） | F-5 + chatMode 长轮保护 | A7/A8/A9 + **A10①b（settled env 关闭，U6）** |

## 10. 下一层拆分

**本章结论：七个实现单元，依赖关系 U1→U2→U4；U3/U5/U6 并行；U7 随 U6 同 commit。**

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| U1 | `session-channel.ts`：openTurn 两 timer 状态机 + `TurnTimeoutError` + 事件刷新 + `lastTerminalStatus` 记录；`constants.ts` 两新常量 + env 解析；`lookupTurn` 归因放宽（已 settle 的 turn 仍可接收迟到 turn.terminal 的 status 记录——只记录不改写落定，S5 修复；⚠️P-Z2 落地时把「迟到 + 无 sid」形态纳入帧序记录） | 判定语义根修的最小闭环，channel 是事件到达点（刷新信号源唯一在此）；lastTerminalStatus 顺路落在同文件（D5 ①） |
| U2 | `zcode-engine.ts`：catch 分流（timeout→abort 链 + engine_timeout 文案） | 处置链依赖 U1 的类型化错误；engine 是 D3 链与 outcome 合成的归属地 |
| U3 | `zcode-engine.ts`：`parsedAppServerAttempt` 消费 status + run-failed 合成 | 独立于 U1/U2（数据已由 U1 备好）；⚠️P-Z2 探针先行 |
| U4 | `zcode-engine.ts`：`runAppServerAttemptsWithRetry` 扩展 + 预算继承 | 依赖 U2 的失败分类；改动面单函数 |
| U5 | `zcode-engine.ts` + `session-channel.ts`：dispose 前收割 | 独立小改；闭合 §3.4 退化路径 |
| U6 | `settled-watchdog.ts` 两段式原语 + 两挂载点改造 + env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS` | P0-4 独立主题，与 zcode 侧无文件交集，可并行 |
| U7 | 文档回写三处（unbounded-wait-audit §7.2 被否谱系 / impl-plan §5 清账 / settled-watchdog 头注释） | C-proc-10 纪律：随 U6 同 commit，登记即债务修复即清账（实施拆为 0364b349e + e2ae052ef 相邻两 commit 交付，实质义务达成） |

**文件改动地图**：`engines/zcode/{constants,session-channel,zcode-engine}.ts`（U1-U5）；`execution/{settled-watchdog,session-runner,subagent-service}.ts`（U6）；`docs/design/{subagent-core-unbounded-wait-audit.md, subagent-core-unbounded-wait-audit.impl-plan.md}`（U7——设计文档自身不在回写清单内，一致性审查 DE2 修正）。

## 11. 待验证检查点（探针清单，准则 7）

| ID | 验证的行为断言 | 探针 | 状态 | 失败时降级路径 |
|---|---|---|---|---|
| P-T2c | 收尾段（agent_end→settled）<2ms；compact 30 万 tokens 40.1s → 收尾段 600s 定值 | 已有 probe/p-t2c-report.md | ✅ 已执行 | —（按其自身规则 P99×10=401s<600s 成立） |
| P-Z0 | 总上界 60min 先验值标定：真实任务**总时长**分布 P99 显著 < 60min（对照 pi 侧同类任务 spawn watchdog 实际生效值分布） | 扫 T001 34 任务 + 新采样共 58 任务 journal 总时长（非 gap 分布） | ✅ 已执行（2026-09-05 Gate B）：P50=2.4min/P95=4.9min/P99=5.0min（敏感性口径 P99=9.0min 含 343s/541s 注入），P99×2=18min 距 60min 3.3× 余量，单峰——**维持默认 60min** | 合法任务 P99 总时长 ×2 仍 < 60min → 维持默认；P99 ≥ 60min/2 → 默认上调至 P99×2（env 语义不变）；分布双峰 → 取长任务峰 P99×2 |
| P-Z1 | zcode 真实任务事件流最大合法静默窗（工具执行期无事件）显著 < 30min | 扫 T001 34 任务 + 新采样的会话事件流，统计 inter-event gap 分布；＋ pi 侧真实会话日志采 chatMode 轮内 gap 分布（类比采样，标定 D9 中段「长工具无 stdout 事件」残余面） | ✅ 已执行（2026-09-05 Gate B，13632 gap）：zcode 侧 P99=5.3s/max=3.0min（自然终态），pi 类比 P99=2.2min、轮内工具执行 max≈2.7min——「长工具>30min 无事件」零实锤，**维持默认 30min**，S4 降级无需触发 |
| P-Z2 | 终态事件序与 status 枚举（P-Z2 已执行 ✅ 2026-09-05，证据 /tmp/pz2-probe/）：真实协议 status 枚举 = success/interrupted/failed 三值无 "error"；failed 形态 = terminal 帧独到（无 final-frame）+ errorCode/errorMessage，read 不携带错误；错误模型名在 create/setModel 期即 -32603 拒绝不产生 turn 终态 | 真实失效凭据（隔离 HOME + 黑洞 baseURL）触发 failed 终态 + dist schema 核实 | ✅ 已执行（拦截实装判据漂移：u-z3 原判 `==="error"` 对真实 failed 假成功，已修正为 `==="failed"` + terminal 字段透传） | 降级路径前提（final-frame 先到 + read 无错误）在真实协议不可达——final-frame 仅与 success 共存；实施的无条件保守判定相对设计条件降级是安全侧放宽 |
| P-Z3 | dispose 收割：close 缺失时在途 turn 在 grace 窗口内被收割 | fake app-server + 注入 close 事件吞没，断言 failAllTurns 经 dispose 路径触发 | ✅ 机制层测试承载（session-channel-dispose-harvest 测试，u-z5，commit 2b89bd27f；6179bc5e8 验收） | 失败 → HARVEST_GRACE 提至 5s 并保留 onClose 主路径（退化不变但窗口放宽） |
| P-Z4 | 重试预算继承：显式预算下重试轮不重置总预算 | 双超时注入（首轮耗尽大部分预算后注入崩溃），断言重试轮上界=剩余 | ✅ 机制层测试承载（resolveTransientRetryBudget 纯函数数值断言 + 集成行为分野，u-z4，commit 0178faeac） | 失败 → 显式预算存在时禁用重试（仅默认无限时配置启用） |
| P-T2c-r | auto-compact 常态化后收尾段分布仍 < 600s | 未来模型/阈值变化时复跑 p-t2c（ROUND_PLANS 增大填充档位） | 登记待环境 | P99 ≥ 600s/10 → 按 ×10 规则上调常量（env 通道已就位） |

**对「靠推理断言」的既有教训记录**：300s 与 10min 全程窗都是「推理值先上、实测后推翻」的实例（前者被 T001 数据击穿、后者被标定对象错位击穿）——本设计所有时长默认值要么挂已执行探针（P-T2c），要么挂实施期门探针（P-Z0/Z1/Z2），失败时降级方向全部预定义。

---

## 附录：变更历史

- v1（2026-09-04）：初版。基于超时普查总报告（timeout-audit-2026-09.md）P0-1/P0-4 任务书与 T001 深诊实锤撰写；含三方案对比×2（D1/D9）、被否谱系、探针清单与回写义务。
- v1.1（2026-09-04）：第一轮对抗式审查修复（3 MF/6 SG/1 INFO，逐条对应）：
  - MF1（killChain 不可达）→ D3 改双入口分岔：超时入口以 stop 应答三态裁决（成功/协议性 error/连接级失败）替换对已 reject turn 的 race 谓词；「stop 失败即升级」的审查原始建议经健康形态竞态推演击穿（协议性 error ≠ 控制面死），记入被否谱系后修正采用；时间线重演：健康进程形态 stop 报会话已关 → 不杀（close 已回收）；进程假死形态 close/stop 均超时 → killChain 可达。
  - MF2（重试×清理时序）→ D6 补「重试在止损链终局后启动」约束（stop 确认送达即启；失败 → killChain 完成 + 连接惰性重建后再启）；F-1/F-4 文案与恢复指引同步；无新旧 turn 双跑窗。
  - MF3（60min 零探针+自相矛盾）→ 归属论证拆分重写（idle 层「活跃流零误杀」与上界层「显式接受的残余误杀面」分开陈述）；§2 目标 1 加 carve-out；F-2 补量化（T001 最长 541s，先验 6.6×）+ env 自救指引；§11 新增 ⛔P-Z0（任务总时长分布标定，降级路径预定义）。
  - S1（keep-alive 复核缺角）→ D9 中段登记残余误杀面 + P-Z1 扩展 chatMode 轮内 gap 类比采样；S2（迟到 terminal 路由）→ U1 补 lookupTurn 归因放宽；S3（崩溃类判据类型化）→ ChannelClosedError 与 TurnTimeoutError 两判据族并列（D6/F-4；实施落点修正：类型化形态为 `transient:"conn-closed"` 结构化标记而非独立 Error 类，见 F-4）；S4（A2 测量口径）→ 改 app-server journal/SQLite usage 快照对比；S5（负面验收缺位）→ 新增 A10（env ≤0 关闭行为 + 超上界逃生门等价模拟）；S6（clone 版本偏移）→ 引用处标注 0.84.2 落后实装 0.84.4 + 实施期 dist 复核标注。INFO（create 应答刷新源）→ 删除并注明先于挂 timer 到达。
  - 联动同步：正文决策（D1/D3/D6/D9）、终态数据流图（§4/§5.1 abort 链入口标注）、失败路径（F-2 量化）、§10 拆分（U1 归因放宽）、§8 验收（A2 口径/A10 新增）、§11 探针（P-Z0/P-Z1 扩展）七处全部同步。
- v1.2（2026-09-05）：**第 2 轮聚焦复审修复**（1 MF/6 SG/2 INFO 全修，报告 .review/timeout-zcode-turn-r2.md；r1 三条 MF 修复全部经重演+源码核实验证成立——三态判据可判定性/链终局信号源可达性/P-Z0 数据源实存均确认）。①MF（A2 验收结构性不可满足，v1.1 修 S4 时自己引入）：SIGSTOP 冻结进程不处理请求不落盘，「证明 stop 已送达」断言在该形态不可判定——A2 断言改 killChain 路径可判定（stop 3s 超时 → 杀链 → 进程 exit/close → 快照无新增消耗）；新增 A11（stop 送达止损分支：fake app-server 注入 stop 应答成功+terminal 永不到达，断言链不升级+进程存活+文案「stop 已送达」）——F-1 两止损分支各有独立场景。②SG-1：§9 实施表补 A10 映射（①②挂 M1、①b settled env 挂 M3——v1.1 声称七处同步实漏此第八处）；③SG-2：§7 总表止损动作改三态表述（原「session/stop → grace → killChain」是用户取消入口的 grace 概念，超时入口无 grace 段）+ engine 分流段「fire」改「await 链终局后」（防实施者照抄用户取消入口的 void 形态使 D6 时序静默失效）；④SG-3：常量表头改「除中段阈值外均 env 可覆盖」（与 D9 中段不开 env 定案消矛盾）；⑤SG-4：F-1 示例 30000ms → 1800000ms（30s 数值会照抄进错误文案与 30min 行为不符）；⑥SG-5：「九个」→「十一个」（A10+A11）；⑦SG-6：A5 补无双跑窗断言（journal 不出现第二个 session/create 或新 turn 事件）；INFO-1（stop 幂等假设）→ A2 journal 检查顺带留意；INFO-2（畸形 code 帧误判边缘）→ D3 判据段登记 + 双保险可选。
- v1.3（2026-09-05）：**第 3 轮聚焦复审 0 must-fix / 5 SG / 2 INFO，当轮全修收口**（报告 .review/timeout-zcode-turn-r3.md；三轮收敛 3→1→0 MF，r2 全部 9 条修复验证成立）。①SG-1：A11 快照断言改 fake state 流水证据（FAKE_STATE_FILE stop-recv 帧——fake 不产 usage 数据，快照在该场景恒真空转）；②SG-2：A11 注入形态写明 hangOnly + stopBehavior:'none'（send 后静默才触发 idle，防漂移 ceiling）；③SG-3：§8 依赖说明补 A11（fake/真实边界 11 场景全覆盖）；④SG-4：A2 补 outcome 文案断言（与 A11 对称，D3 强制可观测面）；⑤SG-5：D2 补 ≤0 关闭的 warn 规格（A10① 断言依据）+ 与 settled 先例的刻意分歧显式登记（先例 ≤0=非法回落禁用 env，本设计 ≤0=显式关闭）；⑥INFO：A.3 错误码表出处指针 + §8 结论五条目标行回溯补全。**设计就绪。**
