# e2e-visual shell-default 像素基线过期（Landing 态整页 diff 红）

- 状态：**已收口（2026-10-12）**。收口形态 = 视觉轨字体固定（[visual-baseline-font-drift.md](visual-baseline-font-drift.md) 候选 1 落地）随批重录基线——visual-chromium 轨渲染字体 = bundled webfont（Noto Sans SC Variable，fixture 统一注入），本机与 runner 渲染同源，**本地重录即权威**；「基线权威环境 = CI runner」纪律废止（其前提「内置字体不存在」不再成立），常设重录通道（`.github/workflows/visual-baseline-recapture.yml`）退居兜底（字体族/版本变更或需干净 runner 批量重录时用）。重录合法性锚点：基线环境一致性由字体文件本身保证，字体族或 `@fontsource-variable/noto-sans-sc` 版本变更须全量重录一次。本文件的历史调查记录（下方各条）保留作引用警示
- 发现时点：2026-10-07 B2 subagent-stream-chunk D3 验收 A7（E2E-VISUAL-01，`npx playwright test --project=visual-chromium`）
- 症状：`e2e/visual/shell.spec.ts shell-default: AppShell Landing 态整页` 像素 diff 失败；同 spec 的 composer 用例与 electron-smoke 10 用例全绿
- 归属判定：分支遗留，非 B2 引入。依据：基线 PNG 最后更新 = 63ec39056（neutral default-mode chip 刷新），其后的分支 UI 提交含多处 Landing 可见改动（132803b43/9ef50106d scheduler overlay 整合、363b4a6a4/5a9b2ccf7 插件 modal 链退役、composer perf 系）；B2 范围（4bc83d6d6..749bef6fb）的 ui/renderer 改动仅为流式内部接线与 ESLint 自动修复，无 Landing 可见面
- 处置沿革：① 00d69166e 按当时 Landing 视觉重录并经 main CI e2e-visual job 绿；② ui-optimize-unified U19 收尾（2026-10-08）再重录固化设计终态；③ 2026-10-11 demo 100% 复刻波（青玉令牌地基 + 全应用视觉对齐）有意变更全部可视面后再次重录（当时纪律要求重录走 CI 通道，push 前为过渡态）；④ 2026-10-12 视觉轨字体固定落地，`--update-snapshots=all` 重录两张基线（bundled 字体渲染）+ 复跑 2 passed，过渡态随字体固定的环境无关性一并收口
- 引用警示：commit 7f9b0b109 message 中「changed 模式因 diff ≤1% 阈值容忍不覆写」的叙述与像素实测相反（终态同步审查轮 PIL 实测：旧→新基线原始像素差 shell 96.87% = 991950/1024000 px、composer 54.46% = 68879/126480 px，尺寸不变，均远超 shell.spec.ts 的 maxDiffPixelRatio 0.01——差异超阈值的快照在 changed 模式下本就会被覆写）。基线差异量级引用以像素实测为准，勿引该 commit message 的 diff 量级叙述（历史 commit 不可改写，本条登记防引用）
- 关联：视觉基线跨环境字体敏感的根因消除登记见 [visual-baseline-font-drift.md](visual-baseline-font-drift.md)
