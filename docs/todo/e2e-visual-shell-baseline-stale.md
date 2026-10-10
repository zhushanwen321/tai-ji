# e2e-visual shell-default 像素基线过期（Landing 态整页 diff 红）

- 状态：再次过期待 CI 重录——2026-10-08 U19 重录后，2026-10-10 demo 100% 复刻波（青玉令牌地基 + 全应用视觉对齐，见 [ui-replica-demo-fidelity.md](ui-replica-demo-fidelity.md)）再次有意变更全部可视面：本地 visual-chromium 轨 shell/composer 两用例红（预期，未重录、未放宽断言，diff 证据在 test-results/）。push 后 CI 通道重录两张基线；绿 → 在本文件登记采集环境修订纪律
- 发现时点：2026-10-07 B2 subagent-stream-chunk D3 验收 A7（E2E-VISUAL-01，`npx playwright test --project=visual-chromium`）
- 症状：`e2e/visual/shell.spec.ts:13 shell-default: AppShell Landing 态整页` 像素 diff 失败；同 spec 的 composer 用例与 electron-smoke 10 用例全绿
- 归属判定：分支遗留，非 B2 引入。依据：基线 PNG 最后更新 = 63ec39056（neutral default-mode chip 刷新），其后的分支 UI 提交含多处 Landing 可见改动（132803b43/9ef50106d scheduler overlay 整合、363b4a6a4/5a9b2ccf7 插件 modal 链退役、composer perf 系）；B2 范围（4bc83d6d6..749bef6fb）的 ui/renderer 改动仅为流式内部接线与 ESLint 自动修复，无 Landing 可见面
- 处置：按处置选项 ① 落地——00d69166e 按当前 Landing 视觉重录基线（macOS 平台匹配 e2e-visual runner）并经 main CI（2bd72f4ee 检出，2026-10-07）e2e-visual job 绿；ui-optimize-unified U19 收尾（2026-10-08）再次重录 shell/composer 两张基线固化设计终态（六主题令牌重校/侧栏双模式区头/composer 聚合形态），本地复跑绿
- 引用警示：commit 7f9b0b109 message 中「changed 模式因 diff ≤1% 阈值容忍不覆写」的叙述与像素实测相反（终态同步审查轮 PIL 实测：旧→新基线原始像素差 shell 96.87% = 991950/1024000 px、composer 54.46% = 68879/126480 px，尺寸不变，均远超 shell.spec.ts 的 maxDiffPixelRatio 0.01——差异超阈值的快照在 changed 模式下本就会被覆写）。基线差异量级引用以本登记与像素实测为准，勿引该 commit message 的 diff 量级叙述（历史 commit 不可改写，本条登记防引用）
- 关联：视觉基线跨环境字体敏感的长期方案另见 [visual-baseline-font-drift.md](visual-baseline-font-drift.md)
