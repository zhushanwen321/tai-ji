---
description: "审查聚合器。合并多个维度审查的报告为统一的 aggregated.md。"
name: review-aggregator
---

# Review Aggregator

## 角色

本 skill 是审查流程的**聚合器**：合并 A/B/C 多个维度 subagent 的独立报告，去重，
输出统一的 `aggregated.md` + 返回统计 JSON。

聚合器**不重新审查代码**——只读各维度已产出的 report，做合并、去重、排序、统计。

## 输入

task prompt 包含：

- 各维度 report 的文件路径（如 `project-conventions.md` 的 report、`quality-criteria.md` 的 report、`plan-completeness.md` 的 report）
- `outputDir`：聚合产物 `aggregated.md` 的写入目录

预期各维度 report 已按统一档位产出问题条目（MUST_FIX / SUGGESTION / INFO）。
plan-completeness 的 must_fix / should_fix 由该维度自行映射为 MUST_FIX / SUGGESTION（见 plan-completeness.md「严重度与统一档位的对应」）。

## 执行步骤

1. **逐一 read 各维度 report**：解析出每条 issue，标准化为四元组 `(file, line, severity, description)` + 来源维度 `dimension`
2. **去重**：按 `(file, line)` 二元组识别同一处缺陷（相邻 ±5 行视为同一处），**不要求 description 字面一致**——不同维度对同一缺陷的描述措辞会不同，靠 description 匹配会漏去重。当多个维度报告了同一文件同一行（或相邻行）的问题时，按全局优先级 **C（plan 落地）> A（项目约定）> B（通用质量）** 保留最高优先级维度的报告，其余丢弃（记入去重计数）。被保留条目的 `维度` 列标注所有来源（如 `A+B`）
3. **合并统计**：累计 MUST_FIX / SUGGESTION / INFO 三档总数；记录参与聚合的维度列表；记录去重掉的重复条目数
4. **按优先级排序**：MUST_FIX > SUGGESTION > INFO；同档位内按 file → line 排序
5. **写 aggregated.md**：按下述格式写入 `<outputDir>/aggregated.md`
6. **返回 JSON**：`{ "report_file": "<绝对路径>", "must_fix": N, "suggestion": N, "info": N }`

## 约束

- **只读各维度 report**，不重新审查代码、不重新读 diff、不调用任何审查逻辑
- **去重键按 `(file, line)` 二元组**（相邻 ±5 行视为同一处），不要求 description 字面一致：不同维度对同一缺陷的描述措辞不同，靠 description 匹配会漏去重。file + line 重合即判为同一处缺陷
- **去重优先级按全局 C > A > B**：同一处缺陷被多维度报告时，保留最高优先级维度的判定，其余丢弃（记入去重计数）；被保留条目的 `维度` 列标注所有来源（如 `A+B`）。优先级定义见三个维度文件的「重叠裁决」（C = plan 落地，A = 项目约定，B = 通用质量）
- 不修改各维度原始 report（aggregated.md 是独立产物）

## 输出格式（aggregated.md）

```markdown
# Aggregated Review Report

## Summary
- MUST_FIX: <数量>
- SUGGESTION: <数量>
- INFO: <数量>
- 维度: project-conventions, quality-criteria, plan-completeness
- 去重数: <被合并的重复条目数>

## Must-Fix Issues
| # | 文件 | 行号 | 维度 | 描述 | 修复方向 |
|---|------|------|------|------|---------|
| 1 | src/rules/state-machine.ts | 64 | A | 新增 action 未加转换表项 | 在 WAVE_TRANSITIONS 补对应转换 |
| 2 | src/rules/gates/test.ts | 79 | A | gate 结果未写 statusHistory | handler 内 append statusHistory |

## Suggestions
| # | 文件 | 行号 | 维度 | 描述 | 修复方向 |
|---|------|------|------|------|---------|
| 1 | src/dispatch.ts | 197 | A | guard 错误消息缺调试信息 | reason 补当前 status/期望 action |

## Infos
| # | 文件 | 行号 | 维度 | 描述 |
|---|------|------|------|------|
| 1 | src/rules/gates/retrospect.ts | 197 | A | 新增 gate 建议补 e2e |
```

## 返回值（stdout JSON）

```json
{
  "report_file": "<outputDir>/aggregated.md",
  "must_fix": 2,
  "suggestion": 1,
  "info": 1
}
```

调用方（pr-cr-fix 的 SKILL.md）按 `must_fix` 数量决策：`must_fix > 0` → 阻塞通过，引导修复；`must_fix == 0` → 通过。
