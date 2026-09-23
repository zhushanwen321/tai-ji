# v3-specs/ · 能力设计 spec

本目录存放 **v6 视觉体系没有对应物的功能/能力设计 spec**——跨区联动、工作流编排、pi 协议适配的设计 SSOT，仍被代码或后续实现引用。

## 保留的能力 spec

| 子目录 | 性质 | 说明 |
|---|---|---|
| `coding-plan-quota/` | **活跃** | provider 额度查询设计（被 packages/ 7 处代码注释引用） |
| `flow-2-code-review/` | **活跃** | 产品主路径 Flow-2 时序设计（被 message.ts 引用） |
| `flow-3-subagent/` | **活跃** | 产品主路径 Flow-3 多 agent 编排 + 进度聚合 |
| `ask-user/` | **活跃** | inline 提问交互设计（html demo；行为基线——tab 切换 / auto-advance / Other 形态——由统一表单协议的 FormOverlay / ChoiceQuestion 继承） |
| `fast-fork/` | 待实现 | 快速分叉（Fork-to-Ask + 后台分支管理） |
| `fast-merge/` | 待实现 | 多分支差异聚合（依赖 fast-fork 基础层） |
| `fast-handoff/` | 待实现 | 一键交接到新 session |
| `research/` | 实现调研 | pi steer/followup 队列机制调研 |

## 术语/拓扑定义

v3 UI 结构术语（Sidebar / Workspace / Panel / L0-L4 拓扑）的现行载体：[docs/CONTEXT.md](../../CONTEXT.md)「v3 UI 结构术语」章节。

## 视觉设计权威

当前视觉 SSOT = [docs/DESIGN.md](../../DESIGN.md)（太极纯灰 token 与视觉范式单一权威源）。
