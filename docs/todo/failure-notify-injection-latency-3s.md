# 失败轮通知注入端到端 ~3s（设计场景 1 承诺 <1s）

状态：已修复关闭（2026-10-25 根因定位 + 修复落地 + 空载两轮复跑验证达标；本登记转终态存档）。

## 根因（探针实测闭环）

verify-taiji 场景 `p0-subagent-round-failure-facticity`（A1）加 env 门控时间戳探针实测，失败轮通知链（P1 = 父 pi 进程）各跳耗时：

| 跳 | 实测耗时 |
|----|---------|
| markRoundIdle 簿记（record idle 事件落盘 + journal 推送 → runtime 广播锚 `session.subagents` 到达） | ~15ms |
| `ChatRounds.finalizeRoundToIdle` 内 `await disposeWorkflowWindowEngineState`（轮窗口引擎实例收割） | **~3009ms** |
| notifier.notify → port.deliver → pi.sendMessage（steer + triggerTurn）→ custom entry 广播 | ~10ms（deliver 到 message_end 送达凭据边沿） |

收割 3s 的构成：dispose 协议帧 5ms 即 ack；大头在 `killAll` → `transport.close`——runtime 注入 `TAIJI_SUBAGENT_CONTROL_SOCKET`（`control-server.ts` getControlSpawnEnv），引擎客户端走 runtime transport，close 发 `engine_close` 后等 `engine_closed` 回执，宽限上界 = `CONTROL_CLOSE_GRACE_MS`（transport/control-shared.ts，3000ms）；engine_closed 迟到时 close 恒走满 3s 宽限。

根因 = `finalizeRoundToIdle` 在轮终簿记（markRoundIdle）之后 **await** 窗口引擎收割，而 settleRoundFailed / settleRoundSuccess 的轮终通知都排在该 await 之后——通知被引擎进程回收时延（3s 量级、可变）阻塞。登记时的对照证据「成功路径 80ms」不矛盾：其锚（details.endedAt）构造于收割之后，量不到这段；失败路径锚（record idle 广播）构造于收割之前，差值恰好暴露它。注入链本身（notifier → delivery-port → pi 注入）全程 ~10ms，与「嫌疑 = 失败分支载荷/投递链」的收窄方向不符——两分支共用同一投递通道，瓶颈在通道之外的收割 await。

## 处置

`packages/subagent-core/src/execution/service/chat-rounds.ts` `finalizeRoundToIdle`：窗口收割改 fire-and-forget（`void disposeWorkflowWindowEngineState(...)`），与本文件 `onRecordFinalizedCleanup` / `abortContinuationQueue` 的既有 void 形态一致。收割完成不 gate 任何下游：先摘后放（窗口状态在收割函数同步段摘除）保证续聊 drain 经轮窗口解析单点 respawn 的语义不变；单实例失败收集留痕在 `disposeWorkflowWindowEngineState` 内部，不因 void 丢失。

回归锁 = `packages/subagent-core/src/execution/__tests__/chat-rounds-window-dispose.test.ts` 新增用例「轮终通知不被窗口引擎 dispose 时延阻塞」：dispose 挂起时失败轮 settle 链照常落 idle 并发出通知；还原 await 形态该用例红（红绿双向验证过）。

## 验证

- A1 空载复跑两轮（mock-http 零 token 通道）：deltaMs = **-10ms / -9ms**（通知帧先于轮终广播帧到达，同属即投形态；≤1s 预算通过，两轮 verdict pass）。
- 单测：subagent-core execution 套件 2122 passed（含新回归用例）；`pnpm subagent-core` typecheck 干净。

## 遗留观察（不阻塞）

- 引擎通道关闭的 `engine_closed` 回执在 dispose 帧后 >3s 才到（close 恒走满 3s 宽限）——收割链自身时延，修复后已不在任何通知/轮终关键路径上；若后续要压缩引擎回收时延（例如 GUI 收起 subagent 的资源回收观感）再立项。
