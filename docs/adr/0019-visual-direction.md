# 0019: 视觉方向收敛到 zcode-demo 冷蓝暗色

**状态:** Accepted　**日期:** 2026-06-18　**决策者:** 产品负责人

## 决策

以冷蓝 `#4f8ef7`、暗色画布、Inter 作为产品**唯一视觉标准 (single source of truth)**（2026-08-25 字体子决策已 supersede，见 docs/page-design/v6-master-spec.md §4.6），默认主题基调为**暗色优先，亮色为备选**。

> **2026-08-02 更新**：原始 `docs/page-design/zcode-demo/` 探索稿已删除，视觉规格见 `../page-design/v6-spec-*.html`（15 份 HTML 标注稿）与 `../page-design/v6-master-spec.md`。本 ADR 的视觉方向裁决（冷蓝暗色优先）不变。

> **注**：原始画布色值为 `#0d0d0f`，2026-07-09 提亮校准为 `#1a1b1f`（对标 VS Code Dark+，减轻长时间用眼疲劳，详见 `../page-design/design-tokens.md` 暗色章节）。本 ADR 的视觉方向裁决（冷蓝暗色优先）不变。

完整 token 见 `../page-design/design-tokens.md`（本 ADR 的规范附件，唯一可引用的色值/字体/圆角源）。

## 背景

重构前共存四套互相冲突的视觉系统：

| 代号 | 来源 | 方向 | 处置 |
|------|------|------|------|
| A · Warm Workbench | `DESIGN.md` + `PRODUCT.md` 品牌 | 暖奶油 + 赤陶 + serif + 亮色 | **归档** |
| B · 终端/IDE | ~~`../page-design/design-system.md`~~（原 Warm & Soft，ADR-0019 推翻） | 纯黑 + 绿 `#22c55e` + 1px 圆角 | **归档** |
| C · zcode-demo | ~~`docs/page-design/zcode-demo/`~~（探索稿已删除，视觉规格见 `../page-design/v6-spec-*.html`） | 纯黑 + 蓝 `#4f8ef7` + Inter + 暗色 | **✅ 升级为真身** |
| D · 真实代码漂移 | `src-electron/.../style.css` + `tailwind.config.ts` | 暖底 + 青蓝 accent(195°) + serif + 1px | **改到对齐 C** |

`PRODUCT.md` 原定的「温润赤陶 Warm Workbench」品牌方向**被本决策推翻**，需同步重写。

## 理由

1. **用户决策**：产品负责人明确选择 C，接受推翻 Warm 定位的代价。
2. **目标用户对齐**：AI-Coding-Agent 的核心用户是开发者；冷蓝暗色更贴近 Cursor / Windsurf / VS Code 的开发者工具直觉。
3. **暗色优先的内部一致性**：C 本身就是纯暗色，"暗色优先"与 C 无冲突；而 A 的亮色优先与决策矛盾。
4. **布局资产保留**：C 探索出的 layered-float 画布、三栏聊天、进程 mini-chip、右抽屉 diff/浏览器/终端 是产品核心交互创新，随 C 一并保留。

## 代价与风险

- **品牌一致性**：推翻 `PRODUCT.md` 已固化的 Warm 人格，需重写品牌章节，否则文档自相矛盾。
- **C 的 token 残缺**：zcode-demo 原始仅 9 个 CSS 变量，缺 warning/danger/info、间距、阴影、动效、亮色变体。已在 `../page-design/design-tokens.md` 补全，但补全项未经视觉校准，需在高保真阶段验证。
- **D 的状态色资产**：真实代码 `style.css` 已有完整的 success/warning/danger + light 体系，比 C 完整——收敛时**继承 D 的状态色结构**，仅替换色相，不全盘推翻。

## 归档处置

- **A (`DESIGN.md`)**：文件顶部加 `> ⚠️ DEPRECATED by ADR-0019 (2026-06-18). 真身见 ../page-design/design-tokens.md`，保留作历史参考，从所有"当前规范"链接撤下。
- **B (`../page-design/design-system.md`)**：原 Warm & Soft 方案，ADR-0019 推翻后降级为组件原语层参考（不再承载视觉方向）。
- **`PRODUCT.md`**：品牌章节（Warm & Soft 人格、赤陶、anti-references 中"不是冷色开发者工具"）需重写为冷蓝暗色开发者工具人格——**单独任务，不在此 ADR 范围**。

> 落地步骤已删除：实现由代码承载（源码内 // ADR-0019 锚点可回链），git 历史可追溯（2026-09-13 ADR 瘦身）
