/**
 * createInflightDedup 工厂单测（impl-plan U7a）。
 *
 * 覆盖 C-data-18 收编原语的全部内建不变量：
 * - 同 key 并发 run 共享同一 entry（fn 仅发起一次）
 * - 不同 key 并行互不干扰
 * - settle 即清（成功 / 失败两条腿）
 * - 引用比对防误删（慢请求后到 settle 不误删后发起的新 entry）
 * - 失败传播给调用方 + 清理 + 不产生 unhandled rejection
 * - 单键退化形态（固定 key 的单 Promise 变量形态）
 * - 元数据携带形态（发起时刻捕获，复用者共享同一份）
 * - dispose/clear 面（delete / keys 快照 / clear）
 * - fn 同步抛（无条目残留，异常上抛）
 *
 * 运行：cd packages/core && pnpm vitest run src/foundation/create-inflight-dedup.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, vi } from 'vitest'
import { createInflightDedup } from './create-inflight-dedup'

/** 受控 deferred：测试手动决定 promise 何时 settle（模拟慢请求 / 乱序 settle） */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 微任务 flush：让 settle 派生的清理回调（then 双分支）执行完毕 */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then().then()
}

describe('U7a createInflightDedup: 去重不变量', () => {
  it('同 key 并发 run 共享同一 promise（fn 仅发起一次）', () => {
    const dedup = createInflightDedup<number>()
    const d = deferred<number>()
    const fn = vi.fn(() => d.promise)

    const first = dedup.run('sid-1', fn)
    const second = dedup.run('sid-1', fn)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(second.promise).toBe(first.promise)
    expect(second).toBe(first)
    expect(dedup.has('sid-1')).toBe(true)
  })

  it('不同 key 并行互不干扰（各自发起、各自 settle 清理）', async () => {
    const dedup = createInflightDedup<number>()
    const d1 = deferred<number>()
    const d2 = deferred<number>()
    const fn1 = vi.fn(() => d1.promise)
    const fn2 = vi.fn(() => d2.promise)

    const e1 = dedup.run('a', fn1)
    const e2 = dedup.run('b', fn2)

    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
    expect(e2.promise).not.toBe(e1.promise)
    expect(dedup.keys().sort()).toEqual(['a', 'b'])

    // e1 先 settle：只清 a，b 不受影响
    d1.resolve(1)
    await e1.promise
    await flushMicrotasks()
    expect(dedup.has('a')).toBe(false)
    expect(dedup.has('b')).toBe(true)

    d2.resolve(2)
    expect(await e2.promise).toBe(2)
    await flushMicrotasks()
    expect(dedup.has('b')).toBe(false)
  })

  it('settle 后可再发起：同 key 下次 run 是新 promise', async () => {
    const dedup = createInflightDedup<number>()
    const d1 = deferred<number>()
    const fn = vi.fn(() => d1.promise)

    const first = dedup.run('k', fn)
    d1.resolve(10)
    expect(await first.promise).toBe(10)
    await flushMicrotasks()
    expect(dedup.has('k')).toBe(false)

    // settle 后再 run：重新发起（无条件恢复腿，不依赖缓存时效）
    const d2 = deferred<number>()
    fn.mockReturnValue(d2.promise)
    const second = dedup.run('k', fn)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(second.promise).not.toBe(first.promise)
    d2.resolve(20)
    expect(await second.promise).toBe(20)
  })
})

describe('U7a createInflightDedup: 引用比对防误删', () => {
  it('先发起的慢请求 settle 时不误删后发起的新 entry', async () => {
    const dedup = createInflightDedup<number>()
    const slow = deferred<number>()
    const fn = vi.fn(() => slow.promise)

    // 1. 慢请求发起（外部随后把条目清掉——如 dispose / invalidate）
    const slowEntry = dedup.run('sid', fn)
    expect(dedup.has('sid')).toBe(true)

    // 2. 条目被外部删除，同 key 新请求发起（新 entry 覆盖槽位）
    dedup.delete('sid')
    const fresh = deferred<number>()
    fn.mockReturnValue(fresh.promise)
    const freshEntry = dedup.run('sid', fn)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(dedup.has('sid')).toBe(true)

    // 3. 慢请求后到 settle：引用比对发现槽位已不是自己 → 不删除（新 entry 保留）
    slow.resolve(1)
    await slowEntry.promise
    await flushMicrotasks()
    expect(dedup.has('sid')).toBe(true)

    // 4. 新 entry settle 才清理自己的槽位
    fresh.resolve(2)
    await freshEntry.promise
    await flushMicrotasks()
    expect(dedup.has('sid')).toBe(false)
  })

  it('clear 后同 key 新 entry 同样不被旧 promise 的 settle 误删', async () => {
    const dedup = createInflightDedup<number>()
    const old = deferred<number>()
    const fn = vi.fn(() => old.promise)

    const oldEntry = dedup.run('k', fn)
    dedup.clear()

    const fresh = deferred<number>()
    fn.mockReturnValue(fresh.promise)
    const freshEntry = dedup.run('k', fn)
    expect(dedup.has('k')).toBe(true)

    old.resolve(0)
    await oldEntry.promise
    await flushMicrotasks()
    // 旧 promise settle 后新 entry 仍在
    expect(dedup.has('k')).toBe(true)

    fresh.resolve(9)
    expect(await freshEntry.promise).toBe(9)
    await flushMicrotasks()
    expect(dedup.has('k')).toBe(false)
  })
})

describe('U7a createInflightDedup: 失败传播与清理', () => {
  it('reject 传播给调用方 + settle 即清 + 可重试', async () => {
    const dedup = createInflightDedup<number>()
    const boom = deferred<number>()
    const fn = vi.fn(() => boom.promise)

    const entry = dedup.run('k', fn)
    const rejection = new Error('rpc failed')
    boom.reject(rejection)

    await expect(entry.promise).rejects.toBe(rejection)
    await flushMicrotasks()
    expect(dedup.has('k')).toBe(false)

    // 失败可重试：下次 run 重新发起
    const retry = deferred<number>()
    fn.mockReturnValue(retry.promise)
    const retryEntry = dedup.run('k', fn)
    expect(fn).toHaveBeenCalledTimes(2)
    retry.resolve(7)
    expect(await retryEntry.promise).toBe(7)
  })

  it('失败腿同样受引用比对保护（reject 的旧 promise 不误删新 entry）', async () => {
    const dedup = createInflightDedup<number>()
    const doomed = deferred<number>()
    const fn = vi.fn(() => doomed.promise)

    const doomedEntry = dedup.run('k', fn)
    dedup.delete('k')
    const fresh = deferred<number>()
    fn.mockReturnValue(fresh.promise)
    dedup.run('k', fn)

    doomed.reject(new Error('late failure'))
    await expect(doomedEntry.promise).rejects.toThrow('late failure')
    await flushMicrotasks()
    expect(dedup.has('k')).toBe(true)
  })

  it('settle 清理链不产生 unhandled rejection（调用方未 attach 任何回调时）', async () => {
    // factory 内部 then 双分支已接管 rejection：调用方完全忘记 catch 也不触发
    // unhandled rejection 告警（vitest 对 unhandled rejection 会判用例失败）
    const dedup = createInflightDedup<number>()
    const d = deferred<number>()
    dedup.run('k', () => d.promise)
    d.reject(new Error('nobody awaits me'))
    // 多轮微任务 flush 让潜在的 unhandled rejection 信号暴露
    await flushMicrotasks()
    await flushMicrotasks()
    expect(dedup.has('k')).toBe(false)
  })
})

describe('U7a createInflightDedup: 单键退化形态', () => {
  it('固定 key 常量覆盖单 Promise 变量形态（useProjectSkills globalInFlight 类）', async () => {
    const SINGLE_KEY = 'global'
    const dedup = createInflightDedup<string[]>()
    const d = deferred<string[]>()
    const fn = vi.fn(() => d.promise)

    // 首次调用发起，并发调用复用同一 promise（等价于「in-flight 存在则 await 它」）
    const first = dedup.run(SINGLE_KEY, fn)
    const second = dedup.run(SINGLE_KEY, fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(second.promise).toBe(first.promise)

    d.resolve(['a', 'b'])
    expect(await first.promise).toEqual(['a', 'b'])
    await flushMicrotasks()

    // settle 即清等价于「finally 置 null」：下次调用重新发起
    const next = deferred<string[]>()
    fn.mockReturnValue(next.promise)
    const third = dedup.run(SINGLE_KEY, fn)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(third.promise).not.toBe(first.promise)
    next.resolve(['c'])
    expect(await third.promise).toEqual(['c'])
  })
})

describe('U7a createInflightDedup: 元数据携带形态', () => {
  it('meta 在发起时刻捕获，并发复用者共享同一份（useGenStats seqAtIssue 语义）', async () => {
    const dedup = createInflightDedup<string, { seqAtIssue: number }>()
    const d = deferred<string>()
    const replies: Array<{ reply: string; seqAtIssue: number }> = []

    // 发起方：live 帧序号此刻是 5
    const issuer = dedup.run('sid', () => d.promise, { seqAtIssue: 5 })
    // 复用方 attach 时序号已 bump 到 6——但必须拿到发起时刻的 5（entry 共享）
    const reuser = dedup.run('sid', () => d.promise, { seqAtIssue: 6 })
    expect(reuser).toBe(issuer)
    expect(reuser.meta.seqAtIssue).toBe(5)

    // 双方各自 attach then 读同一 meta 消费结果（split panel 双实例形态）
    void issuer.promise.then((reply) => replies.push({ reply, seqAtIssue: issuer.meta.seqAtIssue }))
    void reuser.promise.then((reply) => replies.push({ reply, seqAtIssue: reuser.meta.seqAtIssue }))

    d.resolve('frame')
    await flushMicrotasks()
    expect(replies).toEqual([
      { reply: 'frame', seqAtIssue: 5 },
      { reply: 'frame', seqAtIssue: 5 },
    ])
  })

  it('无元数据形态 entry.meta 为 undefined（M=void 默认）', async () => {
    const dedup = createInflightDedup<number>()
    const d = deferred<number>()
    const entry = dedup.run('k', () => d.promise)
    expect(entry.meta).toBeUndefined()
    d.resolve(1)
    expect(await entry.promise).toBe(1)
  })
})

describe('U7a createInflightDedup: dispose/clear 面', () => {
  it('keys() 返回快照副本，迭代中删除安全（subscription-state invalidate 前缀失效形态）', () => {
    const dedup = createInflightDedup<number>()
    const mk = (): Promise<number> => deferred<number>().promise
    dedup.run('sid-1', mk)
    dedup.run('sid-1:42', mk)
    dedup.run('sid-2', mk)
    dedup.run('sid-2:7', mk)

    // 按 sid 前缀批量失效（invalidateSubscription 形态）
    const sid = 'sid-1'
    for (const key of dedup.keys()) {
      if (key === sid || key.startsWith(`${sid}:`)) dedup.delete(key)
    }
    expect(dedup.keys().sort()).toEqual(['sid-2', 'sid-2:7'])
    expect(dedup.has('sid-1')).toBe(false)
    expect(dedup.has('sid-1:42')).toBe(false)
  })

  it('clear() 清空全部条目（dispose 钩子 / 测试隔离）', () => {
    const dedup = createInflightDedup<number>()
    const mk = (): Promise<number> => deferred<number>().promise
    dedup.run('a', mk)
    dedup.run('b', mk)
    dedup.clear()
    expect(dedup.keys()).toEqual([])
    expect(dedup.has('a')).toBe(false)
    expect(dedup.has('b')).toBe(false)
  })

  it('settle 清理时序：调用方回调执行时条目已清（可安全再 run）', async () => {
    const dedup = createInflightDedup<number>()
    const d = deferred<number>()
    const entry = dedup.run('k', () => d.promise)

    // 调用方 then 回调（注册在 factory 清理回调之后）执行时，条目应已清理
    let hasInsideCallback = true
    void entry.promise.then(() => {
      hasInsideCallback = dedup.has('k')
    })
    d.resolve(1)
    await flushMicrotasks()
    expect(hasInsideCallback).toBe(false)
  })
})

describe('U7a createInflightDedup: fn 同步抛', () => {
  it('同步异常向上传播且不登记条目（下次 run 可正常发起）', () => {
    const dedup = createInflightDedup<number>()
    const boom = (): Promise<number> => {
      throw new Error('sync throw')
    }

    expect(() => dedup.run('k', boom)).toThrow('sync throw')
    expect(dedup.has('k')).toBe(false)

    // 条目未登记：下次 run 正常发起
    const d = deferred<number>()
    const entry = dedup.run('k', () => d.promise)
    expect(dedup.has('k')).toBe(true)
    d.resolve(3)
    void entry.promise.catch(() => {})
  })
})
