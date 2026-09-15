# 设计审查报告（第四轮·处置复核 + 子文档深审）：workflow-one-shot-lifecycle

## Summary

**3 must-fix, 5 suggestions.**

一句话总评：R3 的 5 个 MUST_FIX 中 4 个已真正修复（测试全量入清单、unit 两阶段重划、S4 文案机制、discard 落点——均经源码复核成立），但**处置引入了 1 个新的硬矛盾**：F4「构造初始 status:"running"」与 WorkflowRun 构造函数的 I1 fail-fast 校验直接冲突（构造即抛错，runWorkflow 无法创建任何 run）；加上 S7 ① 注入脚本与自身通过标准矛盾（重跑必然再崩，自愈断言不可达）、S3 ② 断言的原因串与触发路径不匹配（verifier 按手册执行必失败）。修掉这三处后，子文档即可作为实施唯一权威输入交付 builder。

## R3 五个 MUST_FIX 逐项核验记录

### MF-1（测试文件零覆盖）→ **已修复** ✓

- 子文档 §1.2（U1 处置 7 文件）+ §2.2（U2 处置 4 文件）与 R3 grep 清单 11 文件**逐一对应、无遗漏**：lifecycle.test.ts（删两 describe + 新增 terminateRunningRuns 套件）、error-recovery-handlers / error-recovery-workflow-call（守卫用例改 isTerminal）、launcher-nested-workflow / workflow-nesting-e2e（mock 字段删）、command-handlers（删用例 + 新增 removed 提示断言）、index-session-start（W2TC16 重写）；jsonl-run-store-session-file（paused 快照改 v1 跳过用例）、gui（映射用例删）、WorkflowsView-signature、crash-recovery（union 收窄）。
- 关键归属核实：`WorkflowsView-signature.test.ts:107-108` 实测为 `makeRun({ status: "paused" })` 的**签名对比测试**（computeRenderSignature），不依赖按键分支——U1 不碰 types.ts（三态仍在）时该测试仍过，放 U2 处置（收窄后 "paused" 类型断）**归属正确**。§1.2 全量行「U1 后 jsonl/gui 等测试仍测三态属预期」与逐文件推演一致（gui-mappers/format/jsonl-run-store 均不动，三态测试 U1 后仍绿）。

### MF-2（U1 独立 commit 不成立）→ **已修复** ✓（但 F4 引入新矛盾，见 MF-A）

- F5 两阶段切分成立：U1 领地 = 全部 pauseRun/resumeRun 调用点（lifecycle/error-recovery/index/tool-workflow/commands/command-actions/WorkflowsView），types.ts/jsonl-run-store/gui-mappers/format 明确禁改（U1-7）——「删行为后 paused 成死值、编译全绿、U2 再收窄」的推演经逐文件核实成立：
  - STATUS_ORDER 删 `paused:1` 后旧快照 paused run 排序落 `?? UNKNOWN_STATUS_WEIGHT`（commands.ts:40/:196-197），不崩 ✓
  - launcher/e2e 测试的多余 mock 字段（`vi.mock` factory 返回对象）不触发类型错误 ✓
  - jsonl-run-store 对 paused 快照 `reconstruct` 只查 I2（workflow-run.ts:96-99），U1 后仍合法 ✓
- U1 验收绑定修正（S1 去 v2 断言、S8 拆 S8a/S8b）与父文档 §4/§5 同步 ✓。
- 唯一例外：commands.ts:218-219（ViewActions 注入，U1-5 表格未列）——tsc 强制引导 + U1-6 的 grep 兜底，不破坏全绿主张，列 SG-A。

### MF-3（S4 错误文案不可达）→ **已修复** ✓

- F3 定稿与 pi 源码行为一致（R3 已实证 `packages/ai/src/utils/validation.ts:298-306`：execute 前 throw `Validation failed for tool "workflow"`，扩展不可定制）。工具侧接受拦截 + description/promptGuidelines 前置指引 + 命令侧 REMOVED_LIFECYCLE_VERBS 定制提示——三层分工自洽。
- 父文档场景 D / S4 同步改写，无残留旧文案。
- 可达性补充核实：命令侧提示只在 RPC 分支生效（commands.ts:100 `if (ctx.mode === "rpc")` 内 parse）；TUI 下 `/workflows pause <id>` 落 runId 匹配 → "Workflow 'pause …' not found"（commands.ts:138-157）。S4 ② 步骤明确写「RPC 通道」✓ 一致，不算缺口。

### MF-4（D-2 helper 形态行为分歧）→ **已修复** ✓

- F1 terminateRunningRuns 定稿（不发 onRunDone + 发 pending:unregister + per-run try/catch + 原因串两场景区分），副作用清单完整，理由成立。
- 链路兼容性逐点核实：
  - `makeDeps` 返回 LauncherDeps（index.ts:261-292），含 `runs`/`store`/`eventBus`——terminateRunningRuns(deps, reason) 签名兼容（现状 pauseRun 同样收 `makeDeps(state, ctx)` 产物）✓
  - **eventBus = pi.events**（index.ts:284）——F1 的 `deps.eventBus.emit("pending:unregister")` 与 session_start 先例的 `pi.events.emit`（index.ts:461-464）是同一通道，「对齐先例」名副其实 ✓
  - W2C5 时序保持：terminateRunningRuns 内部 `await deps.store.save(run)` → session_shutdown 的 `await terminateRunningRuns(...)` → `await store.dispose()`，编排顺序不破 ✓（行为微差：原 `Promise.allSettled(running.map(...))` 并行变串行——多 run shutdown 变慢，语义等价，可接受）

### MF-5（discard 落点正确窗口未定）→ **已修复** ✓（但 S7 ① 验收不可达，见 MF-B）

- F2 落点定稿（error-recovery.ts rebuildRuntime :157 `run.replaceRuntime(...)` 之后同步调用）与时序论证经源码复核**成立**：replaceRuntime 同步执行 `release("terminal")`（run-runtime.ts:82-90：clearTimeout + terminate + controller.abort 全同步发起），返回后立即 discard（无 await）时在飞 call 尚未 finalize（executeAgentCall 的 finalize 在 `await runner.run` resolve 后的 microtask，execute-agent-call.ts:153-155）→ `status !== "done"` 过滤精确命中。「放 delay 前误删真结果 / 放 await 后挡不住假失败」的反例论证与源码一致。
- handleScriptError 路径共用 rebuildRuntime，discard 在该场景无害（清在飞、保完成）✓。

### R3 五个 SUGGESTION 处置

| # | 处置 | 核实 |
|---|------|------|
| SG-1（types.ts/format.ts 归属） | ✅ U2-1/U2-6 列入；父文档 D-4 补 gui-mappers/format | ✓ |
| SG-2（D-1 形态） | F4 定稿——但引入 MF-A 新矛盾 | 见 MF-A |
| SG-3（S5/S6/S7 脚本） | 脚本全文已给；S7 ① 有 MF-B、S5 有尾巴 SG-D | 见下 |
| SG-4（行号） | ✅ scheduleRebuild:752 已改；父文档 §2.1「:105-107 case」实测 :101-103（2 行偏移，不影响） | ✓ |
| SG-5（pausedAt） | ✅ F6 定稿 v2 删除 | ✓ |

## Findings（本轮新发现）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | 子文档 §0 F4 + §1.1 U1-1「初始 status:"running"（:178）」 | IR-5 / P0-11 事实（新引入自相矛盾） | **F4 形态与 WorkflowRun 构造函数的 I1 fail-fast 校验直接冲突，按表执行 runWorkflow 构造即抛错**。构造函数硬编码 `this.runtime = undefined`（workflow-run.ts:95）后无条件调 `validateInvariants()`（:102→:125-138），I1 检查 `status === "running" && runtime === undefined → throw "invariant I1 violated"`（:127-132）。F4 顺序第一步 `new WorkflowRun(status:"running")`（runtime 必为 undefined）→ **构造抛错，任何 run 无法创建**，S1/S2/S3/S7 全不可过。F4 依据句「I1 窗口（构造完成到 assignRuntime 间）对外不可见」恰好自证矛盾：validateInvariants 不看对外可见性，构造时无条件校验。且 U2-2 写「assignRuntime 前置校验已在 U1 改（F4）」——子文档把 F4 拆进 U1，但 U1 文件清单（U1-1~U1-7）**无 workflow-run.ts 条目**，清单与 F4/U2-2 的归属声明三方不一致 | 定稿构造侧调整并归位：a)（推荐方向）U1 初始态暂保持 `status:"paused"`（F5 两阶段下 RunStatus 三态仍在，合法且 assignRuntime 前置校验 :222-224 无需动），把「创建即 running + assignRuntime 前置改 + 构造校验调整 + runs.set 后移」整体挪入 U2（types 收窄同 commit，届时 :128-132 的 I1 构造期校验需同步调整——如构造仅查 I2、I1 恢复检查移入 assignRuntime 末尾）；b) 若坚持 U1 改，F4 必须补「构造函数校验的具体改法」并将 workflow-run.ts 列入 U1-1。二选一定稿，消除三方不一致 |
| MUST_FIX | 子文档 §3 S7 ①（crashAt:"second"） | IR-3 / P0-13 验收不可达（新引入自相矛盾） | **注入脚本与通过标准矛盾：按脚本执行必 failed，断言却要 completed**。`setTimeout(() => process.exit(1), 300)` 的注入在 rebuild 重跑后**再次执行**（worker 重建全局重置、$ARGS 不变、脚本无「自己是重跑」的感知）：重跑时 a 命中缓存秒回 → 立即又注册 setTimeout → b 的 agent call（spawn 子进程需数秒）在 300ms 内不可能完成 → 第二次 exit → workerErrorCount 递增 → 3 次耗尽 → done,failed。S7 ① 通过标准「result = {a,b} 自愈完成」「b 重跑成功即 discard 生效」「a 不重复消耗 token」三个断言全部失去验收路径——这是 D-3/F2 唯一的行为验收，F2 落点正确性将无从证明 | 重新设计 ① 的构造使其具备「重跑不再注入」判别：如以 a 的返回耗时区分缓存命中（`const t0=Date.now(); const a=await agent(...); if ($ARGS.crashAt==="second" && Date.now()-t0>50) setTimeout(...)`——真跑慢、replay 秒回，仅首次执行注入），脚本全文更新并复核该判别在缓存命中路径的稳定性；或拆分断言：① 改验「重试轨迹 + a 子进程 session 文件恰 1 份」，「b 重跑成功」另设可单次注入的构造 |
| MUST_FIX | 子文档 §3 S3 ② | IR-3 / P0-13 验收断言与触发路径不匹配 | **通过标准「state.error 含 "Session switched"」在步骤给定的触发路径下不产生**。session_tree handler（产出 "Session switched: run terminated"）由分支树导航触发；而步骤「切换 session（TUI `/new` 或 RPC 等价）」走的是 session_shutdown 路径——`/new` = session_before_switch(reason:"new") + session_shutdown（index.ts:554-558 注释自证），RPC 的 `switch_session` 命令（pi rpc-mode.ts:576-581）同样走 session_shutdown → 原因串为 **"Session shutdown: run terminated"**。verifier 按手册执行断言必失败 | ② 拆两个子场景并写明触发命令：分支切换（TUI `/tree` 或 RPC navigateTree）→ 断言含 "Session switched"；切 session（`/new` 或 RPC `switch_session`）→ 断言含 "Session shutdown"；或断言放宽为含 "terminated" 并注明两路原因串。RPC 触发命令名写进步骤 |
| SUGGESTION | 子文档 §1.1 U1-5 / U1-6 | IR-1 清单行级遗漏 + 位置错 | ViewActions 的 pause/resume 注入实际在 **commands.ts openView :218-219**（`pause: (runId) => pauseRun(runId, deps)`），U1-5 的 commands.ts 表格未列该行；U1-6「注入方」写成「tool-workflow / gui 层」位置错误。U1-5 删 :25 import 后 :218 编译断——tsc 强制引导 + U1-6「grep actions.pause / `pause: ` 注入点清零」兜底，不阻塞，但逐行规格表不应有此空洞 | commands.ts 表格补 :218-219（ViewActions 对象注入收窄为仅 abort）；U1-6 位置改为 commands.ts openView |
| SUGGESTION | 子文档 §1.1 U1-4 / §2（无对应条目） | IR-1 死类型遗漏 | `WorkflowToolDetails` 的 lifecycle 分支 `action: "pause" \| "resume" \| "abort"`（tool-workflow.ts:232）与 `buildWorkflowGui` 的 severity 分支（:286-288，`details.action === "pause"` warn 判定）——U1-4 与 U2 均未列收窄。S8a/S8b grep 模式（pauseRun/resumeRun/"paused"）**均不命中**（无这些字面量）→ 死类型/死分支残留且静态断言抓不到，违背 D-4「类型收窄」与 G3 | U1-4 补：WorkflowToolDetails union 收窄（lifecycle 分支仅 abort）+ buildWorkflowGui severity 分支简化——注意必须与 gui.test.ts :426-438 的 pause/resume action 用例**同一 unit** 处置（该用例现放 U2，则收窄也应放 U2），否则先收窄后删用例会中间态挂测试 |
| SUGGESTION | 子文档 §2.1 U2-3（F8） | IR-1 连带调用点遗漏 | `ReleaseMode` 收窄为 `"terminal"` 后，workflow-run.ts:243 `this.runtime.release("pause")` 硬编码调用**类型断**（"pause" 不再 assignable）。U2-2 只写「核对无 paused 残留」，未列 :243 改动。tsc 强制引导 + 机械修复（改 "terminal"），不阻塞，但规格表应列全 | U2-2 workflow-run.ts 条目补「releaseRuntime 内 release("pause") → release("terminal")（:243）」 |
| SUGGESTION | 子文档 §3 S5 / 环境模板 | IR-3 可执行性尾巴 | ① S5「实施时对照 launcher.ts:290-310 确认 resolveScript 接受绝对路径」——本轮已实证可关：executeNestedWorkflow 用 `deps.registry.getPath(name)`（launcher.ts:328）与 actionRun 同一方法（registry-impl.ts:77），worker 全局 `workflow(name, args)` 确认存在（worker-script-builder.ts:354），绝对路径口径成立，子文档可直接定稿删尾巴；② 环境模板「把手势实际报文记入验收报告」措辞（应为 prompt 报文）；③ S7 ① 的 `-newer <marker>` 未定义 marker 的创建命令（如 `touch /tmp/wf-marker && …`），verifier 需自造 | S5 删「实施时对照」尾巴改为已核实结论；措辞与 marker 命令补全 |
| SUGGESTION | 父文档 §1 G2 表 | 残留自相矛盾 | G2 行「pause 族机制（terminate+重跑+**discard 补丁**）整体删除」与 D-3/子文档 F2「discard 保留、移入 error-recovery 重定位」矛盾——discard 补丁没有整体删除（消失的只是 pause 场景）。子文档是权威，但父文档 G2 会误导读者 | G2 该句改为「pause 族机制（terminate+重跑）删除；discard 补丁随 pause 场景消失并重定位为崩溃重建步骤（D-3）」 |

## 父文档残留扫描清单

| 位置 | 内容 | 判定 |
|------|------|------|
| §1 SCQA-C、§2.2 P4 | 程序化消费方/行为变更表述 | ✓ 与子文档一致，无旧行为暗示 |
| §2.1 旅程图 :99/:105-107 | 行号「:105-107 case」实测 :101-103（2 行偏移） | 可忽略（P1-8） |
| §2.1 事实2 | 已改 :752/:433-446（R3 SG-4 修复确认） | ✓ |
| §3.1 场景 D | pi 核心拦截 + REMOVED_VERBS 定制提示（F3 同步） | ✓ 无残留旧文案 |
| §3.3 D-1 | 探针「S8 grep：无 pauseRun/resumeRun/"paused"」为一步到位表述，与 §4 S8a/S8b 两段式（"paused" 死值 U1 后允许）不一致 | 轻微——D-1 探针宜引用「S8（两段式，见 §4）」消除歧义 |
| §3.3 D-2/D-3/D-5/D-6 | 定稿表述与子文档 F1/F2/F6/F8 一致 | ✓ |
| §4 S1-S8 | S1 标注「v2（U2 后断言）」、S8 拆 S8a/S8b、S4/S5/S7 引用子文档手册 | ✓ |
| §5 unit 表 | 源码/测试文件列与子文档 §1/§2 一致（含 F5 重划说明） | ✓（workflow-run.ts 在 U2 源码列 ✓，但 F4 的 assignRuntime 改动归属 U1 vs U2 的矛盾见 MF-A） |
| 附表 | 「挂起语义不存在」与 D-2 一致 | ✓ |

## 结论

R3 全部 5 MUST_FIX 的处置方向均成立且大部分实现质量高（F1/F2/F3/F5 经源码逐点复核无fact错误）；新增 3 个 MUST_FIX 全部是处置过程**新引入**的问题（F4 构造校验矛盾、S7 ① 脚本自反、S3 ② 断言错路），修复均为局部定稿（不推翻任何已收敛决策）。修完这三处 + 5 个 suggestion 后，子文档可交付 builder。
