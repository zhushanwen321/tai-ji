# 0023: Overview 入口落点与覆盖范围

**状态:** Accepted　**日期:** 2026-06-20　**决策者:** 产品负责人

## 决策

1. **入口落点**：Overview 由 **sidebar 主操作区「Overview」入口按钮**触发，带 session 计数角标 + 快捷键 `⌘⇧O`。**非** workspace 顶栏按钮、**非** shell 级 view 切换、**非** sidebar segmented tab（会话|文件）的第三项。
2. **覆盖范围**：Overview 激活后**覆盖整个 workspace（main）区**，workspace 双 Panel / composer 内容隐去但保留、退出即恢复；**sidebar 持久不变**，导航能力全程不丢。
3. **退出**：点 Overview 任意卡片 → 载入该 session 回 workspace，或 `Esc`。

## 背景

Overview 是独立 L1 Region（与 Sidebar / Workspace / Settings 并列，见 `overview/spec.md` 背景）。但「从哪进 / 覆盖什么」在三份文档中说法不一，2026-06-20 review 时被标为冲突：

| 来源 | 说法 |
|---|---|
| `overview/spec.md` | 入口在 workspace 顶栏「Overview」按钮 |
| `ui-skeleton.md`（已删除，git 可追溯） | 入口是 shell 级 view 切换（`main` 在 chat/overview/settings 间切） |
| `workspace/spec.md` | **完全沉默**（未提 overview）—— 真缺口 |

三方不一致会导致实现时无法判断按钮挂哪、覆盖到哪一层。

## 理由

1. **sidebar 是 session 的自然容器**：Overview 的取向是「多 session 统筹/监控」，入口放在 sidebar（session 列表的近邻）最符合心智——用户在 session 列表旁即见「鸟瞰全部」入口，计数角标让规模一目了然。
2. **sidebar 持久 = 上下文连续**：进入 Overview 时 sidebar 不隐去，用户随时可点别的 session 切回 workspace，导航能力不丢。若入口在 workspace 顶栏且 overview 全屏覆盖，进入 overview 即脱离 sidebar 语境，来回切换成本更高。
3. **覆盖 main 而非替换整个 shell**：Overview 与 Workspace 共用 `main` 区（互斥覆盖），保持 shell 骨架稳定（sidebar 持久），降低视图状态机复杂度。
4. **与 segmented tab 分层**：tab（会话|文件）是 sidebar 自家子视图的互斥切换；Overview 按钮是外部 L1 Region 入口。混排进 tab 会混淆「容器内子视图」与「跨 Region 跳转」两种语义。

## 代价与风险

- **sidebar 垂直空间**：多一个按钮进一步挤压 session 列表纵向空间。缓解：按钮单行 + 计数角标紧凑，且收起态不显示（收起后无需进 overview，⌘⇧O 仍可用）。
- **`⌘⇧O` 快捷键冲突待核**：与 OS / 其它面板快捷键冲突需实机验证（沿用 overview/spec.md 既有遗留项）。
- **覆盖语义需视觉明示**：Overview 激活时 main 区加 accent ring 标 Region 边界，避免用户误以为仍在 workspace。

## 影响（已同步落地）

- `overview/spec.md`：触发与定位段落更新为「sidebar 按钮 + 覆盖 workspace」；标注冲突已收口（本 ADR）。
- `sidebar/spec.md`：容器分层新增「Overview 入口按钮」层，并声明它与 segmented tab 的分层关系。
- `workspace/spec.md`：补「与 Overview 的关系」段落（原缺口）。
- `overview/draft-entry.html`（新）：sidebar(five-states 基底) + Overview 按钮 + 覆盖 workspace 的交互 demo。
- `overview/draft-layout-position.html`（旧）+ 项目根 `overview-layout-position.html`：**删除**——二者展示已失效的「workspace 顶栏 view-tab 切换」方案，由 `draft-entry.html` 取代。
- `PRODUCT.md`：`Mission Control` 废弃别名 → `Overview`。

## 后续步骤

- 实机验证 sidebar Overview 按钮在收起态的行为（建议：收起态仅 ⌘⇧O 可用，不占顶栏位）。
- ⌘⇧O 快捷键冲突核验后定稿。
- 真身代码落地时，Overview 作为 main 区的互斥 view（与 chat/settings 同级 view 切换），由 sidebar store 驱动。
