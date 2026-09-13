# ext-simplify-10：structured-output 仪式化残留收敛（删字面量守卫 + slot 惯例裁决 + low 群移交）

> **一句话结论**：删除 loop-gate 建立在「编译期字面量 delay」上的 30 行 fail-fast 守卫（`assertSafeTimerDelay` 本地副本）与 17 行 `globalThis[Symbol.for]` slot 机械（裁决：回退模块级 `let`——C-ext-06 权威源的适用前提「跨 session 存活的进程级单例」不满足），漂移的同源锚点注释随删除消亡并同批回写 redesign 设计文档（C-proc-10）；`RetryState.reset` / 日常变体 env 重读 / 零消费方出口簇 / 悬空 unified-hooks 引用四项 low 清理显式移交 code-simplify。全案行为零变更，强退机制本体不触碰。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-structured-output`（v5.1.4，universal 组，mandatory infrastructure）是 workflow schema enforcement 包——SW 子进程按 `PI_WORKFLOW_SCHEMA` env 注入权威 schema 到工具参数层（方案 A [HISTORICAL]：注入的权威 schema 是唯一校验权威），配套软 steer hook（turn_end 未调用则 steer，≤2 次）与硬失败闸门 loop-gate（连续 3 次同签名失败 → terminal：双通道日志 → `ctx.abort()` → `ctx.shutdown()` → 15s 兜底硬退）。
- **C（冲突）**：2026-09-11 过度设计审计（so 单元）确认本包机制本体全部过四问（签名归一化族、强退本体、双变体、跨包副本均为本质复杂度），但残留一处 medium 级仪式化守卫——为唯一一个编译期字面量实参上了 30 行双分支 throw 守卫，且其同源锚定注释指向已不存在的路径；外加一组 low 级残留（零调用方方法、不可达分支、零消费方出口、为良性失效模式上的 slot 机械），其中 slot 化与 C-ext-06 惯例的适用关系存在争议须裁决。
- **Q（问题）**：如何在不触碰强退机制本体（真实事故驱动 + 方案 A [HISTORICAL] 的产品锚）的前提下清掉这些仪式化残留，并对 slot 化作出可辩护、可防复发的惯例裁决？
- **A（答案）**：M24 守卫整体删除（守卫的存在前提「delay 来自动态输入」在本副本不成立）+ slot 回退模块级 `let`（裁决依据本地锚定注释防复发）+ redesign 文档同批回写 + low 群移交清单登记。行为零变更，验收以真实 pi CLI 跑 workflow 模式一轮带 schema 任务 + 既有行为用例零改动通过构成。

**层声明**：本文档是「技术方案设计」层，下一层产物 = 可实施的代码任务清单。全部条目为死代码清理 / 机械回退 / 注释修正，无数据流变更；层敏感准则 5（物理数据流）不适用，准则 6/7 按「行为零变更」对象以最小探针面适用。

**证据基线**：pi SDK 断言核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（npm ls 确认版本）；文中全部 file:line 为 2026-09-12 实读当前源码值，与 2026-09-11 审计快照的差异以「审计修正」标注（见 §7 末）；四问记录 sa-ca793788（批 4 structured-output 单元）的五条发现已逐条实读复核。本包既有测试基线绿（8 文件 191 用例通过，2026-09-12 实跑）。

---

## 1. 背景：被设计的系统是什么

**structured-output 解决的问题是「workflow 步骤的输出必须结构化且有界失败」**：subagent-workflow（SW）跑 `agent()` 步骤时，经 pi-subagent-cli 的 `applySchemaEnvToChildEnv` 把步骤的 outputSchema 注入子进程 env `PI_WORKFLOW_SCHEMA`（256 KiB 硬拒绝线在 SW 侧，本包 256 KiB 提示线，`tests/cross-package-contract.test.ts` 锁两端字节相等）。子进程内本包按 env 有无分岔（`src/index.ts:60-72`）：

- **workflow 模式**（env 有值）：注册单参数工具（parameters = 权威 schema 本身，D4 根级 `additionalProperties:false` 注入 / P6 非 object 根 `{value}` 包装）+ turn_end steer hook + loop-gate 失败闸门。
- **日常模式**（env 无值）：注册双参数自报形态工具（模型自报 `{schema, data}`，ajv 校验 + 互换/keyword-less 防御链）。

**loop-gate 强退链是本设计的行为红线**（审计「已核实非过度」明确不可砍）：同签名校验失败连续 3 次 → terminal → stderr + `appendEntry` 双通道日志（含恢复指引）→ `ctx.abort()`（止燃，实测 shutdown 请求后仍有 ~25s token 燃烧窗口）→ `ctx.shutdown()` → `armForceExitTeardown()` 武装 15s 兜底硬退 timer（覆盖 pi 挂死不 settle 的异常态）。真实事故驱动 + 方案 A [HISTORICAL] 规则的产品锚。**本设计只动该链路上的两处仪式化附件（守卫与 slot 持有方式），链路本体一个分支都不改。**

## 2. 设计目标

1. **行为零变更**：workflow / 日常两模式、steer hook、强退链（terminal 判定 / 日志 / abort / shutdown / 15s 硬退 / exit code 1）对外行为与现状逐点等价。
2. **守卫与机械收敛**：删除字面量守卫（约 30 行 + 5 条测试断言）与 slot 机械（约 17 行），漂移锚点注释消亡，替换为指向真实 SSOT 的一行注释。
3. **裁决留痕**：`Symbol.for` slot 的 C-ext-06 适用性裁决成文（§6.2），裁决依据锚定在代码注释里，防未来 reviewer 按模式误报。
4. **low 清理移交登记完整**：4 项 low 移交清单（含批 A 协同注记）可直接交 code-simplify 批量执行。

**In-scope**：`extensions/universal/structured-output/`（src + tests）+ `docs/design/structured-output-redesign.md:275` 一处表述回写（C-proc-10）。
**Out-of-scope**：
- 强退机制本体、签名归一化族（loop-gate.ts:60-345）、双变体工具定义、`isObjectRootSchema` 跨包本地副本（契约测试锁字节相等，churn 已验证其价值）、workflow-hook / loop-gate 双监听结构——审计已核实非过度；
- SW 侧任何文件（redesign 文档 :339 的 SW kill-chain 表述属 SW 包，不动）；
- 批 A 设计 `ext-simplify-01` 已认领的 E5 修复的重复实施（协同注记见 §6.4 / §7 执行项 7）。

---

## 3. 现状：仪式化残留的真实样子

### 3.1 M24：字面量守卫 + 锚点注释漂移（loop-gate.ts:394-422）

现状代码（实读摘录，:407-422）：

```typescript
export function assertSafeTimerDelay(ms: number, source: string): void {
	if (!Number.isFinite(ms)) {
		throw new Error(`[structured-output] ${source} = ${ms} is not a finite number ...`);
	}
	if (ms > MAX_TIMER_DELAY_MS) {   // 2_147_483_647
		throw new Error(`[structured-output] ${source} = ${ms} exceeds the Node setTimeout limit ...`);
	}
}
```

事实链：

- **唯一生产调用点** `armForceExitTeardown`（:484）的实参恒为字面量 `TEARDOWN_FORCE_EXIT_MS = 15_000`（:438，`export const` 原始类型不可变）。两个 throw 分支（非有限值 / 超 2^31-1）对 15000 **永不可达**——被守卫的危害（Node setTimeout 把非法 delay 塌缩为 1ms 立即触发，兜底窗口变成立即硬杀）在该调用点 by construction 不可能发生。
- **原版的存在前提在本副本不成立**：SSOT 原版 `packages/subagent-core/src/shared/timer-delay.ts:37` 有 ≥8 个真实动态调用点（dialog-queue / settled-watchdog / supervisor / subagent-service / lifecycle-manager / lifecycle / launcher，实跑 grep 证实），守卫「动态输入可能算错」的决策在那里成立；本副本恰好 1 个调用点且喂编译期字面量。
- **锚点注释漂移**（:395-397）：`[同源锚定] @zhushanwen/pi-subagent-workflow 的 shared/timer-delay.ts`——`@zhushanwen/pi-subagent-workflow` 包存在（即 `extensions/universal/subagent-workflow`），但其内**没有** shared/timer-delay.ts；全仓 `find -name "timer-delay.ts"` 唯一命中 `packages/subagent-core/src/shared/timer-delay.ts`。注释指路的锚点实体已不存在。
- 测试面：`tests/loop-gate.test.ts:704-709` 专设 5 条断言锁这个不可达守卫的行为。

### 3.2 contested：teardown timer 的 Symbol.for slot（loop-gate.ts:446-463）

现状持有方式（:446-463）：`TEARDOWN_TIMER_SLOT_KEY = Symbol.for("@zhushanwen/pi-structured-output.loopGate.teardownTimer")` + `TeardownTimerSlot` 类型 + `getTeardownTimerSlot()`（Reflect 读写 globalThis），`armForceExitTeardown` 经 slot 读写 timer（:482-483、:494）。注释自认（:447-448）：jiti 双实例下裸模块级 `let` 的失效模式**良性**——「至多双 timer 各自 process.exit，进程级幂等」。

引入史（`git show c20f2b1ef`，review round 2，2026-08-29）：slot 化以 **suggestion** 采纳（「suggestions: loop-gate teardownTimer / notify-ledger 旗标 slot 化（C-ext-06）」），非任何实际双加载 bug 驱动；注释援引的「notify-ledger 先例」如今全部落在 `packages/subagent-core`（notify-ports.ts:123 / host-services.ts:60 / model-config-service.ts:227）——那些是真跨 session 进程单例。

C-ext-06 原文（constraints.json）与权威源（development-guide.md §7.5）的适用前提：

> 「**跨 session 存活、需在 `session_start` 重建**的进程级单例，必须用 `globalThis[Symbol.for("包名.角色")]` 持有，禁止用模块级 `let` 变量」（如 Hub / Runtime / Registry，生命周期长于单个 session）；规则的存在理由是 jiti 双路径加载使模块级 `let` 分裂成互不可见的多实例，导致 setX 写 A、getX 读 B 的**分裂脑**。

teardown timer 三条前提全不占：terminal 路径一次性武装（`newlyTerminal` 门控）、生命周期以 `process.exit` 终结（不跨 session）、无任何跨实例读依赖（武装后只有同实例的幂等 clear 读它）。裁决见 §6.2。

### 3.3 low 群（移交候选，实读核实）

- **RetryState.reset**（workflow-hook.ts:79-86）：注释自认「当前无调用方；保留作状态机完整契约」。全仓唯一调用 = `tests/retry-state.test.ts:105-119` 专设用例。扩展实例生命周期 = 单子进程单次装配（index.ts:59-74），跨 session 复用场景不存在。连带悬空：`:56` markTerminal 注释「不可逆，**仅 reset() 可清**」在 reset 删除后成为悬空语义锚。
- **日常变体 env 重读**（tool-definition.ts:226-241，读取在 :236）：日常变体的 execute 内重读 `process.env[ENV_SCHEMA]`——但模式分岔在 index.ts:60-72 装配期已用**同一个 env** 裁决（env 有值根本不会注册日常变体）；进程 env spawn 时固定、全仓零写入点（审计 grep + 实读 index.ts 仅 :60 一处只读）。这是一个不可达的平行决策点，读者须推理一个不可能发生的「运行中模式切换」。
- **出口面测试专用导出簇**：零消费方导出三处——`GATE_ENTRY_TYPE`（loop-gate.ts:392，全仓零消费，仅同文件 :514 使用）、`HOOK_ENTRY_TYPE`（workflow-hook.ts:90，同上）、`validateAgainstSelfReported`（execute.ts:87，仅同文件 :181 使用）；index.ts re-export 块（:46-55）中 `RetryState`（:52）/ `LoopGate`（:54）/ `setupLoopGate`（:53）经 **index 路径**零消费——本包测试全部走深路径（`tests/loop-gate.test.ts:15-23` ← `../src/loop-gate.js`；`tests/retry-state.test.ts:12` ← `../src/workflow-hook.js`），SW 侧 vitest alias 虽指向 `../structured-output/src/index.ts`，但 grep 证实 SW 无任何源文件 import 该包（alias 为防御性基础设施）。保留面：`normalizeErrorSignature` / `LoopGate` / `TEARDOWN_FORCE_EXIT_MS` / `MAX_CONSECUTIVE_FAILURES` 等深路径导出有真实消费方（本包测试的行为契约锁定，如 :99 锁阈值 3、:674-700 锁 teardown 行为），不动。
- **悬空 unified-hooks 引用**（text-primitives.ts:43-44）：「见 extensions/universal/unified-hooks 的 extractErrorText 及其文档」——unified-hooks 已废弃（AGENTS.md 登记被 base-tool-enhance 整包取代）。批 A 设计 ext-simplify-01 已登记同一点（其执行表 row 4，编号 E5）。

### 4. 根因

**「按模式对齐」替代了「按前提对齐」。** 守卫复制自 subagent-core 原版时搬运了实现而未校准存在前提（原版守动态输入，副本喂字面量）；slot 化源自 review suggestion 的惯例对齐（c20f2b1ef），采纳时未核对 C-ext-06 权威源的适用前提（跨 session 单例）——把「进程级持有」模式套到了「一次性 timer」上。出口面则随多轮审计修复轮次（R3/R4/U2）单向累积：每轮加导出易、无人回头删。三者共同点是每个残留单看都「无害」，合计起来让最强事故驱动的模块（强退链）裹上了一层与事故无关的仪式外衣。

## 5. 终态

**使用者视角：零变化。** workflow 子进程照常按权威 schema 产出结构化结果；模型连续 3 次同签名失败照常走 terminal → 日志 → abort → shutdown → 15s 硬退（exit code 1）；日常 pi 照常双参数自报校验。本设计不改任何对外可观察行为。

**代码面终态**（teardown 段收敛形态，示意）：

```typescript
/** 兜底硬退窗口。15_000 为字面量常量，处于 Node setTimeout 安全域内
 *  （非有限/超 2^31-1 会塌缩为 1ms——若未来 delay 来源动态化，需引入安全域校验，
 *  参照 packages/subagent-core/src/shared/timer-delay.ts 的 assertSafeTimerDelay）。 */
export const TEARDOWN_FORCE_EXIT_MS = 15_000;

// one-shot timer 不属 C-ext-06 §7.5 的「跨 session 存活进程级单例」范畴：
// terminal 一次性武装、随 process.exit 消亡；jiti 双实例下双 timer 各自
// process.exit 进程级幂等，模块级 let 即可。
let teardownTimer: ReturnType<typeof setTimeout> | undefined;

export function armForceExitTeardown(): void {
	if (teardownTimer !== undefined) clearTimeout(teardownTimer);
	const timer = setTimeout(() => { /* stderr 留因 + process.exit(1)，原样 */ }, TEARDOWN_FORCE_EXIT_MS);
	timer.unref();
	teardownTimer = timer;
}
```

失败路径不变量：arm 的幂等 clear（既有测试 ：693-700 锁定）、unref、exit code 1、stderr 文案全部原样保留。

## 6. 关键决策与权衡

**本章结论：4 个决策——守卫整体删除（D1）、slot 回退模块级 let（D2，核心裁决）、出口面按「消费方真实性」口径收敛（D3）、low 群移交边界划分（D4）。**

### 6.1 D1：assertSafeTimerDelay 本地副本处置（选定：整体删除）

- **采用**：删除 :394-422（锚点注释 + `MAX_TIMER_DELAY_MS` + 函数体）与测试 :704-709；:484 调用点替换为一行安全域注释（指向 subagent-core SSOT，见 §5 终态）；redesign 文档 :275 的「`assertSafeTimerDelay` 包裹」表述同批改写（C-proc-10）。
- **被否**：
  - **保留守卫只修锚点注释（doc-right）**——守卫的两个 throw 分支对唯一实参 15000 永不可达，30 行 + 5 断言守护一个 by construction 不可能的危害；若用它，§3.1 的事实链继续要求每个读者推理「这个守卫什么时候触发」，答案是永远不会。
  - **收敛为一行 clamp/断言**——仍是仪式：`Number.isFinite(15_000)` 同样编译期可知为真；一行版省行数不省认知（读者仍要问「防什么」）。
- **证据**：:484 唯一调用点 + :438 字面量实参（实读）；subagent-core 原版 ≥8 动态调用点 vs 本副本 1 字面量（grep 实跑）；「未来动态化再加守卫」符合减法优先——speculative guard 防的是 review 漏检，而 `export const` 字面量改动必然过 diff review。
- **效果**：目标 2；§5 终态成立；强退链行为零变更（探针 P1）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 整体删除 + 一行注释（选） | 守卫前提不存在即不设防；SSOT 指路注释保住知识 | 低：单文件删 + 测试删 5 断言 + 文档回写 | 「未来改动态值」敞口——见 §9 已接受代价 1 | ✅ |
| 保留守卫只修注释 | 30 行不可达分支永续 | 极低 | 认知税永续；锚点知识虽修正但守卫仍无触发场景 | ❌ |
| 收敛为一行 clamp | 同左，省行数不省认知 | 低 | 同左 | ❌ |

### 6.2 D2：teardown timer 持有方式（选定：回退模块级 let——contested 裁决）

- **采用**：删除 :446-463（slot key / 类型 / getter），`armForceExitTeardown` 改回模块级 `let teardownTimer`（c20f2b1ef 引入 slot 前的原形态）；`let` 处留两行裁决注释（§5 终态）——把「为什么不 slot 化」的依据本地锚定，防未来 reviewer 按 C-ext-06 字面误报。
- **被否**：
  - **保留 slot（「C-ext-06 惯例强约束则保留」的 doc-right 读法）**——被 C-ext-06 自己的权威源否决：development-guide §7.5 的规范主语是「**跨 session 存活、需在 session_start 重建**的进程级单例」，节首明示「本节管的是……生命周期长于单个 session」的对象（Hub/Runtime/Registry）；teardown timer 一条不占。若保留，等于把 C-ext-06 的适用面从「跨 session 单例」悄悄扩为「任何进程级持有」，惯例被稀释，且 :447-448 注释自认的良性失效模式证明 slot 防的不是真危害。
  - **保留 slot 并登记 constraints.json 扩面**——为一个 17 行 Reflect 机械扩一条全仓约束，方向反了（减法优先）。
- **证据**：§3.2 三条前提逐条核对（terminal 一次性 / 随 exit 消亡 / 无跨实例读依赖）；引入史 c20f2b1ef 为 suggestion 非 bug 驱动；「notify-ledger 先例」实读落点全在 subagent-core 且均为真跨 session 单例（先例的机制类适用、本例不适用——先例援引本身是采纳时的模式误配）；双实例失效模式良性由 ：447-448 注释自认 + 既有幂等测试（:693-700）锁定。
- **效果**：目标 2 + 目标 3；裁决成文后同类 question 不再重开。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 回退 let + 裁决注释（选） | 惯例按前提适用不被稀释；-17 行机械 | 低：删三件套 + 恢复 let | jiti 双实例下双 timer——进程级幂等（良性，注释锚定） | ✅ |
| 保留 slot（惯例字面读法） | C-ext-06 适用面被悄然扩宽 | 零 | 认知税：读者须推理「timer 为何需要进程级 slot」 | ❌ |
| 保留 slot + 扩登记约束 | 为机械持有人为立规 | 中（动 constraints.json） | 方向与减法优先相悖 | ❌ |

### 6.3 D3：出口面收敛口径（选定：按「消费方真实性」划分）

- **采用**：零消费方导出降模块私有（`GATE_ENTRY_TYPE` / `HOOK_ENTRY_TYPE` / `validateAgainstSelfReported`）；index re-export 块删去经 index 路径零消费的三项（`RetryState` / `LoopGate` / `setupLoopGate`），index 自身生产 import 相应收窄；**保留**有真实消费方的深路径导出（`normalizeErrorSignature` / `LoopGate` 类本体 / `TEARDOWN_FORCE_EXIT_MS` / `MAX_CONSECUTIVE_FAILURES` / `RetryState` 类本体——消费方是本包测试的行为契约锁定，迫使其改走 index 反而扩大出口面，与收敛目标相反）。
- **被否**：全量降私有（把测试消费的导出也砍）——破坏既有契约锁定测试（转移表 / teardown 行为 / 阈值锁），改动面膨胀违背零变更目标；全量保留（现状）——零消费方出口继续累积。
- **证据**：§3.3 消费方 grep 全量清单；SW alias 无实际 import 方（grep 证实）；`pi.extensions: ["./index.ts"]` 按入口加载、无外部深路径消费方（package.json:10-14）。
- **效果**：目标 2；出口面与真实消费方一一对应，后续加导出必须有消费方才立得住。

### 6.4 D4：low 群移交边界（选定：contested 随本设计落地，其余移交）

- **采用**：E1/E2/E3（M24 守卫 + 文档回写 + slot 裁决回退）随本设计实施——contested 项按任务纪律必须在本设计内裁决，且 E1/E3 同在 `armForceExitTeardown` 函数，一批改完避免两次触碰同一函数；E4-E7 移交 code-simplify 批量执行（清单见 §7 执行项表）。E7（text-primitives.ts:43-44）与批 A ext-simplify-01 执行表 row 4 认领同一点：两设计实施时**后做的一方幂等跳过**（同一处注释改写，重复执行无副作用），移交清单中保留条目以保证清单自包含。
- **被否**：全部移交（含 slot 回退）——裁决与实现分离会让「裁决依据注释」与代码改动落在两个批次，review 时依据与事实脱节；全部本设计做（含 low 群）——low 群是审计明示「移交 code-simplify，不进裁决」的批量清理项，本设计实施面应最小。

### 6.5 探针清单（⛔ 实施期门）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | E1/E3 后强退链行为零变更：常量锁 / 15s 到点 stderr+exit(1) / 幂等重武装三用例**零改动通过** | `tests/loop-gate.test.ts:674-700` 既有用例不改一个字跑绿（幂等用例直接覆盖 let 形态的重复武装 clear） | ⛔ 合入前 | 失败 = 回退 E1 或 E3（按红用例归因），恢复守卫为单行 `Number.isFinite` 检查并回本设计重审 D1 |
| P2 | E4-E6 移交项行为等价：双变体注册 / RetryState 转移表 / 出口面收敛后测试 import 全部可达 | 本包既有 191 用例在 E4-E6 改动后仅删除 :704-709 与 reset 专设用例、其余零改动通过 | ⛔ 合入前 | 失败 = 对应移交项回退，登记阻塞原因后重审 D3/D4 |
| P3 | workflow 模式真实可达性：shell 直注 `PI_WORKFLOW_SCHEMA` 后本包进入 workflow 模式（index.ts:60 读同进程 env；extension 与 pi 同进程加载，loop-gate.ts:472-474 既有核实） | 见 §8 V1 命令 | ⛔ 验收期 | 失败（env 未达 extension）→ 改走 SW 真实链路（极简 workflow 单步 agent() 注入 schema）重跑 V1 |

## 7. 执行项清单与文件改动地图

**执行项表格**（性质列：直接执行 = u1 随本设计实施；移交 = code-simplify 批量执行）：

| # | 位置（当前实读行号） | 改动内容 | 性质 |
|---|---|---|---|
| E1 | loop-gate.ts:394-422、:484；tests/loop-gate.test.ts:704-709 | 删守卫三件套（锚点注释 / MAX_TIMER_DELAY_MS / 函数）+ 5 条测试断言；调用点换一行安全域注释（指向 subagent-core SSOT） | 直接执行（D1） |
| E2 | docs/design/structured-output-redesign.md:275 | 「`assertSafeTimerDelay` 包裹」表述改写为「字面量常量处于安全域」；跑 `node scripts/check-doc-symbol-drift.mjs` | 直接执行（D1，同 commit） |
| E3 | loop-gate.ts:446-463、:481-495 | 删 slot 三件套，`armForceExitTeardown` 改模块级 `let` + 两行裁决注释 | 直接执行（D2 裁决落地） |
| E4 | workflow-hook.ts:79-86、:56；tests/retry-state.test.ts:105-119 | 删 `reset()` + 删专设用例；:56「仅 reset() 可清」联动改写；类 doc 注释（:33-34）export 理由改「本包测试深路径消费」 | 移交 code-simplify |
| E5 | tool-definition.ts:226-241 | 删日常变体 execute 内 env 重读分支，直调 `executeStructuredOutput(params)` + 一行构造性事实注释（「日常变体 ≡ env 缺席，装配分岔 index.ts:60-72 已裁决；进程 env spawn 后不变」） | 移交 code-simplify |
| E6 | loop-gate.ts:392；workflow-hook.ts:90；execute.ts:87；index.ts:40、:46-55 | 三处零消费导出降模块私有；index re-export 删 RetryState/LoopGate/setupLoopGate 三项、import 收窄（:32 删 LoopGate、:40 删 RetryState） | 移交 code-simplify |
| E7 | text-primitives.ts:43-44 | 删「见 extensions/universal/unified-hooks 的 extractErrorText 及其文档」从句（保留 agent-loop.js createErrorToolResult 事实锚点）。与批 A ext-simplify-01 row 4 同点，后做方幂等跳过 | 移交 code-simplify（批 A 协同） |

**文件改动地图（u1 直接执行部分）**：`src/loop-gate.ts`（E1+E3，净删约 50 行）/ `tests/loop-gate.test.ts`（删 ：704-709，其余零改动）/ `docs/design/structured-output-redesign.md`（:275 一处）。`package.json` patch bump（5.1.4 → 5.1.5，无对外行为变化）。移交部分（E4-E7）涉及 `workflow-hook.ts` / `tool-definition.ts` / `execute.ts` / `index.ts` / `text-primitives.ts` / `tests/retry-state.test.ts`。

**审计修正记录**（实读 vs 2026-09-11 审计快照）：
1. **事实修正**：审计 finding 5 称「execute.ts:112 `validateAgainstSelfReported` 的注释理由『抽出以便单元测试直接调用』已失实」——不成立。该注释实际位于 `executeStructuredOutput`（execute.ts:143），且该函数确被 `tests/structured-output.test.ts:344+` 经 index 直接调用，注释属实。存活事实收窄为「`validateAgainstSelfReported` 导出零包外消费（含测试），降模块私有即可」。
2. **行号机械偏移**（语义无差）：守卫审计 ：393-424 → 当前 :394-422（调用点 :486 → :484）；reset 审计 :79-87 → 当前注释 :79、方法体 :80-86；slot 审计 :445-461 → 当前 :446-463；env 重读审计 ：225-241 → 当前 ：226-241。
3. **补充发现**（审计未列）：workflow-hook.ts:56 markTerminal 注释「仅 reset() 可清」在 E4 后悬空，已并入 E4 联动面。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「小」（结构清理 + 机械回退，行为零变更目标），3 个真实场景 + 既有行为用例零改动通过作为回归锚。**

### 8.1 改动规模与验收口径

死代码清理 / 守卫删除 / 持有方式回退，无行为变更——按准则 11 小改动口径简化投入；但强退链是边界红线，其「不回归」用双重证据：①真实链路正向冒烟（V1）；②锁定该链路行为的既有用例（转移表 / 常量锁 / 15s 硬退 / 幂等重武装，loop-gate.test.ts 50 用例）**零改动通过**——测试锁的就是行为，用例不改而通过 = 行为未变的构造性证明。说明：terminal 强退的负面路径（真实 3 连败）在本地探针中无法稳定复现（需模型连续 3 次产出同签名违规），其行为正确性由上述既有用例 + characterization 测试承担，不设不可稳定执行的真实触发门槛。

### 8.2 验收场景

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | workflow 模式真实任务（强退链宿主进程正向冒烟） | 目标 1 | 本地 pi CLI 直注 env：`PI_WORKFLOW_SCHEMA='{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/universal/structured-output`，stdin JSONL 发一条会产出结构化结果的 prompt | 工具调用成功返回 "Structured output recorded successfully."，details 含 answer 字段；进程正常退出（非 15s 硬退路径）；stderr 无 gate 告警 |
| V2 | 日常模式真实调用（env 缺席分岔 + E5 等价面） | 目标 1 | 同上命令去掉 env 前缀，prompt 诱导模型按工具 description 的 `{schema, data}` 形态自报调用 | 合法 `{schema,data}` 校验通过；互换形态（schema/data 调包）被 "Likely swapped" 拒绝 |
| V3 | 静态守卫 + 行为回归 | 目标 1/2/4 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连；`node scripts/check-doc-symbol-drift.mjs` | 三连全绿（P2 达成）；doc-drift 通过（E2 回写生效）；loop-gate 既有用例除 :704-709 删除外零改动（P1 达成） |

V1/V2 均为真实依赖（真实 pi CLI、真实模型、真实 session-dir），无 mock；单测仅作回归辅助不计入验收。

## 9. 下一层拆分

### 9.1 实施单元

| 单元 | 内容 | justification |
|---|---|---|
| u1 裁决落地（本设计执行） | E1 + E2 + E3 一个 commit；package.json patch bump | contested 项必须随裁决同批落地；E1/E3 同函数一批改完；E2 的 C-proc-10 纪律要求同 commit 回写；V1-V3 验收对 u1 可独立执行 |
| u2 low 群清理（移交 code-simplify） | E4 + E5 + E6 + E7 批量执行 | 审计定性为移交的批量清理项，不占本设计实施面；四项相互独立、均可一次批量完成；清单自包含（含批 A 协同注记）可独立验收（P2） |

### 9.2 待验证检查点

- P1/P2 的实跑结果（设计阶段断言全部有实读源码与绿基线依据，纪律上仍以实施期实跑为准）。
- V1 的 env 直注通路（P3）：设计阶段依据 index.ts:60 + 同进程加载事实推断，实施期以实跑为准。
- u2 若与批 A 实施时序交叉：E7 的执行方以「后做方跳过」为约定，合并冲突时以先合入方的改写为准。

### 9.3 已接受代价（四要素）

1. **删除守卫后的「未来动态化」敞口**：量级 = 一个 `export const` 字面量，任何改动必经 diff review；恢复路径 = delay 来源动态化时按 :484 处注释指回 `packages/subagent-core/src/shared/timer-delay.ts` 引入同款守卫（一行引用，通道存在）；重审触发 = 该常量任何非字面量化改动进入 review 时；显式判定 = 可接受（speculative guard 的边际收益低于其认知税）。
2. **slot 回退后 jiti 双实例双 timer**：量级 = 仅双路径加载才发生，双 timer 中首个 `process.exit` 获胜、第二个闭包 15s 后对已死进程空跑（无效果）；恢复路径 = 无需（进程级幂等，:447-448 现注释已裁决良性，裁决注释随 E3 保留）；重审触发 = 本包未来引入真跨 session 进程单例需 slot 时统一对齐；显式判定 = 可接受。

---

## 附录：变更历史

- v1（2026-09-12）：初稿。覆盖审计 M24（守卫 + 锚点漂移）、contested slot 裁决（回退 let）与 low 群移交登记（reset / env 重读 / 出口面 / 悬空引用，含批 A E5 协同）；含 2 条审计修正（finding 5 注释归属、行号机械偏移）。
