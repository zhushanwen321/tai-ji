# ADR-032: 内置通用编排 workflow（推翻 ADR-030 D-031）

## Status: Accepted

## Context

ADR-030 决策 3 提到"workflow 嵌套编排（chain/parallel/scatter-gather/map-reduce）"，配套的 D-031（`.taiji-harness/swf-scripts-docs-adr/decisions.md`）决定预制脚本为**纯参考模板**（用户复制修改），理由是"workflow 脚本是 JS 代码，参数化会让模板复杂化；用户复制后自由修改更灵活"。脚本放在 `extensions/subagent-workflow/examples/`，文件名 `*.example.js`，通过 `package.json` `files` 字段随 npm 包发布。

实际使用中发现 D-031 的"参考模板"定位存在两个结构性问题，导致"降低使用门槛"的目标（ADR-030 Consequences 正面）未达成：

### 问题 1：tool 完全发现不了

`examples/` 目录不在 `resource-discovery.ts` 的任何扫描路径上（`buildScanTargets` 覆盖 `~/.pi/agent/workflows/`、npm 包的 `workflows/` 约定目录或 `pi.workflows` manifest、project `.pi/workflows/` 等），且 `package.json` 的 `pi` manifest 没有 `pi.workflows` 字段。结果：`workflow list` 看不到这 4 个脚本，`workflow run chain` 返回 `not found`。模板虽然随包发布，对 discovery 是隐形的。

### 问题 2：模板依赖的子 workflow 全部不存在

4 个模板通过 `workflow()` 调用了 11 个子 workflow（extract/transform/load/split/process/merge/map/reduce 等），这些子 workflow 均未定义。即使复制模板到 `.pi/workflows/`，`workflow run chain` 第一步即返回 `Workflow 'extract' not found`。模板不能"复制后直接运行"，必须先自行补全所有子 workflow——这与"降低门槛"相悖。

## Decision

推翻 D-031。把 4 个模板从"参考实现"改为"开箱即用的通用编排 workflow"：

### 1. 目录迁移：`examples/` → `workflows/`，文件 `.example.js` → `.js`

- `workflows/` 是 `resource-discovery.ts` `processPackage` 的约定目录（无 manifest 时 fallback 扫描 `pkgDir/workflows/`），无需声明 `pi.workflows` manifest 即可被 discovery 自动发现
- `meta.name` 与文件名 stem 一致（`chain.js` → `meta.name: "chain"`），避免 stem/name 不一致的去重歧义
- `package.json` `files` 字段 `examples/` → `workflows/`

### 2. 脚本重写：`agent()` 自包含，不再依赖 `workflow()` 嵌套

每个脚本用 `agent()` 直接调 LLM，不通过 `workflow()` 引用不存在的子 workflow：

| workflow | 模式 | 实现要点 |
|----------|------|----------|
| `chain.js` | analyze → transform → synthesize | 3 个串行 agent，每步 schema 结构化输出作下步 prompt 输入 |
| `parallel.js` | 多视角并行 → 聚合 | `parallel()` 跑 N 个 agent（默认 security/performance/maintainability），再一个 agent 汇总 |
| `scatter-gather.js` | scatter 拆分 → parallel 处理 → gather 合并 | 第一个 agent 拆子任务 → `parallel()` 并行处理 → 最后 agent 合并 |
| `map-reduce.js` | parallel map → reduce | `parallel()` 对 items 数组并行变换 → 一个 agent 归约 |

参数保留必需（`task`/`target`/`items`+`operation`），贴合真实通用编排用途而非 demo。

### 3. lintScript 合规

所有脚本遵守：含 `agent()`/`parallel()` 入口、top-level await 无 bare IIFE、不用 `result` 变量名、用 `schema` 不用 `outputSchema`、try-catch 不 crash、`meta.name` = 文件名 stem。

## Consequences

### 正面

- **tool 可发现**：`workflow list` 显示 4 个内置 workflow，`workflow run chain` 直接执行
- **可直接 run**：无需用户复制、无需补全子 workflow，传 task/target/items 参数即跑
- **真正通用**：替代用户日常需要手写的 subagent 编排代码，4 个模式覆盖顺序链/并行扇出/分发收集/映射归约

### 负面

- **不再演示 `workflow()` 嵌套**：循环检测、预算继承、配额分层等嵌套特性的教学价值降低。但这些特性的 API 文档仍由 `skills/workflow-script-format/SKILL.md` 第 121-159 行的 chain/parallel 基础示例承担。
- **workflow list 多 4 个内置脚本**：命名空间增加 4 项。通过 `meta.description` 的"通用编排"前缀与用户自建脚本区分。

### 推翻的决策

- **ADR-030 D-031**（`.taiji-harness/swf-scripts-docs-adr/decisions.md`）：预制脚本为"纯参考模板"。本 ADR 改为"内置通用编排 workflow"。
- **ADR-030 D-032**（同上）：scatter-gather 和 map-reduce 分开为 4 个模板。本 ADR 保留这一决策（4 个 workflow 语义不同，分开更清晰）。

## 参考

- [ADR-030](./pi-ext-030-subagents-workflow-merge.md) — 决策 3（分层配额 + workflow 嵌套）的原始决策
- `.taiji-harness/swf-scripts-docs-adr/decisions.md` — D-031/D-032 原文
- `skills/workflow-script-format/SKILL.md` — workflow script 完整 API（`workflow()` 嵌套教学示例）
