# branch-review R1 建议级残余（随分支带走）

来源：dev-merge 合入点横切审查（feat-workflow-resume → dev-0.10.5，2026-09-29，报告目录 `.tmp/dev-merge-review/`）。必修 8 条已当场全修；以下 5 条建议级（suggestion）按流程随分支带走，不阻塞合并，待后续排期。各条的证据链与修复方向见对应维度报告全文。

## 1. phaseSettlementTracker 无终局/中断回收（business-logic 维度）

- 现状：`packages/subagent-core/src/orchestration/worker-message-pump.ts:160-165` 注释声称「终局/中断随 MemberReusePool 清理同域回收」，但 `clearMemberReusePool`（member-reuse-pool.ts:171-175）只清 pools/loadedRuns，物理上够不着 tracker（两模块互不 import）。run 中断/终局时若某 phase 仍有未落定 call，runId 条目永久残留——纯内存泄漏（runId 不复用，无行为错误），长驻 pi 宿主内单调增长。
- 实现要点：finalizeRun/interruptRun 调 clearMemberReusePool 的同域追加 `forgetPhaseSettlement(runId)`（pump 侧需新导出）；或把注释改为真实语义。

## 2. record 流读取器双实现（arch-boundary 维度）

- 现状：core 侧 `readRecordStreamStrict` / `rebuildRunFromRecord`（resume-run.ts）与壳侧 `readRecordStream` / `foldRecordStreamToRun`（jsonl-run-store.ts:193/:434）双实现，严格度有意分化（core 多 seq 断档检测）。注释以「跨包单源结构性不可行」作解，但壳同文件大量消费 core barrel，论证不成立于所需方向。
- 实现要点：把坏行判定规则（信封/词表/outcome/settled-缺-result 谓词）从 core barrel 导出为共享校验原语，壳侧包装自己的错误类型；或显式登记「严格度分层的双 reader」契约并补两侧一致性 parity 测试。

## 3. runtime-instance.json 契约双源（arch-boundary 维度）

- 现状：`apps/electron/main/supervisor/port-discoverer.ts:31,125-130` 本地重声明文件名常量与记录形状（pid/port/startedAt），写方 runtime 侧已有导出 SSOT（single-instance-guard.ts:36 `RUNTIME_INSTANCE_FILE` + `RuntimeInstanceRecord`）。单侧改名漂移无机器检查拦截，漂移形态 = main 判「无残留」跳过收割、残留 runtime 占端口。
- 实现要点：常量与记录形状上收 `@taiji/shared`（先例 = C-proc-18 的 `RUNTIME_PLANNED_EXIT_CODE`），两侧同 import。

## 4. 事件词表手抄镜像 + 注释失真（arch-boundary 维度）

- 现状：`packages/runtime/src/services/session/journal-projection.ts:64-85` 的 `RUN_EVENT_TYPE_PROBE` 9 键手抄，注释依据「barrel 未导出 RUN_EVENT_TYPES」已失真（`packages/subagent-core/src/index.ts:693` 实际导出；壳侧 jsonl-run-store.ts:176 已有 `new Set(RUN_EVENT_TYPES)` 消费先例）。镜像有编译期穷尽守卫不会静默漂移，但注释误导后来者。
- 实现要点：改 `new Set(RUN_EVENT_TYPES)`（barrel import）并删失真注释；或保留镜像但把注释改为「编译期穷尽守卫形态」的真实理由。

## 5. shared 对 extension-protocol 的依赖分类漂移（monorepo-impact 维度）

- 现状：`packages/shared/package.json:33`——生产码新增值级依赖 `@zhushanwen/extension-protocol`（message.ts:5-8 import + :44 re-export）但只登记在 devDependencies，是全仓唯一「生产 import + devDep 声明」的包。workspace symlink 下不断链；`pnpm deploy`（只装 production deps）/ 依赖审计 / 转发布时运行时断链。
- 实现要点：该依赖从 devDependencies 移到 dependencies（一行）。
