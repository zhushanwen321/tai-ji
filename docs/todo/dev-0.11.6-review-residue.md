# dev-0.11.6 合入点横切审查 minor 残余（fix-chat-ui-no 分支 · run-group 序号下线）

状态：未解决（2026-10-16 dev-merge 合入点横切审查登记；3 条均为 minor 级，不阻塞合并，终局 PR 期复核裁决补修或关闭）

## 背景

fix-chat-ui-no 分支（run 组组头同名序号下线：删 `RunGroupBlock.seq` 与组头「· N」span）合入 dev-0.11.6 前，经 review-fix-loop 3 维横切审查（business-logic / arch-boundary / data-governance）。审查 4 轮：round 1 唯一 must-fix（MF-1-1 测试注释陈旧）当轮修复并经三方复核关闭，round 2-4 must-fix 连续为 0；loop 因 minor 建议项不收敛（建议数 5→6→8，主观项自然新冒）以 stuck 退出。diff 归属的 5 条 minor（S-1 注释漂移 / S-2 断言串退化 / S-4 可辨识钩子缺口 / N-2 残根护栏缺口 / N-4-org 护栏用例组织）已在合入前当批修复；以下 3 条为存量缺陷或正交基础架构缺口（均非本轮 diff 回归），按 dev-merge 分级「随分支带走」登记。

审查运行记录：review-fix-loop run `wf-1792143977923-58jes8`（base f8b5e3955）。

## 残余清单

| ID | 位置 | 问题 | 修复方向 |
|----|------|------|---------|
| S-3 | `packages/ui/src/features/chat/composables/use-turn-trace.ts`（组块 v-memo deps）+ `Turn.vue:192` 注释 | 组块 deps 缺 `header.failedCount` 及一般化「非末位成员」信号（**存量缺口，非本轮回归**）：takeover 态下组内非末位成员 `running→error`（无 endTime）时七项 dep 全不变 → v-memo 命中旧 vnode，失败 chip 与成员行状态滞旧；takeover 态全局 failedCount 归 0，组头 chip 是该态唯一失败信号 | ① deps 追加 `unit.header.failedCount`（「组块七项」注释同步改八项）；② 补成员内容指纹 dep（如 `unit.members.map((m)=>m.block.ref).join('|')`）；③ 补回归测试（takeover + 未变化成员复用同一对象引用） |
| N-3 | `packages/ui/src/rendering-protocol/primitives/container-registry.ts` + `__tests__/PrimitiveRouter.test.ts` | 测试顺序脆弱（**存量，与本 diff 无关**）：回退用例依赖「必须先于注册用例」的文件内顺序，注册表为模块级 Map 且无 reset/unregister；`--sequence.shuffle` 6 跑 5 红独立复现 | 给 `container-registry.ts` 加 `resetPrimitiveContainers()`（测试专用）并在 `PrimitiveRouter.test.ts` `beforeEach` 调用；或把「barrel 未加载」两用例拆到独立文件 |
| N-4-typegate | `.github/workflows/ci.yml`（typecheck job）+ `.githooks/install-hooks.sh:174`（`FRONTEND_FILES` 正则） | `packages/core` 的**测试文件无任何编译期类型门禁**：CI typecheck job 无 `@taiji/core` 步骤；pre-commit `FRONTEND_FILES` 正则 `^packages/(renderer\|ui\|mobile-renderer)/src/` 把 core 挡在门外；core 生产源码经 renderer include 传递被覆盖，但测试文件不在任何 tsconfig include 内。审查实证：core 测试文件注入类型错 → 52/52 单测绿 + 双类型门静默；同注入改生产文件 → 2 error | ① ci.yml typecheck job 增补 `- name: TypeCheck - core` + `run: pnpm --filter @taiji/core run typecheck`（core tsconfig `include:["src"]` 已含测试）；② `install-hooks.sh:174` 正则扩为含 `core`，或仿 ui/mobile 增一段 `cd packages/core && npx tsc --noEmit` |

## 已修复（终态存档）

- **must-fix**：MF-1-1（major）`Block.test.ts` 组头分区注释「进行中展开、已完成收起」与 ①A「挂载一律收起」实际行为相反——round 1 修复，三方复核关闭。
- **diff 归属 minor**（合入前当批修复）：S-1 `Turn.test.ts` 注释删「序号」漂移项；S-2 `trace-window.test.ts` 三处组身份判别串 `${u.base}:${u.header.count}` → `${u.base}@${u.headFlatIndex}`（同名组 count 相同时恢复可分辨）；S-4 `Block.vue` 组头补 `data-group-head` 稳定锚点（零视觉成本，替代被删序号供机器消费方区分同类型组）；N-2 残根 `Turn.test.ts` 路径 C 真实 Block mount 补忠实 `seq>1` 复辟护栏 + `Block.test.ts` 订正过度声称注释；N-4-org 两条序号护栏从「组名按 base 走三档」用例拆出为独立语义用例。

## 流程注记

审查探针产物 W-1（Arch 报 critical：工作区疑现未提交类型错误探针行）经 aggregator spot-check 降级——当前 `git status` 干净、HEAD 与工作区 grep 0 命中，系并发审查 harness 注入并还原的探针残留，非本 diff 缺陷，不进入修复队列。
