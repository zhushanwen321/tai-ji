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
| ① | `isPlanReviewResponse` 值域守卫加 dismiss 员——运行时守卫 TS 穷尽性管不到，漏改即搁置应答被判垃圾 → bad-response 引导重挂循环；**且**未知 decision 值的降级文案改「宿主/扩展版本不匹配」类指引，**不再引导重挂**（防再入循环，兼覆盖 R2 反方向错配） | `extensions/universal/plan/src/tool.ts`（本地守卫改接 canonical：`extensions/plan/review-contract.ts` 的 `isPlanReviewResponse` / `parsePlanReviewResponse`——unknown-decision 与 malformed 双分源降级文案） | U2 | ☐ |
| ② | `executeSubmitReview` switch 加 dismiss 分支（转移 `reviewing --dismiss--> planning` 落盘 + tool result「用户搁置了本次审阅：plan 模式保持，文档与进度不变；简短告知用户已搁置并询问下一步，不要实施改动」；含 cancelled 归口分支的转移合法性判别——D3 连带段两归口点 + epoch 世代判别） | `extensions/universal/plan/src/tool.ts` | U2 | ☐ |
| ③ | `PlanDetails` / `ReviewErrorDetails` 联合与 `renderPlanResult` 渲染显式加员（default 兜底虽不炸 TUI，新结果形态不显式加员会静默落通用文本） | `extensions/universal/plan/src/`（tool.ts 结果联合 / 渲染 helper 所在文件） | U2 | ☐ |
| ④ | renderer 侧 `PlanReviewResponse` 类型**直接 import extension-protocol**（D2 同一 regime——「renderer 不依赖 extension-protocol」的既存注释是过时描述）；现存本地同形副本删除迁移 | `packages/renderer/src/components/panel/plan/PlanReviewBar.vue`（本地 `PlanReviewResponse` 同形）、`packages/renderer/src/composables/useExtensionUI.ts`（`PlanReviewUIRequest` 同形 + `isPlanReviewRequest` 本地守卫）、`packages/renderer/src/composables/panel/useBtwInteraction.ts`（降档回传同形注释） | U4b | ☐ |
| ⑤ | 契约测试补 dismiss 样本 + 未知 decision 值域降级样本 | **本目录 `review-contract.test.ts`**（dismiss 4 例 / unknown-decision 4 值 / 空载荷 9 形态 / 非法形态 revise·approve 归一化 / 超限截断 5 例） | U1 | ✅（`review-contract.test.ts`，本单元） |

**echo 判定次序勾销锚**（U2 验收④末项）：`choice === payload` 逐字节 echo 判定必须**先于** parse（payload 加 selfReview 后 echo 仍是同一字符串，设计待验证检查点②已核实不受影响——实施时保持判定次序即勾销）。

## 二、D2 entry 读方（旧字段 → state/resumeHint 映射归一点）

| # | 读方 | 义务 | 负责 | 勾销 |
|---|------|------|------|------|
| ① | 扩展 `reconstructPlanState`（自有读边界） | 旧 entry 无 `state` 时映射 reviewState（awaiting→reviewing / revising→revising / 无→planning\|idle 按 isActive）；reviewStateSource:'resubmit' → resumeHint:'resubmit' | U2 | ☐ |
| ② | runtime `plan-state-extractor`（派生单点） | 同一映射在派生处归一，产出 View **恒携带 `state`**、**旧字段不透出**；断言驱动源 = `packages/shared/src/__tests__/fixtures/plan-state-entries.ts` 的 `LEGACY_ENTRY_VIEW_EQUIVALENCE_PAIRS`（5 对等价契约，fixture 定契约、断言在此落位） | U3b | ☐ |
| ③ | renderer 读侧兜底映射（混装格） | `state ?? reviewState 映射 ?? 按 isActive 推断`（与读方①同构）——覆盖「旧 runtime × 新扩展」错配格（D2/R2③），退化不双盲；derivePhase/degradedReason 的 reviewState 分支全部迁移 | U4b | ☐ |

**附加勾销（同批登记面）**：
- U2：`prompts.ts:138` 注释「PlanReviewDecision 收敛为 'approve' | 'revise'」随 D3 加员过时（现为三键值域）——同 commit 修正。
- U4b：`useExtensionUI.ts` 的 `pickPlanFields` 白名单加 selfReview（热帧 `toExtensionUIRequest` 与冷补 `getPendingRequests` **两条入店路径**都过，契约测试覆盖两路径的 selfReview 存在性——防「切回 session 有自审行、实时挂起无」半残形态）；plan-store/useExtensionUI 头注释过时陈述（「renderer 不依赖 extension-protocol」）修正。
- U3b：`tryTranslatePlanReviewSelect` 透传 selfReview（截断在扩展写侧——上限与截断 canonical = `review-contract.ts` 的 `PLAN_SELF_REVIEW_MAX_BYTES` / `truncateSelfReview`）。

## 三、状态机接线（D1 消费面）

| # | 消费面 | 落点 | 负责 | 勾销 |
|---|--------|------|------|------|
| A | 六 action 状态写全改走 `transition()`（enter / submit-review / complete / abort / register-doc / select-template）；副作用内联在转移成功后 | `extensions/universal/plan/src/**` | U2 | ☐ |
| B | **事件命名裁决接线**：`approved --approve--> dispatching` = agent 再调 `complete` 重新选择执行方式（9 事件表无 `complete` 员，D1 边「approved 上 agent 再调 complete → dispatching」取「执行确认」语义族最近员 `approve`）；两归口点按 `via: 'later' \| 'dissolved'` 判别走 `later` / `review_aborted` 边 | `extensions/universal/plan/src/tool.ts` | U2 | ☐ |
| C | derivePhase 接线（PlanModeBar 阶段映射 / plan-store derivePlanStage 重写） | `packages/renderer/src/components/panel/plan/**`、`packages/renderer/src/stores/plan-store.ts` | U4b | ☐ |

## 四、领地外待接线（U1 领地外未动件——收尾 PR / 各消费单元领地持有方处理）

1. **`packages/extension-protocol/src/index.ts` barrel 缺 re-export**：`state-machine.ts` / `review-contract.ts` 未进包出口——包 `exports` map 只有 `"."` 与 `"./background-task"`，**未导出子路径**（已实测 TS2307）。vitest/vite 对 workspace 深路径虽有先例（`@taiji/shared/__tests__` 深 import），但 TS（moduleResolution: bundler）与 node/jiti 运行时（pi 扩展真实加载）会拒绝未导出子路径——**U2（transition 值导入）与 U4b（derivePhase 值导入）必须经 barrel 接线**：index.ts 补 `export { … } from './extensions/plan/state-machine'` + `export { … } from './extensions/plan/review-contract'`（一行/模块）。
2. **`packages/shared/src/protocol.ts` 的 `PlanLifecycleState` 引用形态**：现为跨包相对 type import（`../../extension-protocol/src/extensions/plan/state-machine`，type-only 零运行时面）——barrel 接线后一行切换为 `from '@zhushanwen/extension-protocol'`（D2 原定形态）。
3. **`packages/shared/src/__tests__/plan-protocol.test.ts:119` keyof 契约锁**：`_Assert_View_keys`（`AssertExact<keyof PlanStateView, 8 键>`）随 PlanStateView 契约变更（+`state` / +`resumeHint`）必然转红——守卫按设计触发，需更新为 10 键断言并补 state/resumeHint optional 编码断言（同文件头注释「四必填 + 四 optional」表述同步）。未更新前 `pnpm --filter @taiji/shared typecheck` 红（vitest 运行不受影响）。
