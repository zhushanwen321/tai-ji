/**
 * B5 SessionDataStore tombstone + trash 软删除 + 摘碑双路径单测
 * （memory-leak-remediation §3.2-B5 / 验收 A3 的 L1 层）。
 *
 * 锁定：
 * - clearSession：tombstone 登记（先于 trash，trash 失败时迟到写同样被丢）+ 分区摘除
 *   （flushTimer 取消）+ 文件进 trash（mock 记录，不触真实废纸篓）
 * - 迟到写守卫：clear 后 set()/delete() 丢弃 + warn；不复活文件（flushAll/dispose 后
 *   磁盘无新文件）；不重建内存分区（hasPartition false）
 * - flushTimer 取消：clear 前已排定的 500ms flush 被 dropPartition 清掉，不再写盘
 *   （「迟到 set 是唯一文件复活入口」的前半句源码依据）
 * - trash 失败降级：rejection 上抛（调用方 void…catch(warn) 消费）、文件保留原地、
 *   分区已摘、tombstone 已登记（迟到 set 仍丢弃）
 * - 摘碑：reviveSession（路径①实例侧）/ clearSessionDataTombstone（路径② import 侧）
 *   摘碑后 set 恢复、文件正常复活（这是合法复活）
 * - clearRemovedSessionData 分发：注册实例收到清理；dispose 后不再分发；
 *   单实例失败只 warn 不抛
 *
 * 隔离：configDir 全部 mkdtemp tmp（fs-guard 白名单）；trash port 注入式 mock（真实
 * 实现会 execSync 调系统废纸篓，测试禁触）；sid 每用例唯一（tombstone 模块级共享态）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/session-data-store-tombstone.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// trash port 注入式 mock（B5 port 化后 SessionDataStore 不再 import infra/system/trash，
// vi.mock 模块路径不可用/不必要——构造参数直接注入 mock 实现）。记录调用 + 可编程失败；
// 成功路径同步移除文件（模拟 trash 语义：文件离开原位置，lazy load 读不到）。
const trashState = { calls: [] as string[], failNext: false }
const mockTrashFile = async (filePath: string): Promise<void> => {
  if (trashState.failNext) {
    trashState.failNext = false
    throw new Error('移入废纸篓失败（simulated）：文件已保留在原位置')
  }
  trashState.calls.push(filePath)
  rmSync(filePath, { force: true })
}

import { SessionDataStore, clearRemovedSessionData, clearSessionDataTombstone, isSessionDataCleared } from '../session-data-store.js'

let configDir: string
let warnSpy: ReturnType<typeof vi.spyOn>
const stores: SessionDataStore[] = []

function newStore(): SessionDataStore {
  const s = new SessionDataStore(configDir, undefined, undefined, mockTrashFile)
  stores.push(s)
  return s
}

function dataFile(sid: string): string {
  return join(configDir, 'session-data', `${sid}.json`)
}

function readFileJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'session-data-tombstone-'))
  trashState.calls.length = 0
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const s of stores.splice(0)) s.dispose()
  warnSpy.mockRestore()
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('B5 clearSession：tombstone 登记 + 分区摘除 + trash 软删除', () => {
  it('文件进 trash（rmSync 永久删已废）+ 内存分区摘除 + tombstone 登记', async () => {
    const store = newStore()
    store.set('sid-a', 'k1', 'v1')
    store.flushSession('sid-a')
    expect(existsSync(dataFile('sid-a'))).toBe(true)

    await store.clearSession('sid-a')

    expect(trashState.calls).toEqual([dataFile('sid-a')])
    expect(existsSync(dataFile('sid-a'))).toBe(false)
    expect(store.hasPartition('sid-a')).toBe(false)
    expect(isSessionDataCleared('sid-a')).toBe(true)
  })

  it('无文件 session：跳过 trash（旧 rmSync force 同为 no-op），不抛', async () => {
    const store = newStore()
    await expect(store.clearSession('sid-never-had-data')).resolves.toBeUndefined()
    expect(trashState.calls).toHaveLength(0)
  })
})

describe('B5 迟到写守卫：set/delete 丢弃 + 不复活文件 + 不重建分区', () => {
  it('迟到 set()：warn + 丢弃，flushAll 后文件不复活、分区不重建', async () => {
    const store = newStore()
    store.set('sid-b', 'k1', 'v1')
    store.flushSession('sid-b')
    await store.clearSession('sid-b')

    // 迟到 set（插件 worker 迟到的 sessionData.set RPC，无存活校验）
    store.set('sid-b', 'k2', 'late-write')

    const warned = warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('dropped late sessionData.set'))
    expect(warned).toBe(true)
    // 守卫先于 getPartition：写路径不重建分区
    expect(store.hasPartition('sid-b')).toBe(false)
    // keys 只读不守（设计裁决：get/keys 不在守卫面）——lazy 读已删文件得空集
    expect(store.keys('sid-b')).toEqual([])

    store.flushAll() // 即便强制 flush，也无 dirty 可写
    expect(existsSync(dataFile('sid-b'))).toBe(false) // 文件不复活（唯一复活入口被封死）
  })

  it('迟到 delete()：warn + 丢弃，不 lazy 重建空内存分区', async () => {
    const store = newStore()
    store.set('sid-c', 'k1', 'v1')
    store.flushSession('sid-c')
    await store.clearSession('sid-c')

    store.delete('sid-c', 'k1')

    const warned = warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('dropped late sessionData.delete'))
    expect(warned).toBe(true)
    // delete 的 getPartition 会 lazy 重建空分区（驻留）——guard 短路在其之前
    expect(store.hasPartition('sid-c')).toBe(false)
    store.flushAll()
    expect(existsSync(dataFile('sid-c'))).toBe(false)
  })

  it('flushTimer 取消：clear 前已排定的 500ms flush 被 dropPartition 清掉，文件从未写盘', async () => {
    vi.useFakeTimers()
    try {
      const store = newStore()
      store.set('sid-d', 'k1', 'v1') // scheduleFlush 排定 500ms 后写盘
      expect(store.hasPartition('sid-d')).toBe(true)

      await store.clearSession('sid-d') // dropPartition：clearTimeout + 摘分区

      await vi.advanceTimersByTimeAsync(60_000) // 远超 debounce
      expect(existsSync(dataFile('sid-d'))).toBe(false) // 定时器写盘路径被封死
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('B5 trash 失败降级（best-effort 登记，设计 §3.2-B5）', () => {
  it('rejection 上抛 + 文件保留原地 + 分区已摘 + tombstone 已登记（迟到 set 仍丢弃）', async () => {
    const store = newStore()
    store.set('sid-e', 'k1', 'v1')
    store.flushSession('sid-e')

    trashState.failNext = true
    await expect(store.clearSession('sid-e')).rejects.toThrow(/废纸篓失败/)

    expect(existsSync(dataFile('sid-e'))).toBe(true) // 文件保留原地
    expect(store.hasPartition('sid-e')).toBe(false) // dropPartition 先行
    expect(isSessionDataCleared('sid-e')).toBe(true) // tombstone 先于 trash 登记

    store.set('sid-e', 'k2', 'late') // 迟到写仍被丢弃（旧文件内容可读是登记的降级语义，新写不进场）
    expect(store.keys('sid-e')).toEqual(['k1']) // k1 = 未删成旧文件的存量；k2 不得出现
    expect(store.keys('sid-e')).not.toContain('k2')
    store.flushAll()
    expect(readFileJson(dataFile('sid-e'))).toEqual({ k1: 'v1' }) // 落盘内容不含迟到写
  })
})

describe('B5 摘碑双路径：同 id 复活后写通道恢复', () => {
  it('路径①（reviveSession，plugin-service setOnSessionCreated 回调侧）：摘碑后 set 恢复 + 文件合法复活', async () => {
    const store = newStore()
    store.set('sid-f', 'k1', 'v1')
    store.flushSession('sid-f')
    await store.clearSession('sid-f')

    store.reviveSession('sid-f') // 模拟 notifySessionCreated 收敛点链式摘碑
    expect(isSessionDataCleared('sid-f')).toBe(false)

    store.set('sid-f', 'k1', 'revived') // 新 session 的合法写
    store.flushSession('sid-f')
    expect(existsSync(dataFile('sid-f'))).toBe(true)
    expect(readFileJson(dataFile('sid-f'))).toEqual({ k1: 'revived' })
  })

  it('路径②（clearSessionDataTombstone，import-service doImport 尾部侧）：纯模块级摘碑后写恢复', async () => {
    const store = newStore()
    store.set('sid-g', 'k1', 'v1')
    await store.clearSession('sid-g')

    clearSessionDataTombstone('sid-g') // import 落地（未打开窗口）显式摘碑
    store.set('sid-g', 'k2', 'imported')
    expect(store.keys('sid-g')).toEqual(['k2'])
  })
})

describe('B5 clearRemovedSessionData：lifecycle.delete 真删除路径直调分发（触发面收窄后挂点）', () => {
  it('已注册实例收到清理（tombstone + trash）；dispose 后不再分发', async () => {
    const store = newStore()
    store.set('sid-h', 'k1', 'v1')
    store.flushSession('sid-h')

    clearRemovedSessionData('sid-h')

    // 分发内部 void…catch：trash 是微任务，flush 后断言
    await vi.waitFor(() => expect(trashState.calls).toContain(dataFile('sid-h')))
    expect(isSessionDataCleared('sid-h')).toBe(true)

    // dispose 摘除后再分发：零调用零异常
    store.dispose()
    stores.splice(stores.indexOf(store), 1)
    trashState.calls.length = 0
    expect(() => clearRemovedSessionData('sid-h2')).not.toThrow()
    expect(trashState.calls).toHaveLength(0)
  })

  it('单实例 trash 失败只 warn 不抛（销毁收敛链不被阻断）', async () => {
    const store = newStore()
    store.set('sid-i', 'k1', 'v1')
    store.flushSession('sid-i')
    trashState.failNext = true

    let threw = false
    try {
      clearRemovedSessionData('sid-i')
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    // 分发侧 void…catch(warn) 消费 rejection；tombstone 仍登记（同步先于 trash）
    expect(isSessionDataCleared('sid-i')).toBe(true)
    await vi.waitFor(() =>
      expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('best-effort failed'))).toBe(true))
  })
})
