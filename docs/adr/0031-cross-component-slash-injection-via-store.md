# ADR-0031: 跨组件 slash 命令注入用 store 驱动的一次性消息通道

- 状态：Accepted

> **性质**：架构 D-不可逆决策（跨组件协调模式归位）。本文档定义架构约束。
> **关联**：[ADR-0028 搜索编排归 composable](0028-search-orchestration-in-composable.md)、[ADR-0029 领域类型 SSOT](0029-domain-types-ssot-in-lib.md)。
> **溯源**：`[from: 2026-07-01-search-slash-injection §plan, §技术改动点]`

## 上下文

⌘K 全局搜索浮层（SearchModal，sidebar 级 overlay）点击 slash 命令项后需要将命令 chip 注入活跃 Panel 的 ComposerInput（contenteditable DOM）。但 SearchModal 拿不到 ComposerInput 的元素 ref——ref 链在 Composer 层终止（Composer 未 defineExpose 上抛 insertSlashChip），且 SearchModal 与活跃 Panel 在组件树上是兄弟/叔侄关系，非父子。

v1 实现用 `useSearchJump({ injectSlash: callback })` 回调注入，但 SearchModal 调用 `useSearchJump()` 时从未传入该回调——断链。所有 slash 命令点击恒返「slash 命令注入未接线」。

调研项目惯用模式：无前端事件总线（events.ts 是 WS 分发器无 emit；无 mitt；provide/inject 仅 AppShell 一处回调先例）。跨组件协调惯用 = Pinia store + composable 模块单例 ref（useSidebar 写 store / useNewTaskFlow 模块单例 ref / panel store 驱动 Composer 渲染）。

## 决策

**commandStore 新增 `pendingSlash` ref 作为一次性消息通道（写 → 消费 → 清）。**

- `commandStore.pendingSlash: PendingSlash | null`（形状 `{command, icon?, sessionId, ts}`）
- 写入方：`useSearchJump.confirmCommand` slash 分支调 `requestSlashInjection({command, icon, sessionId})`
- 消费方：`Composer.vue` 的 `watch(() => commandStore.pendingSlash)` 按 `sessionId` 过滤匹配后调 `inputRef.insertSlashChip(command, icon)` + `clearPendingSlash()`
- 与现有 `retryState`/`queueState` 瞬时状态同构（store 持有一次性信号，消费后清除）

### 关键约束（实现必须遵守）

1. **watch 非 immediate**：防 Composer 后挂载时读到旧 pendingSlash 残留值误注入（store 可能已有给前一个 Composer 的请求）
2. **sessionId 过滤**：`req.sessionId === props.sessionId`（含双方 null 的 landing 态匹配），不匹配时不 clear（防误清留给其他 Composer 的请求）
3. **注入顺序**：先 `insertSlashChip` 后 `clearPendingSlash`（防先清后注入读到 null）
4. **ts 字段**：重复点击同命令靠 ts 变化触发 watch 引用变化（同值覆盖不触发）

## 备选方案与取舍

| 方案 | 否决理由 |
|------|---------|
| mitt / 前端事件总线 | 与项目惯例不符（项目无前端总线），引入新依赖模式 |
| provide / inject 传递 ComposerInput ref | ref 链在 Composer 终止（无 defineExpose），且 SearchModal 与 Panel 非父子关系，inject 拿不到 |
| props 逐层传递 injectSlash 回调 | 临时 flag 传多层 props，违反「不把临时 flag 传五层」原则 |

store 驱动是项目惯用模式（store + 响应式跟随）的自然延伸，与 retryState/queueState 同构，无新模式引入。

## 后果

- 正向：SearchModal 与 Composer 解耦，注入链路通过 store 状态驱动，可测试性强（单测直接操作 store）
- 正向：split 双 Composer 场景靠 sessionId 过滤天然隔离（pendingSlash 全局单例，但消费侧过滤保证只注入目标）
- 负向：store 多一个瞬时状态字段，但与 retryState/queueState 同构，复杂度可控

## 适用边界

本模式适用于「跨组件树、非父子、需传递一次性动作信号」的场景。不适用于：
- 持续状态同步（用 store ref 直接订阅）
- 父子组件通信（用 props/emit）
- 高频事件流（用事件总线或 WS 通道）
