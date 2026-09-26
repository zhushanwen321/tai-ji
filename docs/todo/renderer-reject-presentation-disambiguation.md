# D6：RPC reject 呈现裁决三处三形态（低优先级，批次 4）

状态：已定案（2026-09-26）：拆分——消化原语（`packages/core/src/domain/chat/reject-digest.ts`）承载 bash/compact 两消费点，send 保持独立（WS FIFO 归属论证自成体系）；定案记录 = reject-digest.ts 头注（2026-09-26 登记，源自 code-overdesign-audit 第三轮扫描 + 用户追问范围核实）

## 问题

renderer 发 RPC 给 runtime，失败回执到达时要裁决「该不该向用户呈现」——不裁决会出现同一个错误双弹（对话流一次 + toast 一次）或误吞（该提示的不提示）。现状三处消费点各养一套机制，形态互不相同：

| 消费点 | 消歧的子问题 | 机制 | 位置 |
|---|---|---|---|
| bash 执行 | 错误已被终态帧消化？ | **反向查询**：终态帧把命令移出「执行中列表」，回执处查列表空 = 帧来过 = 已消化 → 抑制 toast | `core/domain/chat/useChat.ts:1160-1163` |
| 手动压缩 | 错误已被终态帧消化？ | **正向标记**：`manualCompactionState` 三态 Map（发起置 false / 终态帧置 true / 回执处查 true 才不弹），finally + 会话销毁 + 测试 reset 三处清理 | `useChat.ts:103/:488/:1209-1222/:1388` |
| 普通消息发送 | reject 归属是我吗？ | **clientUuid 回带 + 未决记录**：`pendingDirectSends` 命中队列条目（flush 重放/迟到帧）静默吞；孤儿 reject 才弹 | `useChat.ts:425-434`（WS FIFO 时序论证，已确认为本质复杂度） |

前两者极性相反（置位 vs 清空），第三者结构同族但子问题正交（归属 vs 消化）。

## 双弹问题的发生条件（为什么只有 bash/compact 撞满）

四条同时满足才双弹：①长时操作（RPC 成功 ≠ 操作结束，有异步终态）；②终态经广播帧流回并渲染进对话流；③失败时帧与回执赛跑（帧走事件流、回执走应答通道，帧可能先到）；④回执错误默认弹 toast。bash/compact 四条全中；普通发送/stop/respond 是瞬时操作不满足 ①②（发送的 message.* 帧是后续 turn 的内容流，不是该请求的终态）。

## 修复方向（三方案对照，已论证）

- **统一正向标记**：语义直白但状态税翻倍（bash 从零专门状态变两份，每份拖自己的生命周期）。
- **统一反向查询**：**排除**——前提是「有现成业务态可搭便车」，只有 bash 满足（执行列表是业务必需）；compact 无业务态可反查，改造后实质还是标记。
- **抽小原语（推荐）**：`消化标记` 原语（markInitiated / markConsumed / isConsumed / clearSession 四方法 + 一份生命周期管理），bash/compact 注册 key 接入；生命周期税合并为原语内一份；时序假设（帧先于回执、帧到达必置位）显式化为原语契约。

**原语拆分决策点（执行期定）**：send 消歧的是「归属」（clientUuid 对账）与「消化」正交——要么拆两个小原语，要么 send 保持独立（其 WS FIFO 论证自成体系）。Rule of Three 名义已到（三消费点），但子问题不同质，合并与否看执行时的实际形状。

## 证据

- 三轮扫描报告：`.tmp/code-overdesign-audit/code-overdesign-audit-20260925-1759.md` 第三轮 D 组 D6 条目
- 裁决与范围修正记录：`.tmp/code-overdesign-audit/baseline.md`（20260926 D6 范围修正条目）
- 执行批次归宿：审计报告「执行批次总表」批次 4（重构批）
