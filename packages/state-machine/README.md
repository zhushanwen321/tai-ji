# @zhushanwen/state-machine

声明式有限状态机基建（taiji 仓「领域状态必须显式状态机」裁决的共享实现载体）。

## 用法

```ts
import { defineStateMachine } from '@zhushanwen/state-machine'

const archiveEntryMachine = defineStateMachine({
  name: 'archive-entry',
  states: { staging: {}, archived: {}, restoring: {} },
  initial: 'staging',
  events: { compress_done: {}, unarchive: {}, restore_done: {}, purge: {} },
  transitions: [
    { from: 'staging', on: 'compress_done', to: 'archived', outputs: ['rewriteLedger'] },
    { from: ['staging', 'archived'], on: 'unarchive', to: 'restoring' },
    { from: 'restoring', on: 'restore_done', to: null }, // null = 实体消亡
    { from: ['staging', 'archived'], on: 'purge', to: null, outputs: ['trashMain'] },
  ],
  errorPolicy: 'throw',
})

const next = archiveEntryMachine.transition('staging', 'compress_done')
// → { ok: true, state: 'archived', planned: { outputs: ['rewriteLedger'] } }

archiveEntryMachine.coerceState(rawDiskString) // → 'staging' | null（词表外/原型链键 → null）
```

- `defineStateMachine`：声明即得类型层词表约束（from/to/on 字面量）+ 定义期自检
  （词表外行 / 同 (from, on) 多行混入无 guard 行 → 定义时 throw）
- `transition`：纯函数内核——guard 按行声明序求值、多命中 = 转移表不变量破坏恒
  throw、planned 只计划不执行（副作用归编排外壳）、`errorPolicy: 'throw' | 'result'`
  每实体声明、`errorFactory` 保形既有错误类型
- `coerceState`：磁盘读回字符串等词表外输入的统一映射入口（枚举 includes 白名单）
- `runTransition`：事务性编排外壳——宿主按名注入动作实现（`actions`），按 planned
  顺序执行、全部成功次态才应用（`{ ok: true, state }`）；任一失败上抛第一个错误
  （单态 fail-fast）；outputs 引用未注入的动作名 → 立即抛 `MissingActionError` 且
  零执行。动作执行上下文 `c` 成员固定 `{ machine, event, from, to }`，宿主附加输入
  经调用点闭包捕获；同步契约（动作返回 Promise 会被 fail-fast 拒绝）

## 测试生成器（testing 子出口）

```ts
import { generateTableTests } from '@zhushanwen/state-machine/testing'

generateTableTests(archiveEntryMachine) // 全状态 × 全事件穷举断言（D5）
```

vitest 仅为 optional peer dependency——只被 `./testing` 子出口触及，运行时出口零依赖。
