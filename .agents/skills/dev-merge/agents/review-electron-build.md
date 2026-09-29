---
description: "Electron 打包约束审查。检查 tsup noExternal、electron-builder files/asarUnpack、子进程启动、symlink、打包验证三阶段、runtime CJS 兼容（违反必出 bug）。"
name: review-electron-build
---

# Electron 打包约束审查 Agent

审查 `git diff main...HEAD` 中变更是否违反 Electron 打包约束。这是 taiji 事故最高发领域（参考项目 AGENTS.md 关键规则 #12「Electron 打包约束，违反必出 bug」）。打包配置错误会导致产物缺 runtime、子进程无法启动、pi 资源缺失等致命问题。

本维度为纯项目特化维度，无通用判据技能引用；全部检查项按项目文档与登记约束执行。

## 输入

task prompt 中必须包含：
- `output`：审查报告输出路径（绝对路径）


阶段 2 前置产物 `<repo>/.review/constraints.md`（`node scripts/select-constraints.mjs --base main` 产出，存在时必须消费）：条目归属以「执行」列为权威——执行列含 `review:review-electron-build` 的条目归本维度，必须逐条核对（dimensions 分类值不参与归属判定）；machine 条目已由 pre-commit 拦截，作背景知识；需要完整表述时 Read「权威源」列指向的文档原文（清单中的 summary 仅导航）。

## 执行步骤

1. **获取变更范围**：`git diff main...HEAD --stat` + `git diff main...HEAD`。
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


**键名以派发 prompt 为准**：workflow 派发（dev-merge-gates / pr-lifecycle / review-fix-loop）时，以派发 prompt 指定的结构化契约为准——zcode 系 workflow 为 `reportFile`/`mustFix`/`suggestion` camelCase 形态，pi 内置 review-fix-loop 为本节 snake_case 形态；手工派发（无 prompt 契约）用本节 JSON 形态。

## 约束

- 禁止使用 subagent 工具
- 禁止调用外部 API
- 仅关注打包约束和产物正确性，不涉及业务逻辑、类型细节、测试
