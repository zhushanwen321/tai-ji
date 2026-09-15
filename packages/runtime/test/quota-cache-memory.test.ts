/**
 * W26（00 §5 微项 11）：quota 缓存内存层。
 *
 * QuotaCache.getEntry 命中内存零磁盘读（hover 浮层反复 getCached 不再每次
 * readFileSync 整个 quota-cache.json）。磁盘持久化语义不变（update 原子写 +
 * 读-改-写串行化，微项只加读加速层）。
 *
 * 验收：quota 重复查询命中内存层（readFileSync mock 计数不增长）。
 * node:fs 部分 mock：仅 readFileSync 包装为 hoisted vi.fn 计数探针（实现委托
 * 真实 fs）——ESM 下 vi.spyOn(node:fs) 不可用，部分 mock 是等价替代。
 *
 * 运行：cd packages/runtime && npx vitest run test/quota-cache-memory.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NormalizedQuotaRow } from '@taiji/shared'
import { QuotaCache } from '../src/services/quota-cache.js'

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  realReadFileSync: null as unknown,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsMock.realReadFileSync = actual.readFileSync
  return { ...actual, readFileSync: fsMock.readFileSync }
})

function makeRow(label: string): NormalizedQuotaRow {
  return {
    label,
    wins: [
      { pct: 30, resetSec: 3600 },
      { pct: 50, resetSec: null },
      { pct: null, resetSec: null },
    ],
  }
}

/** 等 update 的 writeChain 完成（update 是 Promise 链，测试需等微任务落盘）。 */
async function flushWriteChain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** readFileSync 累计调用次数（内存命中零磁盘读的观察口径）。 */
function readCallCount(): number {
  return fsMock.readFileSync.mock.calls.length
}

describe('QuotaCache 内存层（W26 微项 11）', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'quota-mem-'))
    // 计数口径：清跨用例残留 calls，实现委托真实 fs
    fsMock.readFileSync.mockClear()
    fsMock.readFileSync.mockImplementation(fsMock.realReadFileSync as typeof import('node:fs')['readFileSync'])
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('重复查询同一 provider 命中内存层：仅首次读磁盘，二次起零磁盘读', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('provider-1'))
    await flushWriteChain()

    const first = cache.getEntry('p1')
    const callsAfterFirst = readCallCount()
    // update 已同步内存镜像（doUpdate 写盘后 memoryCache=cache）→ getEntry 命中内存，零磁盘读
    expect(callsAfterFirst).toBe(0)
    expect(first?.data.label).toBe('provider-1')

    // 二次起：命中内存，零磁盘读
    const second = cache.getEntry('p1')
    expect(readCallCount()).toBe(callsAfterFirst)
    expect(second).toEqual(first)
  })

  it('update 后内存同步：getEntry 立即返回新数据且不再读磁盘', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('v1'))
    await flushWriteChain()
    cache.getEntry('p1') // 加载内存镜像

    cache.update('p1', makeRow('v2'))
    await flushWriteChain()
    const callsAfterUpdate = readCallCount()

    const got = cache.getEntry('p1')
    expect(got?.data.label).toBe('v2')
    // getEntry 命中内存，update 之后的查询零新增磁盘读
    expect(readCallCount()).toBe(callsAfterUpdate)
  })

  it('多 provider 互不干扰：各 provider 独立命中内存', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('one'))
    cache.update('p2', makeRow('two'))
    await flushWriteChain()

    expect(cache.getEntry('p1')?.data.label).toBe('one')
    expect(cache.getEntry('p2')?.data.label).toBe('two')
    expect(cache.getEntry('p1')?.data.label).toBe('one')
    // 仅 update p2 的 doUpdate 读盘一次（p1 首次写盘时文件不存在）；三次 getEntry 全命中内存
    expect(readCallCount()).toBe(1)
  })

  it('磁盘持久化语义不变：update 后文件落盘且内容可读（跨实例重载可见）', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('persisted'))
    await flushWriteChain()

    const filePath = join(dataDir, 'quota-cache.json')
    expect(existsSync(filePath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(onDisk.providers.p1.data.label).toBe('persisted')

    // 新实例（模拟重启）从磁盘加载
    const fresh = new QuotaCache(dataDir)
    expect(fresh.getEntry('p1')?.data.label).toBe('persisted')
  })

  it('无缓存的 provider 返回 null（内存 miss，不抛）', async () => {
    const cache = new QuotaCache(dataDir)
    cache.update('p1', makeRow('one'))
    await flushWriteChain()
    cache.getEntry('p1') // 加载内存
    expect(cache.getEntry('no-such-provider')).toBeNull()
  })
})
