# 太极 LOGO

> **状态（2026-08-02）**：**已收敛**。千问 AI 生成的水墨双鱼图定为唯一参考源，SVG 矢量化复刻已落地。
> 定案素材见 [`assets/qianwen/`](./assets/qianwen/)。已淘汰的蝴蝶/太极/taiji-fish 素材和早期概念对比稿归档在 [`archive/pre-2026-08-qianwen/`](./archive/pre-2026-08-qianwen/)。

## 定案素材

当前唯一活跃目录：[`assets/qianwen/`](./assets/qianwen/)

| 文件 | 用途 |
|------|------|
| `source.png` | 千问 AI 原图（857×1224） |
| `logo.svg` | 最终 logo（potrace 自动追踪 + 后处理，6 条 path） |
| `logo-square.svg` | 1:1 方版（app icon 用） |
| `logo-square.png` | 方版 PNG（electron-builder icon 源） |
| `logo-autotrace-raw.svg` | potrace 原始输出（几何参考底稿，不要直接用） |
| `preview.html` | 浏览器对比验证 |

详见 [`assets/qianwen/README.md`](./assets/qianwen/README.md) 和 [`assets/README.md`](./assets/README.md)。

## 已落地产物

logo 已应用到以下位置：

- **侧边栏品牌区**：`.tmp/v6/src/components/sidebar/Brand.vue` — 旋转太极双鱼（28px，8s 旋转）
- **可复用组件**：`.tmp/v6/src/components/icons/TaijiLogo.vue` — 带 spin 动画 + prefers-reduced-motion 降级
- **App Icon**：`apps/electron/build/` — icon.svg（矢量源）→ icon.icns（mac）/ icon.ico（win）/ icon-512.png（linux）
- **配色统一**：logo 配色与太极 V3 纯灰方向一致（neutral-fg 描边，无彩色 accent；决策见 [ADR-0066](../../adr/0066-taiji-pure-grey-color-direction.md)）

## 历史探索（已归档）

> 以下内容保留作决策追溯。concepts-*.html 系列已移入 `archive/pre-2026-08-qianwen/concepts/`。

### 概念稿时间线

| 版本 | 风格主线 | 原路径（已归档） | 备注 |
|------|---------|------------------|------|
| v1 | 太极初探 | `concepts.html` `concepts-glm-v1.html` `concepts-kimi-v1.html` `concepts-minimax-v1.html` | 多模型第一轮 |
| v2 | 蝴蝶 + 太极双线 | `concepts-v2.html` `concepts-kimi-v2.html` | 双线探索 |
| v3 | 蝶即两仪 | `concepts-v3.html` `concepts-kimi-v3.html` | 蝴蝶方向第一稿 |
| v4 | 太极中线强化 | `concepts-v4.html` `concepts-kimi-v4.html` | 太极中线 / 蝶翼对比 |
| v5 | 蚀仪三式（太极+鱼） | `concepts-v5.html` `concepts-kimi-v5.html` | 蚀仪·添鳍 / 负空间·醒 / 负空间·梦 |
| v6 | 太极鱼·简约克制 | `concepts-kimi-v6.html` | 基于水墨双鱼参考图再设计，4 候选 A1-A4 |
| v7 | 单鱼复刻（半仪之鱼） | `concepts-kimi-v7.html` | 单鱼高度复刻三式 G1-G3 |

> `concepts-v6.html`（GLM 主线 v6）在工作区未跟踪，未归档。

### 决策路径

探索经历了多个方向（蝴蝶 → 太极几何 → 水墨双鱼复刻），最终 2026-08-01 确定千问 AI 生成的水墨双鱼图为唯一参考，通过 potrace 自动追踪 + 手工后处理得到最终 SVG。决策细节见 [memory: logo-design-exploration-phase]。

---

相关：
- [`assets/README.md`](./assets/README.md) — 素材索引与筛选标准
- [`assets/qianwen/README.md`](./assets/qianwen/README.md) — 定案素材说明
- [ADR-0066](../../adr/0066-taiji-pure-grey-color-direction.md) — 纯灰配色方向
- [`v6-tokens.css`](../v6-tokens.css) — 设计 tokens 值 SSOT
