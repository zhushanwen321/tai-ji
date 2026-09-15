/**
 * pending 注册表补充单测 —— [Q1-5] 共享 sweep timer 超时批量清理、timeoutMs=0 无超时、
 * 容量上限驱逐最老（overflow）、has / reject / rejectAll / 未知 id no-op。
 * 现有 resolveEnvelope 细节在 pending.test.ts，本文件补齐注册表自身行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createCommandId, register, resolve, reject, has, rejectAll,
} from '../pending'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  // 清空残留 pending，防止跨用例污染（rejectAll 同时 disarm sweep timer）；
  // 各用例自行 settle 或挂 catch，此处无未处理 rejection
  rejectAll(new Error('teardown'))
  vi.useRealTimers()
})

describe('pending 注册表 — 超时 sweep（[Q1-5]）', () => {
  it('到期 reject（code=timeout）+ 清理条目', async () => {
    const id = createCommandId()
    const p = register(id, 1_000)
    const expectation = expect(p).rejects.toMatchObject({ code: 'timeout', message: 'request timeout after 1000ms' })
    await vi.advanceTimersByTimeAsync(1_001)
    await expectation
    expect(has(id)).toBe(false)
  })

  it('迟到的 resolve 对已超时条目 no-op（不抛、不重复 settle）', async () => {
    const id = createCommandId()
    const p = register(id, 500)
    const expectation = expect(p).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(501)
    await expectation
    expect(() => resolve(id, 'late')).not.toThrow()
  })

  it('timeoutMs=0 禁用超时：到期后仍可正常 resolve', async () => {
    const id = createCommandId()
    const p = register<string>(id, 0)
    await vi.advanceTimersByTimeAsync(10_000)
    resolve(id, 'ok')
    await expect(p).resolves.toBe('ok')
  })

  it('最近 deadline 驱动 sweep：先短后长两条都按时清理', async () => {
    const idShort = createCommandId()
    const idLong = createCommandId()
    const pShort = register(idShort, 100)
    const pLong = register(idLong, 5_000)
    const eShort = expect(pShort).rejects.toMatchObject({ code: 'timeout' })
    const eLong = expect(pLong).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(101)
    await eShort
    await vi.advanceTimersByTimeAsync(5_000)
    await eLong
  })

  it('后注册更早 deadline 时 sweep timer 重挂到更近触发点', async () => {
    const idLate = createCommandId()
    const idEarly = createCommandId()
    const pLate = register(idLate, 10_000)
    const pEarly = register(idEarly, 100)
    const eEarly = expect(pEarly).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(101)
    await eEarly
    // 早条目清理后晚条目仍存活，可正常 resolve
    resolve(idLate, 'ok')
    await expect(pLate).resolves.toBe('ok')
  })

  it('resolve/reject 后 sweep timer 重算：末条目完成不再空转触发', async () => {
    const id = createCommandId()
    const p = register(id, 200)
    resolve(id, 'done')
    await expect(p).resolves.toBe('done')
    // 无 pending 时推进原 deadline，不应有任何未捕获 reject
    await vi.advanceTimersByTimeAsync(1_000)
  })
})

describe('pending 注册表 — 容量与批量清理', () => {
  it('超限（≥256）驱逐最老：oldest reject code=overflow，新条目正常注册', async () => {
    const oldest = createCommandId()
    const pOldest = register(oldest, 0)
    const eOldest = expect(pOldest).rejects.toMatchObject({ code: 'overflow' })
    for (let i = 0; i < 300; i++) {
      // catch 吸附驱逐/teardown reject，防 unhandled rejection（条目本身不逐条断言）
      register(createCommandId(), 0).catch(() => {})
    }
    await eOldest
    // 最新注册的条目仍存活可 resolve
    const newest = createCommandId()
    const pNewest = register<string>(newest, 0)
    resolve(newest, 'ok')
    await expect(pNewest).resolves.toBe('ok')
  })

  it('has 区分注册中 / 已完成条目（广播误吞防线的判定依据）', async () => {
    const id = createCommandId()
    register(id, 0)
    expect(has(id)).toBe(true)
    resolve(id, 'x')
    expect(has(id)).toBe(false)
    expect(has('ghost')).toBe(false)
  })

  it('reject：settled promise rejects + 未知 id no-op', async () => {
    const id = createCommandId()
    const p = register(id, 0)
    reject(id, new Error('rpc failed'))
    await expect(p).rejects.toThrow('rpc failed')
    expect(() => reject('ghost', new Error('x'))).not.toThrow()
    expect(() => resolve('ghost', 'x')).not.toThrow()
  })

  it('rejectAll：全部 reject + map 清空（WS 断连场景）', async () => {
    const ids = [createCommandId(), createCommandId(), createCommandId()]
    const ps = ids.map((id) => register(id, 0).catch((e: unknown) => e))
    rejectAll(new Error('disconnected'))
    const results = await Promise.all(ps)
    for (const r of results) {
      expect(r).toBeInstanceOf(Error)
    }
    for (const id of ids) {
      expect(has(id)).toBe(false)
    }
  })
})
