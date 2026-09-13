# ADR-0059: core factory 与 pinia store 集成范式（方法访问 + cast 接缝）

**Status**: Proposed（待 ST1 方向 A 落地验证后转 Accepted）
**Date**: 2026-08-06
**Decider**: 架构决策（基于 chat / session 两域 createUseXxx 范式分歧审查 + improve-codebase-architecture grilling）

## Context

### 问题

strangler 迁移中，core 抽出 `createXxxStore` factory（纯 headless）+ `createUseXxx` 编排 factory（业务编排），renderer store 退化为薄壳。但 **core factory 与 pinia store 的集成范式各域不一致**。

现状仅 chat / session 两域有 createUseXxx 编排 factory，范式分歧：

| 域 | createUseXxx 碰 store 字段 `.value` | pinia 集成方式 | 双轨 |
|---|---|---|---|
| **chat**（正确）| **0 次**（经方法/getter 访问）| `getChatStore: () => useChatStore() as unknown as ChatStoreInstance` cast | 无 |
| **session**（债）| **7 次**（`store.activeId.value` / `store.list.value`）| raw `createSessionStore()` 绕 pinia + config.sessions 广播桥接同步到 pinia useSessionStore | 有（raw + pinia + useSessionStoreSafe 桥接，useSidebarNew C-W5-5 接缝 ~60 行）|

### 根因

pinia setup store 的 proxy 会 **unwrap ref/computed**（`store.activeId` 在 pinia 下是值，非 ref）。core factory 的 ref 访问范式（`store.activeId.value`）在 pinia 下 `.value` 失效（undefined）。session 因此被迫绕开 pinia 自建 raw 实例，再桥接同步给旧消费方。

chat 没此问题，因为 createUseChat 经**方法/getter** 访问 store——方法内部在 setup 闭包里持有原始 ref（`.value` 正常工作），pinia 只 unwrap 对外暴露的 ref，不影响方法闭包。

### pinia 是终态保留，非过渡层

[renderer-package-topology.md:116](../architecture/renderer-package-topology.md) 明确："Pinia store 和 composable 是 headless 逻辑的最佳载体，强行"框架无关化"是过度工程"。即 core factory（返回 ref）+ pinia（unwrap ref）的结合是**永久架构**。因此本 ADR 处理的 cast 接缝是永久的，非 strangler 过渡态。

### 主论据：范式分歧不可扩展，session 是「没规则所以走偏」的先例

17 个 renderer store **仅 2 个**（chat / terminal-write-queue）完成 strangler 绞杀，**15 个待迁移**。无统一规则时，每个新域的 createUseXxx 可能重蹈 session 的 raw 双轨。session 正是"没有范式规则，开发者各自解决"的产物。本 ADR 把 chat 的正确范式固化为规则，作为 strangler 后续推进的范式保障。

### 适用范围

本 ADR 针对**有 createUseXxx 编排 factory 的复杂域**（chat / session / subagent / workflow 等业务编排重的域）。简单 store（fileTree / navigation / panel 等）只需薄壳化（defineStore + createXxxStore），无 createUseXxx，不涉及 cast / 方法访问范式——多数待迁移 store 属此类，本 ADR 不强加 cast 给它们。

## Decision

**core factory store 访问范式统一为「方法访问 + pinia cast 接缝」**：

### 1. createUseXxx 编排层：store 封装原则（经公开接口访问，不绕过接口直访内部 ref）

createUseXxx 访问 store 必须经 store **公开接口**（actions + 显式 getters）。读响应式字段用 store 暴露的 getter（`store.getActiveId()`），写用 action（`store.setActiveId(v)`），调业务逻辑用 action（`store.appendUser()`）。**不绕过接口直访内部 ref**（`store.xxx.value`）。

> 原则不是"机械禁止 .value"，而是 **store 封装**：createXxxStore 是 SSOT，决定暴露什么接口；createUseXxx 是消费方，经接口访问。chat 自然遵守（只调 actions，不读响应式字段）；session 编排需读 activeId/list，故 store 补 getter 暴露。

### 2. createXxxStore factory：暴露方法访问层

factory 返回的响应式字段（ref/computed）保留（core 内部响应式 + 单测直接用），但**必须额外暴露方法访问层**（getXxx/setXxx）供 createUseXxx 消费。方法内部在 setup 闭包里 `.value` 访问自己的 ref（pinia/raw 双模式下都正常）。

### 3. pinia 集成接缝：renderer 薄壳 cast（pinia 的固有类型鸿沟，集中可控）

pinia setup store unwrap ref（外部拿到值），与 core factory 返回的 ref 类型不兼容——这是 **pinia 设计的固有代价**（非本 ADR 引入），不可消除（弃 pinia 或弃 core factory 的 ref，均被 renderer-package-topology.md:116 否决）。运行时方法闭包持原始 ref，cast 后方法访问正常工作。

接缝集中在 renderer 薄包装的 getXxxStore getter（chat 实测 2 处，都在 useChat.ts 内），createUseXxx 内部拿到 ChatStoreInstance 类型（干净），消费方零感知：

```ts
defineStore('xxx', () => createXxxStore())           // 薄壳注册 pinia
getXxxStore: () => useXxxStore() as unknown as XxxStoreInstance  // 集中 cast，一处
```

**禁止** raw `createXxxStore()` 双轨 + 桥接同步（如 useSidebarNew C-W5-5 模式）——双轨比 cast 代价大得多（~60 行桥接 + 同步漂移风险）。

### 4. 现有 session 域按本 ADR 收敛（ST1）

createUseSession 的 7 处 `store.xxx.value` → 方法访问；createSessionStore 补 getActiveId/setActiveId/getList 方法；session.ts 薄壳化；useSidebarNew 删 raw + 桥接，改 cast。

## Alternatives Considered

### A：接受 raw 双轨（session 现状）

**否决**：双轨 + 桥接是债（useSidebarNew ~60 行接缝），不可扩展到 15 个待迁移 store。每域各搞桥接 = 维护灾难。

### B：core factory 不用 pinia，全 raw

**否决**：失去 pinia devtools / 响应式集成 / 模块热替换。pinia 是项目既定状态管理（renderer-rebuild:116），core factory 应兼容而非排斥。

### C：storeToRefs 解构

**否决**：(a) 仍需处理 cast 类型鸿沟；(b) createUseXxx 持有解构 ref 仍需 `.value` 访问，没解决根本范式问题；(c) 方法访问更彻底（chat 已验证完全够用）。

## Consequences

### 正面
- 统一范式：新域 createXxxStore + createUseXxx 有规则可循
- session 收敛有承重依据（ST1 方向 A）
- 消除 raw/pinia 双轨 + 桥接同步债
- strangler 后续 store 绞杀有范式保障

### 负面
- createXxxStore 需补方法访问层（仅当 createUseXxx 要读响应式字段时；chat 只调 actions，无需补）
- createUseSession 改造（ST1，约 7 处 `.value` → getter/action）
- `as unknown as` cast 是 pinia + core factory 结合的**固有类型鸿沟**（pinia unwrap ref 的设计代价，非本 ADR 引入）。集中在 renderer 薄包装 getXxxStore，createUseXxx 内部与消费方零感知。代价可接受——替代方案（raw 双轨 / 弃 pinia / 弃 core factory ref）都被否决。

### 迁移
- **session**：按 ST1 方向 A 收敛（本 ADR 落地的首个实践，验证范式可复制）
- **其他 store 绞杀时**遵循本 ADR：createXxxStore 补方法访问层 + createUseXxx 方法访问 + cast 接缝

## Status 备注

**Proposed** → 待 ST1 方向 A 落地 + 验证（createUseSession 方法访问改造可行 + useSidebarNew 去双轨后行为不变 + 测试全绿）→ **Accepted**。验证失败则回退并重评估 Alternatives。建议至少再经 1 个新域（subagent/workflow 绞杀时）验证后再转 Accepted。

## 关联

- [renderer-package-topology.md:116](../architecture/renderer-package-topology.md)：pinia 是 headless 载体的终态定位（本 ADR 的前提）
- [ADR-0049](0049-session-isolation-map-partition.md)：per-session 隔离范式（本 ADR 的 store 访问范式与隔离范式正交，不冲突）
- [ADR-0058](0058-dom-core-package.md)：dom-core 包划分（core headless 边界，本 ADR 在该边界上定义 store 集成范式）
- chat 域 [README.md](../../packages/core/src/domain/chat/README.md) IF1 契约：factory + 薄壳范式标杆（本 ADR 的正确范式来源）
- ST1 candidate（架构审查报告绞杀类）：本 ADR 的首个落地实践
