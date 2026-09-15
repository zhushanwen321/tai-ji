# 太极 LOGO

> **状态**：**已收敛**。千问 AI 生成的水墨双鱼图为唯一参考源，SVG 矢量化复刻已落地。
> 定案素材见 [`assets/qianwen/`](./assets/qianwen/)。

## 定案素材

当前唯一活跃目录：[`assets/qianwen/`](./assets/qianwen/)

| 文件 | 用途 |
|------|------|
| `logo.svg` | 最终 logo（potrace 自动追踪 + 后处理，6 条 path） |
| `logo.png` | logo.svg 渲染的位图版（根 README 门面图） |
| `logo-square.svg` | 1:1 方版（app icon 用） |
| `logo-square.png` | 方版 PNG（electron-builder icon 源） |

## 已落地产物

logo 已应用到以下位置：

- **侧边栏品牌区**：`packages/renderer/src/components/sidebar/Brand.vue` — 旋转太极双鱼（28px，8s 旋转）
- **可复用组件**：`packages/renderer/src/components/icons/TaijiLogo.vue` — 带 spin 动画 + prefers-reduced-motion 降级
- **App Icon**：`apps/electron/build/` — icon.svg（矢量源）→ icon.icns（mac）/ icon.ico（win）/ icon-512.png（linux）
- **配色统一**：logo 配色与太极纯灰方向一致（neutral-fg 描边，无彩色 accent；决策见 [ADR-0066](../../adr/decisions.md)）

## 设计决策

以千问 AI 生成的水墨双鱼图为唯一参考，通过 potrace 自动追踪 + 手工后处理得到最终 SVG。设计取舍详见 [`assets/qianwen/README.md`](./assets/qianwen/README.md)。

---

相关：
- [ADR-0066](../../adr/decisions.md) — 纯灰配色方向
- [DESIGN.md](../../DESIGN.md) — 视觉设计权威（token 值与范式）
