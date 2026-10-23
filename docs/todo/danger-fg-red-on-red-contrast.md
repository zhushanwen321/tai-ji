# danger 实底 + text-danger-fg 组合暗红字对比不足

状态：待裁决（2026-10-23 归档列表 vision 真机验收中发现；发现时即已修复本次改动面内的两处，其余消费点未动，等用户裁决修复方案）。

## 现象与根因

`bg-danger`（暗色主题 `--danger: #bf6b6b`）实底上使用 `text-danger-fg` 做文字/图标色，渲染为红底暗红褐字（像素实测 RGB 39,21,21，对比约 4.6:1），视觉发闷。根因：`--danger-fg` 暗色主题解析值 = `color-mix(in oklch, var(--danger) 12%, #160b0b)`——低浓度 danger 混深底，产出的是暗红褐而非亮字；该 token 的亮色族被 `[data-theme="light"]` 覆盖为白字，暗色族未覆盖。

项目内 danger 实底上文字的既有正确先例 = destructive 按钮：`--destructive-foreground: var(--neutral-fg)`（亮字）。

## 消费点清单（全仓 grep `text-danger-fg`）

| 消费点 | 形态 | 状态 |
|--------|------|------|
| `packages/renderer/src/components/sidebar/session-item/SessionItemContextMenu.vue`（两处） | 删除确认态红底 | 未修（本登记对象） |
| `packages/renderer/src/components/sidebar/SessionDirLabel.vue` | 删除确认态红底 | 未修（本登记对象） |
| `packages/renderer/src/components/canvas/CanvasDetailPanel.vue` | danger pill 底 | 未修（本登记对象） |
| `ArchiveListView.vue` 行级彻底删除钮确认态 | 删除确认态红底 | 已修（commit 75d932944，换 `text-neutral-fg`） |
| `ArchiveListView.vue` 批量清理钮确认态 | 删除确认态红底 | 已修（同上） |

## 待裁决：修复方案二选一

- **方案 A（各消费点换 `text-neutral-fg`）**：最小改动，逐点对齐 destructive 按钮先例；`--danger-fg` token 保留给未来真正的「danger 实底浅字」语义消费方（当前无正确用法）。
- **方案 B（token 层重定义 `--danger-fg` 暗色值）**：改 `style.css` 一处全仓生效；影响面大——需先盘点 `--danger-fg` 的全部消费形态（含非 `bg-danger` 底的场景），确认没有依赖当前暗红值的合法用法。
