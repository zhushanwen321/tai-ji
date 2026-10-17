# extension 工具 result 的 details.summary 读侧守卫收敛（手抄 helper ×14 + as 断言双形态）

状态：未解决（收敛收编待排期；2026-10-17 dev-merge branch-review 登记，dmg-r2-2 + round-1 降档披露合并承载）

## 现状

10 个 extension 包落地 tool result `details.summary`（一行英文摘要，GUI ToolRow 与 TUI renderResult 折叠态共用）后，读侧（render.ts 等从 result/details 取 summary 与 content 文本的代码）存在两类未收敛形态：

1. **守卫式 helper 多处手抄**：`fieldValue` 形态守卫在 8 处独立手抄、`readDetailsSummary` 语义 helper 在 6 处独立手抄（reviewer grep 实证）——无单点权威实现，各副本签名与防御程度已开始漂移。
2. **as 断言式双形态**：canvas（`extensions/taiji/canvas/src/render.ts`）与 session-manager（`extensions/universal/session-manager/src/render.ts`）用 `as` 断言直读 summary/content，与其余 6 包的守卫式双形态并存——形式同构可合并的假差异。

当前均不构成行为缺陷（reviewer 自评：本批不构成行为缺陷，属债类披露）。

## 收敛方向（待裁决排期）

- 在 `@zhushanwen/extension-protocol` 提供单点读侧 helper（守卫式取 details.summary / content 首文本），各包删除手抄副本换用——跨 8 包 + extension-protocol 的收编重构；canvas/session-manager 的 as 断言同批换守卫式。
- 收编前新增第 9 处手抄副本属于加重债，应避免（新增包直接 import extension-protocol 的 helper，若该批先行收敛则自然消解）。

## 出处

- dev-merge branch-review run `.tmp/dev-merge-review/dmg-505bbfa72/`（ledger.json + round-1/aggregated.md）
