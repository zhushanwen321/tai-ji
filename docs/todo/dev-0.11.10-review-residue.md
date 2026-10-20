# dev-0.11.10 合入点横切审查 minor 残余（feat-session-compaction 分支）

状态：未解决（2026-10-20 dev-merge 合入点横切审查登记；全部 minor 级，不阻塞合并，终局 PR 期复核裁决补修或关闭）

## 背景

feat-session-compaction 分支（session-archive 设计包交付：归档契约层 / ArchiveService 三操作 / 摘要提取 / 自愈 / RPC 接线 / renderer 摘要视图 / 归档搜索 + state-machine 基建包五域迁移）合入 dev-0.11.10 前，经 dev-merge-gates workflow 六维横切审查（business-logic / arch-boundary / data-governance 恒派 + electron-build / monorepo-impact / extension-api 触发全命中）。审查对象 = `git diff 7257772716...HEAD`（分支增量 165+ 文件）。

审查运行记录：zcode workflow run `dwfrun-8d9d11d1`（base `7257772716`），聚合产物 `~/.agents/skill-data/dev-merge/feat-session-compaction-829a73e3/dmg-a0a99d6b6/ledger.json`。轮次结论：

- round 1 = 5 must-fix + 8 minor（13 条全 evidence；must-fix 与 13 条全量修复并提交，`da5bfbfc5`..`9782490f5` 共 8 笔 + changeset 起草 `a0a99d6b6`）
- round 2 = 2 must-fix + 2 minor（4 条全 evidence；round-1 修复 13/13 对账核实 fixed；round-2 修复并提交 `67d874835`..`2deafbb82` 共 4 笔）
- round 3 = 0 must-fix + 4 minor（对账全部闭合，converged）

质量门：quality-gates 全绿（typecheck 四处 / coverage 增量 + 盲区 / metrics）；pi-extension-smoke 22 入口全绿；changeset WARN 起草 4 文件（session-reader 归档摘要视图 1 + branch-review 补登记 3）。

修复组文件清单越权 WARN 核对（6 条 disclosure）：全部为 fixer 申报原文中显式列出的伴随文件（测试 / docs / changeset / formula-sync 脚本），非越权改动——WARN 源于聚合分组清单粒度窄于申报，逐条对照 fix 申报记录核实无业务文件越界。

## 残余清单（round-3 全 minor，未派发修复）

| ID | 维度 | 位置 | 问题 | 修复方向 |
|----|------|------|------|---------|
| dmg-r3-1 | data-governance | `packages/subagent-core/src/execution/persistence/record-store-rounds.ts` (:204/:221/:257/:329) | 正文注释仍把已退场的 `.state` 收条描述为现行写点，与同文件 :265 退场注释自相矛盾（`2deafbb82` 修复只覆盖 constraints.json summary 与头注释，正文长尾漏改） | 正文四处随 `2deafbb82` 的终态表述同步改写（终局由事件帧承载、磁盘写面 = 事件追加 + binding/manifest writeSync） |
| dmg-r3-2 | arch-boundary | `packages/renderer/src/composables/features/sidebar/useSidebarSessionActions.ts` (:107 定义 / :307 导出 / :43/:66 依赖) | 删除入口迁移归档列表后的死导出链：`onDeleteSession` 全仓零调用点，`options.deleteSession` 必选依赖唯一消费点 = 该死函数体 | 删 `onDeleteSession` + `deleteSession` 依赖降级为可选或移除；核对两测试文件的间接引用 |
| dmg-r3-3 | electron-build | `.github/workflows/ci.yml`、`packages/mobile-renderer/src/shell/app-runtime.ts` | `SessionApiPort` 新增必选成员 `archive` 属接口 breaking 变更，mobile-renderer 实现方在 CI 全 workflows 零 typecheck 覆盖——未来同类端口变更漏改移动壳时 CI 全绿合入、运行时才爆 | ci.yml 补 mobile-renderer typecheck step（本地 quality-gates 已覆盖四处 typecheck，CI 对齐） |
| dmg-r3-4 | data-governance | `packages/renderer/src/composables/features/sidebar/useArchiveView.ts` | `refreshArchives` 手写 in-flight 去重（模块级 `refreshInFlight` + `refreshPending` + do/while trailing 补拉），违反 `createInflightDedup` 收编禁令（C-data-18）且无豁免登记 | 收编进 `createInflightDedup` 单点（核对 trailing 补拉语义是否为该工具已覆盖形态；不覆盖则补工具能力而非留双轨） |
