# 视觉基线跨环境字体敏感（已收口：候选 1 webfont 根因消除 + 候选 2 重录通道均已落地）

## 背景与现状

2026-09-30 v0.10.6 发布期：composer 视觉基线因「本机渲染 vs GitHub runner 渲染」的系统中文字体 metrics 差异恒红（placeholder hint 加长后差异从 <1% 放大到 2%）。当时修复 = spec 对 placeholder 文字区加 mask + 一次性 workflow 用 CI runner 渲染重录基线（commit 34451dbd2 / 7ddd6b871）。

该修复是止损：mask 外区域的本地/runner 字体差异仍在 1% 阈值容差内（当时实测 mask 外像素一致属侥幸），macOS 版本升级或断言面纳入新增长文案可能再次触发同型失败。根因（系统字体栈随环境变）已由字体固定构造性消除，本登记收口。

## 现行机制（终态）

**视觉轨字体固定（2026-10-12 落地）**：visual-chromium project 的每个 page 由 `e2e/visual/fixtures/visual-server.ts` 注入 bundled webfont——

- 字体源 = `@fontsource-variable/noto-sans-sc`（npm devDependency，根 package.json；可变字重 100-900 单源覆盖项目三档字重令牌 --fw-text:500 / --fw-mid:600 / --fw-bold:700 的真实字重，不做合成加粗；OFL 许可）。101 个 unicode-range subset 切片留在 node_modules，不入 git。
- 注入链路：fontsource index.css（101 条 @font-face）+ `--font-sans` 变量覆盖（`html:root` specificity 压过产品 style.css 的 :root 声明；--font-mono 不在固定范围，等宽字体差异是已知残留）经 addInitScript 早于首帧注册（执行点早于 HTML 解析器建元素，用 MutationObserver 等根元素挂上再安装）；woff2 请求经 page.route 按 basename 映射回 node_modules 本地 fulfill，不依赖网络。
- 截图时序：spec 在截图前调 `fontsReady(page)`（fixture 导出的统一入口——`document.fonts.ready` + 双 rAF），防「字体未就绪的 fallback 帧」照进基线；unicode-range 按需加载下交互后新渲染文字触发的新 subset 加载也被 ready 覆盖。
- 环境一致性锚点 = 字体文件本身（包版本锁定）。**字体族或包版本变更须全量重录基线一次**（重录合法：本地与 runner 渲染同源，本地 `--update-snapshots=all` 即权威；常设重录 workflow 退居兜底，见 `.github/workflows/visual-baseline-recapture.yml` 头注释）。
- 产品源码（packages/）零改动；只影响 visual-chromium 轨渲染，不进产品构建。

**基线全量 CI 通道（候选 2，2026-10-12 同日落地）**：`.github/workflows/visual-baseline-recapture.yml`——workflow_dispatch 手动触发，macos-latest runner 跑 `--update-snapshots=all` 全量重录，artifact 供人工回传落库。字体固定后其定位从「权威采集环境」退居兜底通道。

## 落地验证记录（2026-10-12）

注入链路经独立探针核实：`--font-sans` computed 值首位 = 'Noto Sans SC Variable'、body 继承生效、document.fonts 注册 121 个字体面（101 Noto + 20 页面自带）、页面字符触发 12 个 subset 经 route 本地 fulfill 后 status=loaded。重录前零阈值量化：shell 整页 diff 3652px（0.36%）、composer 区域 diff 276px（0.21%），均低于 1% 阈值（本机系统栈渲染与 Noto Sans SC 在本轨文字形态上像素差异细微）——首跑未红属实测事实，字体固定不受其影响：渲染源已从系统栈切到 bundled 栈，「与今天本机恰好相似」不再是被依赖的前提，环境无关性由字体文件保证。`--update-snapshots=all` 重录两张基线后复跑 2 passed。
