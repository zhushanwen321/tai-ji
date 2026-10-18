# stale ctx 普查清单与「stale 静默语义」判定表（crash-resilience u1-ext-guard 交付物；设计文档已删，git 可追溯）

> 依据：docs/design/crash-resilience.md（已删除，git 可追溯；独有档案已并入 docs/architecture/crash-forensics-and-watchdog.md 附录 D）§3.3 D1（extension 异步回调检查）· §2.2 事件 E1 · §3.5 P-stale-throw / P-stale-wording / P-guard-holds。
> 检查：`@zhushanwen/pi-ext-guards` 的 `guardStaleCtx(fn, opts)`——前置代际检查（isCtxStale，主判）+ fn 同步执行 + 错误文案 `stale after session replacement` 分诊（兜底）；stale 类静默降级（调 `opts.onStale`），非 stale 类原样上抛（检查不吞真实 bug）。
> 分诊词是 pi 语义断言：登记 docs/pi-semantics.json PS-30（探针 `extensions/shared/ext-guards/src/__tests__/pi-semantics-stale-ctx-wording.test.ts`），随 C-proc-08 pi 版本门禁自动重验。

## 1. pi 实装锚点（0.84.4 实测，检查分诊的适用范围）

- `runner.js`：`invalidate()`（:396）默认 message 含 `stale after session replacement`（staleMessage 唯一写入点）；`assertActive()`（:402-406）`throw new Error(this.staleMessage)`；`createContext()`（:503 起）的 ctx 全部方法（`compact`/`abort`/`shutdown`/`getContextUsage`/`isIdle` 等）逐个 `assertActive()` 前置；session 替换时 `agent-session.js:595` 调 invalidate。
- `loader.js`（:291-321 起）：pi API 的 `sendMessage`/`sendUserMessage`/`appendEntry`/`setSessionName` 等每个方法 `assertActive()` 前置后转发共享 runtime——E1 崩溃堆栈帧 `assertActive → sendUserMessage` 的实装位置。
- **崩溃范围分层（本次普查新增实证）**：pi runner 的 `emit()`（runner.js :628-656）对每个事件 handler 有 try/catch（错误转 `emitError`，不崩进程）。因此「事件 handler 内的 pi/ctx 调用」**不是 E1 同款无人接崩溃范围**（E1 的崩溃点是 compact 的 onComplete/onError——由 AgentSession.compact 的内部 Promise 链调用，不在任何 pi 侧 catch 内）。事件 handler 接入检查的价值 = stale 降级的可观测 debug 日志 + D1 防线统一 + 对未来 pi 派发语义变化的防御纵深，而非即刻防崩。

## 2. 接入清单（本次改动）

| 包 | 文件 | 接入点 | 检查配置 |
|---|---|---|---|
| ext-guards | `src/index.ts` | 新增 `guardStaleCtx` / `STALE_CTX_MARKER` | —（检查本体） |
| smart-context | `src/tool.ts` | `compact_context` 的 `onComplete`/`onError` 两处（E1 实锤崩溃点，tool.ts 原 :183/:187） | isCtxStale 注入 + onStale=debugLog |
| smart-context | `src/index.ts` | `agent_settled` 阈值提醒、`model_select` 跨界通知、`model_select` downshift 三处 `pi.sendUserMessage`（原 :127/:144/:157） | isCtxStale（模块级代数计数器，同 scheduler G1 范式）+ onStale=debugLog |
| plan | `src/execution-notice.ts`（原 compact.ts） | 已退役：原接入点 src/compact.ts :218-229 两处回调已随 D-B1-6 形态砍除（文件改名 execution-notice.ts，回调通道不存在，无接入范围；全包 `guardStaleCtx` 零调用） | — |
| scheduler | `src/runtime.ts` | `startScheduler` 的 tick 回调整体迁移到 `guardStaleCtx`（三件套语义等价，对照见 §5） | isCtxStale + onStale=retireStaleTimer |
| structured-output | `src/loop-gate.ts` | terminal teardown 的 `ctx.abort()`/`ctx.shutdown()` | onStale=stderr 直出（该包日志惯例） |
| subagent-workflow | `src/workflow-notify.ts` | `notifyDone` port 缺席降级的 `pi.sendMessage`（workflow-result 完成通知，经 onRunDone 异步触发；主路径已切 port.deliver——同步受理结果 + port 内部 try/catch，审计 §7 blockers#1 收尾形态随统一投递波 2 迁移） | label 分诊 + onStale=logger.warn（extension-logger `subagents` 通道） |
| subagent-workflow | `src/session-lifecycle.ts` | 已退役：ledgerHost `sendDelivery` 接入随通知账本退役删除（投递归 pi-delivery-port，本包零装配义务） | — |
| session-manager | `src/notify-delivery.ts` | 已退役：原 `src/notify-ledger.ts` sendDelivery 接入范围随通知账本退役删除；现行链 = `recordManagedNotify` → `port.deliver`（同步受理结果 + 自有 try/catch + warn 降级，无检查接入范围） | — |

配套依赖声明（workspace:*）：smart-context / plan / scheduler / structured-output / session-manager 的 package.json 各加 `@zhushanwen/pi-ext-guards`——其中 plan 的 `guardStaleCtx` 接入已无调用（D-B1-6 退役），依赖保留（`toErrorMessage` 仍用于 state.ts / execution-notice.ts 的错误文案）。

## 3. 全仓普查清单（grep 模式 × 逐包判定）

普查模式（设计 §5 U1）：① `ctx.compact(`；② `setInterval`/`setTimeout` 回调内 `pi.`/`ctx.` 调用；③ `pi.on`/`pi.events.on` 回调内捕获旧 ctx/pi（含全部 `pi.sendUserMessage`/`pi.sendMessage`/`pi.appendEntry` 命中的上下文归因）。

| 包 | 命中点 | 判定 | 理由 |
|---|---|---|---|
| **smart-context** | tool.ts compact 两回调（E1 实锤）；index.ts 三处事件回调内 `pi.sendUserMessage` | **接入** | E1 实锤崩溃点（9/3 pi-crash log 堆栈 `assertActive → sendUserMessage`）；三处事件回调为 D1「所有 fire-and-forget 异步回调接入」判定对象（价值见 §1 崩溃面分层） |
| **plan** | 原接入点 compact.ts :218-229 两处回调（已随 D-B1-6 形态砍除——文件改名 execution-notice.ts，回调通道不存在，无接入面，全包 `guardStaleCtx` 零调用）；现存 execution-notice.ts 完成投递（`pi.sendMessage`，经 tool.ts :1235 `handlePlanComplete` 同步调用）；command.ts /plan command handler | **退役**（原 compact 两处接入）；**排除**（完成投递、command handler） | 原接入与 E1 同构（无人接的 Promise 链），形态已删；现存投递在 plan 工具 execute 的同步链（用户批准 plan 的当次工具调用内执行），执行时 session 活跃，无跨 session 存活窗口；command handler 是用户主动触发的同步上下文，同理由 |
| **scheduler** | runtime.ts tick（setInterval 回调内 `onAfterTick → ctx.ui` / dispatch → `pi.sendMessage`） | **迁移**（共享检查替换原地实现） | 既有已验证范式（G1+F2+retireStaleTimer），迁移语义等价对照见 §5 |
| **structured-output** | loop-gate.ts terminal 的 `ctx.abort()`/`ctx.shutdown()`（无防御）；workflow-hook.ts :249 `pi.sendUserMessage`（try/catch 有痕降级）；loop-gate forceExit setTimeout（只 `process.stderr.write` + `process.exit`） | **接入**（loop-gate terminal）；**排除**（workflow-hook、forceExit timer） | abort/shutdown 在 assertActive 范围且无任何 try/catch（async handler 内 throw = 无人接 rejection）；workflow-hook 的 turn_end 已有 try/catch + writeSteerFailedLog（无崩溃范围；检查「非 stale 上抛」语义在此处会把有痕降级恶化为崩溃，不接入是行为保持）；forceExit timer 不触碰 pi/ctx |
| **pending-notifications** | events.on 回调内 `pi.appendEntry`（经 safeAppendEntry） | **排除** | 包内 `safeAppendEntry` 已 try/catch 静默兜底（注释明言 stale 场景）；events.on 订阅经 pi tracked subscription 在 session 替换时自动退订（W4 注释实锚 loader.js:338-341）——双防线已覆盖，无无人接抛错路径 |
| **goal** | src/adapters/command-adapter.ts :381（/goal command handler 内 followUp）；src/adapters/event-handlers/agent-end.ts :179 `pi.appendEntry`（agent_end handler 内） | **排除**（普查实证后无需接入） | command handler = 同步上下文（同 plan command 排除理由）；agent_end handler 在 pi `emit()` 的 try/catch 内（§1 实证）——stale throw 被 pi 捕获转 emitError，非崩溃范围 |
| **base-tool-enhance** | src/background/notify.ts :154 `pi.sendMessage`（任务完成通知）；exit-collector.ts 的 ChildProcess `child.on("exit")` 监听 | **排除** | sendTaskFinishedMessage 已有 try/catch（注释明言「旧 bus 已 dispose（session 替换毫秒窗口）——降级日志，不中断后续通知」）；exit 边沿链路经同一 handleTaskExit 入口，回调链全模块级（task-store / notify 均模块级单例，无实例级 ctx/pi 捕获——pi 引用经 D17 refreshPiReference 刷新，session 替换不产生 stale 捕获） |
| **cache-probe** | before_agent_start / before_provider_request handler 内多处 `pi.appendEntry` | **排除** | 全部调用点已有 try/catch（appendErr 兜底 + stderr 诊断），且在 pi emit() catch 之内——双覆盖 |
| **subagent-workflow** | src/injectors/engine-awareness.ts :181（before_agent_start handler 内 try 块）；workflow-notify.ts notifyDone port 缺席降级的 `pi.sendMessage`（主路径已切 port.deliver——同步受理结果 + port 内部 try/catch，原 interface/helpers.ts 接入范围随统一投递波 2 迁移）；jsonl-run-store.ts :477 setTimeout | **接入**（notifyDone 缺席降级直发——不在 pi emit() catch 内，port 缺席窗口 stale 即无人接 rejection，同 E1 机制）；**排除**（engine-awareness / jsonl-run-store） | engine-awareness 有 handler 内 try + emit() catch 双覆盖；jsonl-run-store timer 是纯文件持久化 debounce（`.catch(() => {})`，不触碰 pi/ctx）；notifyDone 主路径经 port.deliver 同步返回受理结果无检查范围，仅缺席降级 sendMessage 保留检查接入 |
| **unified-hooks** | pi.appendEntry（已废弃包） | **排除** | 包已 deprecated（被 base-tool-enhance 整包取代），残留安装场景不在维护面 |
| **system-prompt** | index.ts :255 `before_agent_start` handler（唯一 hook） | **排除** | handler 同步执行、只做文件读 + 字符串拼接（`buildSystemPrompt` 不触碰任何 pi/ctx 方法）；无 timer / 无 Promise 回调 / 无捕获旧 ctx；失败路径经 `logHookFailure` 双层 try/catch 兜底（logger 自身抛错也内吞），无无人接抛错路径 || **ask-user** | index.ts `execute`（await `ui.custom`/`askUserInteract` 后调 `disableAskUser(pi)`）；channel-handler.ts 捕获 session_start ctx 的 channel handler（subagent 请求到达时异步调用 `ctx.ui.select`/`ctx.ui.custom`） | **排除** | execute 全程在 pi 工具执行链的 await/catch 结构内（agent-loop 对 execute throw 置 isError——index.ts 头注释 SDK 契约自证），无无人接 rejection；channel handler 是包内唯一跨 session 存活的异步闭包，但其抛错由调用方 subagent-core dialog-queue 兜底为 `{cancelled:true}`（dialog-queue.ts「handler 抛错兜底」注释自证）——有痕降级非崩溃面（同 base-tool-enhance sendTaskFinishedMessage 判例）；handler 无 timer / 无自注册延迟调用 |
| **todo** | handlers.ts 5 个 `pi.on`（session_start/session_tree/agent_start/before_agent_start/agent_end，async 体内无 await）；commands.ts /todos handler `await ctx.ui.custom`；tool.ts execute | **排除** | 全部 ctx/pi 调用（`reconstructState` 读 sessionManager、`ctx.ui.setStatus`/`setWidget`、refreshDisplay）都在同步上下文或 pi 自有 await 链——ctx 是事件派发时入参，非注册时捕获的旧引用；无 timer、无跨 session 存活回调（同合并行 permission「setTimeout 是本地 Promise」类排除理由） |
| **ext-guards** | 检查宿主包（`guardStaleCtx`/`oncePerProcess` 定义处，src/index.ts 唯一 `.then` 是检查自身 rejection 分诊实现） | **排除** | 非 pi extension 的零依赖纯函数库（无 pi SDK peerDep，包注释自证），自身不捕获、不持有任何 pi/ctx——检查宿主 ≠ 自身豁免，按源码事实判定为零调用点 |
| **notify-ledger-host** | 包已删除（随通知账本退役，原 sendDelivery / sendDisplayMessage 检查接入范围不复存在；投递归 extensions/shared/delivery-port，见 delivery-port 行） | **已退役** | — |
| **session-manager** | src/notify-delivery.ts recordManagedNotify → `port.deliver`（原 src/notify-ledger.ts sendDelivery 随通知账本退役删除）；watch-coordinator.ts :146 openWatch fire-and-forget watch promise（`.then` 应答回调 + rejection 分诊）；watch-coordinator.ts :224-227 WATCH_FLUSH_DEBOUNCE_MS flush timer（setTimeout → flush 攒批投递） | **排除**（全命中点） | recordManagedNotify → port.deliver 同步返回受理结果、自有 try/catch（warn 留痕）；port 注入口按 delivery-port 行设计内不接检查（stale throw 由内核收尾 retain），本链无检查接入范围。watch promise / flush timer 均为自有 try/catch 有痕降级非崩溃范围（同 provider-live-sync 判例）：watch promise 的 `.then` 应答回调整体自有 try/catch（error 留痕）+ rejection 分诊 warn，回调内 pi 触碰点 unregisterPending 的 `pi.events.emit` 自有 try/catch（stale bus warn 留痕）；flush timer 链触碰面 recordManagedNotify 自有 try/catch（warn 留痕，unregister 照常）、unregisterPending 同上；stale 窗口残留语义 = 该条通知 register 不即时注销，由 session_start 收尾路径 recoverStaleRegisters 兜底重开 watch 清理 |
| **rename-session / msg-id-mapper / agent-ext / system-prompt-trace / extension-logger / file-lock / llm-shared / exec-skills / session-path / session-reader / smart-context 其余模块 / permission** | 普查无「跨 session 存活异步回调触碰 pi/ctx」命中 | **排除** | permission 的 setTimeout 是 classifier 超时（resolve 本地 Promise）；session-path 是同步纯函数库（活跃路径裁剪，无 hook / timer / pi 捕获）；其余命中点（pi.appendEntry 等）均在同步上下文（session_start/工具 execute 直接链）或供依赖注入的闭包声明，无 stale 窗口 |
| **delivery-port** | delivery-port.ts 注入口（kernelPort.send 内 `pi.sendMessage`，经 merge timer / compaction 边沿 / settled 边沿 / 重放异步触发）；60s 合批窗口 setTimeout（armMergeTimer 回调 flushMergeBuffer → 内核出站链）；pi.on 三订阅回调（message_end / session_compact(_failed) / agent_settled） | **排除**（全命中点，设计内显式不接 guardStaleCtx） | ① 注入口刻意不接检查（unified-delivery 设计 §3.7 失败行：注入类失败显式走 retain 不吞咽）——stale throw 上抛后被内核 attemptSend 的 catch 收尾为 retain warn（session-delivery delivery.ts onSendFail），条目留守 outbox 由 session_start 差集重放闭环，有痕降级非无人接 rejection；② merge timer 回调链无探测范围（compaction 挂起由 compaction 事件标记承载，标记读取无异常范围——原 isIdle 探测随预检移除）+ 注入 throw 由内核出站 catch 收尾 retain（session-delivery delivery.ts onSendFail）；③ pi 事件回调自有 try/catch warn 兜底（message_end handler / compaction 边沿）+ pi emit() catch 双覆盖 |
| **provider-live-sync** | index.ts :287 setTimeout 轮询链（tick 内 :271/:273 `ctx.modelRegistry.refresh`/`getError`）；:232 session_start handler | **排除** | tick 全链 try/catch + logError 有痕降级（:279-283「轮询绝不自杀：本拍失败下一拍继续」注释明言）——session 替换窗口 stale 抛错被内吞为日志，非无人接 rejection（同 base-tool-enhance sendTaskFinishedMessage 判例）；session_start handler 仅同步赋值捕获新 ctx（:232-234），无 pi/ctx API 调用 |

## 4. 「stale 静默语义」判定表（每接入包：stale 时静默意味着什么、用户出路）

| 包:场景 | stale 静默的具体含义 | 用户可见影响 | 恢复路径（用户出路） | 观测（stale 降级日志） |
|---|---|---|---|---|
| **smart-context**：compact `onComplete` | 压缩完成的结果消息不投递——**压缩本身已完成并落盘**（compaction entry 已写入），丢的只是结果通报 | 压缩后无「压缩完成」消息；上下文实际已压缩，可继续工作 | 无需恢复；对压缩效果有疑虑可重试 `/compact` 或 `compact_context` | `~/.pi/agent/logs/`（TAIJI_AGENT_DEBUG=1）：`compact result delivery skipped (stale ctx)` |
| **smart-context**：compact `onError` | 压缩失败的告警消息不投递——用户不知道该轮压缩失败了 | 上下文未变化（压缩失败无副作用），只是没有失败提示 | 稍后重试 `/compact`；反复失败查 smart-context 配置 | 同上：`compact failure notice delivery skipped (stale ctx)` |
| **smart-context**：agent_settled 阈值提醒 | 一次性越档提醒不投递——fired 标记已置位（旧代闭包内），该提醒本次不重发 | 少收一条「上下文将满」提醒；下轮 settled 若仍在同一 session 会重新评估（标记随 session 重建） | 用户可主动 `/compact`；切回该 session 后提醒机制随新代重建正常工作 | 同上：`threshold reminder delivery skipped (stale ctx)` |
| **smart-context**：model_select 两处通知 | 模型可用性变化/downshift 提醒不投递（用户切了 session，通知对旧 session 无意义） | 无实际影响（通知对象是已离开的 session 上下文） | 无需恢复 | 同上：`switch/downshift notice delivery skipped (stale ctx)` |
| **plan**：compact 隔离 `onComplete`/`onError`（已退役） | 场景已随 D-B1-6 形态砍除（回调通道不存在，无检查接入）；现 complete 投递在 plan 工具 execute 的同步链内执行，session 活跃，无 stale 窗口 | — | — | — |
| **scheduler**：tick stale 自停（retireStaleTimer） | 泄漏 timer 自停退场，旧代 runtime 不再调度——任务持久化（append-only op）不受影响，新一代 runtime 的 session_start 已接管调度 | 无感知（调度由新代接管；旧代自停正是防「任务双投递」） | 无需恢复 | `tick stopped: stale extension ctx (session replaced); timer self-retired`（warn，行为同迁移前） |
| **structured-output**：terminal teardown | 跳过优雅 abort/shutdown——该 workflow 子进程的存在意义已随 session 替换消失 | 无感知（父进程按既有失败路径处理） | 无需恢复 | stderr（runtime 的 pi tee 可见）：`terminal teardown skipped (stale ctx, session replaced)` |
| **subagent-workflow**：notifyDone 完成通知（port 缺席降级直发） | 降级直发的完成通知（workflow-result 消息 + `__gui__` 渲染数据）不投递——**run 本体已终态写入**（jsonl-run-store 持久化 + session 历史的 workflow 工具调用 entry 不受影响） | workflow 结束时无完成通知消息；用户可从 session 历史 / 工具结果看到 workflow 结果（status/trace 持久化内容） | 重新打开该 session 查看 workflow 工具调用记录；或重跑 workflow | `~/.pi/agent/logs/`（`subagents` 通道）：`workflow completion notice delivery skipped (stale ctx)`（含 runId） |

**分诊词退化的统一语义**（D1 降级声明）：pi 升级改掉 stale 文案且 PS-30 门禁未及时更新时，检查退化为「非 stale 判定 → 全部上抛」——回到与 E1 相同的崩溃链路（有 pi-crash log 取证，不更危险），门禁报红提示同步 `STALE_CTX_MARKER`。

## 5. scheduler 迁移的三件套语义等价对照

| 三件套 | 迁移前（原地实现） | 迁移后（guardStaleCtx） | 等价性 |
|---|---|---|---|
| G1 前置检查 | interval 回调首行 `if (this.isCtxStale?.()) { this.retireStaleTimer(); return }` | 检查前置检查 `isCtxStale` 命中 → `onStale`（=retireStaleTimer）且 tickScheduler 不执行 | 等价：retire 调用点从前置分支移入检查 onStale；tick 不执行；`tick stopped` warn 口径不变（U1/G1-b 测试锚定，迁移后复跑通过） |
| F2 catch 分诊 | `void this.tickScheduler().catch(err => this.isCtxStale?.() \|\| msg.includes(STALE_CTX_MARKER) ? retireStaleTimer() : warn('tick error'))` | 检查对 async fn 的 rejection 用同一谓词分诊：stale → onStale；非 stale → 原样 reject → 外层 `.catch` warn `'tick error'`（`toErrorMessage` 与原 `err instanceof Error ? .message : String()` 同实现） | 等价：分诊谓词字面一致（代际主判 \|\| 文案兜底）；非 stale 的 warn 调用点从检查内移至检查外 .catch，文案与「不终止调度」语义不变（U2/G1-c/G1-d 锚定） |
| retireStaleTimer 自停 | 私有方法：warn `tick stopped: stale extension ctx (session replaced); timer self-retired` + 幂等 `stopScheduler()` | 未改动 | 完全一致 |
| STALE_CTX_MARKER 常量 | 本模块字符串常量 | 改为 import ext-guards 的共享常量（同一字面量） | 值不变；文案稳定性责任上移到 PS-30 门禁 |

## 6. P-guard-holds 探针执行记录（pi CLI RPC 实测，⛔ 交付门）

**执行环境**：2026-09-09，本机 pi CLI 0.84.0（RPC 模式；stale 文案与 workspace 实装 0.84.4 一致，已先行核对全局安装的 runner.js :352 invalidate 默认 message）；模型 `<本机可用模型>`（真实 LLM）；dev extension 直挂 `extensions/universal/smart-context`；`PI_CODING_AGENT_DIR` 指向 mkdtemp 临时目录（凭据文件复制 + 低阈值配置 `reminderThresholds: [100,200,300]`，对齐 A10 阈值校准法——压缩触发面在测试配置内构造，链路全真实）+ `TAIJI_AGENT_DEBUG=1`；session-dir 为临时目录，实测后整体删除。

**场景 1（P-guard-holds 主场景，stale）**：stdin JSONL 发 `prompt` → 模型调用 `compact_context`（tool_execution_end isError=false，工具返回「压缩已启动」）→ 3 秒后发 `new_session`（session 替换，runner invalidate）→ 10 秒后发 `get_state`。

结果 **PASS**，四项断言：

```
pi_alive_get_state_replied=true          # RPC 连接存活，pi 进程未退出
guard_degradation_log_found=true         # 检查降级日志落盘（见下）
stale_assertActive_surfaced=false        # 无 assertActive 堆栈浮出（stdout/stderr 事件流均无）
pi_exited_before_assert=false
VERDICT=PASS
```

检查降级日志（`<agentDir>/logs/smart-context-2026-09-09.log`，两条）：

```
2026-09-09T16:48:09.641Z [debug] compact failure notice delivery skipped (stale ctx): This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload. ...
2026-09-09T16:48:37.243Z [debug] compact failure notice delivery skipped (stale ctx): This extension ctx is stale after session replacement or reload. ...
```

触发路径与 E1 实锤堆栈（`assertActive → sendUserMessage → onError`）完全同构：session 替换后 compact 的 `onError` 回调触发，回调内 `pi.sendUserMessage` 命中 stale ctx 同步 throw——未检查前即 9/3 的 pi exit 1；检查捕获后静默降级，pi 进程存活。同一场景连续两次触发（两次 compact 尝试）检查均拦截。

**场景 2（A2 负面验证，不切 session）**：同配置、大背景文本 prompt（推上下文过 pi 压缩门槛 20K tokens，filler ≈27K tokens）→ `compact_context` 执行 → 不切 session → 等待压缩完成。

结果 **PASS**：

```
compact_context executed=true
compact RESULT message observed (onComplete steer arrived)   # onComplete → pi.sendUserMessage('[smart-context] 压缩完成…') 正常注入对话流
pi_alive_get_state_replied=true
VERDICT=PASS
```

检查不改变正常路径：onComplete 回调在同一检查包裹下正常完成「结果消息投递」。

**与设计 A9① 的对齐**（crash-resilience §4 验收表，该设计文档已删除 git 可追溯）：场景 1 + 场景 2 合并覆盖 A9① 断言的实质两面——场景 1 以 pi CLI RPC 直跑（不经 taiji）验证错误路径（stale 静默降级、pi 进程存活、无 assertActive 堆栈浮出），场景 2 验证正常路径零行为变化（onComplete 结果消息正常投递）——即「pi 行为无任何变化（ext-guards 检查只在错误路径生效）」的正反两面均有实测。

**已知边界（如实记录）**：① 本机全局 pi 为 0.84.0（workspace 实装 0.84.4），文案已核对一致；0.84.4 侧由 PS-30 静态探针（CI 内检查，ext-guards 包测试全绿）覆盖。② 一轮 stale 补充场景中模型未配合调用 compact_context（LLM 行为波动，非检查问题），未计入判定——判定以上述两场景为准。③ pi 原生 compact 有 `Nothing to compact (session too small)`（keepRecentTokens 默认 20000）门槛，实测用大 prompt 构造跨过；`settings.json` 的 `compaction.keepRecentTokens` 覆盖在 0.84.0 CLI 下未生效（键被忽略，原因未深查），如实登记。

## 7. Blockers（清单外疑似风险面，待主 agent 裁决）

1. **subagent-workflow `notifyDone`**（`src/interface/helpers.ts` :150 `pi.sendMessage`，调用链 `src/index.ts` :248 `onRunDone`）：workflow 完成链路异步触发，不在 pi `emit()` catch 内、无自有 try/catch——session 替换窗口 stale 即同 E1 机制崩 pi。同链路家族的 `session-lifecycle.ts` sendDelivery 依赖注入封装同判。超出本单元授权包清单（structured-output / pending-notifications），未改动，建议作为后续单元接入 `guardStaleCtx`。
   **【已完成 2026-09-09】**两处均已接入 `guardStaleCtx`（`subagent-workflow:notifyDone` / `subagent-workflow:sendDelivery`，stale 静默语义判定见 §4），单测锁定 stale 静默 / 非 stale 上抛 / 正常路径透传三面——notifyDone 检查组现役载体 = `src/__tests__/workflow-notify.test.ts`；sendDelivery 检查组随波 2 账本退役删除（被测装配 seam 已删除，port 形态对位锁面迁移至 pi-delivery-port 套件，见 session-lifecycle.test.ts 文末退役注记）。
