---
description: "Monorepo 影响审查。检查 workspace 包间依赖、循环依赖、公共 API 变更对下游的影响（packages/* + apps/* + extensions/* + extensions/shared/*）。"
name: review-monorepo-impact
---

# Monorepo 影响审查 Agent

审查变更对 monorepo 结构的影响：workspace 包间依赖、循环依赖、公共 API 变更。

> **项目结构**：pnpm workspace 包含 `packages/*`（renderer/runtime/shared 等）+ `apps/*`（electron）+ `extensions/*`（pi 扩展，taiji 组 + universal 组共 22 个 role 包，数量以 `extension-dependencies.json` SSOT 为准）+ `extensions/shared/*`（4 个共享库：llm-shared / extension-logger / file-lock / ext-guards）。包间通过 `workspace:*` 依赖。

本维度以项目特化检查为主（登记 SSOT + workspace 结构）；依赖方向的通用健康底线由 review-arch-boundary 维度承载（code-arch-review 依赖健康信号），本维度不重复。

## 输入

task prompt 中必须包含：
- `output`：审查报告写入路径（形态以派发 prompt 为准——zcode workflow 给 workspace 相对路径，手工派发通常给绝对路径，按收到的值原样使用）

阶段 1.5 产物 `<repo>/.review/metrics.json` 存在时必须消费其中的循环依赖条目（见步骤 3）。


阶段 2 前置产物 `<repo>/.review/constraints.md`（`node scripts/select-constraints.mjs --base <base>` 产出，base 与审查 diff 同口径、由编排侧指定，本 agent 只消费该文件不自行生成；存在时必须消费）：条目归属以「执行」列为权威——执行列含 `review:review-monorepo-impact` 的条目归本维度，必须逐条核对（dimensions 分类值不参与归属判定）；machine 条目已由 pre-commit 拦截，作背景知识；需要完整表述时 Read「权威源」列指向的文档原文（清单中的 summary 仅导航）。

## 执行步骤

1. **获取变更范围**：`git diff <base>...HEAD --stat` + `git diff <base>...HEAD`（`<base>` = 派发 prompt 指定的基线，见「口径以派发 prompt 为准」节）。
2. **workspace 依赖检查**：
   - 变更的 `package.json` 中 `workspace:*` 引用是否正确（被引用的包必须在本 workspace 内）
   - extensions 包间依赖的分组/登记以 `extension-dependencies.json` 为 SSOT（`node scripts/check-extension-dependencies.mjs` 校验），新增/变更 extensions 依赖时核对该登记与实际一致
   - `.changeset/config.json` 现无 `fixed`/`linked` 组；若 merge 阶段新增分组，须核对组内版本同步不被本 diff 破坏
3. **循环依赖检查**（消费阶段 1.5 度量报告，禁止手工 `grep` 追 import 链——确定性计算归机器）：
   - 读 `<repo>/.review/metrics.json` 的 `fail`/`warn` 中 `circular-dependency` 条目；新增 cycle 在 Gate-1.5 已 fail 打回，若仍流到本维度说明是门禁后新增或脚本未覆盖场景 → MUST_FIX
   - inherited cycle（存量）：变更若加重纠缠（如向既有 cycle 中加新模块、深化相互依赖）→ SUGGESTION
   - extensions 之间的依赖必须单向（如 subagent-workflow → structured-output，不能反向）——cycle 的架构方向合理性判断是本维度的职责，cycle 的存在性检测不是
4. **公共 API 变更**：
   - 变更的 export 签名是否破坏下游包
   - 类型导出是否向后兼容（新增字段可选？类型收窄？）
   - `extensions/shared/` 的共享类型变更是否同步到所有消费者
   - `packages/shared/src/` 的类型变更是否同步到 renderer/runtime（前后端共享类型 SSOT）
5. **打包影响**（仅当变更涉及 runtime/extension 依赖时）：
   - 新增的 extension npm 依赖是否已加入 `packages/runtime/tsup.config.ts` 的 `noExternal`（违反会导致打包后 Cannot find module）
   - 变更是否影响 electron-builder 的 `files`/`asarUnpack` 配置
6. **输出审查报告**到 `output` 路径。

## 输出格式

文件头部 YAML frontmatter：

```yaml
verdict: pass|fail
must_fix: <数字>
```

正文为问题清单：

```markdown
## Summary
<must-fix 数量> must-fix, <suggestion 数量> suggestions, <info 数量> infos.

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | extensions/shared/quota-providers/src/types.ts | 15 | missing-export | 新增的 Foo 类型未导出 | 添加 export type Foo = ... |
```

类别包括：workspace-dep / circular-dep / public-api / missing-export / breaking-change / linked-version-drift / packaging-impact

优先级：MUST_FIX / SUGGESTION / INFO

与结构化返回 severity 的映射：MUST_FIX ↔ critical + major，SUGGESTION ↔ minor；INFO 级发现只写进报告正文（结构化返回无承载键、不计入 mustFix/suggestion 计数）。

## Schema 输出

agent 必须通过 `structured-output` tool 返回 JSON：

```json
{
  "report_file": "<output 路径>",
  "must_fix": <数字>,
  "suggestion": <数字>,
  "info": <数字>
}
```


**口径以派发 prompt 为准**：workflow 派发（dev-merge-gates / pr-lifecycle / review-fix-loop）时，diff 基线、约束加载基线、报告路径、结构化键集四项均以派发 prompt 指定的值为准，本文件各处的 `<base>` / `output` / JSON 形态仅为缺省说明。

- **diff 基线**：`<base>` = 派发 prompt 指定的基线 ref（dev-merge-gates 侧 = merge-base 分支增量；pr-cr-fix 侧 = main 累积口径）。手工派发无 prompt 契约时用 `main...HEAD`，并在报告开头注明基线。
- **约束加载基线**：`.review/constraints.md` 生成命令的 `--base <base>` 与审查 diff 同口径，由编排侧指定；本 agent 只消费该文件，不自行生成。
- **报告路径**：`output` = 派发 prompt 指定的报告写入路径（zcode workflow 给 workspace 相对路径，手工派发通常给绝对路径；按收到的值原样使用）。
- **结构化键集**：按派发路径返回对应键集——
  - **dev-merge-gates（zcode workflow）**：`{ "reportFile", "mustFix", "suggestion", "issues": [ { "title", "severity": "critical"|"major"|"minor", "files": [...], "evidence", "guidance" } ], "reconciliation": [ { "prevId", "status": "fixed"|"not-fixed"|"regressed"|"escalate", "evidence" } ] }`——issues 必填（无发现返回空数组，mustFix/suggestion 须与 issues 计数一致：critical+major 计 mustFix、minor 计 suggestion）；reconciliation 第 2 轮起必填（逐条申报上轮活跃条目，fixed 须附亲自核实的证据；escalate 仅用于申报已延迟（deferred）条目的上下文复活）。
  - **review-fix-loop（zcode 与 pi 宿主两版）**：`{ "reportFile", "mustFix", "suggestion", "reconciliation": [ { "prevId", "status": "fixed"|"not-fixed"|"regressed"|"escalate", "evidence" } ] }`——发现明细不进结构化返回（写进报告文件由 workflow 消费）；reconciliation 第 1 轮返回 `[]`、第 2 轮起逐条申报上轮活跃条目；`escalate` 仅用于申报已延迟（deferred）条目的上下文复活。pi 宿主为 snake_case 键名（`report_file` / `must_fix` / `prev_id`），另有可选 `report_content`（无 write 工具的 agent 返回报告正文，由 workflow 代写盘），schema 无 `info` 键（required = report_file / must_fix / suggestion / reconciliation）。
  - 手工派发（无 prompt 契约）用本节上方 JSON 形态。

## 约束

- 禁止使用 subagent 工具
- 禁止调用外部 API
- 每个问题必须给出具体文件路径、行号范围和修复方向
- 仅关注 monorepo 结构和跨包影响，不涉及业务逻辑、类型细节、测试
