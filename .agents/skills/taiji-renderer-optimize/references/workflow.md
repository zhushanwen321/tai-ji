# Workflow — taiji-renderer-optimize 主流程

被触发后先判模式，全程**先报告、确认后改**。

## 步骤 0：模式判定 [MANDATORY]

| 用户话术 | 模式 | 行为 |
|---------|------|------|
| "找找哪里能简化" / "前端哪里能优化" / "找死代码" / "清理重复" | **scan** | 只产候选清单（按文件分组 + 严重度/置信度），**绝不改代码** |
| 其他（"帮我简化这段" / "优化这个组件" / 默认） | **fix** | 定范围 → 审查 → 报告 → 用户确认 → 增量应用 |

## 步骤 1：确定范围

- 默认范围 = 用户指定文件/组件；未指定时 = 当前工作区改动（`git diff` / 最近提交）。
- 范围涉聊天功能时，**必须三包同查**：`packages/renderer`（壳）+ `packages/core/src/domain/chat`（领域）+ `packages/ui/src/features/chat`（展示）。只看壳层必漏。
- 估算负载：≤3 文件 → 单 agent；>3 文件或跨三包 → 按问题类别并行拆（简化向 / 性能向各一个 agent），或按目录分片。

## 步骤 2：审查

- [MANDATORY] 审查者必读：`references/renderer-map.md` §3（已有范式清单，拦截重复提议）+ 对应 signals 文件（简化向 → `simplify-signals.md`；性能向 → `perf-signals.md`）。
- 并行原则：多 agent 时各拿完整范围，互不等待；聚合由主 agent 合并发现、丢弃命中「已有范式」的误报、消除冲突建议。
- 每条发现必须回答："这是不是既有范式的有意形态？"——答不上来就查 ADR/git blame 再定性。

## 步骤 3：报告

按文件分组列举：**文件、位置、类型（简化/性能）、问题、建议改法、为什么更易懂/更快**。

- 性能类额外标注：**A/B 档、热路径证据、预期收益量级、测量方式**；无测量手段的只列不改。
- 标注严重度 / 置信度（高置信可改，低置信需用户判断）。
- scan 模式到此结束。fix 模式：**结尾问用户哪些要应用**，等明确确认（可全选/单选/忽略），确认前不动文件。

## 步骤 4：确认后应用（增量、验证）

- 一次只做一个简化，每步后增量验证；失败回滚这一步。
- 重构与 feature 分开提交。
- 完成后汇报：改了什么、跳过什么及原因（静默跳过 = 未完成）、行为如何保持不变。

### 验证矩阵（按改动性质选）

| 改动性质 | 必跑验证 |
|---------|---------|
| 纯逻辑/composable | `cd packages/renderer && npx vitest run <相关测试>` + `pnpm --filter @taiji/frontend typecheck` |
| 涉 `packages/core` | 另加 `pnpm --filter @taiji/core test` |
| 组件模板/样式 | 上述 + 相关组件测试（三视角：每条用例至少一个用户可见 DOM 断言） |
| 模块加载期代码（import 结构/顶层副作用/CSS 变量） | 上述 + `node scripts/dev-smoke.mjs` [MANDATORY] |
| 纯删除 | 上述 + 评估覆盖率 gate（阈值 68/66/56/60，见 `perf-signals.md` 护栏） |
| 收尾/PR 场景 | renderer 全量 `npx vitest run` + `pnpm lint` |

测试红线：vitest（禁 `node:test` / `tsx --test`）；timer 用 fake timers；bash cwd 不持久，每条命令带 `cd packages/renderer &&`。

## 关键检查点

- [MANDATORY] 范围外代码一概不动（用户明确扩范围除外）。
- [MANDATORY] 未获确认前不应用任何修改。
- [MANDATORY] 命中「已有范式清单」的建议 = 误报，聚合阶段丢弃并在报告中说明丢弃理由（防止下一轮重复提出）。
- [MANDATORY] B 档性能改动必须经用户确认行为差异后才可应用。
