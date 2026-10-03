# 浮层 chunk 网络类装载失败：占位重试不自愈（已知限制）

> **状态**：已知限制（2026-10-03 D5 sync 裁决取登记臂，终态同步 F1-18 落盘；修码臂如翻转立项时更新本状态行）。
>
> **本文件定位**：登记 display-containers 交付的「错误占位重试对网络类 chunk 失败不自愈」已知缺陷及其修复方向。裁决关闭或立项修复时更新状态行。

## 缺陷描述

浮层装载失败回落目标（右抽屉 workflow tab，AsyncErrorFallback 占位链）的占位内重试按钮，对**网络类** chunk 装载失败瞬时再拒：浏览器 module map 对失败模块的记忆化使 re-import 零网络请求（dev/prod 同构造）。重试链机械在位（loader 重跑 + key 重挂），但重试不会产生新的网络请求——自愈不存在。

- **降级形态（现状可接受面）**：错误占位可见；Esc / ⌘W 可退出；重开浮层重置 Guard，每次点击均重试（重试链本身不坏）。
- **双证据**：D3-G2（实测重试零网络请求 + module map 记忆化归因）。

## 修复方向（二选一，立项时裁决）

1. **retry import 加 cache-busting**——仅 dev 形态可行；prod `file://` 指纹 chunk 的 URL 由构建管线生成，无法按 URL 重建。
2. **降级 reload**——整窗刷新，代价是对话流状态重挂，需评估 per-session 分区状态的持久恢复面。

## 证据指针

- 设计文档：`.tmp/tech-design/display-containers.md` §5.3 第 2 行「已知限制」段（.tmp 过程产物不入库，本文件为仓库内唯一登记处）。
- 实施计划：`.tmp/tech-design/display-containers.impl-plan.json` `residualRisks[1]`（chunk 网络失败重试不可自愈，source = D3-G2 双证据）。

## 同族项（登记口径互见）

- vitest 4.x worker 拆卸竞态（全仓套件 ~12%/轮假红，跟踪点 = vitest 升级时复验）：同属「已知未解决缺陷」，登记处 = impl-plan `residualRisks[0]`（未落 docs/todo——登记口径统一属主 agent 终审，见 impl-plan residualRisks[0] detail 互引）。
