# ADR-0001: workflow 与 subagent 资源暴露机制重构

**状态**: Proposed
**日期**: 2026-08-08
**关联**: 竞品调研（opencode / codex / claude-code）、ADR-030（分层配额）、ADR-031（统一资源发现）、AGENTS.md「派发提示词三段式」

## 背景

本包（`@zhushanwen/pi-subagent-workflow`）内 subagent（任务委派）与 workflow（多 agent 编排）两子系统共享资源发现机制（ADR-031 `resource-discovery.ts`），但暴露给主 agent 的机制分叉，且质量不对等。

### 内部四维诊断

| 维度 | subagent | workflow |
|---|---|---|
| **发现层**（system prompt） | 只注入 `name + description`（frontmatter 单行）✅ | 把整个 `meta.description`（review-fix-loop ~400 字参数说明）塞进 `available_workflows` ❌ |
| **加载层**（按需查契约） | 正文 spawn 时注入子进程，主 agent 不持有 ✅ | **无**——只能看 description 散文或读 `.js` 源码反推 ❌ |
| **校验** | 统一 TypeBox schema（`SubagentParams`）✅ | `$ARGS` 纯透传零校验（`worker-script-builder.ts:103`），各脚本自写 `normalizeInt`/`fail` ❌ |
| **隐式契约** | task 格式靠 description 软传达 | 参数约束靠 description 散文 + `workflows/README.md` 表格，双 SSOT ❌ |

### 竞品调研结论（关键修正）

调研 opencode / codex / claude-code 三家 subagent 机制。**核心结论：四家（含 pi-subagent）趋同于「两段式」，不是「三段式」。**

| | ① 发现 | ② 主动加载层（委派前查契约） | ③ spawn 注入执行 | ④ 引擎统一校验 |
|---|---|---|---|---|
| **skill** | name+desc | **✅ read SKILL.md** | — | — |
| opencode subagent | name+desc | ❌ | ✅ | ✅ 统一 schema |
| codex subagent | name+desc+locked | ❌ | ✅ config layer | ✅ 统一 + `deny_unknown_fields` |
| claude-code subagent | desc+`<example>` | ❌ | ✅ 正文 | ✅ 统一 + `validate-agent.sh` |
| pi-subagent | name+desc | ❌ | ✅ 正文 | ✅ 统一 schema |
| **pi-workflow** | ❌ 400字臃肿 | ❌ | — | ❌ 各自写 |

真正有「主动加载层」（主 agent 委派前查契约）的只有 skill。三家竞品 subagent 都没有，且工作良好。**没有任何一家用 per-agent / per-workflow 自定义参数 schema**——差异全部收敛成「统一固定 schema + 配置差异」。

> **本 ADR 初稿曾误将此格局归纳为"四家趋同三段式"，把 subagent 的「spawn 时按需注入」（自动）误当成了「主 agent 主动查契约的加载层」（skill 式）。经复核纠正：竞品 subagent 是两段式。这个修正直接决定了 workflow 与 subagent 必须用不同的优化路径。**

## 决策

两子系统本质不同——**workflow 输入是结构化参数，subagent 输入是自由文本 task**——不套统一框架，分别论证。

### 决策 A：workflow 重构（第一性原理推导，独立于竞品）

**根因：workflow 的本质是「结构化参数 + 固定编排」。** 结构化参数是它一切暴露问题的单一根因，推出三个必然结论：

1. **参数契约必须可被查** → 主 agent 不看 schema 就无法正确调用 → 加载层必然存在
2. **参数必须被校验** → 结构化参数传错会 fail 或行为错误 → 引擎层声明式校验必然
3. **参数说明不能塞发现层** → system prompt 是所有 turn 的固定成本，塞满参数是纯浪费 → 发现层瘦身必然

这三点不是三个独立决策，是同一根因的三个必然推论。**workflow 的方案不借鉴任何竞品**——竞品没有 workflow 这种带 per-workflow 结构化参数的东西。方案与 skill 同构，是两者面对相同经济学问题（结构化契约 + 稀缺 context）得出相同解，**非借鉴**。

**方案**：
- 发现层瘦身：`available_workflows` 只保留 name + 一句话职责，参数移出
- meta 声明 `parameters`（JSON Schema draft-07）+ `usage`（markdown 语义说明）
- 引擎层 ajv 校验 `$ARGS`，fail-fast，错误回带 schema
- `workflow info` action 按需返回 `{ parameters, usage }`

### 决策 B：subagent 优化（参考竞品）

**pi-subagent 已符合两段式范式**（发现 + spawn 注入 + 统一校验），骨架健康。优化方向是**在范式内补齐发现层质量差距**：

- **发现层增强**：借鉴 claude-code `<example>` + `<commentary>` 触发教学样本（context→user→assistant→commentary 四元组），把"何时该用/不该用"做成主 agent 可学习样本，提升路由准确率。pi-subagent 当前发现层是四家里最弱的（单行、无强制、路由信息最少）。
- **放宽单行 description 限制**：当前 `parseAgentFrontmatter` 只支持单行 `key: value`（block scalar 不支持），反向激励 description 过简。
- **校验层顺手增强**：借鉴 codex `deny_unknown_fields`，未知参数报错防幻觉。校验层已与竞品持平，仅此小优化。

**不加加载层（撤销本 ADR 初稿的设计）。** 根因：subagent 输入是**自由文本 task**，不是结构化参数——没有"参数 schema"需要查。主 agent 凭对任务的理解 + description 就能写 task。四家竞品 subagent 全无加载层且工作良好，验证了这一点。给 subagent 加加载层，是把 workflow 的解法错套到 subagent 上。

**task 格式问题归位**：AGENTS.md「派发提示词三段式」表明 task 期望格式是隐式契约，但**契约的负担应在消费者侧（子 agent 正文鲁棒处理各种 task），而非生产者侧（主 agent 记住格式）**。「三段式」是人定规范把负担压错了位置。正解：靠 description 传达 task 期望 + 让子 agent 正文鲁棒，不加加载层。

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| **subagent 加载层**（`subagent info` 返回 taskGuide）| 违反自由文本输入本质。竞品四家验证：subagent 不需要加载层。把 workflow 的解法错套到 subagent |
| **三段式统一框架**（初稿错误）| 抹平 workflow/subagent 本质差异——前者结构化参数必然要加载层，后者自由文本必然不需要。用同一框架一刀切是归纳错误 |
| **动态工具注册**（每 workflow 一个工具，inputSchema = parameters）| 工具列表膨胀；动态 workflow 变化需重注册；过度工程 |
| **纯 prompt 引导**（description 写"调用前必看"）| 软约束，agent 不看——当前状态已失效。事故证据：description 已提参数名，agent 仍读源码 |
| **description 补约束**（不动机制，只把约束写进 description）| 治标：review-fix-loop 已 400 字，补全到 600+；文字约束 LLM 解析不可靠、无 runtime 校验 |

## 取舍边界

1. **JSON Schema 管结构性约束，跨字段语义约束留代码**。review-fix-loop 的「agents 与 batchN 互斥」「fallow-scan 仅 git-diff 合法」超出 JSON Schema 表达力，留脚本 `fail()` + `usage` 文字。schema 把能机器化的机器化（消除 ~80% 传错），语义约束靠代码。不要用 `oneOf` 嵌套硬塞语义约束。

2. **workflow 必须有 per-workflow parameters schema**（结构化参数本质）。**subagent 不加参数 schema**（自由文本本质）。两者差异是本质的，不能为"统一"而抹平。

3. **enum 必须下沉 schema**。opencode / codex 把 subagent_type 做成自由 String（合法清单未下沉 enum），导致幻觉名运行时才发现——反面教材。workflow parameters 用 enum 约束可选值。

4. **workflow 与 skill 同构非借鉴**。推导路径是第一性原理（结构化参数根因 + context 经济学 + 声明优于命令），得出与 skill 相似的形态是同问题同解。

## 强制机制（解决「agent 不看」）

workflow 的核心约束力在**执行层**：发现层引导「先 info」是软约束（agent 可能跳过）；加载层 `info` 是自然约束（不查就没契约）；**引擎校验是硬约束**——就算 agent 跳过 info 直接 run 瞎猜 args，校验必然拦截，错误回带完整 schema，被迫按 schema 重试。对比现状「瞎猜 → 读源码 → 继续瞎猜」，新机制是「瞎猜 → 被拦 → 看 schema → 按重试」。

## 影响

要点：

- **workflow**：meta 扩展 parameters+usage、`workflow info` action、引擎 ajv 校验、review-fix-loop 首个迁移示范、`findFlattenedArgKeys` 补丁下线
- **subagent**：frontmatter 支持触发样本、放宽单行限制、`deny_unknown_fields`。无加载层改动
- 两子系统改动完全解耦，可独立上线
