# plan 契约消费面清单（D3/D2 冻结版——勾销锚）

> plan 模式状态机显式化（设计 D3「消费面清单」+ D2「entry 读方」）的逐点改动面登记。
> **用途**：契约在 U1 冻结，实现分落 U2/U3b/U4b——每项落地后在「勾销」列标记 `✅ + commit/文件指针`。
> 漏改即 F1 循环复活（忽略/搁置应答被判垃圾 → bad-response 引导重挂再入）或双盲降级，逐条核对不可跳读。
>
> 契约源（本目录）：`state-machine.ts`（8 态/9 事件/transition/derivePhase，D1）·
> `review-contract.ts`（值域守卫 + error envelope + selfReview 有界截断，D3①⑤/D9③）·
> `../../core/types.ts`（PlanReviewRequest/PlanReviewResponse/PlanReviewDecision，D3/D9 加员）。

## 一、D3 消费面（dismiss 加员逐点改动面）

| # | 消费面（D3 语义） | 落点 | 负责 | 勾销 |
|---|------------------|------|------|------|
| ① | `isPlanReviewResponse` 值域守卫加 dismiss 员——运行时守卫 TS 穷尽性管不到，漏改即搁置应答被判垃圾 → bad-response 引导重挂循环；**且**未知 decision 值的降级文案改「宿主/扩展版本不匹配」类指引，**不再引导重挂**（防再入循环，兼覆盖 R2 反方向错配） | `extensions/universal/plan/src/tool.ts`（本地守卫改接 canonical：`src/extensions/plan/review-contract.ts` 的 `isPlanReviewResponse` / `parsePlanReviewResponse`——unknown-decision 与 malformed 双分源降级文案） | U2 | ✅（U2：tool.ts 本地守卫删迁移，改接 `parsePlanReviewResponse` envelope——unknown-decision → `version-mismatch`（不引导重挂）/ malformed → `bad-response`（引导重挂）；契约测试 `review-contract-boundary.test.ts`） |
| ② | `executeSubmitReview` switch 加 dismiss 分支（转移 `reviewing --dismiss--> planning` 落盘 + tool result「用户搁置了本次审阅：plan 模式保持，文档与进度不变；简短告知用户已搁置并询问下一步，不要实施改动」；含 cancelled 归口分支的转移合法性判别——D3 连带段两归口点 + epoch 世代判别） | `extensions/universal/plan/src/tool.ts` | U2 | ✅（U2：tool.ts dismiss 分支 + 归口①②（epoch 世代判别，via 先于 epoch）+ `CompleteChoiceOutcome` 显式 via 五构造点；S15 断言族 `fsm-consumption.test.ts`） |
| ③ | `PlanDetails` / `ReviewErrorDetails` 联合与 `renderPlanResult` 渲染显式加员（default 兜底虽不炸 TUI，新结果形态不显式加员会静默落通用文本） | `extensions/universal/plan/src/`（tool.ts 结果联合 / 渲染 helper 所在文件） | U2 | ✅（U2：tool.ts 联合加员 `review-dismissed` / `complete-later` + ReviewErrorDetails 词表扩 `version-mismatch`/`no-self-review`/`stale-self-review`/`out-of-order`/`review-interrupted`；CompleteCancelledDetails 带 `source: 'reset'|'external'`；renderPlanResult 逐 case 显式渲染） |
| ④ | renderer 侧 `PlanReviewResponse` 类型**直接 import extension-protocol**（D2 同一 regime——「renderer 不依赖 extension-protocol」的既存注释是过时描述）；现存本地同形副本删除迁移 | `packages/renderer/src/components/panel/plan/PlanReviewBar.vue`（本地 `PlanReviewResponse` 同形）、`packages/renderer/src/composables/useExtensionUI.ts`（`PlanReviewUIRequest` 同形 + `isPlanReviewRequest` 本地守卫）、`packages/renderer/src/composables/panel/useBtwInteraction.ts`（降档回传同形注释） | U4b | ✅（U4b：PlanReviewBar 本地 `PlanReviewResponse` 同形已删除、改 direct import `@zhushanwen/extension-protocol`；plan-store 的 `PlanReviewComment` 同批迁移；useExtensionUI 的 `PlanReviewUIRequest` 保留为 core 帧视图扩展（core 契约不携带 plan 标记键，非契约同形副本），`selfReview` 类型引 canonical `PlanReviewRequest['selfReview']`，同名帧守卫与 canonical 载荷守卫的输入域区分已注释显式化，头注释过时陈述已修正；**残余子项**：useBtwInteraction.ts 降档回传同形注释在 U4b 领地外未动，待其领地持有方处理（已入 U4b 交付 blockers）） |
| ⑤ | 契约测试补 dismiss 样本 + 未知 decision 值域降级样本 | **本目录 `review-contract.test.ts`**（dismiss 4 例 / unknown-decision 4 值 / 空载荷 9 形态 / 非法形态 revise·approve 归一化 / 超限截断 5 例） | U1 | ✅（`review-contract.test.ts`，本单元） |

**echo 判定次序勾销锚**（U2 验收④末项）：`choice === payload` 逐字节 echo 判定必须**先于** parse（payload 加 selfReview 后 echo 仍是同一字符串，设计待验证检查点②已核实不受影响——实施时保持判定次序即勾销）。✅（U2：tool.ts 保持「echo 判定 → JSON.parse → canonical 值域解析」次序，`review.test.ts` echo 用例锁定不引导重挂）

## 二、D2 entry 读方（旧字段 → state/resumeHint 映射归一点）

| # | 读方 | 义务 | 负责 | 勾销 |
|---|------|------|------|------|
| ① | 扩展 `reconstructPlanState`（自有读边界） | 旧 entry 无 `state` 时映射 reviewState（awaiting→reviewing / revising→revising / 无→planning\|idle 按 isActive）；reviewStateSource:'resubmit' → resumeHint:'resubmit' | U2 | ✅（U2：state.ts `readLifecycleState`（state 值域守卫 + 旧映射 + isActive 推断）/ `readResumeHint`（resumeHint 直读 + reviewStateSource 同义映射）/ `readSelfReview`（4KB 读侧防御）；映射测试 `state.test.ts` + `index.test.ts` 旧 entry 用例） |
| ② | runtime `plan-state-extractor`（派生单点） | 同一映射在派生处归一，产出 View **恒携带 `state`**、**旧字段不透出**；断言驱动源 = `packages/shared/src/__tests__/fixtures/plan-state-entries.ts` 的 `LEGACY_ENTRY_VIEW_EQUIVALENCE_PAIRS`（5 对等价契约，fixture 定契约、断言在此落位） | U3b | ✅（`plan-state-extractor.ts` 归一 + `__tests__/plan-state-extractor.test.ts` 等价对断言，U3b） |
| ③ | renderer 读侧兜底映射（混装格） | `state ?? reviewState 映射 ?? 按 isActive 推断`（与读方①同构）——覆盖「旧 runtime × 新扩展」错配格（D2/R2③），退化不双盲；derivePhase/degradedReason 的 reviewState 分支全部迁移 | U4b | ✅（U4b：`plan-store.ts` 的 `resolvePlanLifecycleState`（含运行时垃圾 state 兜底）+ `resolveResumeHint`（reviewStateSource:'resubmit' 同义映射）；消费点全迁移——derivePlanStage / PlanReviewBar 公式与 degradedReason 分源 / PlanModeBar revising 判定均不再直读旧字段；契约测试 plan-store.test.ts「D2 读方③ 兜底映射」族） |
| ④ | runtime `session-records` `planStateEquals`（View 发布 diff 基线——**隐性消费面，清单漏项**） | D2 归一改变 View 字段域时，diff 比对维度必须同步（现 = state/resumeHint；reviewState/reviewStateSource 两行比对已删——旧字段恒缺后比对其 = 恒等，state/resumeHint 单维变化被抑制不广播，谎言 UI 族）；同类「对 View 形状敏感」的写侧 diff/快照面新增时先登记本表 | U3b（fix 轮 1 临时领土扩展） | ✅（`session-records.ts` planStateEquals + 测试迁移（session-records.test.ts / session-records-reconcile.test.ts / equivalence live-reload.test.ts），U3b fix 轮 1） |

**附加勾销（同批登记面）**：
- U2：`prompts.ts:138` 注释「PlanReviewDecision 收敛为 'approve' | 'revise'」随 D3 加员过时（现为三键值域）——同 commit 修正。✅（U2：prompts.ts `formatReviewComments` 注释改写为三键值域 + 各分支去向）
- U4b：`useExtensionUI.ts` 的 `pickPlanFields` 白名单加 selfReview（热帧 `toExtensionUIRequest` 与冷补 `getPendingRequests` **两条入店路径**都过，契约测试覆盖两路径的 selfReview 存在性——防「切回 session 有自审行、实时挂起无」半残形态）；plan-store/useExtensionUI 头注释过时陈述（「renderer 不依赖 extension-protocol」）修正。→ ✅（U4b：`pickPlanFields`（planReview + selfReview 白名单，非 string 不入店）接线 toExtensionUIRequest；双入店路径契约测试 = use-extension-ui-plan-review.test.ts「pickPlanFields 白名单 selfReview 双入店路径契约」族（热帧/热帧负向/冷补）；两文件头注释已改述 direct-import regime）
- U3b：`tryTranslatePlanReviewSelect` 透传 selfReview（截断在扩展写侧——上限与截断 canonical = `review-contract.ts` 的 `PLAN_SELF_REVIEW_MAX_BYTES` / `truncateSelfReview`）——✅（`event-adapter.ts` 条件落键 + `event-adapter-plan-review-marker.test.ts` 帧携带/缺席/空串/超限边界，U3b）。

## 三、状态机接线（D1 消费面）

| # | 消费面 | 落点 | 负责 | 勾销 |
|---|--------|------|------|------|
| A | 六 action 状态写全改走 `transition()`（enter / submit-review / complete / abort / register-doc / select-template）；副作用内联在转移成功后 | `extensions/universal/plan/src/**` | U2 | ✅（U2：生命周期写唯一通道 = `state.ts applyPlanEvent`（transition 封装）；enter（enter.ts）/ submit-review / complete（approve·exec_chosen·later·review_aborted 边）/ abort（exit 边）全走它；register-doc/select-template 无对应事件员——persist 携带 state 现值；接线断言 `fsm-consumption.test.ts`） |
| B | **事件命名裁决接线**：`approved --approve--> dispatching` = agent 再调 `complete` 重新选择执行方式（9 事件表无 `complete` 员，D1 边「approved 上 agent 再调 complete → dispatching」取「执行确认」语义族最近员 `approve`）；两归口点按 `via: 'later' \| 'dissolved'` 判别走 `later` / `review_aborted` 边 | `extensions/universal/plan/src/tool.ts` | U2 | ✅（U2：executeComplete 入口统一走 `approve` 边（reviewing 消费审批 / approved 重选同边）；归口①（submit-review choice 空）②（executeComplete cancelled）均 via 判别先于 epoch 判别——later 走 `later` 边、dissolved 走 `review_aborted`（epoch 已变则 no-op）；`resetPlanState(terminal)` 终态参数防覆写 completed） |
| C | derivePhase 接线（PlanModeBar 阶段映射 / plan-store derivePlanStage 重写） | `packages/renderer/src/components/panel/plan/**`、`packages/renderer/src/stores/plan-store.ts` | U4b | ✅（U4b：`derivePlanStage` 重写为 derivePhase 单点接线（含 D5 已批准档 'approved'——dispatching 不打回 ②，F5 不复活）+ PlanModeBar `STAGE_RANK` 阶段映射（③✓ 全对勾）；单测 plan-store.test.ts「derivePhase 单点接线」族 + plan-mode-bar.test.ts） |

## 四、曾列领地外待接线（U1 领地外未动件——已全部接线）

三件均已由 U1 / U1-fix 完成（本节保留记录，防回退）：

1. **`packages/extension-protocol/src/index.ts` barrel re-export** ✅：`state-machine.ts` / `review-contract.ts` 已进包出口（`export { … } from './extensions/plan/state-machine'` + `…review-contract`）——U2（transition 值导入）与 U4b（derivePhase 值导入）均经 barrel 接线，无子路径深 import。
2. **`packages/shared/src/protocol.ts` 的 `PlanLifecycleState` 引用形态** ✅：已切换为 `from '@zhushanwen/extension-protocol'` 包名 type import（D2 原定形态）。
3. **`packages/shared/src/__tests__/plan-protocol.test.ts` keyof 契约锁** ✅：已更新为 10 键断言（+`state` / +`resumeHint`）并补 optional 编码断言（同文件头注释表述同步）。
