# branch-review minor 残余（dev-merge gates dmg-6f5ce5444，pi 1.0 适配分支）

状态：已解决（2026-10-05 修复批。第 1/3/4 条为注释修正；第 2 条时点裁决为立即删除——sendAttempts 连 4 个写点与两处测试引用同步移除，不留投递域重构批）。

来源：dev-merge-gates workflow（.tmp/dev-merge-review/dmg-6f5ce5444）branch-review 第 4 轮收敛时剩余的 open 条目——全部 minor 级，不阻塞合并，按 dev-merge 纪律登记后随分支带走。

## 1. pi isError 返回值丢弃失实断言的源码注释残留批（dmg-r4-1）

三处源码注释仍断言「pi 的 isError 返回值会被丢弃」类旧语义，N1 权威文档修复批（d0ddf8ad0）漏网：

- `extensions/universal/rename-session/src/index.ts`
- `extensions/universal/session-reader/src/handler-utils.ts`
- `extensions/universal/subagent-workflow/src/interface/tool/tool-workflow-script.ts`

修复方向：对照 pi 1.0.0 dist 实装的 isError 语义重写三处注释（与 d0ddf8ad0 同口径）。

已解决（2026-10-05）：三处注释按 d0ddf8ad0 口径重写——pi 1.0.0 agent-loop.js :579 正常返回尊重返回值 isError 标记、:581-588 抛出经外层 catch 统一转 error result；统一 throw 为纪律选择（单一错误路径）。

## 2. session-delivery sendAttempts 死字段（dmg-r4-2）

重试矩阵随 ADR-0122 退役后，`sendAttempts` 成死字段：`packages/session-delivery/src/types.ts:208` 声明 + `delivery.ts` 四处写点，全库生产码零读方。测试（delivery-ownership-state / delivery-ownership-view）引用写字段。

修复方向：删声明 + 删四写点 + 同步两测试文件；属投递域结构清理，可与投递域后续批次同做。

已解决（2026-10-05）：声明与 delivery.ts 四写点（snapshot / createEntry / requeue / failInFlight）及两测试文件同步删除，包内零残留，154 测试全绿。

## 3. pi 行为断言缺 dist 锚点注记两处（dmg-r4-3）

- `packages/runtime/src/infra/pi/pi-session-data.ts`：details 持久化断言未注记 pi 1.0.0 dist 锚点；
- `packages/renderer/src/components/settings/mcp/McpServerForm.vue`：连字符同名断言同缺。

断言本体均属实（审查已核），只缺「以哪个 pi 版本实装为锚」的注记。

已解决（2026-10-05）：pi-session-data.ts 锚 agent-session.js:346 + session-manager.js appendMessage:827-836；McpServerForm.vue 锚 dist core/mcp-servers.js:21 mcpNamespace（与 pi-mcp-store.ts 复刻注记同口径）。

## 4. apply-entry.ts dispatchEntry 头注 case 词表漂移（dmg-r4-4）

`packages/core/src/domain/chat/apply-entry.ts` 头注的 no-op case 清单漏列已建模的 `usage` / `context_edit` 两个 case。纯注释修正。

已解决（2026-10-05）：dispatchEntry 头注 case 清单已补两项（标注零投影显式 no-op）。
