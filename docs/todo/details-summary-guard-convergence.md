# extension 工具 result 的 details.summary 读侧检查收敛（手抄 helper ×14 + as 断言双形态）

状态：已解决（2026-10-23 收编完成；2026-10-17 dev-merge branch-review 登记，dmg-r2-2 + round-1 降档披露合并承载）

## 现状（已收敛）

读侧单点 = `@zhushanwen/extension-protocol` 的三个检查式 helper（`packages/extension-protocol/src/core/helpers.ts`，桶出口导出）：

- `readDetailsSummary(result: unknown): string | undefined`——details.summary 读取单点：result/details 非对象形态、summary 非字符串或空串一律 undefined。
- `resultContentText(result: unknown): string`——content 文本读取单点（`firstContentText` 的 unknown 检查式版）：content 缺失或首块非 text 时兜底空串。
- `firstLine(text: string): string`——折叠态一行摘要的首行切分单点。

10 个落地 details.summary 的 extension 包（rename-session / session-reader / scheduler / smart-context / base-tool-enhance / pending-notifications / structured-output / goal / canvas / session-manager）均已删除各自的手抄取值函数与 `as` 断言，统一 import 上述 helper；新增读侧直接 import，不再手抄。
