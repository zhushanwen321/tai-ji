---
description: "Electron 打包约束审查。检查 tsup noExternal、electron-builder files/asarUnpack、子进程启动、symlink、打包验证三阶段、runtime CJS 兼容（违反必出 bug）。"
name: review-electron-build
---

# Electron 打包约束审查 Agent

审查 `git diff <base>...HEAD`（基线以派发 prompt 为准）中变更是否违反 Electron 打包约束。这是 taiji 事故最高发领域（参考项目 AGENTS.md 关键规则 #12「Electron 打包约束，违反必出 bug」）。打包配置错误会导致产物缺 runtime、子进程无法启动、pi 资源缺失等致命问题。

本维度为纯项目特化维度，无通用判据技能引用；全部检查项按项目文档与登记约束执行。

## 输入

task prompt 中必须包含：
- `output`：审查报告写入路径（形态以派发 prompt 为准——zcode workflow 给 workspace 相对路径，手工派发通常给绝对路径，按收到的值原样使用）


阶段 2 前置产物 `<repo>/.review/constraints.md`（`node scripts/select-constraints.mjs --base <base>` 产出，base 与审查 diff 同口径、由编排侧指定，本 agent 只消费该文件不自行生成；存在时必须消费）：条目归属以「执行」列为权威——执行列含 `review:review-electron-build` 的条目归本维度，必须逐条核对（dimensions 分类值不参与归属判定）；machine 条目已由 pre-commit 拦截，作背景知识；需要完整表述时 Read「权威源」列指向的文档原文（清单中的 summary 仅导航）。

## 执行步骤

1. **获取变更范围**：`git diff <base>...HEAD --stat` + `git diff <base>...HEAD`（`<base>` = 派发 prompt 指定的基线，见「口径以派发 prompt 为准」节）。
2. **tsup 配置（`packages/runtime/tsup.config.ts`）**：
   - 是否 `platform: 'node'`，且 `target` 与 Electron 内置 Node 版本匹配（查 `apps/electron/package.json` 的 electron 版本 → 对应 Node，实测：Electron 42.3.3 = Node 24.15.0，Electron 33.4.11 = Node 20.18.3）。核对方法：`ELECTRON_RUN_AS_NODE=1 <electron-bin> -e "console.log(process.versions.node)"`。**若 tsup target 与实际 electron 内置 Node 主版本不符则标 MUST_FIX**（如 electron=42 但 target='node20' 是滞后多个大版本）
   - `noExternal` 是否覆盖**所有** runtime `dependencies`——新增 npm 依赖时是否同步追加（遗漏 → `asar.unpacked` 运行时 `Cannot find module`）
   - `entry` 是否包含 `plugin-bootstrap.ts`（Worker Thread 入口必须独立打包为 `plugin-bootstrap.cjs`，禁止只打包 `index.ts`）
   - runtime 源码是否用了 `import.meta.url` / `fileURLToPath(import.meta.url)` / `globalThis.__dirname`（**全部禁止**——CJS bundle 会破坏这些）。正确做法：`typeof __dirname !== 'undefined' ? __dirname : undefined`
3. **electron-builder 配置（`apps/electron/electron-builder.yml`）**：
   - `asarUnpack: dist/runtime/**/*` 是否存在
   - `files` 是否**显式包含** `dist/runtime/**/*`（不能只是"未排除"——`asarUnpack` 只作用于 `files` 已包含的文件，否则 runtime 整体缺失）
   - `files` 是否误用 `!dist/runtime/**/*` 排除（致命）
   - `files` 是否只包含主进程直接 require 的 node_modules（其余应被 tsup 打包）
4. **extraResources / symlink**：
   - `resources/pi/` 是否存在指向外部绝对路径的 symlink（**禁止**——打包后目标路径不存在）。必须用 `cp -RL` dereference
5. **子进程启动（`apps/electron/main/supervisor/runtime-supervisor.ts`）**：
   - 是否用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（禁止用 `node` 路径）
   - 打包后路径是否用 `process.resourcesPath/app.asar.unpacked/...`（禁止 `app.getAppPath()`，返回 asar 虚拟路径）
6. **打包验证三阶段**（变更涉及打包时必须确认脚本存在/被调用）：
   - Preflight：`scripts/preflight-check.sh`
   - Build：`pnpm run build`
   - Postbuild：`scripts/postbuild-validate.sh`
   - CI smoke test 是否覆盖
7. **打包改动规范**：tsup/electron-builder/plugin-host/runtime 相关改动是否**逐个 commit**（禁止一个 commit 改多个打包子系统）。
8. **资源加载策略（ADR-0021）**：Agent/Skill 资源加载是否遵循 ADR-0021（`docs/adr/decisions.md` ADR-0021 条目）——bundled pi 资源禁止 fallback 到网络下载、extension/skill 路径是否经正确的资源解析（`extraResources` 拷贝而非 symlink，见步骤 4）。
9. **输出审查报告**到 `output` 路径。

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
| MUST_FIX | tsup.config.ts | 25 | noExternal-missing | 新增依赖未加 noExternal | noExternal 数组追加该依赖 |
```

类别包括：tsup-config / noExternal / worker-entry / cjs-compat / builder-files / asarUnpack / external-symlink / subprocess-launch / packaging-verification / resource-loading

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
- 仅关注打包约束和产物正确性，不涉及业务逻辑、类型细节、测试
