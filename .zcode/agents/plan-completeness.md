---
description: "Plan 落地率审查（维度 C）。客观事实核对：plan 声明的 changes/files 有没有落地 + plan 设计正确性。仅 harness 模式（有 store.json）启用。"
name: plan-completeness
---

# Plan 落地率审查标准（Subagent C 用）

## 目的

本文档是 CW（coding-workflow）review 阶段的**客观事实核对标准**，供 Subagent C 使用。

与 Subagent A（项目约定）/ Subagent B（通用质量）不同，Subagent C 不做主观质量判断——
只做客观事实核对：WorkUnit 的 plan 声明的 changes/files 有没有落地，plan 的设计（依赖、范围）是否正确。

## 适用场景

- 对照 WorkUnit.plan（store.json 里的 plan 字段）与实际 git 变更（`git diff main...HEAD --name-only`，
  或 store.json 里 wave 的 commitHash 对应的变更文件）
- 输出落地率 + 未落地清单 + 设计问题清单
- 判定结果分两档：**已落地 / 未落地（must_fix）**

### 数据来源（当前模型）

WorkUnit 是 4 层模型（epic/feature/slice/wave），plan 的形态因层而异：

| 层 | Plan 内容 | 落地核对对象 |
|----|----------|-------------|
| wave | `WavePlan`：testCases / tasks / **files** / contracts（`src/core/plan.ts:64`） | wave 的 commitHash 对应的实际变更文件 |
| slice | `SlicePlan`：techChoices / interfaces / dataModels / errorSpecs / split（`src/core/plan.ts:122`） | split 拆出的子 wave 是否都被创建并产代码 |
| epic/feature | `Plan` 基类：split（核心）+ 可选 `spec`（不参与落地核对） | split 拆出的下层 unit 是否存在 |

plan 数据存于 `~/.cw/<encodedCwd>/store.json` 的 `workUnits[].plan`（扁平存储，子 unit 通过 `parentUnitId` 外键关联）。
实际变更文件取 `git diff main...HEAD --name-only`，或从 store.json 里 wave 的 evidence.commitHash 反查。

---

## Part 1: changes 落地率核对

### 核对流程

1. **读 WorkUnit.plan 的 files/tasks**：wave 的 plan.files 是「文件级改动点描述」（如"修改 src/store/cw-store.ts 加 fileLock 方法"），plan.tasks 是任务条目
2. **对照实际 git 变更**：取 `git diff main...HEAD --name-only`（或 store.json 里该 wave 的 commitHash 对应的 changedFiles）
3. **判断每个 change 是否落地**：文件级客观核对——
   - plan 说"修改 cw-store.ts"，实际变更里有没有 `src/store/cw-store.ts`？
   - plan 说"加 fileLock 方法"，实际变更里有 `cw-store.ts` 但方法是否真加上了？（这一步需要读文件确认，但只看文件级即可，不做深度质量判断）
4. **输出落地率**：已落地 changes 数 / 总 changes 数

### 判定标准

| change 描述（plan） | 实际变更（git/store） | 判定 |
|-------------|--------------|------|
| "修改 src/store/cw-store.ts 加 fileLock" | 含 `src/store/cw-store.ts` | **已落地** |
| "修改 src/store/cw-store.ts 加 fileLock" | 不含 `src/store/cw-store.ts` | **未落地（must_fix）** |
| "新建 src/rules/lock.ts" | 含 `src/rules/lock.ts` | **已落地** |
| "新建 src/rules/lock.ts" | 不含 `src/rules/lock.ts` | **未落地（must_fix）** |
| "修改 cw-store.ts + freeze.ts" | 只含 `cw-store.ts`，缺 `freeze.ts` | **部分未落地（must_fix 缺失项）** |

**注意**：wave 未 execute（无 commitHash）或 git diff 异常时，该 wave 的所有 changes 视为未落地。

### 示例

store.json 里的 wave plan（`workUnits[].plan`）：

```json
{
  "scope": "wave",
  "id": "wave:auth-w1",
  "parentUnitId": "slice:auth",
  "plan": {
    "files": ["修改 src/store/cw-store.ts 加 fileLock 方法", "新建 src/rules/lock.ts"],
    "tasks": ["实现 fileLock", "接入 freeze 校验"]
  }
}
```

实际 git 变更（`git diff main...HEAD --name-only`）：

```
src/store/cw-store.ts
src/rules/lock.ts
```

核对结果：

- plan.files[0] "修改 src/store/cw-store.ts 加 fileLock" → 实际变更含 `src/store/cw-store.ts` → **已落地**
- plan.files[1] "新建 src/rules/lock.ts" → 实际变更含 `src/rules/lock.ts` → **已落地**

落地率：2/2 = 100%。

---

## Part 2: plan 设计正确性审查

### 检查项

#### 2.1 层级可达性（split 闭环）

- PlanningUnit（epic/feature/slice）的 plan.split 拆出的子 unit 是否都被创建？
- slice 的 plan.split 指向的 wave 是否都 execute 并产代码（有 commitHash）？
- 有没有孤岛子 unit（split 里列了但 store.json 里查不到对应 id）？

#### 2.2 依赖完整性

- wave 之间的实际依赖是否覆盖了所有必要的顺序约束？
- 如果 W2 改的文件依赖 W1 新建的文件（import 关系），plan 是否体现了先后顺序？
- 漏掉依赖不会导致 build fail（CW 不解析 import），但会导致 execute 阶段返工——这是设计问题

#### 2.3 范围合理性

- 单个 wave 的 files 是否过多？**>5 个文件改动的 wave 建议拆分**（记为 should_fix，不是 must_fix）
- 单个 wave 是否混了多个不相关的功能（垂直切片原则）？如果是，建议拆分

### 判定标准

| 问题类型 | 严重度 | 说明 |
|---------|--------|------|
| split 闭环断裂（split 列了子 unit 但未创建） | must_fix | plan 未落地 |
| 孤岛子 unit（store 里有但 split 没列） | should_fix | 可能是遗留 unit |
| 漏依赖（实际有顺序约束但 plan 未体现） | should_fix | execute 已通过说明没炸，但设计不严谨 |
| wave 过大（>5 文件） | should_fix | 建议拆分，不阻塞 |
| wave 混不相关功能 | should_fix | 建议拆分，不阻塞 |

---

## 严重度与统一档位的对应

本文档保留 must_fix / should_fix 两档，因为 Subagent C 做的是**客观事实核对**（落地/未落地是二元事实），
不像 A/B 维度做主观质量分级。它与统一档位的对应关系：

| 本文档档位 | 对应统一档位 | 含义 |
|-----------|-------------|------|
| must_fix | MUST_FIX | plan 声明的 change 未落地，客观缺失 |
| should_fix | SUGGESTION | plan 设计有改进空间（范围/依赖），不阻塞 |

聚合器（review-aggregator.md）合并报告时，must_fix 计入 MUST_FIX 总数，should_fix 计入 SUGGESTION 总数。

---

## 输出格式

Subagent C 的核对结果记入编排器指定的维度报告路径（如 .review/run-<runId>/plan-completeness.md），按下面的"plan 落地率核对"段格式：

```markdown
## plan 落地率核对（Subagent C）

### changes 落地率
- 总 changes 数：N
- 已落地：M
- 未落地：K
- **落地率：M/N = XX%**

### 未落地清单（must_fix）
| WorkUnit | change 描述 | 缺失文件 | 严重度 |
|----------|------------|---------|--------|
| wave:auth-w2 | 修改 src/rules/freeze.ts 接入 fileLock | src/rules/freeze.ts 不在实际变更 | must_fix |

### 设计问题清单
| 类型 | WorkUnit | 问题 | 严重度 |
|------|----------|------|--------|
| wave 过大 | wave:auth-w3 | 7 个文件改动，建议拆分 | should_fix |
| 漏依赖 | wave:auth-w2 | 改的文件 import W1 新建文件，但 plan 未体现先后 | should_fix |
```

---

## 分工边界（重要）

本文档**只审 plan 落地率**。以下不在本文档范围：

| 不审的内容 | 谁来审 |
|-----------|--------|
| 代码类型安全、错误处理、边界条件 | Subagent B（读 quality-criteria.md） |
| 项目特定约定（状态机 / Gate / CLI 契约） | Subagent A（读 project-conventions.md） |
| 代码实现质量（即使文件落地了，写得对不对） | Subagent B（文件落地只代表"改了"，不代表"改对了"） |

Subagent C 的边界：**只回答"plan 声明的 changes/files 有没有落地 + plan 设计对不对"**，不回答"落地了但实现质量如何"。

**重叠裁决**：同一缺陷最多被一个维度报告。全局优先级为 **C > A > B**，C（plan 落地）优先级最高——因为 plan 落地是客观事实核对（文件在不在、changes 做没做），最确定。当问题同时符合 C 和 A/B 时归 C。详见 review-aggregator.md 的去重规则。
