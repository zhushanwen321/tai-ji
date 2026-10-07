# 侧栏快捷键提示（⌘N / ⌘I / ⌘K）是否改按需的重新裁决（D7 移出项）

状态：已裁决并执行（2026-10-06 用户裁决翻转 D7 移出记录：三条提示改悬停显示，经按钮 `title` 承载，快捷键绑定不动）。登记来源：ui-signal-density 设计 D7「v4 移出本次范围」

## 现状（终态）

侧栏「新建任务 / 导入会话 / 搜索」三项入口不再渲染常驻 kbd 徽标，快捷键提示并入按钮 `title`（悬停显示，格式「<动作> · ⌘N」）。实装：`packages/renderer/src/components/sidebar/Sidebar.vue`；绑定仍在 `useGlobalShortcuts.ts`，随 `sidebar.collapsed` 走 CSS 隐藏、DOM 常在。

## 裁决沿革

D7 当初移出的理由（新用户发现入口的唯一静态线索、侧栏不拥挤）被 2026-10-05~06 的 ui 对账裁决推翻：用户明确「侧栏只做激活条目、新建任务、快捷键」三处样式，按 demo 形态执行。demo 的自定义 tooltip 载体未采纳，用原生 `title`（仓内无 Tooltip 原语，最小实现）。
