# e2e-visual shell-default 像素基线过期（Landing 态整页 diff 红）

- 状态：未解决（待裁决——是否按当前 Landing 视觉刷新基线属产品视觉预期判断，非机器可判）
- 发现时点：2026-10-07 B2 subagent-stream-chunk D3 验收 A7（E2E-VISUAL-01，`npx playwright test --project=visual-chromium`）
- 症状：`e2e/visual/shell.spec.ts:13 shell-default: AppShell Landing 态整页` 像素 diff 失败；同 spec 的 composer 用例与 electron-smoke 10 用例全绿
- 归属判定：分支遗留，非 B2 引入。依据：基线 PNG 最后更新 = 63ec39056（neutral default-mode chip 刷新），其后的分支 UI 提交含多处 Landing 可见改动（132803b43/9ef50106d scheduler overlay 整合、363b4a6a4/5a9b2ccf7 插件 modal 链退役、composer perf 系）；B2 范围（4bc83d6d6..749bef6fb）的 ui/renderer 改动仅为流式内部接线与 ESLint 自动修复，无 Landing 可见面
- 处置选项：① 若当前 Landing 视觉为新预期 → `npx playwright test e2e/visual/shell.spec.ts --update-snapshots` 刷新基线随裁决提交；② 若为回归 → 回溯 63ec39056..HEAD 的 UI 提交定位引入点
- 关联：ui-redesign 设计线收尾状态见会话记忆（demo 对账 8 笔提交收口；定时任务 overlay 整合 + 插件 modal 链退役已完成）
