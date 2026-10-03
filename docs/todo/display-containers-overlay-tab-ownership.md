# 浮层 × 未收编模态叠开时的 Tab 属主（设计未定义组合，待裁决）

> **状态**：待裁决（2026-10-03 终态同步 F1-8 登记；无既知回归，纯设计语义空洞）。
>
> **本文件定位**：登记 display-containers §6.7 键盘栈序的一个设计未覆盖组合及其候选修复方向。真机出现对应用户报告或主 agent 裁决时更新本状态行。

## 组合描述

「浮层开着 ∧ 未收编模态/弹层叠在其上」（例：浮层浏览器 + ⌘K 搜索模态同开）时按 Tab 的属主，设计（§6.7/§8.2 S3）只定义了「浮层开着时 Tab 在浮层面板内首末循环」，未定义该叠加组合下 Tab 归谁。

## 实现现状（按字面执行）

`key-orchestrator/orchestrator.ts` Tab 分支只门控 `overlay isOpen`（不查 `defaultPrevented`、不查聚合让位）——该组合下 `trapTabIntoOverlayPanel` 会把焦点拉回浮层面板，穿越叠在其上的模态。

## 影响评估（为何仅登记不修）

- 无既知回归：S3/S8 验收场景均不含该组合；reka 模态 focus-scope 可能先消费 Tab（行为未实证）。
- 补语义属设计裁决（改编排器行为 + 补 S3 组合场景断言）而非文档/代码孰对——不自行裁决。

## 候选修复（裁决「需处理」后实施）

编排器 Tab 分支在陷阱前补 `anyModalSurfaceYieldsEsc()` 让位检查（模态叠在浮层上时 Tab 归模态 focus-scope），并在 §8.2 S3 补「浮层 + ⌘K 搜索模态同开按 Tab」组合场景断言。

## 证据指针

- 设计文档：`.tmp/tech-design/display-containers.md` §6.7 编排器监听规格段「已知未定义组合」注记（.tmp 过程产物不入库，本文件为仓库内唯一登记处）。
- 代码锚：`packages/renderer/src/composables/features/app/key-orchestrator/orchestrator.ts` Tab 分支。
