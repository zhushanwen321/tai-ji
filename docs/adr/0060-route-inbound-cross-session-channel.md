# ADR-0060: route-inbound crossSession 通道（全局消费者订阅带 sid 消息）

**Status**: Proposed（待分步实施验证转 Accepted）
**Date**: 2026-08-06
**Decider**: 架构决策（基于 DP2+DP3+ST4 统一设计 + 评审修正）

## Context

### 问题

route-inbound 路由模型是 **session/global 二分**（基于 `msg.payload.sessionId`：有 sid → session 通道；无 sid → global 通道）。但 ExtensionHost 是**全局单例消费者**（ViewHostStore 按 per-session Map 分区，需收所有 session 的 `extension:*` 下行，不能随 session 切换退订——否则后台 session 更新丢失）。

带 sid 的 extension:* 消息走 session 通道，ExtensionHost 经 global 通道订阅**收不到** → transport 层开 raw-message-tap 旁路（`use-connection.ts:131` emit 原始流，ExtensionHost subscribe 全量）。

### 三个不对称

| | per-session 消费者 | 全局消费者（无 sid）| 全局消费者（有 sid）|
|---|---|---|---|
| 订阅 API | `events.on(sid)` | `events.onGlobal` | 不存在（只能 raw-tap）|
| route-inbound 出口 | `dispatchSession` | `dispatchGlobal` | 不存在（raw-tap 绕过路由）|
| 设计意图 | 显式设计 | 显式设计 | 补丁 |

### 根因

route-inbound 缺失"全局消费者订阅带 sid 消息"的路由类别。raw-tap 是这个缺失能力的 **ad-hoc 实现**：方向对（全局消费者需全量订阅），位置错（transport 绕过 route-inbound → 路由非单一真相源；transport 持有 ExtensionHost 消费逻辑 → 关注点泄漏）。

## Decision

### 1. route-inbound FALLBACK 加 CROSS_SESSION_TYPES 规则

`extension:*` **不进 ROUTE_TABLE**（它们不需 effect 兜底——ROUTE_TABLE 现有条目的模式是 `dispatchSession + InboundEffects 回调`，extension:* 只需 `dispatchSession + dispatchCrossSession`，结构不同，硬塞会产生 5 个雷同 handle 函数）。落 FALLBACK，FALLBACK 内加规则：

```ts
const CROSS_SESSION_TYPES = new Set([
  'extension:widget', 'extension:widgetGui',
  'extension:status', 'extension:notify', 'extension:ui_request',
])
// FALLBACK 内：有 sid → dispatchSession +（若 CROSS_SESSION_TYPES）dispatchCrossSession
```

### 2. events 留 renderer（端口模式），加 crossSession 第三通道

events.ts **不下沉 core**（持有指向组件/composable 的 handler 引用，进 core 破坏 node/worker 可跑契约）。加 `onCrossSession`/`dispatchCrossSession` + crossSessionHandlers。core 定义 `TransportPorts.events` 接口（含 dispatchCrossSession），renderer 实现（端口注入延续 ADR-0059 范式）。

### 3. 命名 crossSession（非 broadcast）+ 消费者约束

crossSession 语义是"**允许全局消费者接收带 sid 消息**"，非"广播到所有人"。合法消费者**仅 ExtensionHost**（+ 未来远程化协同态 busy/idle/presence）。**禁止** per-session 消费用它（那是 `on(sid, handler)` 的职责）。注释明确写"这不是广播"，防未来误用（如"让两个 panel 都收到"误标 crossSession，那该是 per-session 订阅）。

### 4. 删 raw-message-tap

ExtensionHost 改经 `events.onCrossSession` 订阅。transport 层 emit（`use-connection.ts:131`）+ raw-message-tap 模块删除。route-inbound 成为消息分发**单一真相源**。

## Alternatives Considered

### A：events 下沉 core（原 DP3）

**否决**：events 持有指向组件/composable 的 handler 引用，进 core 让 core **无法在 node/worker 环境跑**（比"违反端口模式"更硬的约束——core 的核心契约是 headless）。端口注入已满足可测性（core 测试注入 mock TransportPorts 断言 dispatch），下沉是为不存在的收益付代价。

### C：raw-tap 合法化为正规机制

**否决**：raw-tap 是**模块级惰性单例跨越 core/renderer 包边界**（`sharedTap`），测试隔离脆弱。维持它意味着任何 transport 层改动都要考虑 raw-tap 副作用。route-inbound 永远无法成为消息分发单一真相源。

### D：ExtensionHost per-session 订阅

**否决**：本质是"在 ExtensionHost 里重新发明 crossSession 订阅"——要管理所有 session 的订阅生命周期（新增订阅/删除退订/不随切换退订），比显式通道更脆弱。

### E：InboundEffects 回调扩展

**否决**：InboundEffects 的设计意图是"**必须发生的副作用**"（即使无订阅者也执行，如 session.exited→标记 dead），不是"数据流通道"。widget/gui 是结构化数据流（给 ViewHostStore 渲染），经 effect 回调语义错位；且每加一种全局消息要加一个字段，扩展性差。

## Future Direction：条件匹配订阅模型

当前三分模型（session/global/crossSession）是**过渡态，非终态**。终态是按订阅条件组织：

```
消费者声明：{ type: 'extension:widget', sessionId: '*' }   // 全局 widget
route-inbound 对每条消息：匹配所有订阅条件 → 逐个分发
```

届时 crossSession 收敛为 `sessionId: '*'` 的订阅条件，与其他条件无本质区别。

**现在不做条件匹配模型**（events 重写为大工程：改所有 on/onGlobal 调用方 + 替换 handler Map 为匹配引擎）。本 ADR 的 crossSession 通道是这个方向的**第一步路标**——把散落 raw-tap 的全局消费需求正规化为 route-inbound 内显式出口，未来可平滑收敛为条件匹配。**不阻碍终态**。

## Consequences

### 正面
- route-inbound 成为消息分发单一真相源（消除 transport 旁路）
- 补全缺失路由类别（全局消费者订阅带 sid 消息）
- ExtensionHost 消费经正规路由（不再 transport 层偷听）
- 为远程化协同态（busy/idle/presence）铺路

### 负面
- 核心路径改造（route-inbound + events），需特征测试覆盖三类路由
- ST4 widget 收敛依赖 ViewHostStore.getView API（实施前确认/补：ViewHostStore 现为 per-session Map，加 getView 是薄增量）
- crossSession 是过渡态（非终态），Future Direction 标注防当永久形态

## Status 备注

**Proposed** → 待分步实施验证转 Accepted：
1. events 加 crossSession 通道
2. route-inbound 加 CROSS_SESSION_TYPES 规则
3. ExtensionHost 改经 onCrossSession 订阅
4. 删 raw-message-tap（ExtensionHost 行为不变）
5. ST4 widget 收敛（含 ViewHostStore.getView 数据桥）

验证失败（尤其第 4 步删 raw-tap 后 ExtensionHost 收消息异常 / 第 5 步数据桥不可行）则回退重评估。

## 关联

- [ADR-0049](0049-session-isolation-map-partition.md)：per-session 隔离（crossSessionHandlers 若模块级 Map 需补录例外清单，与 subscription-state/events 同类）
- [ADR-0059](0059-core-pinia-store-integration.md)：core/pinia 集成端口模式（TransportPorts.events 延续此范式）
- [renderer-package-topology.md §2](../architecture/renderer-package-topology.md)（原 renderer-target-architecture.md，已改名/删除，git 可追溯）：T&C 层（crossSession 是 T&C 路由出口）
- ST4 candidate（架构审查报告）：widget 双消费收敛，本 ADR 第 5 步落地
