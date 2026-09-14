# extensions 过度设计简化：设计文档索引（发现 → 设计映射）

> 来源：over-engineering-audit 20260911（25 包 / 12 完整候选 + 25 medium + low 清理点）。
> 用户决策（2026-09-11）：**全部发现落实**，按 extension 包维度拆分，走 tech-design 逐包设计 + 对抗式审查（tech-design-review + tech-design-impact-review），修复至 0 must-fix 后才进入实现。
> 本阶段零实现代码。contested 项用户已拍板全部执行：设计文档中选定方向（默认采纳审计的 code-right 方向，除非有兼容/安全理由，须写明）。
> **范围收窄后扩大（2026-09-12）**：首轮收窄仅 01/02/12 推进对抗式审查闭环并进入 dev-flow 实施；03/09/14 随后亦经双审查至 0 must-fix 并实施完成。当前已实施 6 份（01/02/03/09/12/14）。
> **剩余 9 份已审查（2026-09-13）**：按用户指示以 over-engineering-audit skill 方法论（四问 + 反模式清单 + 证据纪律）对 04-08/10/11/13/15 逐份派 subagent 审查，报告落盘本目录 `ext-simplify-XX-*.review.md`。结果：10/11 两份 PASS（0 must-fix），其余 7 份 NEEDS-FIX 共 12 must-fix（04/05/06/07/08 各 1、13 有 5、15 有 2）——全部为事实基线过时 / 公式自相矛盾 / 跨设计前提失效类文档级问题，**方案方向本身 9/9 全部核实成立（无伪问题、无新增过度设计）**。16 号仍未起草。
> **A 组 6 份已实施（2026-09-14）**：设计就绪后同日走 dev-flow 全流水线——22 单元全部 committed、阶段 3 五区一致性审查（unreasonable/doc_errors 双清零）、Gate A 全量 26 包 4457 用例绿、阶段 5 真机验收全 PASS（GUI 共享轮含 05-A3②/08-V2/V4/11-V2/双层链）。批次尾 changeset 已落；goal 桥运行时断裂（pi 0.84.4 跨扩展 API 不可达）为实施期新发现独立缺陷，待用户裁决。原设计就绪记录：04/05/06/08/10/11 按用户指示走完整 tech-design 流程——v2 修复 over-engineering 审查全部意见（4 MF + 21 sug）后补**双审查**（tech-design-review 主审 + tech-design-impact-review 影响面审；简洁性维度已由 over-engineering 审查的「方案自身过度设计检查」覆盖，不重跑），R1 共 3 must-fix（04：G5① impl-plan 回写落点 ×1；08：慢投递行为表征失实 + 排查通道不可操作 ×2）+ 9 sug 全部当轮修复，R2 聚焦复审 6/6 双 PASS 至 **0 must-fix**。双审查报告按流程约定落 `.tmp/tech-design/`（gitignore，不入库）。B 组（07/13/15）与 16 号不在本轮范围。

## 设计文档清单（16 份）

| # | 设计文档 | 覆盖包 | 覆盖发现（审计编号） | 四问记录（~/.pi/agent/tmp/） | 状态 |
|---|---|---|---|---|---|
| 01 | ext-simplify-01-unified-hooks-llm-shared.md | unified-hooks（删包）、llm-shared | C1 整包删除；low：MigrationResult 死导出、dependsOn reason 漂移（随删包消解）、session_start 上报机制（随删包） | session-view-01a0907b-7243-*.md | 已实施（审查 3 轮至 0 must-fix；u 单元 committed，见 impl-plan 状态表，20260912） |
| 02 | ext-simplify-02-system-prompt-trace.md | taiji/system-prompt-trace | C2 baseline 持久化机制删除（前置：CLI 探针验证 reload 时序）；C11 Like*Event×4 + SessionStartReason/normalize 冗余；low：parseTraceEntryData/computePromptHash export 收敛 | session-view-01a0907b-7242-*.md | 已实施（审查 4 轮至 0 must-fix；u 单元 committed，见 impl-plan 状态表，20260912） |
| 03 | ext-simplify-03-goal.md | goal | C3-goal Like*Event×7；C10 VALID_TRANSITIONS 绕过；M14 write-only 必填字段（持久化兼容）；M15 message_end 三重表述；M16 UiPort theme 声明；M17 SessionPort 死成员；low：budget dimension 死字段、formatBudget 转发层、event-handlers 微碎片（contested→裁决）、port/ctx 双通道惯例 | session-view-01a09053-242a / 01a09053-2419 / 01a0904a-4e4d | 已实施（双审查至 0 must-fix；u1-u5 20260912） |
| 04 | ext-simplify-04-session-reader.md | session-reader | C5 find 三次全量扫盘；low 群：doctor 缓存机（+设计 §6.3 回写）、测试 re-export 块×4 域模块、RESULT_ACTION_DEPS、err 双轨、fullEntry、formatLine/formatOutlineText 双份、family enrichRefs（contested→裁决）、readTailIdentity 双写、SessionRoot.id、byteBudget、OutlineOptions.budget、content 提取 5 变体 | session-view-01a08ff3-3bba / 3ba8 / 3b9a / 3b81 | **已实施 20260914**（v2-r2 双审查 0 must-fix；U1-U9 全 committed；阶段 3 审查双清零 + Gate A 26 包 4457 绿 + 真机 S1-S5 全 PASS——见 .tmp/dev-flow/ext-simplify-group-a.impl-plan.md） |
| 05 | ext-simplify-05-permission.md | permission | C6 注入仪式（setDefaultListAvailableModels）；C7 rpcDeps 注入面；M6 审批卡双份；M7 CommandDeps×2；M8 cancel() 孤儿；M9 ResolvedModelEntry 三字段；M10 pattern 双写；M11 ui 适配闭包×3；low：rules barrel、pipeline export 面、winner 循环×3、toolName 守卫、SelectItem、rerender() | session-view-01a0904a-4e93 / 4e7e / 4e69 / 4e4b / 01a08ff3-3bae | **已实施 20260914**（v2-r1 双审查 0 must-fix；S1-S3 全 committed；真机 A1/A2/A4/A3 全 PASS——A3 澄清：strict 无 AI 分类，reasoning 行单测锚定） |
| 06 | ext-simplify-06-plan.md | plan | C8 isolation×execMode 矩阵（正确性）；M1 三源模板机制；M2 extractPlanSteps 脱节；M3 动态 import×3；+peer 依赖 optional 化（审计发现 5） | session-view-01a09070-77dd-*.md | **已实施 20260914**（v2-r1 双审查 0 must-fix；u0 探针门 P1/P2 PASS 后 u1-u5 全 committed；探针新发现 goal 桥运行时断裂登记独立缺陷；真机 V1-V5 按桥断裂形态全 PASS） |
| 07 | ext-simplify-07-todo.md | todo | M4 UpdateResult 双字段双协议；low：handleAutoClear 双布尔、completed 计数×4 | session-view-01a09070-77fc-*.md | 已审查 20260913：NEEDS-FIX 1 MF（行号基线被同日 auto-GC 提交 8b7f85b8b 重排，§6 实现地图须刷新）+ 3 sug；pi 0.84.4 dist 独立验证 D2 运行时断言（review.md） |
| 08 | ext-simplify-08-scheduler.md | scheduler | M18 croner optional peer 误报；M19 queuedInDeliveryAt 补偿机制（contested→设计裁决：登记跨包债务 vs 根修 session-delivery settled 回调）；low：errorCode、delivery handle 中转、void ctx | session-view-01a09053-242e-*.md | **已实施 20260914**（v2-r2 双审查 0 must-fix；08-u1/u23/u4 全 committed 含 session-delivery 内核 per-message 根修；真机 V1/V3/V4 + V2 staging 半全 PASS，13.1min 观察窗无重复注入） |
| 09 | ext-simplify-09-smart-context.md | smart-context | C12 estimateShadowedTokens→SDK estimateTokens；门控谓词双写；deps 注入缝；details 五字段；Like*Event×5（contested→裁决：SDK 直标/省略标注推断，边界断言不可达——包根缺席 2 符号见设计 §5.1 审计修正） | session-view-01a09070-77fd-*.md | 已实施（设计审查 2 轮至 0 must-fix；u1-u4 20260912） |
| 10 | ext-simplify-10-structured-output.md | structured-output | M24 assertSafeTimerDelay+锚点漂移；low：RetryState.reset、Symbol.for slot（contested→裁决：C-ext-06 惯例 vs 回退）、env 重读、出口面测试专用导出 | session-view-01a09070-7809-*.md | **已实施 20260914**（v2-r1 双审查 0 must-fix；u1 committed 5.1.6 行为零变更；真机 V1/V2 PASS） |
| 11 | ext-simplify-11-ask-user.md | ask-user | M23 Other label 校验缺失（正确性）；low：AnswerValueSchema/ResultSchema、TUI 样板双份、channel registry 外沿（resolve/list 死成员 + gui_widget 空置登记 doc-right） | session-view-01a09053-2422-*.md | **已实施 20260914**（v2-r1 双审查 0 must-fix；u1 committed；真机 V1/V3 + GUI 轮 V2/双层链 PASS；V3② e2e spec 存量漂移 blocked 与本批无关） |
| 12 | ext-simplify-12-pending-notifications.md | pending-notifications | C4 W4 死代码区 ~100 行 + registry 现算化（contested→设计裁决）+ 导出面收敛（14 具名导出仅 1 消费）+ 分档常量头注失实（该常量已随本设计删除，失实随之消解） | session-view-01a0907b-727b-*.md | 已实施（设计审查 2 轮至 0 must-fix；u0-u4 20260912） |
| 13 | ext-simplify-13-base-tool-enhance-protocol.md | base-tool-enhance + extension-protocol（下沉侧） | M12 registry 行为原语三处复制→下沉 extension-protocol（pid 判据/tail/LRU/原子写）；M13 bt- 差集双写（方向 A 提强依赖 vs B 下沉 protocol——设计对比后定）；low：task-store 包装链、getTask 零调用。**〔跨设计协调，登记自 12 号设计 §6.4⑤〕**：13 号 D5 计划在 pending-reconcile.ts :135-141 补注释，其前提「pending 内存 registry 仅在其自身 session_start rebuild 后非空」在 12 号终态（registry/rebuild 删除、entries 现算化）下失效——实施 D5 时须按 12 号文档（ext-simplify-12-pending-notifications.md）终态口径改写该注释，不得引用已删除的 registry/rebuild 机制 | session-view-01a09053-2429-*.md | 已审查 20260913：NEEDS-FIX **5 MF**——MF1 D5 需按 12 号终态整体重裁（现源码注释已是 entries 现算口径，设计的「毫秒级窄窗口」注释会直接矛盾）；MF2 E4/E6 API 形状错位；MF3 §2.3 根因失实（runtime 实际经子入口消费 shared 包）；MF4 P1 探针漏 renderer/core 打包面；MF5 protocol 零依赖下日志通道无归一方案 + 4 sug；三主干方向正确（review.md） |
| 14 | ext-simplify-14-shared-libs.md | file-lock、cache-probe、extension-logger | C9 file-lock 扩展侧 async 面（65 行零调用）；M22 cache-probe seq 声明未实装；low：file-lock LockCoreOptions/双 Options re-export、extension-logger 类型导出+测试出口、cache-probe 测试导出×3 | session-view-01a0907b-727f-*.md | 已实施（双审查至 0 must-fix；u1-u3 20260912） |
| 15 | ext-simplify-15-rename-session-session-manager.md | rename-session、session-manager | M20 PI_RENAME_* env 覆盖层；M25 session-manager 契约 4 字段+1 类型死；low：isSubagentSession 路径嗅探（contested→登记 constraints+双端注释）、preview 双维护 | session-view-01a09070-780e-*.md | 已审查 20260913：NEEDS-FIX 2 MF——MF1 状态失同步（D1/D3/D4/C3 已被 rename-session-three-modes.md D6/D7 吸收实施或关闭，**待执行范围收敛为 D2+B1-B3**）；MF2 §6.1 等价性前提被 three-modes D5 推翻（空 ref 现走 ctx.model）+ 3 sug（review.md） |
| 16 | ext-simplify-16-plugin-bridge.md | plugin-bridge | M21 Inject*Content 透传机制（contested→设计裁决：收窄 text-fallback vs 保留 forward-ready）；low：BridgeSyncPayload.commands 恒空死字段（双端同 PR）、isToolNotFound error 分支、跨包形状一致性测试（补测试） | session-view-01a0907b-7245-*.md | 待设计 |

## 无任务包（审计「已核实非过度」，不出设计文档）

- cw-tool（pn-cw 单元无发现）
- taiji/agent-ext、taiji/msg-id-mapper、taiji/system-prompt（双端消费验证通过）
- shared/ext-guards（oncePerProcess 正常；与 llm-shared 的整合评估未开展，01 号附录 B 不含此项，待后续批次裁决）

## 流程状态

| 阶段 | 状态 |
|------|------|
| 映射索引（本文件） | ✅ 20260911（20260912 范围收窄更新；20260913 审查状态更新；20260914 A 组设计就绪更新） |
| 起草（16 份，tech-design 五段骨架） | 01-15 已落盘并提交（16 未起草）；20260912 收窄为仅 01/02/12 推进，后扩大：03/09/14 亦审查实施完成 |
| 审查 | 01/02/03/09/12/14：双审查（tech-design-review + tech-design-impact-review）完成。04-08/10/11/13/15：20260913 完成 over-engineering-audit 视角审查（9 份报告 `ext-simplify-XX-*.review.md`，2 PASS / 7 NEEDS-FIX 共 12 must-fix，方案方向 9/9 成立）；其中 **A 组 6 份（04/05/06/08/10/11）20260913-14 追加 tech-design 双审查至 0 must-fix**（报告 `.tmp/tech-design/`，gitignore）；16 未起草 |
| 修复循环（每轮全修 must-fix+suggestion 至 0） | 01（3 轮）/ 02（4 轮）/ 12（2 轮）/ 09（2 轮）/ 03（聚焦复审 R1 双 0）/ 14（主审 R1 + 影响面 R2）均收敛至 0 must-fix；**A 组 6 份（04/05/06/08/10/11）：over-eng 意见 4 MF + 21 sug 全修（v2）→ 双审查 R1 3 MF + 9 sug 全修（v2-r1）→ R2 聚焦复审 6/6 双 PASS（04 补 1 sug / 08 补 2 INFO 措辞，v2-r2）**；B 组（07/13/15）余 8 must-fix 待修复 |
| 设计就绪宣告 + commit | 01/02/03/09/12/14 + **A 组 04/05/06/08/10/11（20260914 dev-flow 全流水线交付，impl-plan .tmp/dev-flow/ext-simplify-group-a.impl-plan.md）**共 12 份已实施；07/13/15 待修复后进双审查；16 待起草 |
