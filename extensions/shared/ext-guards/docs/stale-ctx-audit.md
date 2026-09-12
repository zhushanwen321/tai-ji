# stale ctx 普查清单与「stale 静默语义」判定表（crash-resilience u1-ext-guard 交付物；设计文档已删，git 可追溯）

> 依据：docs/design/crash-resilience.md（已删除，git 可追溯；独有档案已并入 docs/design/crash-forensics-and-watchdog.md 附录 D）§3.3 D1（extension 异步回调守卫）· §2.2 事件 E1 · §3.5 P-stale-throw / P-stale-wording / P-guard-holds。
> 守卫：`@zhushanwen/pi-ext-guards` 的 `guardStaleCtx(fn, opts)`——前置代际检查（isCtxStale，主判）+ fn 同步执行 + 错误文案 `stale after session replacement` 分诊（兜底）；stale 类静默降级（调 `opts.onStale`），非 stale 类原样上抛（守卫不吞真实 bug）。
> 分诊词是 pi 语义断言：登记 docs/pi-semantics.json PS-30（探针 `extensions/shared/ext-guards/src/__tests__/pi-semantics-stale-ctx-wording.test.ts`），随 C-proc-08 pi 版本门禁自动重验。

## 1. pi 实装锚点（0.84.4 实测，守卫分诊的适用面）

- `runner.js`：`invalidate()`（:396）默认 message 含 `stale after session replacement`（staleMessage 唯一写入点）；`assertActive()`（:402-406）`throw new Error(this.staleMessage)`；`createContext()`（:503 起）的 ctx 全部方法（`compact`/`abort`/`shutdown`/`getContextUsage`/`isIdle` 等）逐个 `assertActive()` 前置；session 替换时 `agent-session.js:595` 调 invalidate。
- `loader.js`（:291-321 起）：pi API 的 `sendMessage`/`sendUserMessage`/`appendEntry`/`setSessionName` 等每个方法 `assertActive()` 前置后转发共享 runtime——E1 崩溃堆栈帧 `assertActive → sendUserMessage` 的实装位置。
- **崩溃面分层（本次普查新增实证）**：pi runner 的 `emit()`（runner.js :628-656）对每个事件 handler 有 try/catch（错误转 `emitError`，不崩进程）。因此「事件 handler 内的 pi/ctx 调用」**不是 E1 同款无人接崩溃面**（E1 的崩溃点是 compact 的 onComplete/onError——由 AgentSession.compact 的内部 Promise 链调用，不在任何 pi 侧 catch 内）。事件 handler 接入守卫的价值 = stale 降级的可观测 debug 日志 + D1 防线统一 + 对未来 pi 派发语义变化的防御纵深，而非即刻防崩。

## 2. 接入清单（本次改动）

| 包 | 文件 | 接入点 | 守卫配置 |
|---|---|---|---|
| ext-guards | `src/index.ts` | 新增 `guardStaleCtx` / `STALE_CTX_MARKER` | —（守卫本体） |
| smart-context | `src/tool.ts` | `compact_context` 的 `onComplete`/`onError` 两处（E1 实锤崩溃点，tool.ts 原 :183/:187） | isCtxStale 注入 + onStale=debugLog |
| smart-context | `src/index.ts` | `agent_settled` 阈值提醒、`model_select` 跨界通知、`model_select` downshift 三处 `pi.sendUserMessage`（原 :127/:144/:157） | isCtxStale（模块级代数计数器，同 scheduler G1 范式）+ onStale=debugLog |
| plan | `src/compact.ts` | `handlePlanComplete` compact 隔离流的 `onComplete`/`onError` 两处（原 :218-229） | 文案兜底分诊（无代际，判定见 §4）+ onStale=logger.warn |
| scheduler | `src/runtime.ts` | `startScheduler` 的 tick 回调整体迁移到 `guardStaleCtx`（三件套语义等价，对照见 §5） | isCtxStale + onStale=retireStaleTimer |
| structured-output | `src/loop-gate.ts` | terminal teardown 的 `ctx.abort()`/`ctx.shutdown()` | onStale=stderr 直出（该包日志惯例） |
| subagent-workflow | `src/interface/helpers.ts` | `notifyDone` 的 `pi.sendMessage`（workflow-result 完成通知，原 :150；经 onRunDone 异步触发，审计 §7 blockers#1 收口） | label 分诊 + onStale=logger.warn（extension-logger `subagents` 通道） |
| subagent-workflow | `src/session-lifecycle.ts` | ledgerHost `sendDelivery` 的 `pi.sendMessage`（同链路家族同判） | 同上 |

配套依赖声明（workspace:\*）：smart-context / plan / scheduler / structured-output 的 package.json 各加 `@zhushanwen/pi-ext-guards`。

## 3. 全仓普查清单（grep 模式 × 逐包判定）

普查模式（设计 §5 U1）：① `ctx.compact(`；② `setInterval`/`setTimeout` 回调内 `pi.`/`ctx.` 调用；③ `pi.on`/`pi.events.on` 回调内捕获旧 ctx/pi（含全部 `pi.sendUserMessage`/`pi.sendMessage`/`pi.appendEntry` 命中的上下文归因）。

| 包 | 命中点 | 判定 | 理由 |
|---|---|---|---|
| **smart-context** | tool.ts compact 两回调（E1 实锤）；index.ts 三处事件回调内 `pi.sendUserMessage` | **接入** | E1 实锤崩溃点（9/3 pi-crash log 堆栈 `assertActive → sendUserMessage`）；三处事件回调为 D1「所有 fire-and-forget 异步回调接入」判定对象（价值见 §1 崩溃面分层） |
| **plan** | compact.ts :218-229 两处；compact.ts :258-263 case "direct"/default（`pi.sendUserMessage` + `tryGoalInit`）；command.ts :67/:164（/plan command handler 内） | **接入**（compact 两处）；**排除**（case "direct"、command 两处） | compact 回调与 E1 同构（无人接的 Promise 链）；case "direct" 在 plan 工具 execute 的同步链（`handlePlanComplete` 尾部 switch，经 tool.ts executeComplete 在用户批准 plan 的当次工具调用内执行），执行时 session 活跃，无跨 session 存活窗口；command handler 是用户主动触发的同步上下文，同理由 |
| **scheduler** | runtime.ts tick（setInterval 回调内 `onAfterTick → ctx.ui` / dispatch → `pi.sendMessage`） | **迁移**（共享守卫替换原地实现） | 既有已验证范式（G1+F2+retireStaleTimer），迁移语义等价对照见 §5 |
| **structured-output** | loop-gate.ts terminal 的 `ctx.abort()`/`ctx.shutdown()`（无防御）；workflow-hook.ts :249 `pi.sendUserMessage`（try/catch 有痕降级）；loop-gate forceExit setTimeout（只 `process.stderr.write` + `process.exit`） | **接入**（loop-gate terminal）；**排除**（workflow-hook、forceExit timer） | abort/shutdown 在 assertActive 面且无任何 try/catch（async handler 内 throw = 无人接 rejection）；workflow-hook 的 turn_end 已有 try/catch + writeSteerFailedLog（无崩溃面；守卫「非 stale 上抛」语义在此处会把有痕降级恶化为崩溃，不接入是行为保持）；forceExit timer 不触碰 pi/ctx |
| **pending-notifications** | events.on 回调内 `pi.appendEntry`（经 safeAppendEntry） | **排除** | 包内 `safeAppendEntry` 已 try/catch 静默兜底（注释明言 stale 场景）；events.on 订阅经 pi tracked subscription 在 session 替换时自动退订（W4 注释实锚 loader.js:338-341）——双防线已覆盖，无无人接抛错路径 |
| **cw-tool** | cw-runner.ts :180 setTimeout | **排除** | timer 回调只置本地 `timedOut` 标志 + `combined.abort()`（AbortController），不触碰任何 pi/ctx API，无 stale 面 |
| **goal** | src/adapters/command-adapter.ts :381（/goal command handler 内 followUp）；src/adapters/event-handlers/agent-end.ts :179 `pi.appendEntry`（agent_end handler 内） | **排除**（普查实证后无需接入） | command handler = 同步上下文（同 plan command 排除理由）；agent_end handler 在 pi `emit()` 的 try/catch 内（§1 实证）——stale throw 被 pi 捕获转 emitError，非崩溃面 |
| **base-tool-enhance** | src/background/notify.ts :154 `pi.sendMessage`（任务完成通知）；poller.ts setInterval | **排除** | sendTaskFinishedMessage 已有 try/catch（注释明言「旧 bus 已 dispose（session 替换毫秒窗口）——降级日志，不中断轮询」）；pollTick 链路经同一 handleTaskExit 入口 |
| **cache-probe** | before_agent_start / before_provider_request handler 内多处 `pi.appendEntry` | **排除** | 全部调用点已有 try/catch（appendErr 兜底 + stderr 诊断），且在 pi emit() catch 之内——双覆盖 |
| **subagent-workflow** | src/injectors/engine-awareness.ts :181（before_agent_start handler 内 try 块）；session-lifecycle.ts sendDelivery；interface/helpers.ts notifyDone :150（`pi.sendMessage` workflow-result）；jsonl-run-store.ts :477 setTimeout | **接入**（notifyDone / sendDelivery 链路，审计 §7 blockers#1 已收口）；**排除**（engine-awareness / jsonl-run-store） | engine-awareness 有 handler 内 try + emit() catch 双覆盖；jsonl-run-store timer 是纯文件持久化 debounce（`.catch(() => {})`，不触碰 pi/ctx）；**notifyDone 经 onRunDone 在 workflow 完成链路异步触发，不在 pi emit() catch 内、无自有 try/catch**——session 替换窗口 stale 即无人接 rejection（同 E1 机制）；sendDelivery 与 notifyDone 同链路家族（settled 边沿 / 看门狗 / 恢复重放异步触发） |
| **unified-hooks** | pi.appendEntry（已废弃包） | **排除** | 包已 deprecated（被 base-tool-enhance 整包取代），残留安装场景不在维护面 |
| **system-prompt** | index.ts :255 `before_agent_start` handler（唯一 hook） | **排除** | handler 同步执行、只做文件读 + 字符串拼接（`buildSystemPrompt` 不触碰任何 pi/ctx 方法）；无 timer / 无 Promise 回调 / 无捕获旧 ctx；失败路径经 `logHookFailure` 双层 try/catch 兜底（logger 自身抛错也内吞），无无人接抛错路径 |
| **ask-user** | index.ts `execute`（await `ui.custom`/`askUserInteract` 后调 `disableAskUser(pi)`）；channel-handler.ts 捕获 session_start ctx 的 channel handler（subagent 请求到达时异步调用 `ctx.ui.select`/`ctx.ui.custom`） | **排除** | execute 全程在 pi 工具执行链的 await/catch 结构内（agent-loop 对 execute throw 置 isError——index.ts 头注释 SDK 契约自证），无无人接 rejection；channel handler 是包内唯一跨 session 存活的异步闭包，但其抛错由调用方 subagent-core dialog-queue 兜底为 `{cancelled:true}`（dialog-queue.ts「handler 抛错兜底」注释自证）——有痕降级非崩溃面（同 base-tool-enhance sendTaskFinishedMessage 判例）；handler 无 timer / 无自注册延迟调用 |
| **todo** | handlers.ts 5 个 `pi.on`（session_start/session_tree/agent_start/before_agent_start/agent_end，async 体内无 await）；commands.ts /todos handler `await ctx.ui.custom`；tool.ts execute | **排除** | 全部 ctx/pi 调用（`reconstructState` 读 sessionManager、`ctx.ui.setStatus`/`setWidget`、refreshDisplay）都在同步上下文或 pi 自有 await 链——ctx 是事件派发时入参，非注册时捕获的旧引用；无 timer、无跨 session 存活回调（同合并行 permission「setTimeout 是本地 Promise」类排除理由） |
| **ext-guards** | 守卫宿主包（`guardStaleCtx`/`oncePerProcess` 定义处，src/index.ts 唯一 `.then` 是守卫自身 rejection 分诊实现） | **排除** | 非 pi extension 的零依赖纯函数库（无 pi SDK peerDep，包注释自证），自身不捕获、不持有任何 pi/ctx——守卫宿主 ≠ 自身豁免，按源码事实判定为零调用面 |
| **rename-session / msg-id-mapper / agent-ext / system-prompt-trace / extension-logger / file-lock / llm-shared / session-manager / session-reader / smart-context 其余模块 / permission / plugin-bridge（taiji）** | 普查无「跨 session 存活异步回调触碰 pi/ctx」命中 | **排除** | permission 的 setTimeout 是 classifier 超时（resolve 本地 Promise）；plugin-bridge 的 setTimeout 是 sync 重试/网关超时（Promise 竞速，不触碰 pi API）；其余命中点（pi.appendEntry 等）均在同步上下文（session_start/工具 execute 直接链）或供依赖注入的闭包声明，无 stale 窗口 |

## 4. 「stale 静默语义」判定表（每接入包：stale 时静默意味着什么、用户出路）

| 包:场景 | stale 静默的具体含义 | 用户可见影响 | 恢复路径（用户出路） | 观测（stale 降级日志） |
|---|---|---|---|---|
| **smart-context**：compact `onComplete` | 压缩完成的结果消息不投递——**压缩本身已完成并落盘**（compaction entry 已写入），丢的只是结果通报 | 压缩后无「压缩完成」消息；上下文实际已压缩，可继续工作 | 无需恢复；对压缩效果有疑虑可重试 `/compact` 或 `compact_context` | `~/.pi/agent/logs/`（XYZ_AGENT_DEBUG=1）：`compact result delivery skipped (stale ctx)` |
| **smart-context**：compact `onError` | 压缩失败的告警消息不投递——用户不知道该轮压缩失败了 | 上下文未变化（压缩失败无副作用），只是没有失败提示 | 稍后重试 `/compact`；反复失败查 smart-context 配置 | 同上：`compact failure notice delivery skipped (stale ctx)` |
| **smart-context**：agent_settled 阈值提醒 | 一次性越档提醒不投递——fired 标记已置位（旧代闭包内），该提醒本次不重发 | 少收一条「上下文将满」提醒；下轮 settled 若仍在同一 session 会重新评估（标记随 session 重建） | 用户可主动 `/compact`；切回该 session 后提醒机制随新代重建正常工作 | 同上：`threshold reminder delivery skipped (stale ctx)` |
| **smart-context**：model_select 两处通知 | 模型可用性变化/downshift 提醒不投递（用户切了 session，通知对旧 session 无意义） | 无实际影响（通知对象是已离开的 session 上下文） | 无需恢复 | 同上：`switch/downshift notice delivery skipped (stale ctx)` |
| **plan**：compact 隔离 `onComplete`/`onError` | 「Plan approved，开始执行」的执行指令消息不投递 + goalInit 不触发——**plan 文件本身已落盘** | 用户批准 plan 后未见执行启动（压缩隔离流被 session 替换打断） | **用户可手动 Read plan 文件执行**（plan 文件路径在批准交互中有留痕）；或重新走 /plan | `~/.pi/agent/logs/`：`plan execution notice delivery skipped (stale ctx)`（logger.warn） |
| **scheduler**：tick stale 自停（retireStaleTimer） | 泄漏 timer 自停退场，旧代 runtime 不再调度——任务持久化（append-only op）不受影响，新一代 runtime 的 session_start 已接管调度 | 无感知（调度由新代接管；旧代自停正是防「任务双投递」） | 无需恢复 | `tick stopped: stale extension ctx (session replaced); timer self-retired`（warn，行为同迁移前） |
| **structured-output**：terminal teardown | 跳过优雅 abort/shutdown——该 workflow 子进程的存在意义已随 session 替换消失，15s 硬退兜底（armForceExitTeardown）保持武装完成自清理 | 无感知（子进程延迟 ≤15s 自退） | 无需恢复 | stderr（runtime 的 pi tee 可见）：`terminal teardown skipped (stale ctx, session replaced)` |
| **subagent-workflow**：notifyDone 完成通知 | workflow 完成通知（workflow-result 消息 + `__gui__` 渲染数据）不投递——**run 本体已终态落盘**（jsonl-run-store 持久化 + session 历史的 workflow 工具调用 entry 不受影响） | workflow 结束时无完成通知消息；用户可从 session 历史 / 工具结果看到 workflow 结果（status/trace 持久化面） | 重新打开该 session 查看 workflow 工具调用记录；或重跑 workflow | `~/.pi/agent/logs/`（`subagents` 通道）：`workflow completion notice delivery skipped (stale ctx)`（含 runId） |
| **subagent-workflow**：sendDelivery 账本投递 | 本条通知不投递；attemptDeliver 按已受理标 sentAt（账面无重投）——session 替换后通知对旧 session 已无意义，与守卫前「留 pending 反复撞 stale 直到账本重绑」终局一致 | 旧 session 的 subagent 完成通知缺失；subagent 结果仍可从 session 历史 / bg-notify 渲染历史看到 | 打开对应 subagent session 查看结果；重启恢复面只覆盖未销账号，此路径为已受理态不重放 | 同上：`notify delivery skipped (stale ctx)` |

**分诊词退化的统一语义**（D1 降级声明）：pi 升级改掉 stale 文案且 PS-30 门禁未及时更新时，守卫退化为「非 stale 判定 → 全部上抛」——回到与 E1 相同的崩溃链路（有 pi-crash log 取证，不更危险），门禁报红提示同步 `STALE_CTX_MARKER`。

## 5. scheduler 迁移的三件套语义等价对照

| 三件套 | 迁移前（原地实现） | 迁移后（guardStaleCtx） | 等价性 |
|---|---|---|---|
| G1 前置检查 | interval 回调首行 `if (this.isCtxStale?.()) { this.retireStaleTimer(); return }` | 守卫前置检查 `isCtxStale` 命中 → `onStale`（=retireStaleTimer）且 tickScheduler 不执行 | 等价：retire 调用点从前置分支移入守卫 onStale；tick 不执行；`tick stopped` warn 口径不变（U1/G1-b 测试锚定，迁移后复跑通过） |
| F2 catch 分诊 | `void this.tickScheduler().catch(err => this.isCtxStale?.() \|\| msg.includes(STALE_CTX_MARKER) ? retireStaleTimer() : warn('tick error'))` | 守卫对 async fn 的 rejection 用同一谓词分诊：stale → onStale；非 stale → 原样 reject → 外层 `.catch` warn `'tick error'`（`toErrorMessage` 与原 `err instanceof Error ? .message : String()` 同实现） | 等价：分诊谓词字面一致（代际主判 \|\| 文案兜底）；非 stale 的 warn 调用点从守卫内移至守卫外 .catch，文案与「不终止调度」语义不变（U2/G1-c/G1-d 锚定） |
| retireStaleTimer 自停 | 私有方法：warn `tick stopped: stale extension ctx (session replaced); timer self-retired` + 幂等 `stopScheduler()` | 未改动 | 完全一致 |
| STALE_CTX_MARKER 常量 | 本模块字符串常量 | 改为 import ext-guards 的共享常量（同一字面量） | 值不变；文案稳定性责任上移到 PS-30 门禁 |

## 6. P-guard-holds 探针执行记录（pi CLI RPC 实测，⛔ 交付门）

**执行环境**：2026-09-09，本机 pi CLI 0.84.0（RPC 模式；stale 文案与 workspace 实装 0.84.4 一致，已先行核对全局安装的 runner.js :352 invalidate 默认 message）；模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`（真实 LLM）；dev extension 直挂 `extensions/universal/smart-context`；`PI_CODING_AGENT_DIR` 指向 mkdtemp 临时目录（凭据文件复制 + 低阈值配置 `reminderThresholds: [100,200,300]`，对齐 A10 阈值校准法——压缩触发面在测试配置内构造，链路全真实）+ `XYZ_AGENT_DEBUG=1`；session-dir 为临时目录，实测后整体删除。

**场景 1（P-guard-holds 主场景，stale）**：stdin JSONL 发 `prompt` → 模型调用 `compact_context`（tool_execution_end isError=false，工具返回「压缩已启动」）→ 3 秒后发 `new_session`（session 替换，runner invalidate）→ 10 秒后发 `get_state`。

结果 **PASS**，四项断言：

```
pi_alive_get_state_replied=true          # RPC 连接存活，pi 进程未退出
guard_degradation_log_found=true         # 守卫降级日志落盘（见下）
stale_assertActive_surfaced=false        # 无 assertActive 堆栈浮出（stdout/stderr 事件流均无）
pi_exited_before_assert=false
VERDICT=PASS
```

守卫降级日志（`<agentDir>/logs/smart-context-2026-09-09.log`，两条）：

```
2026-09-09T16:48:09.641Z [debug] compact failure notice delivery skipped (stale ctx): This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload. ...
2026-09-09T16:48:37.243Z [debug] compact failure notice delivery skipped (stale ctx): This extension ctx is stale after session replacement or reload. ...
```

触发路径与 E1 实锤堆栈（`assertActive → sendUserMessage → onError`）完全同构：session 替换后 compact 的 `onError` 回调触发，回调内 `pi.sendUserMessage` 命中 stale ctx 同步 throw——未守卫前即 9/3 的 pi exit 1；守卫捕获后静默降级，pi 进程存活。同一场景连续两次触发（两次 compact 尝试）守卫均拦截。

**场景 2（A2 负面验证，不切 session）**：同配置、大背景文本 prompt（推上下文过 pi 压缩门槛 20K tokens，filler ≈27K tokens）→ `compact_context` 执行 → 不切 session → 等待压缩完成。

结果 **PASS**：

```
compact_context executed=true
compact RESULT message observed (onComplete steer arrived)   # onComplete → pi.sendUserMessage('[smart-context] 压缩完成…') 正常注入对话流
pi_alive_get_state_replied=true
VERDICT=PASS
```

守卫不改变正常路径：onComplete 回调在同一守卫包裹下正常完成「结果消息投递」。

**与设计 A9① 的对齐**（crash-resilience §4 验收表，该设计文档已删除 git 可追溯）：场景 1 + 场景 2 合并覆盖 A9① 断言的实质两面——场景 1 以 pi CLI RPC 直跑（不经 xyz-agent）验证错误路径（stale 静默降级、pi 进程存活、无 assertActive 堆栈浮出），场景 2 验证正常路径零行为变化（onComplete 结果消息正常投递）——即「pi 行为无任何变化（ext-guards 守卫只在错误路径生效）」的正反两面均有实测。

**已知边界（如实记录）**：① 本机全局 pi 为 0.84.0（workspace 实装 0.84.4），文案已核对一致；0.84.4 侧由 PS-30 静态探针（CI 内守卫，ext-guards 包测试全绿）覆盖。② 一轮 stale 补充场景中模型未配合调用 compact_context（LLM 行为波动，非守卫问题），未计入判定——判定以上述两场景为准。③ pi 原生 compact 有 `Nothing to compact (session too small)`（keepRecentTokens 默认 20000）门槛，实测用大 prompt 构造跨过；`settings.json` 的 `compaction.keepRecentTokens` 覆盖在 0.84.0 CLI 下未生效（键被忽略，原因未深查），如实登记。

## 7. Blockers（清单外疑似风险面，待主 agent 裁决）

1. **subagent-workflow `notifyDone`**（`src/interface/helpers.ts` :150 `pi.sendMessage`，调用链 `src/index.ts` :248 `onRunDone`）：workflow 完成链路异步触发，不在 pi `emit()` catch 内、无自有 try/catch——session 替换窗口 stale 即同 E1 机制崩 pi。同链路家族的 `session-lifecycle.ts` sendDelivery 依赖注入封装同判。超出本单元授权包清单（structured-output / pending-notifications / cw-tool），未改动，建议作为后续单元接入 `guardStaleCtx`。
   **【已收口 2026-09-09】**两处均已接入 `guardStaleCtx`（`subagent-workflow:notifyDone` / `subagent-workflow:sendDelivery`，stale 静默语义判定见 §4），单测 `src/__tests__/notify-stale-guard.test.ts` 锁定 stale 静默 / 非 stale 上抛 / 正常路径透传三面。
