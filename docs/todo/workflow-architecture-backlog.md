# TODO：workflow 架构层立项候选清单

状态：待统一裁决（2026-09-29 登记；全部条目走 tech-design 立项，不在实施批顺带改）

## 背景

workflow 能力全景审计与 workflow resume 线 handoff 审查遗留的架构层候选项。已裁决：这些条目走 tech-design 立项流程统一裁决，不在日常实施批次里顺带修改。本文件为 tracked 登记文件（审计原始产出在 gitignored 的 `.tmp/` 工作流产物中）。

## 条目

每条一行简述 + 文件指针（行号于 2026-09-29 核实）：

- **G2 表现层 status 到文案的映射未归并为一套**：同一「运行状态 → 展示文案 / 颜色 / 图标」的映射在 4 个文件各自独立实现（共至少 6 处）——`extensions/universal/subagent-workflow/src/interface/format.ts` 内部即有 3 处（:149 statusGlyph、:454、:474 三处独立 switch）+ `interface/views/detail-content.ts:88` + `interface/gui-mappers.ts:62`（mapRunStatus，if 链形态）+ `interface/bg-notify-render.ts:260`。
- **G3 进程级 globalThis Symbol 槽过多且命名空间混用**：subagent-core 与 subagent-workflow 两包共 17 个唯一 `Symbol.for` 注册键（2026-09-29 grep 统计实际数，非原审计的 13）。命名空间前缀 3 种并存——`@zhushanwen/pi-subagents.*` 6 个、`@zhushanwen/subagent-core.*` 2 个、`@zhushanwen/pi-subagent-workflow.*` 8 个——另有 1 个无前缀变体 `pi-subagent-workflow.ui-observability`（`packages/subagent-core/src/execution/ui/ui-request-observability.ts:23`）。代表性定义位置：`packages/subagent-core/src/execution/engine/registry.ts:166`（engineRegistry）、`packages/subagent-core/src/execution/engine/routing.ts:69`（engineDiscoveryRescanOpts）、`extensions/universal/subagent-workflow/src/session-lifecycle.ts:240`（dialogQueue）。
- **G4 靠 process.env 探针区分父/子进程角色**：`extensions/universal/subagent-workflow/src/session-lifecycle.ts:421-440`（appendSubagentIdentityEntry）以 `PI_SUBAGENT_SELF_RECORD_ID` 是否存在判定主/子进程（仅 session-runner spawn 子进程时注入），并从 `PI_SUBAGENT_MODE` / `PI_SUBAGENT_AGENT` 等一组 env 读取身份数据——角色判定机制隐式依赖 spawn 约定，无独立裁决入口。
- **G7 interface/ 目录多职责混装**：`extensions/universal/subagent-workflow/src/interface/` 下 22 个文件混装命令处理（commands.ts / command-actions.ts）、格式化（format.ts）、GUI 映射（gui-mappers.ts / list-view.ts / views/）、工具定义（tool-*.ts 共 7 个）、TUI 基建（tui-kit.ts）等多类职责。
- **G8 决策记录两处并存**：包内 `extensions/universal/subagent-workflow/docs/adr/`（3 个 ADR 文件）与 `docs/design/`（13 个设计文档）跟项目级 `docs/adr/decisions.md`（ADR 收敛登记处）两套文档源头并存，决策与设计的位置无单一规则。
- **G9 测试深路径 import**：测试直接 import 包内部深层模块路径而非包入口，如 `extensions/universal/subagent-workflow/src/interface/__tests__/commands-resume.test.ts:21`（`@zhushanwen/subagent-core/orchestration/resume-run.ts`）、`interface/__tests__/tool-subagents.test.ts:28`（`@zhushanwen/subagent-core/orchestration/lifecycle.ts`）；另有跨包超深相对路径形态 `packages/subagent-core/src/execution/engine/__tests__/conformance/registry-fork-filter.test.ts:35`。
- **F1-C6 subagents 批量 tool 经转译间接层执行**：`extensions/universal/subagent-workflow/src/interface/tool-subagents.ts:13` / :68（FAN_OUT_SCRIPT_NAME）——tasks[] 参数经 handler 确定性转译为内置 fan-out 模板脚本再执行，工具契约与执行形态之间隔一层模板转译。
- **F1-C8 slug 长度限制**：`SLUG_MAX_LENGTH = 35`，权威定义在 `packages/subagent-core/src/orchestration/models/types.ts:99`（subagent-workflow 侧 `interface/subagent-tool-schema.ts:25` 从包入口引用）。长度上限的取值依据未登记。

已关闭不列入：G5（toRunSnapshot 导出但无任何调用点）已由 commit 6760d4168 清理，源码全仓零残留。

## 处置状态

全部条目待统一走 tech-design 立项裁决：逐条判定立项 / 不采用 / 降级为随手修，裁决后按结论消化并关闭对应条目。
