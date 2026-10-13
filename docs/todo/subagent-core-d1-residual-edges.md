# subagent-core D1 拆边残余（2 条豁免反向值边 + 1 条转发路径残留）

状态：开放（小残余，不阻塞）。D1（execution → orchestration 反向依赖拆边，2026-09-30 用户裁决的终态演进纲领）原第 ③ 步「终局编排搬迁」已由逐符号最小处置替代完成，整族搬迁无待办；本文件登记其后新增的显式豁免边与一处转发路径残留（2026-10-11 源码核实）。

## 核实结论（2026-10-11）

- **原计划闭合**：terminal-actions 一族归属终态已满足——`packages/subagent-core/src/orchestration/terminal-actions.ts` 仍在 orchestration/（归属正确，无需搬迁）；2026-09-30 Class C 第 5 步以逐符号处置替代整族搬迁（`settleWorkflowRecord` 判记录级原语下沉 `execution/persistence/execution-record.ts`；`adoptInterruptedRun` 判编排动作留 orchestration、唯一调用点 `startup-sweep` 上移 `orchestration/startup-sweep.ts`），当时实测生产代码反向值边 = 0。
- **机器守卫现状**：`node scripts/check-subagent-core-value-cycles.mjs` = OK，包内零值依赖环（C-data-26；该守卫拦「环」，不拦单向反向边，故下列残余不红）。
- **残余 1（显式豁免值边）**：`execution/subagent-service.ts:116` 值导入 `orchestration/run-events.ts` 的 `latestModelOverride`（2026-10-06 commit ee3cf092d 模型切换接线引入）。代码注释显式登记为有意豁免：model-override 折叠语义消费面单点优先于拆边纪律（手写折叠即双轨），「拆边批可后续整族收编」。
- **残余 2（未注记值边）**：`execution/service/model-switch-wiring.ts:15` 值导入 `orchestration/run-registry.ts` 的 `projectRunRegistryEvents`（同批引入，无显式豁免注记）。
- **残余 3（转发路径残留）**：`shared/entry-guards.ts:15` 经 `orchestration/models/types.ts` 取 `SLUG_MAX_LENGTH`，而权威定义已下沉 `shared/run-vocabulary.ts`（`orchestration/models/types.ts:29` 仅 re-export）——纯 import 路径残留，无环、零语义影响。

## 待做

1. 拆边收编批（低优先）：残余 1 的 model-override 折叠族与残余 2 的 registry 投影消费收进 execution 侧单源（或改经端口接口），兑现 D1 终态「反向边收窄为端口接口」；或经用户裁决把两条登记为长期豁免（守卫只拦环，不收编也不阻塞）。
2. 残余 3 随手改：`entry-guards.ts` 改直连 `shared/run-vocabulary.ts`（一行 import 路径，可随任意后续 core 提交顺带）。

## 关联

- D1 执行纲领原表（原样保留）：[subagent-workflow-issues.md](subagent-workflow-issues.md) §2.0。
- 机器守卫：`scripts/check-subagent-core-value-cycles.mjs`（约束 C-data-26，pre-commit / CI 双接线）。
