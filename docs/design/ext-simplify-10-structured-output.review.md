# ext-simplify-10（structured-output 仪式化残留收敛）设计文档审查报告

> **审查对象**：`docs/design/ext-simplify-10-structured-output.md`（v1，2026-09-12）
> **审查方法**：over-engineering-audit skill 判定框架（四问 + 反模式清单 + 豁免规则），对抗式（默认怀疑，逐条以当前源码定核）
> **审查基线**：2026-09-13 实读当前源码（分支 `feat-optimize-extension-over-engineering`）。注意：本设计起草（09-12）后，ext-simplify 批次 01/02/03/09/12/14 已实施并完成版本 bump（commit `c79cd621c`，09-12 13:52），部分事实已漂移，本报告逐条标注。
> **审查纪律**：本审查只读源码 + 写本报告，未修改设计文档与任何源码。全部 file:line 均为审查时实读值。

---

## 1. 总判定

**VERDICT: PASS (must-fix 0 / suggestion 5)**

设计的核心事实链全部经当前源码独立核实成立，四个决策（D1 删守卫 / D2 slot 回退 let / D3 出口收敛 / D4 移交边界）均通过四问核对，无投机抽象、无新增机制、「行为零变更」有构造性可证伪验收。5 条 suggestion 全部为文档级事实精度修正（行号漂移、版本号过时、一处测试路径表述失实、一处调用点计数失实、测试基线数字漂移），不阻塞实施，但建议实施前顺手更正以防误导实施者。

---

## 2. 事实核对表

设计文档声称的每条「现状问题」× 当前源码核实结果。行号列括号内为设计文档记录值，差异为机械偏移（见 S5）。

| # | 设计声称（章节） | 当前源码核实（file:line 实读） | 判定 |
|---|---|---|---|
| F1 | M24 守卫存在：`assertSafeTimerDelay` 双分支 throw，约 30 行（§3.1，记 :394-422） | `extensions/universal/structured-output/src/loop-gate.ts:395-423`：锚点注释 :395-402 + `MAX_TIMER_DELAY_MS` :403 + 函数体 :408-423（两 throw 分支：非有限值 / 超 2^31-1） | 属实（行号 +1） |
| F2 | 唯一生产调用点实参恒为字面量 `TEARDOWN_FORCE_EXIT_MS = 15_000`（§3.1，记 :484 / :438） | 调用点 `loop-gate.ts:485`（唯一，grep 全仓证实）；`TEARDOWN_FORCE_EXIT_MS = 15_000` 于 :439，`export const` 字面量 | 属实 |
| F3 | 两个 throw 分支对 15000 永不可达（by construction） | 15000 是有限数且 < 2^31-1，数学事实 | 属实 |
| F4 | SSOT 原版 `packages/subagent-core/src/shared/timer-delay.ts:37` 有 ≥8 个真实动态调用点（§3.1） | 实际 **7 个**调用点：settled-watchdog.ts:237/269/309（×3）+ lifecycle-manager.ts:142 + supervisor.ts:371 + lifecycle.ts:197 + launcher.ts:168。设计列举的 dialog-queue.ts:53 与 subagent-service（run-orchestration.ts:1604）实为**注释引用**非调用 | **部分属实**（计数失实；「原版守动态输入、副本喂字面量」的方向结论成立，见 S4） |
| F5 | 锚点注释漂移：指向 `@zhushanwen/pi-subagent-workflow` 的 `shared/timer-delay.ts`，该路径不存在（§3.1） | 注释实文 `loop-gate.ts:396-398`；`find` 全仓 `timer-delay.ts` 唯一命中 `packages/subagent-core/src/shared/timer-delay.ts`；`extensions/universal/subagent-workflow/` 内无此文件 | 属实 |
| F6 | 测试专设 5 条断言锁守卫（§3.1，记 :704-709） | `tests/loop-gate.test.ts:705-711`（it 块），5 断言在 :706-710（NaN / +Infinity / 2^31 超限 throw + 15000 放行 + 2^31-1 放行） | 属实（行号 +1~2） |
| F7 | slot 三件套 17 行：SLOT_KEY + TeardownTimerSlot + getter，`armForceExitTeardown` 经 slot 读写（§3.2，记 :446-463 / :482-483 / :494） | `loop-gate.ts:447-464`（注释 :447-449 + key :450 + type :452 + getter :454-464）；读写点 :483（get）/ :484（clear）/ :495（set） | 属实（行号 +1） |
| F8 | 注释自认 jiti 双实例失效模式良性——「至多双 timer 各自 process.exit，进程级幂等」（§3.2，记 :447-448） | 注释实文 `loop-gate.ts:447-449` 逐字一致 | 属实 |
| F9 | 引入史 `c20f2b1ef`（2026-08-29 review round 2）以 **suggestion** 采纳 slot 化，非 bug 驱动；slot 化前原形态即模块级 `let teardownTimer`（§3.2） | `git show c20f2b1ef` 证实：commit message 明列「suggestions: loop-gate teardownTimer / notify-ledger 旗标 slot 化（C-ext-06）」；diff 显示删除的原注释为「已武装的兜底硬退 timer（模块级；terminal 全生命周期至多一次，防御性幂等再清）」+ `let teardownTimer` | 属实 |
| F10 | 「notify-ledger 先例」如今全部落在 `packages/subagent-core`（notify-ports.ts:123 / host-services.ts:60 / model-config-service.ts:227），且均为真跨 session 进程单例（§3.2） | 三处实读证实：notify-ports.ts:123（NOTIFY_PORTS_SLOT_KEY，配置态持有）、host-services.ts:60（HOST_SLOT_KEY，注释自述 **dist 双形态下 configureCore 写主 bundle 副本、子入口侧恒 undefined 的真实分裂脑**）、model-config-service.ts:227（MODEL_SERVICE_SLOT_KEY，进程单例访问器）。三者均为「写后必须跨实例读到」的状态语义单例 | 属实 |
| F11 | C-ext-06 权威源适用前提 =「跨 session 存活、需在 session_start 重建的进程级单例」（§3.2 引用） | `docs/extensions/development-guide.md:785-790`（§7.5）逐字证实：「跨 session 存活、需在 `session_start` 重建的进程级单例……（如 Hub / Runtime / Registry），这种对象的生命周期长于单个 session」。`docs/constraints.json` 的 C-ext-06 summary 措辞更宽（「禁模块级 let 状态」无前提限定），但其 `authority` 字段指向 development-guide.md，正文为权威。§7.5 另有「纯性能缓存豁免」段，证明权威源本就对适用面有边界讨论 | 属实 |
| F12 | teardown timer 三条前提全不占：terminal 路径一次性武装（newlyTerminal 门控）/ 生命周期以 process.exit 终结 / 无任何跨实例读依赖（§3.2——**D2 立论根基**） | ① `loop-gate.ts:558` `if (!outcome.newlyTerminal) return;` 门控 + :579 唯一武装点；② timer 回调 :486-492 到 15s `process.exit(1)`，武装后进程必然在 ≤15s 内终结，不存在跨 session 存活；③ **slot 三件套全部未导出**（grep 全仓：TEARDOWN_TIMER_SLOT_KEY / getTeardownTimerSlot / teardownTimer 共 6 处引用全在 loop-gate.ts 内），`slot.current` 的读-清-写在单次 `armForceExitTeardown` 调用内同实例同步完成，全仓不存在「实例 A 写、实例 B 读」的时序依赖点。分裂脑（setX 写 A、getX 读 B 致状态丢失）对 one-shot exit timer 结构性不可达：timer 句柄唯一用途是幂等 clear，clear 失效的后果只是多一个 unref timer 空等，进程 exit 后消亡 | **属实**（核心裁决立论根基成立，详证见 §5.4） |
| F13 | `RetryState.reset` 零生产调用方，全仓唯一调用 = 专设测试用例（§3.3，记 :79-86 / :105-119） | `workflow-hook.ts:79-86`（注释 :79 自认「当前无调用方」+ 方法体 :80-86）；grep 全仓唯一调用 = `tests/retry-state.test.ts:106-121`（it 块）；连带悬空锚 `:56`「不可逆，仅 reset() 可清」注释实文存在 | 属实（行号 +1） |
| F14 | 日常变体 execute 内 env 重读不可达：装配分岔已用同一 env 裁决，进程 env spawn 时固定、全仓零写入点（§3.3，记 :226-241，读取 :236） | `tool-definition.ts:226-242`（读取点 :236 `process.env[ENV_SCHEMA] \|\| undefined`）；装配分岔 `index.ts:60-72`（:60 读同一 env，有值注册 workflow 变体不注册日常变体）；grep 全仓 `PI_WORKFLOW_SCHEMA` 唯一真实写入点 = `packages/pi-subagent-cli/src/spawn-args.ts:131`（`childEnv[SCHEMA_ENV_VAR] = schemaEnv`，spawn 时一次性注入），进程内运行时零写入 | 属实 |
| F15 | 零消费方导出三处：`GATE_ENTRY_TYPE`（loop-gate.ts:392）/ `HOOK_ENTRY_TYPE`（workflow-hook.ts:90）/ `validateAgainstSelfReported`（execute.ts:87），均仅同文件使用（§3.3） | 实读 :393 / :90 / :87；grep 全仓 import 消费方为零，同文件使用 :515 / :103 / :181。补充核实：两个 entry type 的**字符串值**（"structured-output:gate" / "structured-output:hook"）有测试按字面量断言（loop-gate.test.ts:626、characterization-hook.test.ts:84/:192/:222）——降模块私有不改变字符串值，不受影响；xyz-agent 侧（session-reader 等）无按字符串消费点 | 属实（GATE_ENTRY_TYPE 行号 +1） |
| F16 | index re-export 三项（`RetryState` :52 / `setupLoopGate` :53 / `LoopGate` :54）经 index 路径零消费；「本包测试全部走深路径」（§3.3） | 三项零消费核实**属实**（structured-output.test.ts / cross-package-contract.test.ts 虽走 index 路径，但只 import `executeStructuredOutput` / `createDailyToolDefinition` / `createWorkflowToolDefinition` / `SO_SCHEMA_SIZE_WARN_BYTES` / `ENV_SCHEMA`，均不在删除面）。但「本包测试**全部**走深路径」表述**失实**：`tests/structured-output.test.ts:29` 与 `tests/cross-package-contract.test.ts:24` 均经 `../src/index.js` 导入。与 §6.3 自己的保留面论证（「迫使其改走 index 反而扩大出口面」——承认 index 路径有测试消费）内部矛盾 | **部分属实**（见 S1） |
| F17 | SW 侧 vitest alias 指向 structured-output/src/index.ts 但无任何源文件 import（alias 为防御性基础设施）（§3.3） | `extensions/universal/subagent-workflow/vitest.config.ts:30` alias 实文；grep SW src 与 tests 均零 import（唯一命中 alias 配置自身） | 属实 |
| F18 | 悬空 unified-hooks 引用：text-primitives.ts:43-44「见 extensions/universal/unified-hooks 的 extractErrorText 及其文档」（§3.3 / E7） | **当前已不存在**——`ext-simplify-01` 实施commit `bf7ee07d0`（09-12 02:36，其 impl-plan E5 明确认领同点「text-primitives.ts :43-44 直接删除该从句」）已清理，当前 text-primitives.ts 全文无 unified-hooks 字样。设计 §6.4 已预见此情况并写明「后做的一方幂等跳过」协议，E7 在当前现状下为 no-op | **已被 01 号实施改变**（设计协同协议已覆盖，非设计错误） |
| F19 | redesign 文档 :275 有「`assertSafeTimerDelay` 包裹」表述需同批回写（E2，C-proc-10） | `docs/design/structured-output-redesign.md:275` 实文：「15s 兜底硬退 timer（`assertSafeTimerDelay` 包裹 + `unref` + terminal 路径幂等 clear；exit code 1……）」，位于 §6.3 v4 补记 SO 侧 terminal 动作链 | 属实（回写点定位准确） |
| F20 | redesign 文档 :339 的 kill-chain 表述属 SW 包，不动（Out-of-scope） | `:339` 位于附录 D「加固机制清单」，其上文明确「本节回写 **SW 侧**与其余语义」——SIGKILL 升级链/watchdog 为 SW 侧机制（其 `assertSafeTimerDelay` 引用对应 subagent-core launcher.ts:168 等仍在用的守卫），不随本包 E1 删除而漂移 | 属实（划界成立） |
| F21 | 既有测试基线绿：8 文件 191 用例通过（2026-09-12 实跑）（证据基线） | 审查时实跑 `npx vitest run`：**8 文件 194 用例全部通过**（867ms）。差异 +3 = commit `bbfae6f19`（09-10）加入的 stale ctx ①②③ 三用例（loop-gate.test.ts :744+）。全绿结论成立，用例数已漂移 | 部分属实（见 S3） |
| F22 | 包版本 v5.1.4，实施时 patch bump 5.1.4 → 5.1.5（§1 / §7） | 当前 `package.json` 已是 **5.1.5**——ext-simplify 批次收尾 bump `c79cd621c`（09-12 13:52「bte/plan/scheduler/structured-output/spt patch」）已占用该版本号。实施时应 bump 至 5.1.6 | **已被批次 bump 改变**（见 S2） |
| F23 | 审计修正 1：`executeStructuredOutput` 的「抽出以便单元测试直接调用」注释属实（execute.ts:143），且被 tests/structured-output.test.ts:344+ 经 index 调用（§7） | `execute.ts:143` 注释实文；`tests/structured-output.test.ts:29` import 自 `../src/index.js` + :343 起 describe 直调 `executeStructuredOutput` | 属实 |

---

## 3. must-fix 清单

**无。** 全部 23 项现状声称经当前源码独立核实：19 项属实、2 项部分属实但决策结论均独立成立（F4 / F16）、2 项已被其他已实施设计改变但设计自身协同协议已覆盖（F18 / F22）。未发现伪问题（现状指控失实导致方案不成立）、未发现有效性不可证伪项、未发现移交登记断链项。

---

## 4. suggestion 清单

### S1（最重）：§3.3「本包测试全部走深路径」表述失实，且与 §6.3 保留面论证内部矛盾

- **设计文档位置**：§3.3 出口面段（「本包测试全部走深路径（tests/loop-gate.test.ts:15-23 ← ../src/loop-gate.js；tests/retry-state.test.ts:12 ← ../src/workflow-hook.js）」）。
- **源码证据**：`tests/structured-output.test.ts:29`（`from "../src/index.js"`，import executeStructuredOutput / createDailyToolDefinition / createWorkflowToolDefinition / SO_SCHEMA_SIZE_WARN_BYTES）；`tests/cross-package-contract.test.ts:24`（`from "../src/index.js"`，import ENV_SCHEMA / SO_SCHEMA_SIZE_WARN_BYTES）。
- **问题**：「全部走深路径」为假。该失实表述与 §6.3 D3 采用段「迫使其改走 index 反而扩大出口面」自相矛盾（后者承认 index 路径有测试消费方）。
- **为什么非阻塞**：E6 的具体动作（只删 RetryState / LoopGate / setupLoopGate 三项 re-export）经独立核实安全——上述两个走 index 的测试文件 import 的符号均不在删除面，P2「既有用例仅删 :705-711 与 reset 专设用例、其余零改动通过」依然成立。
- **建议修法**：把该句改写为「三项符号经 index 路径零消费：structured-output.test.ts 与 cross-package-contract.test.ts 虽经 index 导入，但只 import executeStructuredOutput / 双变体工厂 / SO_SCHEMA_SIZE_WARN_BYTES / ENV_SCHEMA（均在保留面）；RetryState 与 LoopGate 的测试消费全部走深路径（retry-state.test.ts:12 / loop-gate.test.ts:15-23）」。

### S2：版本号指引已过时（5.1.5 已被批次 bump 占用）

- **设计文档位置**：§1（「v5.1.4」）、§7 文件改动地图（「package.json patch bump（5.1.4 → 5.1.5）」）。
- **源码证据**：`extensions/universal/structured-output/package.json:3` `"version": "5.1.5"`；占用来源 commit `c79cd621c`（2026-09-12 13:52，ext-simplify 批次 24 包 bump，structured-output 在 patch 列表内）。
- **问题**：照设计执行「bump 到 5.1.5」将是无操作（当前已是 5.1.5），实施者若不核对会漏 bump。
- **建议修法**：§7 改为「patch bump（当前 5.1.5 → 5.1.6；设计基线的 5.1.4→5.1.5 已被 ext-simplify 批次收尾 bump c79cd621c 占用）」。

### S3：测试基线用例数 191 → 194 漂移

- **设计文档位置**：证据基线段（「8 文件 191 用例通过，2026-09-12 实跑」）、P2（「本包既有 191 用例」）。
- **源码证据**：审查时实跑 8 文件 **194** 用例全绿；+3 来源 = commit `bbfae6f19`（2026-09-10「gate-A reflow … + 3 coverage fills」）在 loop-gate.test.ts :744+ 追加的 stale ctx ①②③ 三用例（该三用例恰好覆盖 `guardStaleCtx` 分诊下的 armForceExitTeardown 行为，对 E1/E3 是额外回归保护，方向有利）。
- **问题**：P2 以「191 用例」为基线口径，实施时实跑对不上会产生困惑。
- **建议修法**：P2 口径改为「既有用例全量（当前实跑 194）」，并保留「以实施期实跑为准」（§9.2 已有此纪律声明，本条只需更新数字）。

### S4：subagent-core 原版调用点计数「≥8」失实（实际 7）

- **设计文档位置**：§3.1（「SSOT 原版 packages/subagent-core/src/shared/timer-delay.ts:37 有 ≥8 个真实动态调用点（dialog-queue / settled-watchdog / supervisor / subagent-service / lifecycle-manager / lifecycle / launcher，实跑 grep 证实）」）。
- **源码证据**：真实调用 7 处——settled-watchdog.ts:237/269/309、lifecycle-manager.ts:142、supervisor.ts:371、lifecycle.ts:197、launcher.ts:168。设计列举的 dialog-queue.ts:53 与 run-orchestration.ts:1604（subagent-service）是**注释引用**（前者讨论 clamp 策略、后者描述旧链路），非调用。
- **问题**：计数与「实跑 grep 证实」的自我声明不符。方向结论（原版守真实动态输入 vs 本副本喂编译期字面量）不受影响。
- **建议修法**：§3.1 改为「7 个真实动态调用点（settled-watchdog ×3 / lifecycle-manager / supervisor / lifecycle / launcher；dialog-queue 与 run-orchestration 为注释引用）」。

### S5：行号系统性 ±1~2 偏移（定位无歧义，建议实施前批量校准）

- **设计文档位置**：§3.1 / §3.2 / §3.3 / §6.5 / §7 全部 file:line（设计自我声明「2026-09-12 实读当前源码值」）。
- **核对结果**（设计值 → 审查实读值）：守卫段 :394-422 → :395-423；调用点 :484 → :485；TEARDOWN_FORCE_EXIT_MS :438 → :439；GATE_ENTRY_TYPE :392 → :393；同文件使用 :514 → :515；slot 段 :446-463 → :447-464；slot 读写 :482-483/:494 → :483-484/:495；reset :79-86 → :79-86（一致）；reset 用例 :105-119 → :106-121；守卫用例 :704-709 → :705-711；P1 引用 :674-700 → :676-703。
- **问题**：偏移均为 1-2 行、语义定位无歧义，但设计声称行号为「实读当前值」与事实有出入（可能因 09-12 当天其他 commit 的细小改动）。
- **建议修法**：实施时以符号名定位（grep），不照抄行号；或实施 PR 中附行号校准 diff。不要求设计文档逐行更正。

---

## 5. 已核实无问题

以下检查点经实际读源码/跑测试/查 git 历史通过，附证据快照，防后续重复怀疑。

### 5.1 M24 守卫的「编译期字面量前提已漂移」指控成立

`loop-gate.ts:485` 是 `assertSafeTimerDelay` 在本包的唯一生产调用（grep 全仓证实：其余命中为定义 :408、注释 :397/:478、测试 :705-711），实参 `TEARDOWN_FORCE_EXIT_MS`（:439）为 `export const` 字面量 `15_000`。原版（subagent-core）守 7 个真实动态调用点（见 S4 证据）。守卫的 30 行 + 5 断言在本地副本上守一个 by construction 不可能的危害——设计的事实链成立，D1 整体删除裁决有据。E1 删除面正确排除了 `MS_PER_SECOND`（:405-406，teardown 日志 :488 仍在用，不在删除面）。

### 5.2 D2 裁决（slot 回退模块级 let）立论根基完整成立

四条独立证据链全部核实：

1. **C-ext-06 适用前提**（development-guide.md:785-790）：规范主语是「跨 session 存活、需在 session_start 重建的进程级单例（Hub / Runtime / Registry）」，规则存在理由是 jiti 双路径致模块级 let 分裂成「setX 写 A、getX 读 B」的分裂脑。constraints.json summary 虽措辞更宽，但 authority 指向 development-guide.md，正文为权威。
2. **三前提不占**（F12 详证）：一次性武装（:558 newlyTerminal 门控 + :579 唯一武装点）/ process.exit 终结（:486-492，武装后 ≤15s 进程必死）/ **无跨实例读依赖**（slot 三件套零导出，`slot.current` 读-清-写在单次 arm 调用内同实例同步完成，全仓 6 处引用全在 loop-gate.ts 内——grep 证实）。
3. **引入史**：`c20f2b1ef` commit message 明示 suggestion 采纳；diff 证实 slot 化前就是模块级 `let`（注释「terminal 全生命周期至多一次，防御性幂等再清」），回退即恢复原形态。
4. **先例区分**：注释援引的 notify-ledger 先例三处（F10 证据）均为「写后必须跨实例读到」的真跨 session 单例——host-services.ts:60 注释甚至自述了真实发生过的分裂脑（「configureCore 只写主 bundle 副本，子入口侧恒 undefined」）。teardown timer 是 one-shot 副作用句柄，无状态语义可分裂。设计的「先例的机制类适用、本例不适用」论证成立。

分裂脑不可达性的独立推演（对抗式复核）：jiti 双实例下 slot 形态 = 第二实例 arm 会 clear 第一实例的 timer 再武装（单 timer）；let 形态 = 双 timer 并存，但两个 timer 均 unref 且 15s 后首个 `process.exit(1)` 即杀进程，第二个随进程消亡。两种形态对外可观察行为（terminal 后进程 ≤15s 内以 code 1 退出 + stderr 留因）完全一致——slot 化无行为收益，回退无行为损失。设计 §9.3 代价 2 的「良性」定性成立。

### 5.3 强退链「本体不触碰」边界与「行为零变更」可证伪性

- E1/E3 改动面 = `armForceExitTeardown` 的守卫前置调用与 timer 持有方式；链路本体（terminal 判定 :558 / 双通道日志 :504-529 / guardStaleCtx 包装 :567-578 / abort+shutdown / exit code 1 / stderr 文案）零分支改动。
- P1 的「既有用例零改动通过 = 行为未变的构造性证明」论证有效：teardown 行为已被三用例锁定（常量锁 :677-679 / 15s 到点 stderr+exit(1) :681-694 / 幂等重武装 :696-703——其中幂等用例两次直调 `armForceExitTeardown`，在 let 形态下直接覆盖新代码路径的重复武装 clear）；terminal 负面路径（真实 3 连败）由 mock pi 装配层用例驱动（loop-gate.test.ts:717-732 三连失败到 terminal+shutdown+不 steer；:744+ stale ①②③ 三用例覆盖 guardStaleCtx 分诊下的武装行为，bbfae6f19 加入）+ characterization-hook.test.ts 承担。设计 §8.1 对「负面路径本地不可稳定复现」的诚实边界声明与既有覆盖现状相符——验收覆盖强退路径的真实触发场景（事件驱动级），不缺口。
- 审查时实跑全量 194 用例绿（F21），基线健康。

### 5.4 E5（env 重读删除）构造性等价成立

三段证据：装配分岔（index.ts:60-72）用同一 env 裁决 → 日常变体注册时 env 必空；全仓 `PI_WORKFLOW_SCHEMA` 唯一运行时写入点 = spawn-args.ts:131（spawn 时注入子进程 env，此后进程内零写入，grep 证实）；故日常变体 execute 的 env 重读恒得 undefined、恒走 params 直传——删除分岔后行为逐点等价。设计的一行构造性事实注释方案恰当。

### 5.5 E6（出口收敛）动作面安全

- 三处零消费导出降私有：符号级 grep 零外部 import（F15）；entry type 字符串值仅测试字面量断言（loop-gate.test.ts:626 / characterization-hook.test.ts:84/:192/:222），私有化不改字符串值，断言不受影响。
- index re-export 删三项：全仓经 index 路径的消费方（structured-output.test.ts:29 / cross-package-contract.test.ts:24 / SW vitest alias）import 的符号均不在删除面（F16/F17）。
- import 收窄核实：index.ts:32 的 `LoopGate` 与 :40 的 `RetryState` 在 index.ts 内唯一使用即 re-export 本身（setupLoopGate 有 :69 生产使用故保留 import），收窄动作成立。
- 保留面有真实测试消费：loop-gate.test.ts:15-23 深路径 import LoopGate / MAX_CONSECUTIVE_FAILURES / normalizeErrorSignature / setupLoopGate / TEARDOWN_FORCE_EXIT_MS / armForceExitTeardown；retry-state.test.ts:12 深路径 import RetryState——「消费方真实性」口径划分有据。
- pi 入口 `pi.extensions: ["./index.ts"]`（package.json:10-14 区域实读）不受 re-export 删除影响。

### 5.6 E4（reset 删除）连带面完整

reset 唯一调用 = retry-state.test.ts:106-121 专设用例（grep 证实）；:56「仅 reset() 可清」注释在删除后悬空已入 E4 联动面；类 doc 注释（:33-34）的「IF-7，export 契约」理由改写方向正确（export 的真实消费方是深路径测试，非「M5 从本模块 import」的旧理由）。扩展实例生命周期 = 单子进程单次装配（index.ts:59-74 default export 只在 extension 加载时执行一次），跨 session 复用场景不存在——设计论证成立。

### 5.7 E7 协同协议已生效，无重复实施风险

ext-simplify-01 实施 commit `bf7ee07d0`（09-12 02:36）已清理 text-primitives.ts 的 unified-hooks 悬空从句（其 impl-plan E5 认领「:43-44 直接删除」；当前源文件全文无 unified-hooks 字样，grep 证实）。设计 §6.4「后做的一方幂等跳过」+ §9.2「以先合入方的改写为准」协议覆盖此情况；移交清单保留 E7 条目以自包含的做法可接受（执行时为 no-op）。

### 5.8 E2（redesign 文档回写）定位准确且划界正确

redesign.md:275 的「`assertSafeTimerDelay` 包裹」表述在 SO 侧 terminal 动作链段（E2 回写点）；:339 的同名引用在附录 D SW 侧加固机制段（其守卫对应 subagent-core launcher.ts:168 等仍在用的实装，不随本包删除漂移）。E2 只回写 :275、不动 :339 的范围划定正确。redesign 文档本身覆盖 SO+SW 两包（§实施范围明文「extensions/universal/subagent-workflow/」），「:339 属 SW 包」的归属描述与其文档结构一致。

### 5.9 四项 low 移交登记完整可追溯（B 部分结论）

E4-E7 各含：精确位置（文件 + 行号 + 符号名）、改动内容、联动面（E4 的 :56 注释 / E6 的 import 收窄）、协同注记（E7 批 A row 4 幂等跳过）、验收挂接（P2）。§9.1 u2 单元自包含可独立执行。移交清单无断链。

---

## 6. 方案自身的过度设计检查（C 部分，四问逐项）

对本设计引入/保留的每个机制逐字核对四问与反模式清单：

| 机制 | ①赌的决策（会真变吗） | ②间接成本 vs 认知压缩 | ③已发生证据 or 想象未来 | ④反模式 | 结论 |
|---|---|---|---|---|---|
| D1 删守卫 + 一行 SSOT 指路注释 | 「TEARDOWN_FORCE_EXIT_MS 保持编译期字面量」——字面量改动必过 diff review，重审触发已登记（§9.3 代价 1） | 净删 30 行 + 5 断言，换 1 行注释；概念数 -2（assertSafeTimerDelay / Node 塌缩语义本地化） | 唯一调用点字面量实参（:485/:439 实读）+ 原版 7 动态调用点对照（已发生证据） | 删除的对象本身是 speculative guard（防 review 漏检的仪式守卫）——本设计消除而非引入 | 通过 |
| D2 slot 回退模块级 let + 两行裁决注释 | 「teardown timer 永不成为跨 session 单例」——一次性武装 + process.exit 终结是机制固有属性，重审触发登记（§9.3 代价 2） | 净删 17 行 Reflect 机械；概念数 -3（SLOT_KEY / Slot 类型 / getter + C-ext-06 适用推理义务） | 引入史 suggestion 非 bug 驱动（c20f2b1ef commit message 实证）+ 先例三处前提核对（实读） | 保留 slot 才是 pass-through 反向问题（按模式对齐非按前提对齐的模式误配）；回退消除 | 通过 |
| D3 出口按消费方真实性收敛 | 「深路径导出 + 测试契约锁定」现状已被消费（不赌未来） | 纯减法：删 3 个零消费导出 + 3 个零消费 re-export，无新增面 | 消费方 grep 全量清单（审查复核一致） | 无 | 通过 |
| D4 移交边界（E1/E3 本设计、E4-E7 移交） | 无赌注：contested 项按纪律随裁决落地（E1/E3 同函数一批改完是空间局部性，非投机） | 无新增机制 | 审计定性 + 批 A 协同实证（E7 已被先做方消化） | 无 | 通过 |
| 保留面（签名归一化族 / 强退本体 / 双变体 / isObjectRootSchema 跨包副本） | 设计声明不动（Out-of-scope） | 契约测试 cross-package-contract.test.ts:82-88 锁跨包字节相等（实读证实副本存在于 subagent-core agent-opts-resolver.ts:54） | 2026-09-11 审计四问记录（sa-ca793788），本设计不重开 | 不在本次审查范围（任务边界） | 豁免（非本设计引入） |

**简化铁律核对**：概念数严格下降（守卫语义 -2、slot 机械 -3，新增机制 0——两处注释是知识锚定不是机制）；「简化后更难懂 = 失败」不触发（let + 一眼可见的 setTimeout 是 JS 最低共同形态）。**「改测试迁就简化 = 撤销」核对**：E1 删守卫专设用例、E4 删 reset 专设用例均为「被测对象已亡、其专设测试同亡」，行为面用例零改动（P1/P2 明文），不属于迁就。**second-system effect**：纯减法设计，无「顺便做进去」的通用性。**Greenspun / inner-platform / abstraction inversion / leaky abstraction / middle man**：本设计未引入任何新抽象层，无命中。

---

## 7. 审查结论

设计文档的事实密度与自校准质量高于平均水平（自带审计修正记录、协同协议、四要素已接受代价、行号偏移自我声明）。23 项现状声称中 0 项伪问题；两个核心裁决（D1/D2）的立论根基经独立对抗核实全部成立；验收以「既有用例零改动通过」构造性锁定行为等价，覆盖强退路径的事件驱动级真实触发场景。5 条 suggestion 均为文档精度修正，建议实施 PR 中顺手更正（S1 措辞、S2 版本号、S3 基线数字为必改项，S4/S5 可选）。

---

## 附录：审查动作记录（可复现）

- 实读源码：loop-gate.ts（全文 583 行）/ index.ts / workflow-hook.ts / tool-definition.ts（:200-244）/ execute.ts / text-primitives.ts / tests/loop-gate.test.ts（:1-30 / :660-739）/ tests/retry-state.test.ts（:95-124）/ tests/structured-output.test.ts（:1-32 / :338-352）。
- grep 核实：assertSafeTimerDelay（全仓）、GATE_ENTRY_TYPE / HOOK_ENTRY_TYPE / validateAgainstSelfReported / RetryState / LoopGate / setupLoopGate / normalizeErrorSignature / TEARDOWN_FORCE_EXIT_MS / MAX_CONSECUTIVE_FAILURES（全仓 import 消费方）、PI_WORKFLOW_SCHEMA（写入点）、TEARDOWN_TIMER_SLOT_KEY / getTeardownTimerSlot / teardownTimer（跨实例依赖面）、unified-hooks（悬空引用现状）、isObjectRootSchema（跨包副本）、structured-output:gate / :hook（字符串消费方）。
- 实跑：`npx vitest run`（structured-output 包，8 文件 194 用例全绿，867ms）。
- git 考古：`c20f2b1ef`（slot 引入 diff 全文）、`bf7ee07d0`（01 号实施）、`c79cd621c`（批次 bump）、`bbfae6f19`（+3 用例来源）。
- 文档核对：constraints.json C-ext-06 条目、development-guide.md §7.5 全文、structured-output-redesign.md（:275 / :300-345 / 标题与范围段）、ext-simplify-01 设计与 impl-plan 的 E5 认领。
