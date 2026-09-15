---
description: "项目约定审查（维度 A）。审查 CW 引擎特有约定：状态机正确性 / Gate 完备性 / 引擎类型边界 / CLI 契约。只在 src/ 有改动时适用。"
name: project-conventions
---

# 项目约定审查标准（Subagent A 用）

## 目的

本文档是 CW（coding-workflow）的**项目特定约定审查标准**，供 review 阶段的 Subagent A 使用。

定义 CW 引擎自身必须遵守的工程约定——状态机正确性、Gate 完备性、引擎层类型边界、CLI 契约。
这些约定是「这个项目（纯 TypeScript CLI 引擎）」特有的，换一个项目就不适用，因此与语言通用质量
（quality-criteria.md）分开。

## 适用场景

- 只在审查 **coding-workflow 自身源码**（`src/`）时启用
- 审查的项目特定约定分 4 个子维度：状态机正确性 / Gate 完备性 / 引擎层类型边界 / CLI 契约
- 判定结果分三档：**MUST_FIX / SUGGESTION / INFO**

## 判定档位语义

| 档位 | 含义 | 处理 |
|------|------|------|
| MUST_FIX | 违反引擎核心不变式（状态机失守、Gate 弱化、契约破裂），会导致流程崩坏或机器检查失效 | 记入 report，阻塞通过，必须先修 |
| SUGGESTION | 有改进空间但不阻塞（如 nextAction 文案不全、错误消息缺修正指引） | 记入 report，建议修，不阻塞 |
| INFO | 仅提示（如新增 gate 建议补 e2e、命名与既有风格不一致） | 记入 report，可选 |

档位由「最严重的问题」决定：出现一个 MUST_FIX 级缺陷 → 该子维度记 MUST_FIX；只有 SUGGESTION 级 → 记 SUGGESTION；全无问题 → pass（不列条目）。

---

## 子维度 1：状态机正确性

### 定义

状态机是 CW 的核心，转换规则错误会导致整个流程崩坏。本子维度审 `src/rules/state-machine.ts` 的两张转换表 + 两个单重 guard + 各 action 的语义完整性。

### 核心文件

- `src/rules/state-machine.ts`（WAVE_TRANSITIONS / PLANNING_TRANSITIONS / guardWave / guardPlanning）
- `src/dispatch.ts`（guard → handler 路由）

### MUST_FIX 标准

- **新增/修改 Action 未同步转换表**：`src/core/workunit.ts` 的 action 联合新增成员时，`WAVE_TRANSITIONS`（wave 专属 action）或 `PLANNING_TRANSITIONS`（planning action）必须同步添加对应转换。遗漏会导致 `guardWave`/`guardPlanning` 查表返回 undefined → 抛 `illegal_transition`
- **guard 未覆盖**：dispatch 路径上每个 advance action 流转前必须经过对应 guard（wave 走 `guardWave`，planning 走 `guardPlanning`）。绕过 guard = 状态机失守
- **wave 专属 action 泄漏到 planning**：`test` / `exec-review` 是 wave 专属，PlanningUnit 收到必须抛 `illegal_transition`。若 PLANNING_TRANSITIONS 误加了这两个 action → MUST_FIX
- **replan append-only 破坏**：replan 是唯一旁路 action（不改 status），确认其「已 committed 的子 unit 不可改、只级联 abort」的约束（`src/rules/replan.ts`）没被破坏
- **nextAction 不完整**：各 handler 返回的 `nextAction`（`src/handlers/types.ts` CwNextAction）必须给出合法下一步 action + guidance。新增 action 时，所有前置状态的 nextAction 都要指向它

### SUGGESTION 标准

- guard 的错误消息（CwEngineError 的 reason）未说明「当前 status / 期望 action / 合法后继」，调试困难
- progressive action（design / design-review）的多次调用语义在转换表注释里未说明

### 示例

```typescript
// MUST_FIX：新增 action 'foo' 但忘了加转换表项
export const WAVE_TRANSITIONS = {
  // ... 缺 foo → guardWave 查表返回 undefined
};

// pass：wave 专属 action 不进 PLANNING_TRANSITIONS
// test 只在 WAVE_TRANSITIONS，PlanningUnit 调 test → guardPlanning 抛 illegal_transition
```

---

## 子维度 2：Gate 完备性

### 定义

Gate 是 CW 的核心价值（机器检查门，防 AI 谎报）。本子维度审 `src/rules/gates/` 下各 gate 是否覆盖关键不变式、结果是否完整记录、外部命令是否安全。

### 核心文件

- `src/rules/gates/test.ts`（commitExists / testsAllPass / testReferencesDesignReview / testCasesExecuted）
- `src/rules/gates/design-review.ts`（testCasesNonEmpty / testCasesHaveExpected / designReview* 系列）
- `src/rules/gates/exec-review.ts`（execReview* 系列）
- `src/rules/gates/retrospect.ts`（lessonsLearnedNonEmpty / allWavesClosed / splitFulfillmentCoversPlan 等）
- `src/rules/freeze.ts`（checkFreeze / checkFreezePlanning / checkFreezeFeatureSpec，closeout 冻结校验）

### MUST_FIX 标准

- **新增 gate 未接入 handler**：`src/rules/gates/*.ts` 新增具名 check 函数时，对应 handler 必须调用它。写了 check 但没接 = 检查形同虚设
- **gate 结果未写 statusHistory**：每次 gate 执行（pass/fail）的结果必须 append 到 unit 的 `statusHistory`（`src/core/status.ts` StatusChange，含 fail 记录）。遗漏记录 = 审计断链，closeout 回溯失真
- **关键检查被弱化**：
  - `commitExists`（`test.ts:44`）校验 commitHash 非空 + `git cat-file -e` 存在性（IO 由 handler 注入，gate 零 IO）——改校验逻辑时确认「commitHash 非空 + commit 存在于 repo」的语义没变
  - `testsAllPass`（`test.ts:79`）判定 `testRunResult.passed=true`（fail 数=0）；测试由 cli.ts 用 `spawnSync` 执行（per-wave testCommand），结果解析后传入 gate，gate 零 IO。任何「测试失败也当 pass」的改动 = MUST_FIX
  - `testCasesExecuted` / `testReferencesDesignReview`（`test.ts:117` / `:212`）做精确匹配。若改匹配逻辑（加 trim/substring 容差），破坏「防 AI 谎报」设计意图 → MUST_FIX
- **freeze 校验绕过**：`checkFreeze`（`freeze.ts:141`）在 closeout 时校验 artifacts drift + 冻结 evidence（frozenAt）。任何跳过 freeze 检查的改动 → MUST_FIX
- **测试命令执行安全**：cli.ts:736 用 `spawnSync(testCommand, {shell:true})` 执行 per-wave testCommand（agent 撰写）。审查命令注入风险应聚焦此处 + `guardTestCommand`（cli.ts:672）的空白短路守卫，确认 testCommand 非纯空白才放行 spawn

### SUGGESTION 标准

- gate fail 的 guidance 未给「如何修正」指引（应指向具体缺失字段或失败断言）
- 新增 gate 未补对应 `*.test.ts`（见 quality-criteria.md 测试有效性，但项目约定层面也提示）

### 示例

```typescript
// MUST_FIX：gate 结果没写 statusHistory
const result = commitExists(unit, deps);
// 缺：store.appendStatusHistory(unit, { action: "test", gateResult: result });

// pass：testCommand 非纯空白才 spawn（guardTestCommand 空白短路守卫），shell:true 执行 per-wave 命令
guardTestCommand(unit.plan.testCommand); // 空白短路返回，不 spawn
const r = spawnSync(unit.plan.testCommand.trim(), { shell: true });
```

---

## 子维度 3：引擎层类型边界

### 定义

CW 是强类型 TypeScript 引擎，schema 是外部输入的契约边界。本子维度审引擎层特有的类型约定：
禁 any、两种错误类的边界、schema 校验、import type 防循环。

> 说明：通用的「类型安全 / 错误处理 / 边界条件」范式审查归 quality-criteria.md（Subagent B）。
> 本子维度只审 CW 引擎特有的约定：CwError vs CwEngineError 的边界、store schema 契约、
> 引擎层禁止 any 的项目硬规则。

### 核心文件

- `src/core/errors.ts`（CwError，exit 1 预期错误）
- `src/dispatch.ts`（CwEngineError:102，guard fail / unit not found）
- `src/store/schema.ts`（encodeCwd / CwJsonFile schema）

### MUST_FIX 标准

- **CwError vs CwEngineError 边界错位**：
  - `CwError`（`errors.ts:8`）= 预期错误（参数缺失、JSON 解析失败、action unknown），CLI 映射 exit 1
  - `CwEngineError`（`dispatch.ts:102`）= guard fail（illegal_transition）/ unit not found，CLI 映射 exit 1，不可恢复
  - 普通 `Error` = 内部异常（不变式违反、lock 失败），CLI 映射 exit 2
  - 新增 throw 时分类错误（如把 guard fail 抛成普通 Error → 误判 exit 2）→ MUST_FIX
- **store schema 绕过**：`store.json` 是外部输入（`~/.cw/<encodedCwd>/store.json`），必须经 `src/store/schema.ts` 校验。新增 WorkUnit 字段时必须同步更新 schema，否则外部输入绕过类型检查
- **encodeCwd 不一致**：`encodeCwd`（`schema.ts:85`）把 `/` 和 `\` 都映射为 `__`。改编码规则时必须同步 `decodeCwd`（`schema.ts:98`）和 store 路径定位逻辑，否则找不到 store
- **引擎层出现 any**：项目硬规则禁止 `any`（用 `unknown` 或具体类型）。引擎层（`src/core/`、`src/dispatch.ts`、`src/rules/`、`src/store/`）出现裸 `any` 且无注释 → MUST_FIX

### SUGGESTION 标准

- 跨模块纯类型引用未用 `import type`（如 `src/types.ts` 反引 CwStore/GitValidator），可能把循环依赖打进运行时
- schema 校验失败的错误消息未含「期望字段 / 实际值」

### 示例

```typescript
// MUST_FIX：guard fail 抛成了普通 Error，exit code 误判
if (!unit) throw new Error("unit not found"); // 应抛 CwEngineError → exit 1，非 exit 2

// pass：分类正确
throw new CwEngineError("unit_not_found", `unit not found: ${params.unitId}`);
throw new CwError("execute 需要 --commitHash");
```

---

## 子维度 4：CLI 契约

### 定义

CLI 是 agent 与引擎的唯一接口（agent 通过 bash 调 cw）。本子维度审 exit code 映射、dispatch 纯函数性、参数解析、错误消息可读性。

### 核心文件

- `src/cli.ts`（argv 解析 / buildParams / exit code 映射）
- `src/dispatch.ts`（platform-agnostic 纯函数入口）

### MUST_FIX 标准

- **exit code 映射错误**：`cli.ts` 的退出码语义——
  - `0` = 正常（含 gate fail，结果在 stdout JSON）
  - `1` = CwError / CwEngineError / 参数错误（guard fail、unit not found）
  - `2` = 未预期的内部异常（普通 Error 兜底）
  - 新增错误类型或改 `mapExitCode` 时破坏此映射 → MUST_FIX
- **dispatch 引入 agent 特定依赖**：`dispatch.ts` 是 platform-agnostic 纯函数（`(params, deps) => ActionResult`）。新增逻辑引入 pi / claude-code / 特定 harness runtime 依赖 → MUST_FIX（破坏 agent-agnostic 设计）
- **参数解析不透传**：`cli.ts` 用 argv 解析（`buildParams`）。新增参数时若透传到 dispatch 的路径断裂（参数在 cli 层丢了没进 CwParams）→ MUST_FIX
- **只读命令误写 store**：`tree` / `status` / `list` / `handoff` / `frontier`（`READONLY_QUERIES`，`cli.ts:166`）不经 dispatch、不写 store、不 append statusHistory。若误改成走 dispatch 写 store → MUST_FIX

### SUGGESTION 标准

- 错误消息缺「如何修正」指引（CLI 面向人类 + agent，应含 "expected field X, got: ..." 而非只报「失败」）
- 新增参数未同步 `--help` 输出

### 示例

```typescript
// MUST_FIX：dispatch 直接 import 了 harness runtime
import { piAgent } from "some-harness"; // 引擎层禁止 agent 特定依赖

// pass：dispatch 是纯函数，依赖通过 CwDeps 注入
export function dispatch(params: CwParams, deps: CwDeps): ActionResult { ... }
```

---

## 分工边界（重要）

本文档**只审 coding-workflow 项目特有的约定**（状态机 / Gate / 引擎类型边界 / CLI 契约）。以下不在本文档范围：

| 不审的内容 | 谁来审 |
|-----------|--------|
| 通用类型安全（any/as 断言的范式判定）、通用错误处理（try/catch 完整性）、通用边界条件、测试有效性 | Subagent B（读 quality-criteria.md） |
| plan 声明的 changes/files 是否落地（落地率核对） | Subagent C（读 plan-completeness.md） |
| 通用代码风格、命名规范（camelCase 等） | Subagent B |

### 重叠处理

- **CwError vs CwEngineError 边界**：归本文档（Subagent A），因为它是 CW 引擎特有的错误分类约定
- **通用 try/catch 完整性**（某处裸 await 无错误处理）：归 quality-criteria.md（Subagent B）
- **gate 检查的测试覆盖**：项目约定层面（gate 是否接 handler）归本文档；测试断言是否具体归 quality-criteria.md

**重叠裁决**：同一缺陷最多被一个维度报告。全局优先级为 **C（plan 落地）> A（项目约定）> B（通用质量）**。当问题同时符合 A 和 B 时（如引擎层裸 any 既是项目硬规则又是通用类型安全问题），归 A（项目特定优先于通用）；当问题同时符合 A 和 C 时归 C。详见 review-aggregator.md 的去重规则。
