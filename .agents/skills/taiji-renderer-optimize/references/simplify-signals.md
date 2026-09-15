# Simplify Signals — 项目特化简化信号清单

审查者必读。本文件只列 **taiji renderer 特有**的信号；通用简化信号（未使用代码、重复逻辑、冗余抽象、命名不清、嵌套过深、死参数等）照常适用——完整通用清单在 `~/.agents/skills/code-simplify/references/review-signals.md`，有权限时读它，读不到就按上述类别自行覆盖，不得因读不到而跳过通用信号审查。

## 1. 范式一致性信号（最高优先级）

### per-session 状态（ADR-0049）

- **信号**：composable 持有 per-session 状态但没走 `useSessionScopedState` 工厂——实例级状态、`watch(sessionId)` 手动清空、模块级裸对象按 sid 拼 key。
- **正确范式**：`useSessionScopedState`（init 返回 reactive 容器；null sid 不写 Map）；WS handler 用 `updateFor(capturedSid)` 不用 `update`。
- **反向信号（勿提）**：把现有 Map 分区"简化"成单实例状态 = 破坏 session 隔离，禁止提议。
- **参照**：`stores/turn-expansion.ts`（外层故意非响应式 plain Map + 内层 reactive Map，注释解释了为什么）；`components/panel/MessageStream.vue`（turnCacheState）。

### 事件订阅（standards §2.2）

- **信号**：可能被多实例化的 composable（split mode 下同组件多实例）直接 `on()` 而无模块级 refCount 保护；或有 refCount 但缺 `onScopeDispose` 归零退订。
- **正确范式**：模块级 `subCount` + `onScopeDispose`；refCount !== 1 早退、归零退订。
- **参照**：`composables/features/sidebar/useSidebar.ts`、`composables/features/settings/useAppUpdate.ts`（最完整实现）。
- **emit 契约**：`emit('event', { ... })` 只传单个 payload 对象，多参数 emit 是 bug 不是风格问题。

### 消息体不可变性（ADR-0039）

- **信号**：对 messages 数组/消息对象做原地 mutation（`msg.parts.push(...)`、`arr[i] = ...`）或深响应式化；正确范式是浅拷贝替换 + shallowRef。
- **信号**：新增 `JSON.parse(JSON.stringify(...))` 深拷贝——本 skill 三包范围内目前无此热点（范围外的 runtime/extensions 有既存用法，不在审查范围），新增即审查点。

### session 隔离（三层）

- **信号**：runtime → 前端消息处理未校验 `sessionId`、ChatStore 未按 Map 分区、PaneSessionView 未过滤。修复方向永远是补 sessionId 路由，不是加锁/加时序。

## 2. 样式三层信号

层级 SSOT：tokens（`src/style.css` 只放 CSS 变量 + reset）→ Tailwind 工具类（组件样式统一在此）→ `<style scoped>` 仅 escape hatch。

- **信号**：`<style scoped>` 写了动画/伪元素/Transition 类**以外**的属性——vue_rules_checker 的意图是 scoped CSS 只作 escape hatch（豁免动画/伪元素/Transition 类；后代选择器是 de facto 放行），其余必须 inline style 或 Tailwind 类（参照 `MessageStream.vue` 尾部 overflowAnchor inline 的处理与注释）。注意检查器有白名单文件（如 `shell/MainPanel.vue` 可写任意 scoped CSS），白名单内文件不适用本信号。
- **信号**：硬编码颜色（`#xxx`/`rgb()`）或魔数间距——必须用 CSS 变量与标准 Tailwind scale。
- **信号**：`@apply`——禁止，样式归 Tailwind 工具类层。
- **信号**：border-radius 裸值——遵循 v3 tokens（`--radius-sm:3px` 默认 / `--radius:8px` / `--radius-lg:12px`）。
- **反向信号**：把合法的 scoped 动画/伪元素"简化"掉 = 破坏 escape hatch 机制。

## 3. 组件规范信号

- **信号**：原生 HTML 表单元素（`<input>`/`<select>`/`<button>` 裸用）——必须用 @taiji/ui 组件（taste-lint no-native-html 会拦，存量漏网的是简化候选）。
- **信号**：emoji 字符——必须 inline `<svg>` / @lucide/vue。
- **信号**：`:value` + `@input` 手写绑定——必须 `v-model`。
- **信号**：`<template>` > 400 行 / `<script setup>` > 300 行——拆分候选（vue_rules_checker 会拦新增，存量是候选）。
- **信号**：`any` 类型或缺运行时 guard 的类型断言。
- **信号**：多个独立数据源串行 `await`——`Promise.allSettled` 并行。
- **信号**：v-html 使用——standards §7 有包装陷阱约束，新增 v-html 是审查点。

## 4. 渲染链路特有信号

- **信号**：对 `renderItems`/消息列表做全量重建（每次 streaming 全量 map）——已有 `toRenderItemsIncremental` 增量缓存，绕开它是回退。
- **信号**：在 `<Virtualizer>` 子项里放会随 streaming 频繁重建的响应式对象——破坏"视口内历史 Turn 不被 patch"的增量性质。
- **信号**：跨 session 共享测量/缓存状态——Virtualizer 靠 `:key=sessionId` 重建隔离，绕过它是 bug。
- **信号**：markdown 渲染绕开 deps 注入（`ChatViewDepsKey`）直接 import——破坏包边界（renderer 壳层经 `composables/panel/useChatViewDeps.ts` 注入）。

## 5. 死代码与重复

- 通用死代码信号（未引用导出、注释掉的整块代码、永不命中的分支）照常适用，但注意：
  - `[HISTORICAL]` 注释块不是死代码，是事故档案，**禁止删除**。
  - `_virtua-mock-helper.ts` 等测试基建被测试间接引用，静态分析可能误报未引用——删前先 `rg` 全仓（含 `__tests__`）核实。
- 重复判定以**模式**为单位不以文本为单位：三处长得像的 Map 分区写法是**有意重复**（ADR-0049 范式），合并成抽象前先确认是否违反"一致性 > 品味"。

## 冲突裁决

通用简化建议与本文件信号冲突时，以本文件为准；本文件与 ADR/constraints.json 冲突时，以 ADR/constraints.json 为准并回报漂移。
