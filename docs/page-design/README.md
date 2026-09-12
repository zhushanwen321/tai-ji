# page-design · 页面设计

xyz-agent 前端设计的权威目录。设计系统的 SSOT 与设计稿集中于此。

> **当前状态（2026-08）**：视觉层已从 v3 冷蓝演进到 **v6 太极纯灰**（accent `#cfcfd4`）。v6 范式 SSOT = [`v6-master-spec.md`](./v6-master-spec.md)（单一权威源）。token 值真值固化在 [`v6-tokens.css`](./v6-tokens.css)（自 demo 固化，随仓库提交）。v6 Vue 交互 demo 在 `../../.tmp/v6/`（独立可运行项目，不放在文档目录）。完整演变叙事见 [design-evolution.md](../design-evolution.md)。

## 目录结构

```
page-design/
├── README.md                          本文件（索引 + 归属判定）
├── v6-tokens.css                      值 SSOT（hook check_css_token_ssot.py 对照面；运行时真值 = style.css :root，逐 token why 注释在两处 css 内）
├── design-system.md                   组件原语层（Card/Input/Button 等如何用 tokens；历史参考，冲突以 v6 为准）
├── v6-master-spec.md                  ★ v6 单一权威源（决策与范式，整合自 28 份过程文档 + demo）
├── v6-design.md                       v6 五原则原始定稿（被 master-spec 取代为实现细节参考）
├── v6-summary.md                      v6 设计稿总览（索引与摘要）
├── ui-design-principles.md            UI/UX 设计方法论（认知负荷/格式塔/WCAG，色相无关）
├── pi-launch-presets.md               pi 启动预设设计（被 packages/ 5 处源文件引用）
├── v6-spec-tokens.html                v6 token 集 + 标注规范
├── v6-spec-*.html                     v6 各视图视觉稿（15 个文件，部分已滞后于 master-spec）
├── v6-spec-base.css                   对话流共享 CSS
├── v6-plugin-max-demo.html            plugin 最大化交互原型
├── logo/                              品牌 logo 素材与设计稿
│   ├── assets/qianwen/                当前唯一活跃素材库（千问双鱼）
│   └── archive/pre-2026-08-qianwen/   已淘汰素材（butterfly/taiji/taiji-fish + concepts）
└── archive/                           历史设计稿归档（见下方详细说明）
```

> v6 Vue 交互 demo 在 `../../.tmp/v6/`（独立 Vue 3 + Vite 项目，有自己的 package.json / node_modules）。

## SSOT 链（v6 权威源优先级）

```
v6-master-spec.md      ← v6 单一权威源（决策与范式）
        ↑ 冲突时以此为准
v6-tokens.css          ← token 值 SSOT（hook 守卫的登记对照面；色相决策见 ADR-0066）
        ↑ 值以此为准
style.css :root        ← 运行时真值（逐 token why 注释；新增 token 必须同批登记进 v6-tokens.css）
        ↑ 组件实现
.tmp/v6/ demo          ← 活验证层（组件实现对照，值以 v6-tokens.css 为准）
```

- **v6-master-spec.md 是 v6 单一权威源**：整合自 v6-design.md / v6-summary.md / v6-review-* / v6-fix-plan / v6-spec-*.html 等 28 份过程文档 + demo。冲突时以 master-spec §4 + v6-tokens.css 为准
- **v6-tokens.css 是值登记的唯一对照面**（2026-09-13 收口，原 design-tokens.md 已删除，git 可追溯）
- **过程文档已降级**：v6-design.md / v6-spec-*.html 作为实现细节参考保留，不代表当前最新决策

## archive/ 目录说明

archive/ 是历史设计稿归档区。pre-v3 探索稿（Warm & Soft 时期 demo HTML、过程审查日志等）已于 2026-08-02 清理，完整演变叙事见 [design-evolution.md](../design-evolution.md)。

### archive/ 根 — 早期探索稿与过期规格

- `v6-demo.html` / `v6-drawer-tabs-demo.html` — 早期 HTML 探索稿（已被 `.tmp/v6/` Vue demo 取代，master-spec §附录已降级）
- `zcode-ui-spec.md` — v3 冷蓝期 Chat UI/UX 布局规格（色值已过期，布局规则仅历史参考）

### archive/v3/ — 能力设计 spec（活跃，非死稿）

v3 视觉稿（shell/sidebar/panel/settings 等）已被 v6 取代并删除。仅保留 v6 没有对应物的**功能/能力设计 spec**：

| 子目录 | 说明 |
|--------|------|
| `coding-plan-quota/` | provider 额度查询设计（被 packages/ 7 处代码注释引用） |
| `flow-2-code-review/` | 产品主路径 Flow-2 时序设计（被 message.ts 引用） |
| `flow-3-subagent/` | 产品主路径 Flow-3 多 agent 编排 |
| `ask-user/` | inline ask-user 交互设计（被 AskUserOverlay.vue 引用） |
| `fast-fork/` `fast-handoff/` `fast-merge/` | 跨区联动能力（待实现） |
| `subagent-panel/` | agent-call-streaming + workflow-extension-adaptation |
| `research/` | pi steer/followup 队列机制调研 |
| `handoffs/` | 各能力 spec 的接手入口文档 |

详见 [archive/v3/README.md](./archive/v3/README.md)。

## 文档归属判定

| 问题 | 去向 |
|------|------|
| 色值/字体/圆角/阴影/动效的值定义？ | `v6-tokens.css`（登记对照面；运行时值在 style.css） |
| v6 决策与范式？ | `v6-master-spec.md` |
| 组件原语（Card 族、Input、Button）的形态/状态？ | `design-system.md` |
| v6 视觉稿（某视图的标注规范）？ | `v6-spec-*.html`（参考，以 master-spec 为准） |
| 跨模块的用户流程（如 code-review 流）？ | `archive/v3/flow-*/spec.md`（活跃能力 spec） |
| Fork/Handoff/Merge 联动能力？ | `archive/v3/fast-*/spec.md`（活跃能力 spec） |
| Logo 素材？ | `logo/assets/qianwen/`（活跃）/ `logo/archive/`（已淘汰） |
| UI 设计演变历史？ | `../design-evolution.md`（单篇汇总） |

## 关键约束

1. **tokens 是唯一值源**：`packages/renderer/src/style.css` 的 CSS 变量必须全部能在 `v6-tokens.css` 找到（pre-commit hook `check_css_token_ssot.py` 强制校验）
2. **ADR 归架构目录**：设计决策记录放 `docs/adr/`，不放本目录

## 相关文档

- [ADR-0019 视觉方向](../adr/0019-visual-direction.md) — v3 冷蓝暗色确立
- [ADR-0066 太极纯灰配色](../adr/0066-taiji-pure-grey-color-direction.md) — 纯灰配色方向定案（原配色决策文档已删除，git 可追溯）
- [UI 设计演变史](../design-evolution.md) — Warm&Soft → v3 → v6 → 太极纯灰完整叙事
- [领域术语表](../architecture/context.md) — UI 结构术语
- [编码规范 §设计](../standards.md) — 前端设计规则
