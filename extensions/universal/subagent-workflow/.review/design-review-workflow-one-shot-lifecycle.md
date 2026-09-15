# 设计审查报告：workflow-one-shot-lifecycle.md

## Summary

**结论：方案的前提事实错误，不能按现状实施。** 文档声称「pause/resume 只有手动入口、没有任何程序化消费方」——源码核实为假：`index.ts` 的 `session_tree`（:525-540）与 `session_shutdown`（:595-607）两个 session 生命周期 handler 会**程序化自动 pauseRun 所有 running run**。这使「删除零损失」的整个论证链（Q → 方案 A → D-2「现状诚实化」）动摇：session 切换时 run 从「自动挂起、可 resume 续跑（replay 保住已完成调用）」变成「直接 done,failed、token 投入作废」——这是行为变更，不是诚实化。

**4 must-fix, 6 suggestions.**

其余声称核实结果（通过项）：kill-9 残留 running 转 failed 属实（index.ts:456-465 + jsonl-run-store.ts:211-213 注释）；SNAPSHOT_VERSION 现状 `wf-run-v1` 与 bump/跳过先例属实（jsonl-run-store.ts:61-65）；lifecycle.ts 的 pauseRun:251/resumeRun:312/discardInFlightCalls:288/MUST_FIX 注释:265/创建 paused:178 行号全部属实；error-recovery.ts:151 注释属实；五段骨架完整（P0-1 通过）；三方案对比 + 明确推荐（P0-7/8/9 通过）；§2.1 物理数据流 + 场景 D 错误恢复指引（P0-17/18 通过）；探针标注结构（P0-16 通过）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §1 SCQA-C、§2.2 P4、§2.1 事实3 | P0-11 事实 | **「pause/resume 只有手动入口、没有任何程序化消费方」与源码不符，方案核心前提不成立**。`index.ts:525-540` session_tree handler（「切分支前 pause 所有 running run」）与 `index.ts:595-607` session_shutdown handler（「pause 所有 running run + store 收尾」，冷路径 flush 注释自证「run 转 paused 落盘，kill-9 恢复不误判」）是 pi session 生命周期事件驱动的**程序化调用**，不是手动入口。pause 的触发是程序化的（session 切换/关闭自动挂起），resume 是手动——两者构成「切 session 挂起、回来续跑」的完整真实链路，文档 §2.1 旅程图自己都画了「切换到另一个 session → /workflows resume」。 | 重新核实消费方后重写论证：把 session_tree/session_shutdown 的自动 pause 纳入分析；若确认是真实用户路径，「无消费方」前提不成立，方案 A 的「零损失」论断必须重做 |
| MUST_FIX | §3.3 D-2、§3.2 边界声明、§1 Out-of-scope | P0-10 对抗 + P0-12 | **D-2「session 切换统一转 failed」是行为变更，被包装成「现状诚实化」，且删除真实使用场景**。现状：session 切换/关闭时 running run 被 pauseRun 转 paused 落盘（index.ts:603-607），paused 跨 session 可 resume（jsonl-run-store.ts:24 注释「跨 session resume 后 loadAll 依赖指针」）；只有 kill-9 的 running 残留才转 failed。方案后：session 切换 run 直接 done,failed，已完成 agent 调用（token 投入）作废重跑——这正是文档否决方案 C 的理由（「长 workflow 已完成 N 个调用因一次事件全部作废」），而 session 切换远比 worker 崩溃常见。文档自相矛盾：§1 Out-of-scope 承认「一次性化**后** session 切换时转 failed」（新行为），D-2 却声称「现状对 running 残留本就如此」。违反 G1「功能不回归」。 | 承认这是行为变更并重估：要么保留「切 session 挂起可续」语义（改造而非删除 pause），要么把「session 切换 = 长 workflow 作废」明确列为用户可见后果并确认接受；「跨 session 存续」从 Out-of-scope 的「未来需求」改判为「现状能力，本方案删除之」 |
| MUST_FIX | §3.3 D-4、§5 U3 | P0-12 遗漏 | **接口面清除清单漏掉 pauseRun 最大的消费方 index.ts，且「session 切换当刻」的替代行为零设计**。D-4/U3 文件清单只有 tool-workflow/commands/command-actions/WorkflowsView/gui-mappers，不含 index.ts（:538/:607 两处调用）。D-2 只设计了「重启后 loadAll 转 failed」（:456-465 的恢复代码），没设计 session_shutdown/session_tree 当刻 running run 的替代行为——实施者要么自创「当刻转 failed 落盘」（文档未授权），要么留下跨 session 幽灵 running。S8 的 grep 断言通过后此缺口仍无人决策。 | index.ts 纳入 D-4/U3 文件清单；D-2 补「session 生命周期事件当刻」的明确行为（如 session_shutdown 内 running → done,failed 并落盘，与 loadAll 恢复语义对齐） |
| MUST_FIX | §4 S7、§5 检查点2 | P0-13 验收 | **D-3 核心验收 S7 当前不可执行，注入点「实施期定」= 设计未就绪**。D-3 是方案 A 中唯一「保留但重定位」的机制（discardInFlightCalls 挪入崩溃重建路径），S7 是它唯一的验收，而 S7 步骤写「实施期定注入点：如测试脚本内触发**不可达分支**使 worker 抛基础设施错误」——不可达分支无法触发，例子自相矛盾。§5 检查点 2 再次承认未定。后果：设计评审无法验证「崩溃重建路径 replay 假失败」是否被 discard 闭环（即 P3 描述的静默错误是否在崩溃路径复现），D-3 的「被否」论证（「删 discard → 崩溃一次 = 在飞调用永远 failed」）停留在推理层。 | 设计阶段定注入点：如 deps.workerHost.start 注入抛错、worker 内 process.exit(1)、指定脚本错误分类为 worker error 的具体构造方法；S7 步骤给出可执行的触发动作 |
| SUGGESTION | §2.1 事实2 | P1-8 事实 | 声称「6+ 处守卫」并列 10 个行号，实际执行级 `status === "paused"` 守卫 4 处（error-recovery.ts:178/624/667/699），其余为注释位置；:236/:346 不在 grep 命中内；遗漏两处执行级引用：lifecycle.ts:374（abortRun 的 paused 防御分支）与 error-recovery.ts:736（scheduleRebuild 重检）。方向不影响方案成立（守卫确实散布），证据列表应改准。 | 重列证据：4 处守卫 + 注释散布 + lifecycle:374/scheduleRebuild:736 执行级引用，数量与位置改准 |
| SUGGESTION | §3.3 D-6 | P1-8 事实 | 注释清理清单遗漏三处模型文件引用：models/run-runtime.ts:27（「lifecycle pauseRun 传 "pause"」）、models/budget.ts:103（「runWorkflow/resumeRun 内 setTimeout」）、models/trace.ts:156（「仅 lifecycle.pauseRun 清理」），另 index.ts:587/:604 注释。 | D-6 清单补入上述文件；或 S8 的「历史注释除外」明确覆盖模型文件注释 |
| SUGGESTION | §5 检查点1 | P1-8 事实 | 「快照格式含 "pending" 值」是 grep 误读：jsonl-run-store.ts:91 的 `"pending"` 是 `calls[].status`（agent-call 状态），run 的 status 字段是 `RunStatus` 类型（无 pending）。检查点 1 是伪问题，且暴露作者对快照格式的解读偏差。 | 删除检查点 1；如需保留，改写为「RunStatus 枚举收窄的编译期核对」 |
| SUGGESTION | §1 层声明、§2.3、§3.2 | P1-3 受众 | 「V4 B-1 方向在编排层的镜像」「V4 P5 的同类教训」引用 subagent 侧 V4 文档结论，未附摘要，未读过 V4 文档的读者不可理解；「MUST_FIX (round-4 #1)」是源码注释原文标记，未加引号标注，易与本文档自身的 MUST_FIX 混淆。 | 引用处补一句话 V4 结论；源码注释原文加引号并标注「源码注释原文」 |
| SUGGESTION | §2.1 事实3、D-2 | P1-8 事实 | 源码注释里的「D-4」编号与本文档决策编号 D-4（接口面清除）撞号；「loadAll 的恢复逻辑（jsonl-run-store.ts:211-213 的 D-4）」表述不准——恢复逻辑在 index.ts session_start handler（:456-465），store 文件里只有注释。 | 改称「源码 D-4 标记」；恢复逻辑定位改为 index.ts:456-465 |
| SUGGESTION | §3.3 D-1、§5 U1 | P1-2 拆分 | 「创建即 running」合并会撞上 WorkflowRun.assignRuntime 的 paused 前置契约（workflow-run.ts:222-224 抛错「requires status==="paused"」），构造函数/assignRuntime 的契约改动未在 U1 改动点列出。 | U1 补「WorkflowRun 构造与 assignRuntime 契约调整」条目 |
