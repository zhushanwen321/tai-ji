# TODO：workflow resume 重派丢失脚本路径锚定，内置模板 resume 必失败

状态：产品级缺陷，tracked 登记（2026-09-29；tech-design-wf 设计流程已于同日启动，实施后关闭本条）

## 背景

workflow resume（断点续跑）重派还没返回结果的调用时，需要从 record 事件流重建 RunSpec 再启动 worker。重建时脚本路径锚定（scriptPath——worker 用来定位脚本所在目录的路径）丢失，导致 6 个内置模板脚本（chain / fan-out / map-reduce / parallel / scatter-gather / review-fix-loop）的 resume 全部必然失败。真机验收终判 BLOCKED，证据在 `.tmp/dev-flow/workflow-run-store-convergence.acceptance/a1a4/verdict.json` 的 A4_completion 字段（gitignored 工作流产物，本文件是该缺陷在 tracked 文档中的登记条目）。

## 现状（证据链）

- `packages/subagent-core/src/orchestration/resume-run.ts:678`：从 record 流重建 spec 时 `scriptPath: ""` 硬编码空串——重建出的 spec 不携带脚本路径。
- `packages/subagent-core/src/orchestration/run-events.ts:308-338`：`RunCreatedEvent` 接口（record 流首条事件的载荷）只有 workflowName / argsSummary / args / model / scriptSource 字段，无 scriptPath——record 流本身存不下脚本路径，重派时无处可读。
- `packages/subagent-core/src/orchestration/worker-host.ts:55`：正常路径下 WorkerHost 把 `spec.scriptPath` 注入 workerData 传给 worker。
- `packages/subagent-core/workflows/fan-out.js:67-74`：worker 启动时检查 `workerData.scriptPath`，缺席即 throw `core_module_load_failed`，不回退 process.cwd()——这是刻意的防注入安全设计（process.cwd() 是用户项目目录，回退 cwd 会打开从用户目录误加载、或被植入同名 `_shared/agent-refs.cjs` 的代码加载通道）。
- 6 个内置模板全部依赖 scriptPath 锚定脚本目录才能加载共享模块：chain.js:51 / fan-out.js:74 / map-reduce.js:83 / parallel.js:61 / scatter-gather.js:52 各自 `require(SCRIPT_DIR + "/_shared/agent-refs.cjs")`；review-fix-loop.js:163 require 同目录 `review-fix-loop-utils.cjs`（依赖形态与前五个不同，但同样依赖 scriptPath 推导 SCRIPT_DIR）。缺席检查分布：chain.js:44-45 / fan-out.js:67-68 / map-reduce.js:76-77 / parallel.js:54-55 / scatter-gather.js:45-46 / review-fix-loop.js:105-106。
- 影响范围：inline 脚本（scriptSource 即全文）可 resume；6 个内置模板不可（scriptPath 空串被 worker 启动检查拒绝）；subagents 批量 tool（转译为 fan-out 模板执行，见 `extensions/universal/subagent-workflow/src/interface/tool-subagents.ts:68`）连带不可。

## 实现要点（修复方向候选，供后续 tech-design 裁决，不写死结论）

- 候选 A：`RunCreatedEvent` 增加 scriptPath 可选字段。代价 = record 流格式变更，且需评估绝对路径跨环境（换机器 / 包重装路径变化）失效问题。
- 候选 B：ResumeRunOptions 增加 scriptPath 字段，由壳入口（pi / zcode 两侧调用方）在发起 resume 时显式传入。
- 候选 C：core 侧按 workflowName 反查内置模板路径（内置模板在包内 `packages/subagent-core/workflows/` 下，名字可枚举）。
- 候选 D：`_shared` / 同目录共享模块的定位改为从 core 包自身位置推导（不依赖 per-run 的 scriptPath）。

## 处置状态

tech-design-wf 设计流程已于 2026-09-29 启动，设计文档将落 `.tmp/tech-design/`（gitignored）。本文件是该缺陷的 tracked 登记条目，实施并验证后关闭。

## 出处

- 真机终判：`.tmp/dev-flow/workflow-run-store-convergence.acceptance/a1a4/verdict.json` A4_completion 字段（BLOCKED）
- workflow resume 线 handoff 审查发现的登记缺失项（本文件补 tracked 登记）
