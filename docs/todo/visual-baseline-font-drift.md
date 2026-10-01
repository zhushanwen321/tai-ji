# 视觉基线跨环境字体敏感（长期方案待排期）

## 背景与现状

2026-09-30 v0.10.6 发布期：composer 视觉基线因「本机渲染 vs GitHub runner 渲染」的系统中文字体 metrics 差异恒红（placeholder hint 加长后差异从 <1% 放大到 2%）。当时修复 = spec 对 placeholder 文字区加 mask + 一次性 workflow 用 CI runner 渲染重录基线（`e2e/visual/composer.spec.ts` 注释与 commit 34451dbd2 / 7ddd6b871）。

该修复是止损：mask 外区域的本地/runner 字体差异仍在 1% 阈值容差内（本次实测 mask 外像素一致属侥幸），后续 macOS 版本升级或断言面纳入新增长文案可能再次触发同型失败。

## 实现要点（候选方向）

1. **视觉轨字体固定**：visual-chromium project 加载 bundled webfont（如 Noto Sans SC subset）并注入 `font-family`，构造性消除系统字体差异；只影响视觉轨渲染，不进产品构建。
2. **基线全量 CI 通道固化**：把「CI 重录 + artifact 回传」从一次性 workflow 固化为常设 workflow_dispatch，配合「基线权威环境 = CI runner」纪律（spec 注释已登记）。

方向 1 为长期方案（消除根因），方向 2 为通道兜底；两者可并行。
