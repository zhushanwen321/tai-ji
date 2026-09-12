# subagent 通知恢复能力在新架构上的重放移植设计（replay port）

> **[HISTORICAL] 部分退役注记（2026-09-11，H1 符号清扫批）**：本设计的 M1/M2/LC-4（sessionFile 获取链）与 M3（workflow 域 no-progress 熔断）仍现行；但 F2/F3 清账段描述的 chat 续聊轮活性载体——`host/roundLifecycle` active 相位、`emitActivePhase`、pi `chat-session.ts` 续聊轮事件外发、宿主 `handleChatRoundPhase` case active、`kickOffChatRound` 派发链——已随 [subagent-chat-run-unification.md](subagent-chat-run-unification.md)（H1）整族退役：续聊轮 = 新 run + resume 锚点，工具执行期活性经 run 事件通道 `activity` 变体直达宿主（覆盖窗 = run 域全域，不再有「chat 续聊轮失明」边界）。正文相关段保留作交付史实，不逐处改写；现行排障口径见 [../troubleshooting.md](../troubleshooting.md) §12。

> **一句话结论**：dev-0.9.16 的新架构（pi-subagent-cli + engine protocol）消灭了「agent_end 保守处置 → 永挂 → 通知冻结」的事故主干，但对抗审查（R1-R4）逐步证伪了「每环都有熔断」——**workflow 域（carbon 事故原发路径）的静默楔死在两代架构都无 no-progress 熔断**（旧架构 arm 两处生产调用点均在 chatMode 门内，该域 mid-round 静默楔死的唯一外层是 rpc-client 5400s——正是 carbon 90min 耗尽形态的表现；新架构同样零覆盖），本设计将其补挂（M3）。加上 S2 契约防御修复（M1）与 sessionFile 获取链补强（M2 惰性回补 + M4 兜底扫描——M4 已于交付后移除，见状态修订），移植面共四件；D1（迟到接受）已等价覆盖无需移植，D3/D3a/D4 的问题域在新架构不存在，判定不移植并给出证据。本文档是线 B 设计 [`subagent-agent-end-recovery.md`](subagent-agent-end-recovery.md) 在架构分叉后的重放移植裁决书。
>
> **层声明**：当前层 = 技术方案（重放移植裁决 + 落点设计）；下一层 = 实现计划（§5 拆分单元，供 dev-flow / coding-workflow 消费）。不跨层写代码。
>
> **状态**：**设计就绪**（2026-09-10）。对抗式审查五轮收敛：R1（5 MF + 7 S）→ R2（3 MF + 5 S）→ R3（2 MF + 2 S）→ R4（主审 1 MF + 2 S；影响面审 0/0 收敛）→ R5（主审 0/0 收敛）。关键收敛轨迹：S2 触发前提勘误（pi 应答恒带 sessionFile）→ M3 fire 链真终止（镜像记账不杀进程，abort 阶梯承载）→ 落点迁 SAR.run（executeAndAwait/runAndFinalize 系 W3 后残留面）→ 缺口定性勘误（两代共有原生缺口非回归）。审查报告归档 `.review/design-review-replay-r1~r5*.md`。
>
> **交付后修订（2026-09-10，commit `dbe0a60d4`）**：**M4（决策 4，close 时 prompt 头键 sessionFile 兜底扫描）经用户裁定整体移除**。依据：① K3② 实测旗舰并发形态前 200 字符 6/6 同质 → M4 必然多命中放弃，在最需要它的场景结构性无效；② prompt 头键是启发式认领，误配代价（冷续 resume append 共写他 session 文件 = 写污染）高于取证收益；③ 四路全 miss 本身是应响亮报错的异常信号，不应被自动认领掩盖。替代形态 = close 收尾 LC-4 后仍缺 → **响亮 warn**（recordId + 四路全 miss 归因 + 人工排查指引），LC-4 保留。K3② 的键策略升级后续任务随之作废。本文档 M4 相关章节保留作决策历史，均以「交付后修订」标注。

---

## 1 背景目标

### 1.1 SCQA

- **S（情境）**：2026-09-09 carbon PROD 四次复现：6 路并发 subagent 派发全部 90 分钟墙钟超时耗尽，串行同任务 36s 正常。根因定案：get_state 握手一次性 7s 窗口失败 → `record.sessionFile` 永久缺失 → `agent_end` 时累积通知条目返 error → 旧 inproc session-runner 保守 keep-alive（永不 kill）→ `runSpawn` 永挂 → 通知链整条冻结。fix-subagent-no-notification 分支据此实现了四项机制并完整走过质量闭环（设计对抗收敛 → dev-flow 双 Gate → design-code-sync）：**D1** 握手迟到接受（迟到 response 幂等回填 sessionFile）、**D2** sessionDir 扫描兜底（按 identity entry 内容匹配找回 sessionFile）、**D3** agent_end 处置翻转（读不出 sessionFile 时开 15s/3 轮回补窗口，耗尽 kill 并按成功语义通知；**D3a** 无后代能力工具时零判定快路径）、**D4** spawn-channel 门面（spawn 七件原语归一收拢）。
- **C（冲突）**：合并时发现架构分叉——dev-0.9.16 提交 `0df9ef8b3`（W3）删除了 D1-D4 的全部宿主（`packages/subagent-core/src/execution/engine/engines/pi/` 整目录），新架构改为 `packages/pi-subagent-cli/` 独立引擎进程 + engine protocol。cherry-pick 物理不可行，直接 merge 撞架构分叉（已 merge --abort 一次）。**用户已拍板：以 dev-0.9.16 为主，在新架构上重新落地本分支功能。**
- **Q（问题）**：D1-D4 四项机制在新架构上哪些还有对象、哪些已无对象？无对象的如何证明其问题域被覆盖？有对象的以什么形态重放？
- **A（答案）**：逐项判定（§3.2 移植判定表）——D1 等价覆盖不移植；D2 精简重放（匹配键更换）；D3/D3a 问题域结构性消失不移植；D4 目标已由进程边界达成不移植。审查期追加发现 workflow 域守护缺口（§2.4），移植面共四件：S2 契约防御修复 + agent_end 惰性回补 + workflow 域 no-progress 补挂 + close 兜底扫描。

### 1.2 系统是什么（受众补认知）

新架构的 subagent 执行链是**两层进程嵌套**（与旧架构单进程内 spawn 的本质差异）：

```
主 pi 进程（xyz-agent 宿主）
 └─ subagent-core 作为 extension 运行：SubagentService 编排、notify、RoundSupervisor
     └─ spawn① 引擎 CLI 进程（packages/pi-subagent-cli，NDJSON stdio 说 engine protocol v1）
         └─ spawn② pi rpc 任务子进程（--mode rpc，stdout 出 SdkEvent 流）
```

- **core ↔ 引擎**：10 个正向方法（initialize/run/read/…）+ 9 个反向通道（host/askUser、host/childSpawned 等），帧形态 SSOT 在 `packages/subagent-engine-sdk/src/protocol/frames.ts`
- **引擎 ↔ pi 子进程**：stdin 写命令（`prompt` / `get_state` / `extension_ui_response`），stdout 逐行 NDJSON 事件（`agent_end` / `message_end` / `response` 等），经 `spawn-event-translator.ts` 翻译成 AgentEvent 上抛
- **通知主 agent 的通路不经引擎协议**：run 终态 → core 进程内 `pi.sendMessage({customType:"subagent-bg-notify", triggerTurn:true})` 直投主会话（`packages/subagent-core/src/execution/notifier.ts:411-426`），另有 notify-ledger 四步兜底（写账 → settled 边沿投递 → 回执销账 → 重放幂等）

关键协议事实（理解后文的前提）：**rpc 模式 pi 子进程无 header 行，sessionFile 唯一正常获取通道是 get_state 问答**；实装 pi（0.84.4，`dist/core/session-manager.js` `newSession()`，~:1136）在 session 创建时即赋值 sessionFile 路径、延迟落盘只影响文件**存在性**（`flushed` 位）不影响应答字段——真实 RPC 层 get_state 应答恒带 sessionFile。因此握手失败的现实形态是**超时无应答**（并发负载下事件循环拥塞，即原事故形态），而非「应答缺字段」；后者是协议上可能、设计期未见真实观测路径的死路径——S2 修复（M1）的定位是契约一致性防御（头注「最多重试 3 次」与实现不符真实存在，dev-0.9.16 review 登记 S2 条目同定性：SUGGESTION 级、「实际影响有限……净损失 = 剩余 2 次重试轮丢失」，见 `.review/reports/round1/business-logic.md` Findings 表），不是活缺陷止血。

### 1.3 设计目标

从使用者（派发 subagent 的主 agent / 最终用户）体验倒推：

- **G1（根除不通知）**：任何 subagent run——无论握手成败、进程死活、引擎崩否——终态必然到达主 agent（完成/失败/终止通知三选一），不存在无限等待。
- **G2（通知质量）**：完成通知携带结果正文与 `session_read` 截断指针行；sessionFile 尽最大努力获取（它决定 chat 域「Full transcript」指针、冷续 resume 锚点、session-reader 取证能力），但**其缺失不得阻塞通知**。
- **G3（防复发）**：失败类抽象为「一次性获取 + 失败不可恢复 + 下游无限保守等待」——新架构每环都必须有不依赖运气的外部熔断，且本文档把判定证据固化，防止未来重构时旧病根借尸还魂。

### 1.4 in / out scope

**in scope**：

1. S2 握手契约防御修复（`pi-subagent-cli/src/get-state-handshake.ts:82-91`，「最多重试 3 次」头注契约与实现不一致——应答缺 sessionFile 的死路径下剩余重试丢失、Promise 悬挂）
2. workflow 域 no-progress 守护补挂（R1 发现的 G1 缺口、R3 修正落点：SAR.run → RemoteEngine.run 直达路径无任何熔断，§2.4）
3. D2 精简重放：agent_end 惰性 get_state 回补（one-shot 域）+ close 收尾兜底扫描（总 miss 场景）
4. D1-D4 逐项移植判定书（含不移植的证据链，本文档 §3.2 即交付物）
5. 线 B 三份文档的重放移植修订登记（C-proc-10 纪律）

**out of scope**（显式排除，防蔓延）：

- keep-alive 后代保活编排迁回（W7 显式裁决域，重审触发条件未满足，见 §3.3 决策 3）
- runtime rpc-client 双轨调和的机制改造（仅作合并检查项，见 §3.3 决策 5）
- W 系列机制的任何改动（已 committed 且验收，只做只读核验）
- 线 B 已登记遗留 ① NotifyDomainPorts 加固（独立任务）与 ④ carbon 升级到含修复版本（部署侧动作）

---

## 2 现状与问题分析

> **本章结论**：事故六环链在新架构被逐环核验——主干（agent_end 保守处置 → 永挂 → 通知冻结）已结构性消灭，残留的活缺陷只有一个（S2 握手悬挂），外加 sessionFile 兜底强度不足（总 miss 场景无最后防线）。
>
> 本章全部行号基于 dev-0.9.16 worktree（HEAD `b1b0840a9`）实读。缩写：`CLI` = `packages/pi-subagent-cli/src`，`CORE` = `packages/subagent-core/src`。术语：**identity tracker** = 引擎侧会话身份追踪器（`CLI/spawn-run-pump.ts` 内，负责 sessionFile/sessionId 的回填与广播）；**LC-4** = dev-0.9.16 liveness 设计中「close 收尾按 sessionId 文件名后缀反查 sessionFile」的兜底项；**keep-alive** = 旧架构「agent_end 后为潜在后台后代保活子进程」的编排（判定依据 = session 文件内 `pending:register`/`pending:unregister` 条目差集）。

### 2.1 事故链在新架构的重放推演（逐环核验）

把 2026-09-09 事故的六环链逐环放到新架构上，验证每一环的现状：

| # | 事故环（旧架构） | 新架构对应环节 | 现状判定 |
|---|---|---|---|
| 1 | 6 路并发下 get_state 握手 7s 窗口全超时 | `CLI/get-state-handshake.ts:17-21`（3 次 × 2s 超时 + 500ms 间隔）同样一次性 | **契约缺陷（防御面）**：超时无应答形态下握手按设计耗尽并 resolve（正常降级）；但「应答到达却缺 sessionFile」的死路径下 Promise 悬挂、剩余重试丢失（§2.2）——与头注契约不符 |
| 2 | 迟到 response 被丢弃 → sessionFile 永久缺失 | identity tracker 监听表驻留至 close（`CLI/spawn-run-pump.ts:105-127`），迟到 response 走**同步路径**回填 sessionFile 并重发 handleReady（`:73-85`） | **已覆盖且强于旧 D1**（D1 是 `.then` 微任务回填，新架构是同一 data chunk 内同步可见） |
| 3 | agent_end 处置链读不出 sessionFile → error | `CLI/spawn-event-translator.ts:74-87`：agent_end（非 willRetry）→ `onAgentEnd()` → **无条件 kill**（`CLI/spawn-runner.ts:274-276`），不读 session 文件、无保守分支 | **病根环被删除**——旧架构把「读不出」当「可能有后代」无限保守；新架构 agent_end 即终态，kill 触发 close → run 应答 → 通知照发（结果从 stdout 事件累积，`CLI/output-collector.ts:233`，不依赖 sessionFile） |
| 4 | 保守 keep-alive → close 永不到 → runSpawn 永挂 | kill 链 SIGTERM → 30s grace → SIGKILL（`CLI/spawn-runner.ts:330-336`）保证 close 必达；run 帧不设墙钟但 close 是物理必然 | **已覆盖** |
| 5 | 通知链整条冻结（主 agent 永不知情） | run 终态 → core `finalizeEngineOutcome` → CollectCoordinator → notify-ledger 四步兜底 | **已覆盖**（正常终态 + 崩溃路径都有通知，见 §2.4） |
| 6 | 引擎/进程死亡后 record 无人管 | core 侧三层兜底（§2.4） | **已覆盖** |

**结论**：事故主干（环节 3-6）在新架构被结构性消灭，但审查（R1-R4）发现一处例外——**环节 5 的「静默楔死」分支对 workflow 域无熔断**（§2.4 条目 5，SAR 直达路径无 arm；且为两代共有原生缺口非回归）。G1 的既有达成度：chat 域与引擎崩溃路径高；workflow 域静默楔死 = 真实缺口，本设计 M3 补挂。G2 要补的是环节 1 的契约防御和环节 2 的兜底强度。

### 2.2 S2 握手契约缺陷：应答缺 sessionFile 的死路径下 Promise 悬挂

**定性先行（R1 勘误）**：这是契约一致性缺陷而非活缺陷止血——真实 pi 的 get_state 应答恒带 sessionFile（§1.2：`newSession()` 创建即赋路径，「应答缺字段」形态未在生产链路观测到，dev-0.9.16 review 登记 `.review/reports/round1/business-logic.md:27` 同口径）。修复 M1 的价值 = 头注「最多重试 3 次」契约与实现对齐 + 防御未来 pi 语义变化（如应答字段化改造）把这个死路径激活成活缺陷。

现场：`CLI/get-state-handshake.ts:82-91`——response 到达但 `collected.sessionFile` 为空时：

```ts
addResponseListener(reqId, (data) => {
  if (resolved) return;
  clearTimeout(timer);              // :84 本轮唯一驱动源被清除
  if (pendingRetry) clearTimeout(pendingRetry);
  extractGetStateFields(data, collected);
  if (collected.sessionFile) {
    resolved = true;
    resolve(collected);
  }
});                                 // :91 else 分支缺失：什么都不做
```

时序：应答缺 sessionFile（pi 首 flush 前的常态应答形态）→ listener 已被 `dispatchStateResponse` 一次性消费（同 reqId 不再触发）→ `:84` 清掉 2s timer，而 retry 只在 timer 超时回调里排（`:70-79`）→ `resolved` 未置位、不 resolve、不再有 timer → **Promise 永久悬挂**，与头注「最多重试 3 次」契约冲突。登记原文：dev-0.9.16 `.review/reports/round1/business-logic.md:27`。

影响面实测口径（按死路径如实定级）：

- 调用点 `CLI/spawn-runner.ts:385` 是 `void ...then` fire-and-forget，timer 全 unref → **run 不阻塞、进程不挂**（不是旧事故的挂死形态）
- identity 的同步包裹路径（`spawn-run-pump.ts:106-111`）已尽力回填
- 净损失（该路径被触发时）= **剩余 2 次重试轮丢失** + 握手 promise 悬挂（若调用方将来改成 await 则变阻塞）→ sessionFile 缺失概率放大 → 下游降级（§2.3）
- 现存行为已被专测锁死：`CLI/__tests__/get-state-handshake.test.ts:163-192`（推进 20s writes 恒 1、settled 恒 false）——修复时需改写为契约断言

### 2.3 sessionFile 缺失的下游代价（G2 的量化）

新架构 sessionFile 三路获取（`CLI/spawn-run-pump.ts:65-129`）：header 行（rpc 模式无）→ get_state 应答（主体）→ close 时 LC-4 后缀反查（`findSessionFileByHeaderId`，按 `_<sessionId>.jsonl` 后缀扫 sessionDir，`spawn-event-adapter.ts:349-360`）。全 miss（连 sessionId 都没拿到）时 sessionFile 为 undefined，下游代价逐项：

| 下游消费点 | 缺失后果 | 严重度 |
|---|---|---|
| chat 域通知「Full transcript」指针行（`CORE/notifier.ts:287-288`，仅 chatMode 透传） | 整行省略，主 agent 无法定位全文 | 低（one-shot 域本来就没有此行） |
| `session_read {"action":"result","session":"<recordId>"}` 截断指针（`CORE/notifier.ts:202-204`） | 主 agent 按指针取全文失败/降级——长结果只剩通知里的截断正文 | **中**（这是主 agent 消化长结果的主通道） |
| chat 冷续 resume 锚点（`CORE/subagent-service.ts:1454,1493-1499`：record.sessionFile → run.params.chat.resume → `--session`） | 引擎死亡被 supervisor 纳管为 resumable 后，唤醒续跑无法 resume → 2h 决策看门狗最终以失败终态化 | **中**（崩溃恢复能力打折） |
| read ①级 pi 原生重建（session-view-service） | 降级到 ②级 journal 重放（core 侧 journal 一直在写）→ **读基本不丢** | 低 |
| session-reader 取证（事故复盘时唯一证据链） | 无法归档定位 | 低频高值 |

结论：sessionFile 缺失在新架构**不致命但真实伤质量**，且原事故的取证痛点（sessionFile 永久缺失）会原样复现。这是 D2 精简重放的全部理由。

### 2.4 通知必达的既有兜底核验（G1 验证项，含一处缺口）

新架构「任何 run 必有终态通知」的证据链逐项核验（前四项只读确认，第五项为 R1 审查发现的缺口）：

1. **正常终态**：agent_end → kill → close → run 应答帧 → `finalizeEngineOutcome` → notify。
2. **chat 域 + subagents 工具 background 的静默楔死**（agent_end 永不到）：core 侧 `armMidRoundNoProgress` 挂 30min 无进展检测（`CORE/subagent-service.ts:2676`，kickOffChatRound 的 engine.run 派发前；刷新源 = 协议事件含 text_delta）→ fire 即 kill + 失败终态化 + 失败通知（`onHotPathSettledWatchdogTimeout`，:1550）。
3. **引擎进程死亡（宿主存活）**：`engine_crashed` → `adoptResumableAfterEngineDeath`（`CORE/subagent-service.ts:2346,2402`，条件 `chatMode !== true` 即覆盖 one-shot）→ RoundSupervisor 三态（该等/该唤醒/该放弃，2h 决策看门狗 env 可关）→ steer 通知或终止通知。
4. **宿主重启**：`bootPartition` 重认领（initSession 挂点）→ 同 supervisor 流。
5. **【缺口】workflow 域静默楔死无任何熔断（R1 发现、R3 修正落点，M3 修复）**：workflow 域 `agent()` 的真实调用链 = `executeAgentCall`（退避重试 ≤ MAX_ATTEMPTS，`CORE/orchestration/execute-agent-call.ts:148` 起派发）→ **SAR.run**（per-session runner，`CORE/execution/subprocess-agent-runner.ts:235`，`sa-` 前缀 taskId，不创建 ExecutionRecord）→ 引擎路由同步短路（`routing.ts:435-441`）→ `RemoteEngine.run`（协议 run 帧直达引擎进程）——**该路径零 no-progress 熔断**（SAR.run 全文无 arm；per-call 墙钟 `timeoutMs` 是 opt-in，用户未传即不限时）；引擎侧 run 帧不设墙钟（by design，规则 19）。攻击场景：workflow 域 pi 子进程静默楔死（spawn 成功、prompt 已发、零事件输出、不退出）→ 引擎无墙钟 + SAR 无 arm → `agent()` 永挂 → workflow 停摆、无终态通知 = G1 违反。**carbon 事故正是 workflow 域**。
   - **定性勘误（R4）**：本缺口是**两代共有的原生缺口，非新架构回归**——线 B 源码核实：旧架构 `armMidRoundNoProgress` 仅有的两个生产调用点均在 chatMode 门内（线 B `session-runner.ts:2881` 的 `if (record.chatMode)` + `subagent-service.ts:1294` deliverChatMessage 热路径）；keep-alive no-progress 只挂 agent_end 后的裸缺省形态、spawn watchdog 与 worker pending 超时均为 opt-in——workflow 域 one-shot **mid-round** 静默楔死在旧架构同样零兜底（唯一外层 = runtime rpc-client 5400s，carbon 90min 耗尽正是该形态的表现）。M3 首次为该域补上熔断。
   - **勘误登记（R3）**：本文档 R1/R2 版曾断言 workflow 走 `executeAndAwait（:1815）→ runAndFinalize（:2419）`——该两方法是 W3 协议化后**无生产调用方的残留面**（`subprocess-agent-runner.ts:5/:21/:125` 类注释的「委托 executeAndAwait」描述是 W3 前过时形态，正是误读根源）。修复 = M3（§3.3 决策 9，落点 SAR.run）。

残余登记（量级 + 重审条件，R2 修订、R3 沿用）：M3 的 fire 经 watchdog controller → cancel 帧 / killAll 阶梯保证 `engine.run` 收敛（含引擎活楔死形态——killAll 直接杀引擎进程后 run 请求 reject 合成终态）。不收敛残余仅剩「fire 回调自身未执行」（宿主进程在静默期内崩溃）→ 重启后 workflow 无 supervisor 纳管（workflow 域无 record），由 workflow 运行方（subagent-workflow extension 的 run 状态机）自行超时/用户重派——显式登记为已知残余。重审触发 = 出现该残余形态的实例报告。

### 2.5 物理数据流（sessionFile 获取链现状 → 本设计后）

```
现状（三路）：
spawn② pi 子进程 (--session-dir <engine dataDir 派生的 sessionDir>)
  │ stdout: response{get_state, data:{sessionId, sessionFile?}}   ← 主体通道（S2 缺陷在此）
  │         header 行（rpc 模式无）
  ▼
identity tracker (CLI/spawn-run-pump.ts)
  ├─ 应答同步回填 sessionFile/sessionId → host/handleReady → core record
  └─ close 时：clearStateListeners → LC-4 后缀反查（需 sessionId 已知）
                                  └─ 全 miss → sessionFile undefined（§2.3 代价）

本设计后（四路；交付后修订：原第 ⑤ 路 M4 扫描已移除，全 miss 改为响亮 warn）：
  ① spawn 期握手 3×2s（S2 修复：重试轮不再丢失 ★）
  ② 握手窗口后的迟到 response（既有，同步回填）
  ③ agent_end 惰性 get_state 1s（★ M2，one-shot 域，子进程存活且空闲时点）
  ④ close 时 LC-4 后缀反查（既有）
  ⑤ ~~close 时 mtime 窗口 + prompt 键扫描（★ M4）~~ → 移除（dbe0a60d4）：LC-4 后仍缺即响亮 warn，不自动认领
```

### 2.6 根因类抽象（防复发的靶子）

事故类 = **「一次性获取 + 失败不可恢复 + 下游无限保守等待」** 三件套。新架构已拆掉第三件（无保守等待）；本设计拆前两件（获取可重试 + 自然时点可再获取）。防复发的守卫姿势：① 获取链每一段的失败都必须是「有界放弃 + 降级可见（warn 日志）」，不得是「悬挂」或「无限重试」；② 下游消费 sessionFile 的代码一律按 optional 处理（现状已满足，验收守护）。

---

## 3 解决方案

### 3.1 终态（使用者视角）

**成功路径（one-shot workflow run，握手一切正常）**：与现状零差异——主 agent 收到 `subagent-bg-notify` 完成通知，通知正文形态（`CORE/notifier.ts:280-288`）：

```
Subagent "coder" (rec-8f3a) completed.

<结果正文（超预算时截断，并追加指针行）>
[truncated 12.3k of 45.6k chars — full result: session_read {"action":"result","session":"rec-8f3a"}]
```

主 agent 按指针行调用 `session_read` 即可取回全文。

**降级路径（复现事故形态：spawn 期握手 3 轮全超时）**：

1. 若迟到 response 在 run 存续期到达 → 同步回填（现状已有），后续与成功路径一致。
2. 若直到 agent_end 仍缺 → agent_end 时刻补一次 get_state（子进程刚完成 turn、空闲、负载已过，成功率远高于 spawn 时刻）→ 命中则 outcome 携带 sessionFile，通知质量与成功路径一致。
3. 若子进程对补查也不应答（stdin 断/楔死）→ close 时后缀反查（LC-4）→ 仍缺即响亮 warn + 人工排查指引（交付后修订：原 prompt 键扫描 M4 已移除，不自动认领）。
4. 全部 miss → 按现状语义收尾：run 正常终态、通知照发（结果正文来自 stdout 累积），`session_read` 指针行仍生成但 session-reader 侧降级（返回明确的「session file not found」而不是悬挂），warn 日志留痕。**文案规格 = 结构化模板 + 必含字段清单，不逐字规定整句**（M5 修正：close 单点无法断言「5 路全 miss」——chat 域不经 M2 补查、LC-4 可能已命中）：前缀 `[sessionfile] unobtainable for <recordId>` + 尾句 `record finalized without transcript anchor`，中间必含 `reason`（枚举）/ `candidates` / `promptHeadHash` / 可选 `error`，并附 Recovery 指引（session-reader 按 mtime 窗口人工归档 / 重派任务）。

**失败路径（pi 子进程楔死静默）**：chat 域与 subagents 工具 background 现状已有 30min 无进展 watchdog（kill + 失败通知）；workflow 域现状**无熔断**（§2.4 条目 5 缺口），M3 补挂后同样获得 30min 兜底——fire 文案附恢复指引（查态 + 重派）。

**恢复指引（错误 → 权威源 → 重试）**：上述第 4 步 warn 文案中附下一步——「若需 transcript 取证，用 session-reader 列 sessionDir 内 mtime 窗口文件人工归档；若需完整结果，重派任务」。

### 3.2 D1-D4 移植判定表（本设计的核心裁决）

| 项 | 旧机制 | 新架构现状 | 判定 | 证据 |
|---|---|---|---|---|
| **D1 握手迟到接受** | resolver 在 resolved 后回调 `onLateResponse`，幂等回填 `!record.sessionFile` 守卫 | identity 监听表驻留至 close，迟到 response 同步回填 + handleReady 重发 | **不移植（等价覆盖且更强）** | `CLI/spawn-run-pump.ts:105-127`（驻留）`:73-85`（同步回填）；旧 D1 的 alive-marker 属已删 keep-alive 心跳体系，无对应物非缺口 |
| **D2 sessionDir 扫描兜底** | `locateSessionFileByScan`：mtime 降序 + identity entry（`subagent-identity` custom entry）内容匹配 | 仅 LC-4 后缀反查（需 sessionId 已知）；identity entry **结构性不再写入**（见决策 6） | **精简重放（M2+M4），匹配键更换**（交付后修订：M4 已移除——D2 的「扫描自动找回」形态最终未保留，改为响亮 warn + 人工归档指引） | 数据源消亡证据：`CLI/spawn-runner.ts:165-180` buildChildEnv 不注入 `PI_SUBAGENT_SELF_RECORD_ID`；引擎 CLI 以 `args:[]` 启动（`CORE/execution/engine/engine-inspect-package.ts:190`）→ argv-mirror 无 extension flag → pi 子进程不加载 subagent-workflow extension → `appendSubagentIdentityEntry`（extension 内）无从触发 |
| **D3 处置翻转 + 15s 窗口** | error 分支开 15s/3 轮回补窗口，耗尽 kill 成功语义 | agent_end 无条件 kill 即正常路径；「读不出 → 保守永挂」失败模式连同处置链一起不存在 | **不移植（问题域结构性消失）** | `CLI/spawn-event-translator.ts:76-87` 头注（F1.2 根修记录 + keep-alive 未迁移登记）；窗口要守护的「保守等待」已无宿主 |
| **D3a descendantCapable 快路径** | 无后代能力工具时 agent_end 零判定直接杀 | 所有 run 都零判定直接杀 | **不移植（被整体包含）** | 同上；且默认部署下子进程无 subagent/workflow 工具（extension 不加载），「有后代」场景本身不成立 |
| **D4 spawn-channel 门面** | 七件原语 + 四维策略收拢为受控子入口 | 单一家园已由进程边界达成（原语全部住在 pi-subagent-cli + SDK） | **不移植（目标已达成，方式更彻底）** | 门面文件随 engines/pi 删除；线 B 自评「七件仅 LF 行读取实际被 runtime 消费」（impl-plan R4），该消费随合并放弃（决策 5） |

### 3.3 关键决策与权衡

**决策 1：S2 修复选「应答不完整视同未应答」（方案 A），不选显式 else 排 retry（方案 B）**

- 方案 A：`clearTimeout(timer)` 与 `clearTimeout(pendingRetry)`（:84-85 两者）均移入 sessionFile 命中分支——应答缺 sessionFile 时保留**全部既有驱动**（迟到应答形态下 pendingRetry 可能是唯一活驱动，单留 timer 会留 500ms 悬挂窗，R2 S-主审），由既有 2s 超时回调驱动 retry（`CLI/get-state-handshake.ts:70-79` 现成逻辑）；多驱动并发安全由 `resolved`/`attempts` 守卫保证。
- 方案 B：`:90` 后补 else 分支立即排 `pendingRetry`。
- 选 A 理由：retry 的排定权威只有一个（timer 超时回调），B 会造出第二条排定路径，未来改节奏时两处易漂移；A 的代价仅是该轮慢 ≤2s（对 7s 总窗无关痛痒）。长期方案。
- 定位重申（R1 勘误后）：这是契约一致性防御（§2.2），不是活缺陷止血——但契约修复独立成立（头注承诺与实现不符），M1 保留。
- 同批改写锁死现存行为的专测 `get-state-handshake.test.ts:163-192` 为契约断言（缺 sessionFile 应答 → 剩余重试照发 → 3 轮耗尽 resolve）。

**决策 2：M2 = agent_end 惰性 get_state 回补（消费零调用方的 `requestGetStateOnce`）**

- `CLI/get-state-handshake.ts:105-138` 的 `requestGetStateOnce` 注释自述「agent_end 决策点惰性回补专用」，随迁后零生产调用方（其消费者 session-runner 已删）——M2 就是给它接上消费面。
- 落点：`buildTranslatorOpts` 非 chatMode 的 `onAgentEnd` 分支（`CLI/spawn-runner.ts:274-276`）改为 async 编排：同步段先置 `runEnd.endedCleanly = true`（保住「end 与收尾之间被杀」的 exit 0 口径），随后 `void (async () => { try { 回补 } finally { killChild(); } })()`——kill 延后 ≤1s（`LAZY_GET_STATE_TIMEOUT_MS` 量级，控制面单请求秒级，合规规则 19），对已完成 turn 的子进程无副作用。
- **kill 必达约束（R1 MF-2）**：`requestGetStateOnce` 自身「永不 reject」，但回补结果处理链不在该契约内——补查命中 → `applyGetStateFields` → `callbacks.onHandleReady` → server 层组帧发送，任一抛点都会让 kill 丢失 → run 永挂（正常完成路径退化为依赖兜底 = 规则 20 红线）。因此回补段必须整体 try 包裹、kill 放 finally（回补异常按 miss 处理 + warn，不得阻断 kill）。
- 回补结果走 identity tracker 既有 `applyGetStateFields` + handleReady 通路（与迟到 response 同一条回填面，幂等语义免费继承）。
- 竞态清单（重演过）：① 查询期间子进程自行退出 → close finalizer 照跑（`endedCleanly` 已置位，exit 0），监听表被 `clearStateListeners` 清空 → `requestGetStateOnce` 超时 resolve 空对象 → `killChild` 落在已死进程上必须幂等 no-op（实现检查点 K2）；② 查询应答与 kill 竞速 → 应答先到则回填生效，kill 先到则 close 清监听、resolve 空对象，无害；③ chat 域不经此分支（chatMode 在 `onAgentEnd` 另一分支，不 kill），靠存活期迟到回填 + LC-4（M5 修正：close finalizer 对 chat 与 one-shot 是同一条链，实测已覆盖 chat 形态；交付后修订：M4 扫描已移除）。
- 被否方案：15s/3 轮窗口整体重放——窗口守护的「处置决策」已不存在，重放 = 为不需要决策的场景造决策，违反减法原则。

**决策 3：D3/D3a 不迁回 keep-alive（尊重 W7 显式裁决）**

- 协议化 impl-plan 合理偏差登记表原文（dev-0.9.16 `docs/design/subagent-engine-protocolization.impl-plan.md` §5 W7 行）：「后台 pi 后代保活/steer 唤醒场景为行为差异……重审触发 = 用户报告后台任务静默/失联；G5『现有能力零回归』在该场景域不适用（显式裁决记录）2026-09-09」。
- 重审触发条件（用户报告后台任务静默/失联）至今未满足；且 §2.4 的兜底清单（含 M3 补挂 workflow 域守护后）已覆盖「静默必终态」。「后代保活」是另一个产品能力问题（子进程要能先有后代工具才谈得上保活——默认部署连工具都没有），若未来要做属新设计，不是本移植的欠账。

**决策 4：M4 兜底扫描的匹配键 = prompt 头部内容（替代已消亡的 identity entry），带显式失效面与安全约束**

> **交付后修订（2026-09-10，commit `dbe0a60d4`）：本决策整体移除，以下原文保留作决策历史。** 移除依据（用户裁定）：K3② 实测旗舰并发形态（共享模板 >200 字 + 参数末尾）前 200 字符 6/6 完全同质 → M4 在其目标场景必然多命中 → 结构性无效；prompt 头键是启发式认领，误配代价（错 sessionFile → 冷续 resume `--session` append 共写他 session 文件 = 写污染）高于取证收益；四路全 miss 本身是应响亮报错的异常信号，不应被自动认领掩盖。替代形态：close 收尾 LC-4 后仍缺 → 响亮 warn（recordId + 四路全 miss 归因 + 「session-reader 按 mtime 窗口人工归档 / 重派任务」指引），best-effort 不阻断 `resolveExit`；LC-4 保留。原预登记的键策略升级（全文哈希/参数段取样）后续任务随之作废。

- 键设计：close finalizer 内（LC-4 之后、`resolveExit` 之前），若 sessionFile 仍缺 → 扫 sessionDir 内 mtime ∈ [spawnStartedAtMs, close] 的 `.jsonl` 候选 → 逐候选前向读头部（首 ~64KB）→ `includes(promptHead)`（任务 prompt 前 ~200 字符）→ **单命中才采纳，零命中/多命中一律放弃 + warn**。采纳时的 warn 必须附审计证据（候选文件名 + mtime + prompt 头哈希），使误配事后可定位（恢复路径：人工按证据纠正 record.sessionFile）。
- 选 prompt 键理由：引擎侧天然持有（run params 的 task prompt），零协议改动、零 extension 依赖。
- **失效面声明（R1 S-主审1；M5 按一致性审查补第二类）**：共两类结构性失效，均为**安全但无效**（不误配，只是补不上）：
  - ① 「同模板批量并发」场景（同一 workflow 派 6 路 = carbon 事故旗舰形态）prompt 头部大概率相同（模板前缀共享、任务参数在后）→ 全部同模板候选命中 → 多命中 → 放弃。缓解：K3② 实测真实 workflow 并发形态的 prompt 头部区分度；若头部同质率高，键策略升级为「prompt 全文哈希」或「参数段取样」（全文含任务参数必然互异，代价是头读窗口可能不够，需增大读取或按行流式匹配）。头部键在 K3② 结论出来前是默认值，不是终局。
  - ② **prompt 不在候选文件前 64KB 内** → 键不可见 → 静默 `no_match`。两条真实路径必然命中此形态：`fork-from` 派生会话（pi `session-manager.js` forkFrom 先写 header 再逐条复制源会话全部非 header entry，本次 prompt 追加在全量历史之后——源会话 >64KB 即越界；入口 `CLI/pi-engine.ts` 的 `task.forkSource` → `--fork`）与 `--session` 续写追加（`CLI/spawn-runner.ts` 的 `resumeSessionFile`）。§3.1 第 3 步「close 时后缀反查 + prompt 键扫描」的覆盖面**不含**这两种形态。重审条件：若需覆盖，改按行流式匹配或全文哈希，代价是读窗口放大（并同步评估 §3.4 的 100ms 降级门）。
- **误配代价四要素（R1 MF-3）**：
  - 量级：单命中误配需同时满足「自身文件 miss（prompt 非逐字落盘或文件不在窗口）∧ 窗口内恰有一个他文件含本 prompt 头」。同模板并发产生多命中（→ 安全放弃），异构 prompt 不含本头（→ 不命中）；危险格 = 自身 miss ∧ 恰一同头 sibling，概率由 K3 区分度实测门控，设计期不编数字。
  - 后果：错 sessionFile 进 chat 冷续 resume 锚点后引擎以 `--session` **append 续写**（`CORE/subagent-service.ts:1493-1499`；`CLI/spawn-args.ts:54` 明示禁双写约束）——若目标是另一活跃会话文件即两进程共写同一 jsonl 的**写污染**，不止取证读污染。
  - 恢复路径：warn 审计证据（上文）+ 暴露面 = session_read 取回错误全文 / 冷续读错会话时可据此定位纠正；无自动纠正通道（显式登记）。
  - 重审条件：任一误配实测发生 → 停用 M4 或升级双键（prompt 头 + sessionId 弱校验）。
- **IO 量级与降级门（R1 S3 双审）**：候选数 = O(mtime 窗口内并发 run 数)（受 pool 并发上界约束，个位数量级）；readdir 成本 ∝ 同 cwd 历史文件总数（sessionDir 是 per-cwd 共享目录单调累积，无自动清理——重度使用数月 ≈ 数千条目 ≈ 数 ms，与既有 LC-4 同段同量级先例）。降级门：候选数 > 64 或单次扫描耗时 > 100ms → 跳过扫描 + warn。重审条件：sessionDir 文件数 > 1e4 时重评估扫描策略（如引入索引）。
- **resolveExit 必达约束（R1 MF-2）**：扫描器整体 try-catch，任何 fs 异常降级为放弃 + warn，不得阻断 close finalizer 的 `resolveExit`（先例：`spawn-run-pump.ts:230-236` stderrTee.close 的 try-catch，注释明言「抛出会遮蔽真实退出码处理」）。
- 线 B 的 `session-file-locator.ts` 骨架可参考（mtime 过滤 + 前向读 + 候选级容错），但匹配键与命中语义按本节重写，不做逐字 cherry-pick。
- 诚实成本声明：M2 之后全 miss 概率是 rare²（握手总失 × agent_end 补查又失）。M4 的价值主要是取证完整性与「根本性」的收口，实现摩擦超预期时可降级放弃（见检查点 K3）。**K3① 实测结论（2026-09-10，M5 回填）：prompt 确为「非逐字落盘」（pi 0.84.4 逐行 `JSON.stringify`），但降级路径未采用**——匹配键改为「原文 + JSON 转义形态」双 includes：JSON 转义是单射且逐字符确定，匹配仍是逐字节精确子串，误配面与原文匹配同强度、安全底线（单命中才采纳）未放松，而单一原文键在本实现下恒 miss。故降级条件（「非逐字即不可靠」）经证据推翻，双键为终局。

**决策 5：runtime rpc-client 合并取向 = dev-0.9.16 版为准**

- 线 B 曾把 runtime `rpc-client.ts` 切到共享 spawn-channel 行读取（D4 唯一兑现的消费）。dev-0.9.16 的 rpc-client 独立演进（含 W7 `lastEventAt` 信号面）。合并时取 dev-0.9.16 版，放弃线 B 的切换——归一已由进程边界达成，runtime↔主 pi 长驻通道与引擎 spawn 通道是两个对象（真差异）。
- **合并陷阱（R1 merge-tree 实测）**：`rpc-client.ts` 双侧改动会**干净自动合并**（无冲突标记）——不主动 checkout dev 版就会把线 B 的 spawn-channel import 合进来（指向已删文件）。由决策 7 的整树重置兜住。
- 检查点 K4：diff 两版 rpc-client，确认线 B 侧无独立 bug 修复需要重放（已知线 B 改动仅为消费切换 + CRLF 防御测试，预期无欠账）。

**决策 6：不恢复 identity entry 数据源（显式记录被否谱系）**

- 被否方案：buildChildEnv 注入 `PI_SUBAGENT_SELF_RECORD_ID` + 协议 v1.x 增加 extension 路径传递——需要 run 协议加字段、argv 传递链全通、子进程加载 extension 带来 pending relay 等副作用面，为 rare² 场景引入协议演进，不成比例。
- 击穿反例：即使注入 env，extension 不加载 `appendSubagentIdentityEntry` 依然不触发（它读 env 后由 extension 的 session_start hook 写盘）——数据源恢复的最小代价也要动 extension 加载链，非 env 一行。

**决策 7：实施基底 = 本分支 merge dev-0.9.16 后在其上实现（操作语义已 merge-tree 实测固化）**

- 本 worktree（fix-subagent-no-notification）无 `packages/pi-subagent-cli`（实测确认），移植代码无处落。推荐顺序：先 `git merge dev-0.9.16`，解冲突后**整树重置代码面**：`git checkout dev-0.9.16 -- packages/ && git checkout dev-0.9.16 -- eslint.config.mjs`，再在其上实现 M1-M5，完成后 dev-merge 回 dev-0.9.16（届时接近 fast-forward）。
- **为什么必须整树重置而非逐个解冲突（R1 MF-1，merge-tree + blob hash 实测）**：merge 的实际冲突面分四类，其中两类解冲突操作根本碰不到——
  1. 内容冲突（2 件）：`eslint.config.mjs`、`packages/subagent-core/tsup.config.ts`——逐个取 theirs 可解；
  2. **干净自动合并陷阱（2 件）**：`packages/subagent-core/package.json`（线 B 的 spawn-channel exports 条目会静默合入，指向已删源文件）与 `packages/runtime/src/infra/pi/rpc-client.ts`（双侧改动合流，见决策 5）——不冲突但必须重置；
  3. **非冲突自动保留面（5 件）**：`rpc-client-lf-framing.test.ts` / `rpc-client-bash-timeout.test.ts` / `rpc-client-mock.ts` / `rpc-client-timeout.test.ts` / `rpc-client.test.ts`——dev 侧 blob == merge-base（git 对 dev 未改动的文件不产生冲突、自动保留线 B 版），其中 lf-framing 测试 import `@zhushanwen/subagent-core/spawn-channel` 子入口，随源删除即 import 解析失败 → 三连必红；
  4. file-location 冲突（7 件）+ modify/delete 冲突（3 件）：全部是 engines/pi 系线 B 文件，随整树重置消失。
  类 2/3 只有 `git checkout dev-0.9.16 -- packages/` 能全覆盖——「取 theirs」若按常规解冲突操作执行会漏掉它们，merge 后三连红时存在「补回 spawn-channel」的错误修复方向窗口。
- 被否方案：另开基于 dev-0.9.16 的全新 worktree——分支叙事断裂、线 B 文档与实现分离在两个分支上，合并时还要二次归位。
- 风险与缓解：merge 后先跑全量测试三连确认基底绿再动手；若 packages/ 外出现大面积意外冲突（K5），停下重估。

**决策 8：文档处置（C-proc-10 同步纪律）+ drift 守卫显式登记**

- 线 B 三份文档（`subagent-agent-end-recovery.md` + `.impl-plan.md` + 涟漪 `subagent-core-unbounded-wait-audit.md`、`troubleshooting.md` §12）随合并带入 dev-0.9.16，头部加「架构分叉后的重放移植」修订记录：D1-D4 判定结论、新落点（M1-M4）、旧实现文件已随 engines/pi 删除。
- 本文档（replay.md）是重放的权威 SSOT。
- **drift 守卫登记决策（R1 S-4）**：`check-doc-symbol-drift.mjs` 是显式登记制（未登记的文档不检查）——M5 必须把 replay.md 登记 `DOC_MODULE_MAP` 映射 `packages/pi-subagent-cli/src`（现存反引号符号如 `requestGetStateOnce` 登记后可通过）；线 B 三份文档的修订记录中已删符号（`locateSessionFileByScan`、`appendSubagentIdentityEntry` 等）要么去反引号，要么登记映射时确保不悬空。不登记则「守卫必须过」语义空转（恒真零覆盖）。

**决策 9（R1 新增，R2/R3 修订）：M3 = workflow 域 no-progress 守护补挂，落点 SAR.run，复用 settled-watchdog 既有原语**

- 缺口（§2.4 条目 5，R3 修正真实链路、R4 修正定性）：workflow 域 `agent()` → `executeAgentCall`（退避重试）→ **SAR.run**（`subprocess-agent-runner.ts:235`，`sa-` taskId、journal :197、stream :229、signal 合流 :214 三件套齐备，**不创建 ExecutionRecord**）→ `RemoteEngine.run` 直达——零熔断，静默楔死 = `agent()` 永挂 + workflow 停摆 + 无终态通知；carbon 事故正是该域。缺口定性 = **两代共有原生缺口**（旧架构 arm 两点均在 chatMode 门内，见 §2.4 定性勘误），非新架构回归——但本设计的 G1 目标覆盖它，仍须补挂。
- 方案对比：
  - **采用：SAR.run 内挂 per-run watchdog**——arm 点 = `engine.run` 派发之前的 try 块内；刷新源 = `journal.onEvent` 包装 ∪ `stream.onDelta` 包装（若存在，streamDelta 反向帧不经 journal——R2 S-影响1）；disarm = `finally`（journal.close 同段）+ run 收敛。
  - 被否：arm 挂 `runAndFinalize`（R1/R2 版方案）——该方法与 `executeAndAwait` 同为 W3 后无生产调用方的残留面（R3 证实），挂上去 = 守护挂不到真实路径。
  - 被否：仅登记缺口不动——违反 G1 且缺口真实存在（两代共有不等于可继续不修）。
  - 被否：给 engine.run 加墙钟超时——违反规则 19，且无进展检测（静默才判死）与 ADR-0047 一致。
- **fire 动作（SAR 域形态，无 record 三件套）**：SAR 不持有 ExecutionRecord / tryTransition / collectCoordinator——fire = **per-run watchdog `AbortController` 叠加进既有 signal 合流**（`mergeTimeoutSignal` 旁新增一源，与 D-A9 timeoutMs 同构）：watchdogController.abort() → mergedSignal abort → `RemoteEngine` `wireAbortSignal`（`remote-engine.ts:364-392`）→ cancelRun 帧 → 引擎按 runId 精确路由杀目标子进程（`server.ts:306-308`）→ run 应答 cancelled outcome → SAR `outcomeToRunnerResult` 出 error result；引擎无响应则 `CANCEL_SETTLE_GRACE_MS`（3s，`engine-protocol.ts:51`）收敛窗 → `killAll` → 引擎进程死 → **`RemoteEngine.run` 内部将 pending run 合成终态后正常返回**（非经 SAR catch）→ 同样出 error result。**两条路径都保证 `engine.run` 收敛** → SAR finally（journal close）→ `agent()` 返回。disarm 时同步移除 signal 桥接 listener（run 正常收敛后桥接若残留会在外部 signal 上挂 listener——实施卫生项，R4 INFO）。
- **重试语义**：fire 的 error result 回到 `executeAgentCall` 通用重试面（`attempts < MAX_ATTEMPTS` 退避重试，`:188-193`）——**保留重试是有意决策**：并发拥塞型楔死（carbon 形态）重试常自愈；每次重试重新 arm watchdog（SAR.run 为 per-call 方法，重试递归全新调用，天然重挂）。最坏收敛上界 = MAX_ATTEMPTS × 30min + 退避（存在 token/时间预算时更早收敛——`budget.isExceeded` / `scheduleTimeBudget` 两条既有通道都会把 run 更早收敛为失败终态，fire error 不含 usage 不烧 token 预算）。重审条件：实例显示重试放大不可接受（如持久楔死占多数且 3×30min 太久）→ error 加 no-progress 标记跳过重试。
- **killAll 组杀连带面（R3 MF-影响，四要素登记）**：
  - 量级：组杀触发前提 = 引擎进程对 cancelRun 帧 >3s 无响应（引擎事件循环停摆或极重拥塞）——**非每次 fire**（引擎活而响应时 cancel 只杀目标子进程，run 正常应答）；触发时 `killAll` → `teardownProcess`（`engine-client.ts:612-643`）全量 reject 在途 run 请求 + 清空路由，同引擎其余并发 run 全部 engine_crashed error 终态（失败通知照发，G1 字面保持；引擎单例共享 = `registry.ts:246-247`）。
  - 显式判定：接受——机制系既有（`cancelBackground` 同链）、被连杀 run 有失败通知与 executeAgentCall 重试通道、替代方案（per-run 引擎实例隔离）成本不成比例。
  - 恢复路径：被连杀 run error result → 退避重试（引擎崩溃重建 1+3 次现成）→ 或最终失败进 workflow 结果。
  - 重审条件：carbon 形态实测连带率高（如 >50% healthy run 被连杀）或出现 killAll 后重建失败实例 → 重评 per-run 隔离或 killAll 前逐 run cancel 广播。
- **fire 回调契约**：继承 `onHotPathSettledWatchdogTimeout` 先例（:1545-1550）——同步段只做 controller.abort（AbortController.abort 幂等不抛）+ warn，异步收尾 fire-and-forget catch 归 bestEffort；错误逃出回调 = uncaughtException 崩宿主。
- 超时哲学合规：30min 无进展检测 = 回收层有界兜底（产出即刷新，非墙钟），与 chat 域同一原语同一量级，规则 19 合规。
- **误杀面（R3 S-影响，收窄断言；M5 按一致性审查分区 B 补第二形态）**：「刷新面全化后理论误杀面归零」**不成立**——共两类形态，均为「合法任务被误判无进展 → fire 终止」：
  - ① `host/askUser` / `host/permission` 反向请求 ack 后不计时等待宿主答复（`reverse-router.ts:80-117` 头注明言 handler 永不 resolve 也不判故障），等待期间无 event/delta，刷新面覆盖不到 → 长于 30min 的合法用户等待会被 fire 终止。处置 = 登记形态（chat 域 mid-round 守护同款盲区，一致性先例）+ 重审条件（workflow 域 askUser 等待被误杀实例出现 → 反向请求到达计入刷新或 pending 期间挂起计时）；不加新机制（减法，chat 域同款已被 W 系列接受）。
  - ② **工具执行期只有 `tool_execution_update` 流**（pi 内置 bash **无默认超时**：`dist/core/tools/bash.js` schema 明写「optional, no default timeout」，`resolveTimeoutMs(undefined) → undefined`；pi 以 `dist/core/agent-session.js:537-539` 发 `tool_execution_update`），而引擎翻译层 `CLI/spawn-event-translator.ts:152-184` 的 switch 无该分支（`default: return`）——该事件既不产 AgentEvent 也不进 `onDelta`，**刷新两路同时失明** → 单次工具调用持续 >30min（长构建/长测试/长安装，期间有可见输出）会被判无进展并取消，重试 3 轮后失败。**处置 = 修（不是登记接受）**：工具持续产出即「有进展」，把该事件计为活性信号即可消除误杀，且不削弱「静默楔死仍被回收」的安全底线（静默工具调用仍会被回收）。修复须在 pi-subagent-cli 内闭环，受两条硬约束：不得污染聊天记录（不得把工具输出当正文文本推流）、不得让楔死工具永续命。**已修（commit `1d94a2471`）**：翻译层 `tool_execution_update` → onEvent 活性信号（1s 节流、不进 `onDelta`）。**载体升级（交付后，F2 清账）**：活性信号载体已从「usage/error 双缺省的 `message_end` 借用形态」升级为**协议第一类 `activity` 变体**（AgentEvent 闭合联合第 9 员：双侧 reducer no-op、core journal-wiring 豁免 append 不进持久/重放面、wire 盲传对旧宿主前向兼容，协议维持 v1 additive；pi 翻译层 `TOOL_ACTIVITY_EVENT` 已换轨、core 遗留翻译器 `jsonlToAgentEvent` 同语义对齐）。**覆盖边界（定向复审补，勿夸大）**：= **workflow 域全域 + chat 首轮**；**chat 续聊（interact）轮仍失明**——`CLI/chat-session.ts:283-285` 对续聊轮不外发事件（`if (!session.firstRoundDone) opts.onEvent(event)`），而宿主续聊轮的刷新源只有 `streamDelta`（`subagent-service.ts:1366/:2641`），工具输出又被硬约束①挡在 delta 外 → 该轮内「仅工具输出、零正文」>30min 仍会被 fire。此边界**无法在 pi-subagent-cli 领地内闭合**（唯一 CLI 内出口是伪造 streamDelta，违反硬约束①），处置 = 登记 + 待协议 activity 变体（见 impl-plan F2）。chat 首轮与 workflow 域同款盲区随本修复受益这一表述仅在首轮成立。**已闭合（2026-09-10 交付后 PR2，见 impl-plan F3 清账）**：activity 变体落地后，`host/roundLifecycle` 增 `phase:"active"` 轮内心跳相位——pi chat-session 续聊轮把 `activity` 事件经独立发射函数 `emitActivePhase` 转 recordId 键 active 帧（不经 `emitPhase`，防误 resolve cancel 轮终等待体；superseded 抑制），宿主 `handleChatRoundPhase` case active 与 streamDelta 同款刷新中段守护，不处置 record；chat 域续聊轮盲区清零。
- **env 关闭的连带面（M6 登记）**：`XYZ_SUBAGENT_SETTLED_WATCHDOG_MS<=0` 的文档语义是「关掉 chat 域两段守护」，但本决策让 workflow 域经 `armMidRoundNoProgress` **同一入口**挂载——故该 env 为 ≤0 时 workflow 域的 G1 熔断（静默楔死 run 的无进展回收）**一并静默失效**。处置：不改开关语义（减法，且规则 19 下有界兜底的处置须可解释），而是让连带后果**可见**——`settled-watchdog.ts` 的 warn 文案与头注已明示，`troubleshooting.md` §12 第 ⑥ 条同步登记排查入口。
- 与 W 系列无冲突：workflow 域无 record，不触 RoundSupervisor 纳管面；chat 域守护（kickOffChatRound 链）零改动（V5b 回归守护）。

### 3.4 错误规格（新增/改动面）

| 边界 | 行为 | 恢复指引 |
|---|---|---|
| 握手应答缺 sessionFile（S2 修复后） | 保留 timer，2s 后照常排 retry，3 轮耗尽 resolve 已收集字段 | 无需恢复——这是正常降级 |
| agent_end 补查超时/写 stdin 失败 | resolve 空对象，照常 kill，不重试 | 全路 miss 时 close 收尾响亮 warn（M4 已移除） |
| **agent_end 回补编排自身异常**（onHandleReady → server 组帧链抛错） | try-finally 保证 kill 必达，异常按 miss 处理 + warn | kill 后走正常 close 收尾 |
| agent_end 补查命中 | 回填 sessionFile + handleReady，kill 照常（finally） | — |
| ~~M4 扫描零/多命中 / fs 异常 / 采纳命中~~（已随 M4 移除） | close 收尾 LC-4 后 sessionFile 仍缺 → 响亮 warn：`[sessionfile] unobtainable for <recordId> (all acquisition paths missed: spawn handshake, late response, agent_end backfill, LC-4 suffix lookup)` + 恢复指引；best-effort 不阻断 resolveExit | warn 尾句：session-reader 按 mtime 窗口人工归档 / 重派任务 |
| kill 落在已退出子进程 | 幂等 no-op（K2 验证 killChain 既有守卫） | — |
| M2 期间子进程自行退出 | endedCleanly 已置位，close 走 exit 0，补查自然落空 | — |
| **workflow 域静默楔死**（M3 补挂后） | fire：watchdog controller.abort（并入 mergedSignal）→ cancel 帧 / 收敛窗 killAll 阶梯 → engine.run 收敛 → SAR error result（退避重试或最终失败进 workflow 结果） | fire warn 附「同引擎并发 run 可能连带 engine_crashed（killAll 组杀面，见决策 9 四要素）」；失败结果附「重派 workflow / 检查 subagents」指引 |

---

## 4 验收

> 全部场景映射 §1.3 目标；真实场景优先，单测只作契约守护。实施完成后逐条执行并回填结果。
>
> **验收分层声明**：V2-V4 的被测系统 = 引擎 CLI 真实进程 + 真实 spawn/stdio/时序边界，仅 pi 对端用可控协议脚本进程替代（dev-0.9.16 conformance 测试的 fake-engine 同先例）——S2/M2/M4 验证的是握手与收尾的时序行为，需要可控构造「应答缺字段/不应答/延迟」形态，真实 pi 无法确定性构造；V1 用真实 pi 端到端兜底事故形态；V5 的 M3 守护链在 core 包内用单测 + 短超时 seam。

| # | 场景 | 步骤 | 通过标准 | 回溯 | 结果（2026-09-10 M5 回填） |
|---|---|---|---|---|---|
| V1 | 事故形态重放（6 路并发 one-shot） | dev app（`pnpm dev`）真机，主会话派发 6 路并发 workflow subagent（同 carbon 任务形态），等待完成 | 6 条完成通知全部到达（分钟级，无 90min 挂死）；通知含结果正文；抽 1 条 record 验证 sessionFile 非空且 session-reader 能读全文 | G1、G2、M2 | ✅ **Gate B 通过（2026-09-10，两段执行形态）**。① **GUI 层**（dev app 默认 zcode 引擎，20:00:32 派发 → 20:04:10 全完成 ≈3.5min）：6/6 完成通知分钟级全到、通知含结果正文（六首诗 + 逐路 ✅ 汇总；截图 `/tmp/gateb-v1-02/03-*.png`）。② **pi 链真机层**（探针：`bin/pi-subagent-cli.mjs` 当前源码 + PATH 注入真实 staged pi 0.84.4 + 真实 LLM `zai-coding-cn/glm-5.2`，6 路并发同模板）：6/6 终态（59-91s，总 91s）、**handleReady 反向帧 6/6 携带非空 sessionFile**（M1/M2 回填面真机生效）、outcome 正文与 usage 齐、sessionFile 落盘且全文可读（JSONL 直接解析 = session-reader 同格式）。**为何两段**：GUI 直跑 pi 引擎被预存缺口 F6 阻断（relay 身份键缺失 → pi child exit 13，两域全域，见 impl-plan §7 F6；另 staged 引擎为陈旧构建 F7），pi 链改以与 `protocol-e2e.test.ts` 同形态的宿主直连闭环——引擎协议、spawn、握手、回补、close 全层真实，仅宿主进程从「GUI 内 extension」换为「探针脚本」。判据逐条：6 通知分钟级 ✓（①+② 各 6/6）、正文 ✓、sessionFile 非空且可读 ✓（② 6/6） |
| V2 | S2 契约（应答缺 sessionFile） | 协议脚本对端（conformance fake-engine 先例）：首答在 2s 超时后到达且 payload 不含 sessionFile——**纯契约构造**（真实 pi 应答恒带 sessionFile，§1.2；此形态生产未观测，验证的是引擎侧握手状态机对它的鲁棒性） | 日志显示 attempts 继续推进到 3；最终 collected 带 sessionId；close 后 sessionFile 经 LC-4 落位 | G2、M1 | ✅ **单测/契约对端通过（M1，commit `9578af7f4`）**：`get-state-handshake.test.ts` 9 passed，含契约用例「response 只带 sessionId（无 sessionFile）→ 视同未应答：剩余重试照发，3 轮耗尽 resolve 已收集字段」（attempts 1→2→3，settled 置位）。复跑证据 2026-09-10：`pnpm vitest run src/__tests__/get-state-handshake.test.ts` → 9 passed。✅「close 后 sessionFile 经 LC-4 落位」子断言已由 U-A2 新增 e2e 直接覆盖（commit `1d94a2471`：`run-spawn-once.integration.test.ts` 的 id-only 用例断言 `outcome.sessionFile` = LC-4 反查文件 + `handleReady` 恰一条）；⏳ 仅「V2 真机形态」待阶段 5 Gate B。 |
| V3 | agent_end 补查（握手总失 + agent_end 恢复） | 协议脚本对端：spawn 期 get_state 三轮全部不应答（对端扣住应答——原事故的现实形态），正常跑完任务出 agent_end，agent_end 时刻对端恢复应答 | outcome.sessionFile 非空；主会话通知可 session_read 取回全文；总耗时较正常路径 +≤1s | G2、M2 | ✅ **协议脚本对端通过（M2，commit `042dccec6`）**：`agent-end-backfill.test.ts` 6 passed，含 V3 用例「spawn 期三轮不应答 + agent_end 恢复应答 → outcome.sessionFile 非空且恢复 ≤1s」（impl-plan §6 实测 614ms；2026-09-10 复跑 721ms）+ 回补链 reject / 同步 throw 两路 kill 必达 + K2 幂等 + 自退 race。⏳ **V3 真机形态待阶段 5 Gate B**：判据 = 真实 pi 子进程 + wrapper 扣响应形态下 outcome.sessionFile 非空、主会话 session_read 可取回全文、总耗时较正常路径 +≤1s。 |
| V4 | M4 兜底（全程不应答） | 协议脚本对端：get_state 全程不应答（spawn 期 + agent_end 期），对端正常落盘 session 文件后跑完 | close 后 record.sessionFile 经 prompt 键扫描补上（单命中）；若构造多命中（同 prompt 双开）则放弃 + warn，run 仍正常终态、通知照发 | G2、M4 | ✅ 协议脚本对端通过（M4，commit `f737baa7a`，29 用例）。**交付后修订（2026-09-10）：M4 整体移除（`dbe0a60d4`），本场景随之作废**——回归价值由改写后的 e2e 用例承接：「四路全 miss → 响亮 warn（recordId + unobtainable + 排查指引）+ run 正常终态（success 不变、无挂死）」。 |
| V5 | workflow 域守护（M3 补挂，SAR 落点） | 两层：① 单测（fake timers）断言 SAR.run 内 arm → 静默推进 30min → fire（watchdog controller.abort → mergedSignal → engine.run 收敛 → SAR error result），**以及产出刷新面**（事件/delta 持续到达跨窗长时不 fire——刷新源接线缺陷须可被验收暴露，R4 S）；② 真跑一次短超时全链（K6 核实 mid-round 窗可否经 env/测试 seam 缩短后构造楔死） | ① fire 链各环节断言绿 + **产出刷新不 fire 断言绿** + **`agent()` promise 收敛 + journal close + 重试面行为符合决策 9**（只断言通知不断言收敛 = 验收盲区，R2 修订）；② 真实 error result 到达 workflow、退避重试或最终失败可观测 | G1、M3 | ① ✅ **单测（fake timers）通过（M3，commit `bd4404ddf`）**：`subprocess-agent-runner-no-progress-watchdog.test.ts` 7 passed——arm → 静默推进 30min → fire（watchdog abort → mergedSignal → engine.run 收敛 → SAR error result）+ 产出刷新不 fire（事件/delta 两路）+ `agent()` 收敛 / journal close / 重试面。② ✅ **V5② 已由 M6 恢复为可执行并跑通**（commit `8b78f392a`）：mid-round 窗新增**仅测试可达**注入口（`_setMidRoundNoProgressWindowMsForTest`，不做 env、生产恒 30min 且有断言守护、与 `_resetSettledWatchdogsForTest` 一并复位），真引擎秒级窗**单条测试闭环**「窗口到点 → fire → abort → 合流 → 取消帧 → 3s 宽限 → killAll → error result」（实测 8.05s，含邻接 run `engine_crashed` 与 error result 恢复指引）。K6 原「不可缩短」结论仅对 env 路线成立，测试 seam 路线由 M6 打通——fire 链两段拼接的缝不再依赖审查背书。 |
| V5c | killAll 组杀邻接（M3 连带面） | 单测：同引擎 2 路 run（1 路楔死触发 fire + 引擎对 cancel 无响应形态、1 路 healthy），观察连带 | healthy run 收敛为 engine_crashed error（G1 字面保持：有终态 + 可重试），无悬挂 | G1、M3（决策 9 组杀四要素） | ✅ **单测通过（M3）**：`subprocess-agent-runner-no-progress-killall.test.ts` 1 passed（真引擎 3.06s；watchdog fire + 引擎对 cancel 无响应 → killAll → 邻接 healthy run 以 engine_crashed 收敛、无悬挂）。 |
| V5b | chat 域守护回归（守护不误伤） | 单测：chat 域 arm/fire 既有行为零变化（M3 不触碰 kickOffChatRound 链） | 既有 settled-watchdog / chat-round-first-round-watchdog 测试全绿 | G1 | ✅ **单测回归通过（M3）**：`chat-round-first-round-watchdog.test.ts` 6 passed（2026-09-10 复跑；M3 未触碰 kickOffChatRound 链，settled-watchdog 原语既有行为零变化）。 |
| V6 | 常规回归 | 正常单路 one-shot + 一条 chat 域 subagent（含冷续一次） | 行为与现状零差异：通知、结果、sessionFile、resume 全部正常 | G2 | ✅ **Gate B 通过（2026-09-10，两段执行形态）**。① **单路 one-shot**（GUI，默认引擎，20:34:35 派发 ≈75s）：`sa-bf981407`（slug summer-poem）完成通知到达、状态 completed、结果四行诗正文随通知交付（截图 `/tmp/gateb-v6-oneshot-complete.png`）——与现状零差异 ✓。② **chat 域 + 冷续**（GUI 直跑被 F6 阻断——失败通知正常到达本身即 G1 韧性面的真机证据；改真机探针闭环）：首轮 run chat（conversation:true，真实 pi + 真实 LLM）→ handleReady.sessionFile 非空 → settled/idle → run 应答；续聊 interact message（ok+delivered，settled）；**跨进程冷续**（引擎 1 SIGKILL → 引擎 2 新进程 + resume 锚点）→ handle.sessionFile 同一文件、2444B → 10224B 追加写、模型正确召回两轮历史；会话文件含全部三轮 user 条目。sessionFile / resume 与现状零差异 ✓（探针 root：`/tmp/gateb-v6-chat-*`） |
| V7 | 机器门 | `pnpm --filter @zhushanwen/pi-subagent-cli test` + core 全量 + tsc + pre-commit 全守卫 + `node scripts/check-doc-symbol-drift.mjs`（replay.md 已登记映射后真检查，见决策 8） | 全绿 | G3 | ✅ **守卫机器门通过（M5）**：`node scripts/check-doc-symbol-drift.mjs` exit 0（replay.md 已登记 `DOC_MODULE_MAP` → pi-subagent-cli / subagent-core execution 等模块，反向探针证明非恒真——插不存在符号即报 drift，见 M5 汇报）。单元级测试：M1 `9578af7f4` / M2 `042dccec6` / M3 `bd4404ddf` / M4 `f737baa7a`，包内全量见各 commit 状态。⏳ 阶段 5 Gate B 的 pi-subagent-cli test + core 全量 + tsc + pre-commit 全守卫 待回填。 |

V2-V5 的协议脚本对端 = 独立验证脚本进程（按 pi rpc 协议应答，形态可控），用完归档移除（对齐 AGENTS.md「外部系统对接先验证再编码」惯例）。V1 是真实 pi 端到端。**对端进程数据目录约束（R1 S-2）**：对端的 sessionDir 必须 `mkdtempSync` 自建自删，或显式继承测试进程已重定向的 `XYZ_AGENT_DATA_DIR`（pi-subagent-cli vitest global-setup 已重定向），禁止硬编码真实数据目录——fs-guard 是进程内切面，罩不住独立对端进程。V5 的 30min 量级不真跑（fake timers），量级依据已有 P-T2c 探针先例。

### 4.1 K 检查点终局与单元级证据（2026-09-10 M5 回填）

**K1 接线签名**：✅ **零接线改动即满足**——既有握手调用点已用 `performGetStateHandshake(child, identity.addStateListener)` 同形态；`AddGetStateResponseListener = (id, resolver) => void | (() => void)` 与 `addStateListener(id, resolver): void` 直接可赋值。M2 未改 `get-state-handshake.ts`（diff ⊆ 领地，零改动）。

**K2 killChild 幂等**：✅ **成立**（非偏差，结论登记）——`subagent-engine-sdk/src/kill-chain.ts:95` 首行 `if (child.exitCode !== null || child.signalCode !== null) return "terminated"` 早退，:121-129 safeKill 吞「检查与 kill 之间自退」抛出；M2 补组合级用例（回补 finally 经杀链落已退出 child → 不调 `child.kill`、不注册 exit 监听、可重复）。

**K3① prompt 是否逐字落盘**：✅ **结论 = 非逐字**（实装 pi 0.84.4 `dist/core/session-manager.js:701/732/753` 逐行 `JSON.stringify(entry)` 落盘）→ M4 启用「原文 + JSON 转义形态」双 includes，**未走设计预置的降级路径**（降级 = 只做 mtime 窗口 warn、不自动采纳）。双 includes 的误配面与原文匹配同强度（JSON 转义是单射、逐字符确定性），安全底线「单命中才采纳」未放松；反证用例已锁（仅原文 includes 必 miss）。

**K3② 真实 workflow 并发 prompt 头部区分度**：✅ **实测完成（2026-09-10 Gate B，V1 pi 链探针附带）**：6 路同模板并发（共享模板前缀 ≈257 字 + 主题词「山/海/风/月/雪/雨」追加在末尾，prompt 全长 260 字），**前 200 字符 6/6 完全同质**（distinct=1）——carbon 旗舰形态证实：M4 头部键在该场景必然多命中 → **安全放弃（不误配但无效）**，与决策 4 的失效面预判一致。**交付后终局（2026-09-10）：M4 已整体移除（`dbe0a60d4`），原预登记的键策略升级后续任务随之作废**——旗舰场景的全 miss 由响亮 warn + session-reader 人工归档承接。

**K4 rpc-client 双版 diff**：✅ **无欠账重放**（主 agent 核验：线 B 对 `rpc-client.ts` 的改动 = 纯 D4 消费切换 + 注释迁移；线 B 注释提及的 stdout error 吞转发防护在 dev 版同点位存在——`rpc-client.ts:482` 一行防护 + `:496` W2 完整监听）。M5 无 rpc-client 相关重放。

**K5 M0 合并冲突面对照**：✅ **与决策 7 预演清单完全吻合**（内容冲突 2 件 / 自动合并陷阱 2 件 / 自动保留面 5 件 / file-location 7 + modify/delete 3 件）；另清理 3 个 `git checkout <tree> -- packages/` 覆盖不到的线 B 独有测试文件（残留清理 `e192dfe4a`）。

**K6 mid-round 30min 窗可否缩短**：⚠️ **原结论「不可缩短」仅对 env 路线成立，已由 M6 部分推翻**——① env 路线仍关闭（中段阈值是原语内纯常量，`settled-watchdog.ts` 注释「中段阈值 v1 不开 env」，env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS` 只覆盖收尾段或两段全关）——**这是刻意的减法设计**：每个 knob 都是误配置通道，用户调短会误杀正常长任务，故不因测试方便而开 env；② **测试 seam 路线由 M6 打通**（`_setMidRoundNoProgressWindowMsForTest`，仅测试可达、生产恒 30min、可复位）→ **V5② 恢复为可执行并已跑通**（commit `8b78f392a`，真引擎秒级窗全链 8.05s）。原「V5② 降级由 V1 承接」不再适用；V1 仍保留（真机端到端兜底事故形态）。

**单元级证据（commit + 测试）**：

| 单元 | commit | 测试结果 |
|---|---|---|
| M1 S2 契约修复 | `9578af7f4` | 契约断言（缺 sessionFile → 重试 1→2→3 照发 → 3 轮耗尽 resolve 已收集字段）；pi-subagent-cli 全包 304 passed + tsc 干净 |
| M2 agent_end 惰性回补 | `042dccec6` | 6 用例（V3 回补 ≤1s 实测 614ms / 回补 reject 与 sync-throw 两路 kill 必达 / K1 接线面 / K2 幂等 / 自退 race）；全包 310 passed + tsc 干净 |
| M3 workflow 域守护补挂 | `bd4404ddf` | 8 用例（V5① 7 + V5c 1，真引擎 3.06s）；subagent-core 全包 2842 passed + tsc 干净 |
| M4 close 兜底扫描 | `f737baa7a` | 29 用例（locator 17 + pump 8 + 生产路径 e2e 4，含接线前后反向探针）；全包 339 passed + tsc 干净。**交付后移除（`dbe0a60d4`，用户裁定）**：净删 841 行，回归用例改写为「四路全 miss → warn + 正常终态」 |

**复跑证据（2026-09-10 M5 独立复跑）**：pi-subagent-cli 5 个测试文件 `44 passed (44)`；subagent-core M3 两文件 `8 passed (8)`（含 V5c 真引擎 3060ms）+ chat 域回归 `6 passed (6)`。

---

## 5 下一层拆分

### 5.1 实施单元

| 单元 | 内容 | 文件改动地图 | justification / 验收挂钩 | 依赖 |
|---|---|---|---|---|
| **M0 合并基底** | 本 worktree `git merge dev-0.9.16` → 解冲突 → **整树重置代码面**（决策 7：`git checkout dev-0.9.16 -- packages/ && git checkout dev-0.9.16 -- eslint.config.mjs`，覆盖冲突面/自动合并陷阱/自动保留面三类）；文档冲突保两套（线 B 三份 + dev-0.9.16 全部） | 无新改动，纯合并 + 重置 + 归位 | 合并后全量测试三连绿才动手——基底不绿后续无从归因 | — |
| **M1 S2 契约修复** | 决策 1：clearTimeout 移入命中分支；改写锁行为专测为契约断言 | `packages/pi-subagent-cli/src/get-state-handshake.ts:82-91`；`__tests__/get-state-handshake.test.ts:163-192` | 独立可验收（V2 + 单测）；最小 diff 先行，与 M2-M4 解耦 | M0 |
| **M2 agent_end 惰性回补** | 决策 2：onAgentEnd 非 chatMode 分支 async 编排 + requestGetStateOnce 接线 + **回补 try / kill finally 必达** + killChild 幂等核验（K2） | `packages/pi-subagent-cli/src/spawn-runner.ts:274-276`（+ 新增惰性回补小函数）；测试：agent-end 补查用例（fake timers + fake child）+ 回补链抛错 kill 仍达用例 | V3；消费死导出即「欠账清偿」，接口已备 | M0（不依赖 M1，可并行） |
| **M3 workflow 域守护补挂（SAR 落点）** | 决策 9：SAR.run 的 try 块内、engine.run 派发前 arm per-run no-progress watchdog（刷新 = journal.onEvent 包装 ∪ stream.onDelta 包装；disarm = finally；fire = watchdog controller 并入 mergeTimeoutSignal 合流 → wireAbortSignal 阶梯；同步段不抛契约；重试语义保留） | `packages/subagent-core/src/execution/subprocess-agent-runner.ts`（SAR.run :235 起 + signal 合流 :214 扩一源）；测试：楔死 fire 链（fake timers，含 agent() 收敛/重试面断言）+ killAll 组杀邻接（V5c）+ chat 域守护回归零变化（V5b） | V5/V5b/V5c；R1 发现 G1 缺口、R3 修正落点（runAndFinalize 系残留面），复用既有原语 | M0（不依赖 M1/M2，可并行） |
| **M4 close 兜底扫描** | 决策 4：prompt 头键扫描器（参考线 B locator 骨架重写）+ close finalizer 接线（LC-4 之后）+ **整体 catch / resolveExit 必达 / 审计 warn / 降级门** | `packages/pi-subagent-cli/src/session-file-locator.ts`（新）；`spawn-run-pump.ts:201-216`（close finalizer 插入点）；`index.ts` barrel 按域插入；测试：单命中/零命中/多命中/坏行容错/fs 异常降级 | V4；rare² 场景 + 取证价值，允许依 K3 降级 | M0 |
| **M5 文档与守卫** | 决策 8：线 B 三份文档头部修订记录 + troubleshooting §12 同步 + replay.md 登记 DOC_MODULE_MAP（drift 守卫真检查） | `docs/design/subagent-agent-end-recovery.md`、`.impl-plan.md`、`subagent-core-unbounded-wait-audit.md`、`docs/troubleshooting.md`、`scripts/check-doc-symbol-drift.mjs`（登记映射）；本文档回填验收 | V7 | M1-M4 |

### 5.2 待验证检查点（设计阶段无法定死，实施期核验）

- **K1**：`requestGetStateOnce` 的 `addResponseListener` 参数接线——用 identity tracker 的 `addStateListener`（自动过 `applyGetStateFields`）还是裸路由注册；倾向前者（回填面统一），实施时核对签名。
- **K2**：`killChild`（→ killChain）对已退出子进程的幂等性——预期既有守卫（`child.exitCode !== null` 判活先例），实施时核实并补测试。
- **K3（两项）**：① pi session 文件里 user prompt 是否逐字落盘（M4 匹配键前提）——**实测结论（2026-09-10）：非逐字**（逐行 `JSON.stringify` 落盘，引号/反斜杠/制表/换行皆转义形态），**未走原定降级路径**，改为「原文 + JSON 转义形态」双键（理由见决策 4 末条）；单一原文键恒 miss 的反证用例已锁在 `session-file-locator.test.ts`。② **真实 workflow 并发形态的 prompt 头部区分度实测**——**实测完成（2026-09-10 Gate B）：前 200 字符 6/6 完全同质**（共享模板 >200 字 + 参数在末尾的旗舰形态），M4 头部键在该场景必然多命中 → 安全放弃；**交付后终局：M4 已整体移除，键策略升级（全文哈希/参数段取样）后续任务作废**（实测证明六路全文互异，若未来重做兜底可作键设计输入）。
- **K4**：两版 rpc-client diff 核验（决策 5 残余风险）。
- **K5**：M0 合并实际面对照决策 7 的 merge-tree 预演清单（内容冲突 2 件 / 自动合并陷阱 2 件 / 自动保留面 5 件 / file-location 7 件 + modify/delete 3 件）；若出现预演清单外的 packages/ 冲突说明取向判断有误，停下重估。
- **K6**：workflow 域 mid-round 守护窗（30min）可否经 env（`XYZ_SUBAGENT_SETTLED_WATCHDOG_MS` 族）或测试 seam 缩短以支撑 V5② 真跑——不可缩短则 V5② 降级为 V1 端到端兜底（楔死场景不真构造）。

### 5.3 线 B 已登记遗留的处置（随本设计闭环）

| 遗留项 | 处置 |
|---|---|
| ① NotifyDomainPorts 端口缺席加固 | 维持独立任务，不并入（out of scope） |
| ② S6 session_read 指针行端到端 | M2 直接改善其数据面（sessionFile 命中率↑）；V1/V3 验收覆盖，观察项可关闭（交付后修订：M4 已移除，数据面改善由 M2 独立承载） |
| ③ 存量测试 flake 三项 | 随 engines/pi 删除消亡（M0），无需处理 |
| ④ carbon 需升级 | 部署侧提醒：修复生效前提是宿主升级到含本设计的 xyz-agent 版本 |

### 5.4 超时哲学合规声明（规则 19）

本设计新增的全部时限均为控制面/回收层量级：M2 补查 1s（单请求）；M3 守护 30min 无进展检测（回收层有界兜底、产出即刷新非墙钟，与 chat 域同一原语）；M4 扫描有界（候选数 ≤ 并发上界 × 64KB 头读，readdir ∝ 同 cwd 历史文件数 ≈ 数千条目数 ms 级，含 >64 候选/100ms 降级门）；未引入任何任务级墙钟。任务执行正常路径（run 帧）维持不设超时现状。
