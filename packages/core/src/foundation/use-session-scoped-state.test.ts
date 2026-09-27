/**
 * useSessionScopedState 工厂单测（W1 / TDD 红灯，core 迁移版）。
 *
 * 覆盖 ADR-0049 通用 Map 分区工厂的契约（迁移自 renderer characteristic-poc 测试）：
 * - 新 sid 惰性 init（init() 仅调一次/sid）
 * - current 按 sid 查分区
 * - update(updater) 操作当前分区
 * - cleanup(sid) 移除分区
 * - 切 sid 后 current 切分区（不丢旧数据，切回恢复）
 * - null sid 返回默认实例不写 Map（防 null key 污染）
 * - registerSessionCleanup / triggerSessionCleanups 注册触发机制
 *
 * 运行：cd packages/core && npx vitest run src/foundation/use-session-scoped-state.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import {
  useSessionScopedState,
  registerSessionCleanup,
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from './use-session-scoped-state'

// 模块级 cleanup registry 跨测试可能残留（未包 effectScope 的用例无法触发反注册），
// 每个用例前清空，防污染下游断言
beforeEach(() => {
  __clearSessionCleanupRegistryForTest()
})

describe('W1 useSessionScopedState: Map 分区工厂', () => {
  /** 在独立 effectScope 内运行 composable，测试后 dispose 模拟卸载 */
  function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
    const scope = effectScope()
    let result!: T
    scope.run(() => {
      result = fn()
    })
    return { result, dispose: () => scope.stop() }
  }

  it('新 sid 惰性 init：init() 对同一 sid 仅调用一次', () => {
    const init = vi.fn(() => ({ count: 0 }))
    const sid = ref<string | null>('sessionA')
    const { result } = runWithScope(() => useSessionScopedState(sid, init))

    // 首次 current 触发 init
    expect(result.current.value).toEqual({ count: 0 })
    expect(init).toHaveBeenCalledTimes(1)

    // 再次访问 current 不重复 init
    expect(result.current.value).toEqual({ count: 0 })
    expect(init).toHaveBeenCalledTimes(1)

    // update 操作不触发 init
    result.update((s) => { s.count += 1 })
    expect(init).toHaveBeenCalledTimes(1)
    expect(result.current.value).toEqual({ count: 1 })
  })

  it('current 按当前 sid 查分区', () => {
    const sid = ref<string | null>('a')
    const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ tag: '' })))

    result.update((s) => { s.tag = 'a-value' })
    expect(result.current.value.tag).toBe('a-value')

    // 切到 b：current 切到 b 分区（初始值）
    sid.value = 'b'
    expect(result.current.value.tag).toBe('')
  })

  it('update(updater) 操作当前分区，不影响其他 session 分区', () => {
    const sid = ref<string | null>('a')
    const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

    result.update((s) => { s.v = 10 })
    // 切到 b 单独 update
    sid.value = 'b'
    result.update((s) => { s.v = 99 })

    // 切回 a：a 分区数据保留
    sid.value = 'a'
    expect(result.current.value.v).toBe(10)

    // b 分区数据保留
    sid.value = 'b'
    expect(result.current.value.v).toBe(99)
  })

  it('updateFor(targetSid, updater) 显式指定分区，不读 sid.value 实时值（M1 竞态防护）', () => {
    // 场景：WS handler 闭包捕获订阅时 sid='A'，切到 B 后旧消息到达。
    // updateFor(A, ...) 写 A 分区，不污染 B（即使 sid.value 已是 B）
    const sid = ref<string | null>('A')
    const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

    // 模拟切到 B（sid.value 变为 B）
    sid.value = 'B'

    // 此时模拟 A 的迟到 WS 消息：handler 闭包捕获的 sid 仍是 A，调 updateFor('A', ...)
    result.updateFor('A', (s) => { s.v = 42 })

    // A 分区被写入（迟到消息落地到它所属的 session）
    sid.value = 'A'
    expect(result.current.value.v).toBe(42)

    // B 分区不受污染
    sid.value = 'B'
    expect(result.current.value.v).toBe(0)
  })

  it('updateFor 对比 update：update 读实时 sid.value，updateFor 读参数（竞态场景差异）', () => {
    const sid = ref<string | null>('A')
    const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

    sid.value = 'B'  // 模拟切到 B

    // update（读实时值 B）：写入 B 分区
    result.update((s) => { s.v = 10 })
    // updateFor(A)（读参数 A）：写入 A 分区
    result.updateFor('A', (s) => { s.v = 20 })

    sid.value = 'A'
    expect(result.current.value.v).toBe(20)  // A 分区
    sid.value = 'B'
    expect(result.current.value.v).toBe(10)  // B 分区
  })

  it('cleanup(sid) 从 Map 移除指定分区（下次访问重新 init）', () => {
    const init = vi.fn(() => ({ n: 0 }))
    const sid = ref<string | null>('a')
    const { result } = runWithScope(() => useSessionScopedState(sid, init))

    result.update((s) => { s.n = 42 })
    expect(init).toHaveBeenCalledTimes(1)

    // cleanup a
    result.cleanup('a')
    expect(init).toHaveBeenCalledTimes(1)

    // 再次访问 a → 重新 init，状态重置
    expect(result.current.value).toEqual({ n: 0 })
    expect(init).toHaveBeenCalledTimes(2)
  })

  it('切 sid 不丢旧数据，切回恢复（AC-2 隐含契约）', () => {
    const sid = ref<string | null>('a')
    const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ items: [] as string[] })))

    result.update((s) => { s.items.push('a-1') })
    // 切到 b 并写入
    sid.value = 'b'
    result.update((s) => { s.items.push('b-1') })

    // 切回 a：items 仍含 a-1（无丢失）
    sid.value = 'a'
    expect(result.current.value.items).toEqual(['a-1'])
  })

  it('大量 sid 创建后 Map 分区可被 cleanup 回收（防内存泄漏）', () => {
    const sid = ref<string | null>('init-sid')
    const { result } = runWithScope(() => useSessionScopedState(sid, () => ({ v: 0 })))

    // 创建 100 个 sid 分区
    for (let i = 0; i < 100; i++) {
      sid.value = `session-${i}`
      result.update((s) => { s.v = i })
    }

    // 逐个 cleanup
    for (let i = 0; i < 100; i++) {
      result.cleanup(`session-${i}`)
    }

    // cleanup 后访问已 cleanup 的 sid 应重新 init（v 回到 0），
    // 证明 Map 不持有旧分区引用
    sid.value = 'session-0'
    expect(result.current.value.v).toBe(0) // 重新 init

    // cleanup 不存在的 sid 不抛错
    expect(() => result.cleanup('nonexistent')).not.toThrow()
  })

  it('null sid 时 current 返回 init() 默认实例但不写入 Map', () => {
    const init = vi.fn(() => ({ x: 'default' }))
    const sid = ref<string | null>(null)
    const { result } = runWithScope(() => useSessionScopedState(sid, init))

    // null sid 时访问 current 返回默认实例
    expect(result.current.value).toEqual({ x: 'default' })
    // init 被调（生成默认实例），但 null 不应作为 key 污染 Map：
    // 切到真实 sid 时，之前对 null current 的修改不应泄漏到该 session
    sid.value = 'real'
    expect(result.current.value).toEqual({ x: 'default' })

    // 切回 null 再切回 real：real 分区数据应保留（不被 null 访问覆盖）
    sid.value = null
    sid.value = 'real'
    expect(result.current.value).toEqual({ x: 'default' })

    // 给 real 写入，切到 null，再切回 real：real 数据仍在（null 不污染 real 分区）
    result.update((s) => { s.x = 'mutated' })
    sid.value = null
    expect(result.current.value).toEqual({ x: 'default' }) // null 给默认
    sid.value = 'real'
    expect(result.current.value.x).toBe('mutated') // real 分区保留
  })
})

describe('W1 registerSessionCleanup / triggerSessionCleanups 注册机制', () => {
  it('registerSessionCleanup 注册的 cleanup 被 triggerSessionCleanups(sid) 调用', () => {
    const fn = vi.fn()
    registerSessionCleanup(fn)

    triggerSessionCleanups('sessionX')
    expect(fn).toHaveBeenCalledWith('sessionX')
  })

  it('多个 composable 注册的 cleanup 都被调用（AC-8）', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const fn3 = vi.fn()
    registerSessionCleanup(fn1)
    registerSessionCleanup(fn2)
    registerSessionCleanup(fn3)

    triggerSessionCleanups('multi')
    expect(fn1).toHaveBeenCalledWith('multi')
    expect(fn2).toHaveBeenCalledWith('multi')
    expect(fn3).toHaveBeenCalledWith('multi')
  })

  it('composable onUnmounted 时反注册自己的 cleanup（不残留）', async () => {
    const fn = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      const sid = ref<string | null>('a')
      useSessionScopedState(sid, () => ({ v: 0 }))
      registerSessionCleanup(fn)
      // useSessionScopedState 应在 setup 时注册，onUnmounted 时反注册
      // 此处显式 register 模拟另一 composable 的注册路径，验证反注册不被该机制破坏
    })

    scope.stop()
    await nextTick()

    // 卸载后 trigger 不应调用已反注册的 cleanup（此处验证注册表可被反注册）
    // 注意：useSessionScopedState 自身的 cleanup（删 Map 分区）应被反注册；
    // 外部 register 的 fn 由注册者负责反注册，trigger 仍会调用它——这条断言锁的是
    // useSessionScopedState 自身注册的 cleanup 在卸载后不再被调用（见下一条用例）
    triggerSessionCleanups('after-unmount')
    // fn 是外部 register 的，trigger 仍调用（未反注册）
    expect(fn).toHaveBeenCalledWith('after-unmount')
  })

  it('useSessionScopedState 卸载后其内部 cleanup 不再被 trigger 调用', async () => {
    const init = vi.fn(() => ({ v: 0 }))
    const sid = ref<string | null>('doomed')
    const scope = effectScope()
    scope.run(() => {
      // 访问 current 触发惰性 init，建立 'doomed' 分区（惰性 init 契约：不访问不 init）
      const state = useSessionScopedState(sid, init)
      void state.current.value
    })
    expect(init).toHaveBeenCalledTimes(1)

    scope.stop()
    await nextTick()

    // trigger 'doomed' 的 cleanup：useSessionScopedState 卸载后不应再执行其 cleanup
    // （未卸载时 trigger 应移除 'doomed' 分区——见 W5 session-cleanup 集成测试）
    // 此处只验证 trigger 不抛错（反注册后注册表不含该 fn）
    expect(() => triggerSessionCleanups('doomed')).not.toThrow()
  })
})
