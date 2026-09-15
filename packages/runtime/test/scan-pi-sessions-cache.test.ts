/**
 * W26（05-scan-caching D9-1）：scanPiSessions 目录列举层 1s TTL 缓存。
 *
 * 覆盖验收：
 * ① 列表构建消费方 1s 窗口内二次扫描零目录列举 IO（readdirSync mock 计数不变）
 * ② 路径解析消费方 force 旁路：TTL 窗口内新落盘文件 force 扫描可见、列表扫描不可见
 * ③ 显式失效（invalidateScanDirCache，delete/fork/rename 调用）后立即重扫
 * ④ dir 切换（TAIJI_AGENT_DATA_DIR 隔离）整体失效
 * ⑤ 返回数组浅拷贝：消费者 sort/splice 不污染缓存本体
 *
 * 用真实 fs + tmpdir（getSessionsDir mock 指向临时目录）。node:fs 部分 mock：
 * 仅 readdirSync 包装为 hoisted vi.fn（计数探针，实现委托真实 fs）——ESM 下
 * vi.spyOn(node:fs) 不可用（module namespace 不可配置），部分 mock 是等价替代。
 *
 * 运行：cd packages/runtime && npx vitest run test/scan-pi-sessions-cache.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// node:fs 部分 mock：readdirSync 计数探针（实现委托真实 fs，importOriginal 保留其余真实导出）
const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  realReaddirSync: null as unknown,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsMock.realReaddirSync = actual.readdirSync
  return { ...actual, readdirSync: fsMock.readdirSync }
})

// getSessionsDir 指向测试临时目录（每个用例独立 mkdtemp，dir 键防串）
const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/tmp/placeholder') }))
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: pathsMock.getSessionsDir,
  }
})

import { scanPiSessions, invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../src/infra/pi/session-file-utils.js'

/** 写一个 pi 格式 session JSONL（header + user message）。 */
function writeSessionFile(dir: string, id: string, mtimeMs?: number): string {
  const filePath = join(dir, `${id}.jsonl`)
  const content = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2025-01-01T00:00:00Z', cwd: '/proj' }),
    JSON.stringify({ type: 'message', id: `${id}-m1`, parentId: null, timestamp: '2025-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n') + '\n'
  writeFileSync(filePath, content, 'utf-8')
  if (mtimeMs !== undefined) {
    utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs))
  }
  return filePath
}

/** readdirSync 累计调用次数（TTL 窗口零 IO 的观察口径）。 */
function readdirCallCount(): number {
  return fsMock.readdirSync.mock.calls.length
}

describe('scanPiSessions 目录列举 TTL 缓存（W26 D9-1）', () => {
  let sessionDir: string

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'scan-cache-'))
    pathsMock.getSessionsDir.mockReturnValue(sessionDir)
    invalidateScanDirCache()
    _resetSessionMetaCacheForTest()
    // 计数探针实现委托真实 fs（vi.clearAllMocks 只清 calls 不清实现，此处显式设防）
    fsMock.readdirSync.mockImplementation(fsMock.realReaddirSync as typeof import('node:fs')['readdirSync'])
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    invalidateScanDirCache()
  })

  it('1s TTL 窗口内二次扫描零目录列举 IO（列表构建消费方）', () => {
    writeSessionFile(sessionDir, 's1')
    const first = scanPiSessions()
    const firstIoCalls = readdirCallCount()
    expect(firstIoCalls).toBeGreaterThan(0)
    expect(first.map((s) => s.id)).toEqual(['s1'])

    // 同 1s 窗口内再次扫描：命中缓存，readdirSync 零新增调用
    const second = scanPiSessions()
    expect(readdirCallCount()).toBe(firstIoCalls)
    expect(second.map((s) => s.id)).toEqual(['s1'])
  })

  it('TTL 过期（>1s）后重新扫描磁盘', () => {
    vi.useFakeTimers()
    try {
      writeSessionFile(sessionDir, 's1')
      scanPiSessions()
      const firstIoCalls = readdirCallCount()

      // 1s 内：缓存命中
      vi.advanceTimersByTime(500)
      scanPiSessions()
      expect(readdirCallCount()).toBe(firstIoCalls)

      // 超过 1s：重扫
      vi.advanceTimersByTime(501)
      const ids = scanPiSessions().map((s) => s.id)
      expect(readdirCallCount()).toBeGreaterThan(firstIoCalls)
      expect(ids).toEqual(['s1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('时钟回拨防护：Date.now() 后跳（NTP 校时/手动改时）视为缓存过期强制重扫（终审 suggestion）', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      // 空目录填充缓存（expiresAt = 1_001_000），随后新 session 落盘
      scanPiSessions()
      writeSessionFile(sessionDir, 'fresh')

      // 窗口内正常命中：缓存快照（空）生效
      vi.advanceTimersByTime(500)
      expect(scanPiSessions().map((s) => s.id)).toEqual([])

      // 时钟回拨到 t=900_000（< 上次观测 1_000_500）：无防护时 900_000 < 1_001_000 恒真，
      // 缓存再挂 100s；有防护 → 强制重扫，新 session 立即可见
      vi.setSystemTime(900_000)
      expect(scanPiSessions().map((s) => s.id)).toEqual(['fresh'])

      // 回拨后基准已重建：随后的正常窗口（900_000 + 500ms < 新 expiresAt 901_000+...）命中缓存
      const afterBackwardCalls = readdirCallCount()
      vi.advanceTimersByTime(500)
      expect(scanPiSessions().map((s) => s.id)).toEqual(['fresh'])
      expect(readdirCallCount()).toBe(afterBackwardCalls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('force 旁路：TTL 窗口内新落盘文件 force 可见、列表扫描不可见（消费方分层）', () => {
    // 1. 空目录填充 TTL 缓存
    expect(scanPiSessions()).toEqual([])
    const cachedIoCalls = readdirCallCount()

    // 2. 新 session 落盘（pi 外部进程写文件，不触发显式失效）
    writeSessionFile(sessionDir, 'fresh')

    // 3. 列表构建消费方（无 force）：TTL 窗口内不重扫，看不到刚落盘 session
    expect(scanPiSessions().map((s) => s.id)).toEqual([])
    expect(readdirCallCount()).toBe(cachedIoCalls)

    // 4. 路径解析消费方（force）：绕过缓存强制刷新，刚落盘 session 立即可解析
    const forced = scanPiSessions({ force: true })
    expect(forced.map((s) => s.id)).toEqual(['fresh'])
    expect(readdirCallCount()).toBeGreaterThan(cachedIoCalls)

    // 5. force 刷新同时回写缓存：随后 1s 内列表消费方零 IO 读到最新视图
    const afterForceCalls = readdirCallCount()
    expect(scanPiSessions().map((s) => s.id)).toEqual(['fresh'])
    expect(readdirCallCount()).toBe(afterForceCalls)
  })

  it('TTL 过期后列表消费方自然发现新落盘 session（V5 秒级可见）', () => {
    vi.useFakeTimers()
    try {
      scanPiSessions()
      writeSessionFile(sessionDir, 'fresh')
      // 1s 内不可见
      expect(scanPiSessions()).toEqual([])
      // 过期后可见
      vi.advanceTimersByTime(1001)
      expect(scanPiSessions().map((s) => s.id)).toEqual(['fresh'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidateScanDirCache 显式失效（delete/fork/rename 语义）：失效后立即可见', () => {
    // 1. 缓存快照（含 s1）
    writeSessionFile(sessionDir, 's1')
    scanPiSessions()
    const cachedIoCalls = readdirCallCount()

    // 2. 新增文件后不失效：窗口内不可见
    writeSessionFile(sessionDir, 's2')
    expect(scanPiSessions().map((s) => s.id)).toEqual(['s1'])

    // 3. 显式失效（session delete/fork/rename 后的调用点语义）→ 立即重扫
    invalidateScanDirCache()
    const ids = scanPiSessions().map((s) => s.id).sort()
    expect(ids).toEqual(['s1', 's2'])
    expect(readdirCallCount()).toBeGreaterThan(cachedIoCalls)
  })

  it('getSessionsDir 变化（数据目录切换）→ 缓存整体失效重扫', () => {
    writeSessionFile(sessionDir, 's1')
    scanPiSessions()

    // 切到另一个目录（TAIJI_AGENT_DATA_DIR 切换语义）
    const otherDir = mkdtempSync(join(tmpdir(), 'scan-cache-other-'))
    try {
      writeSessionFile(otherDir, 's2')
      pathsMock.getSessionsDir.mockReturnValue(otherDir)
      const ids = scanPiSessions().map((s) => s.id)
      expect(ids).toEqual(['s2'])
    } finally {
      rmSync(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('返回数组为浅拷贝：消费者排序不污染缓存本体', () => {
    // 两个文件不同 mtime（utimes 控制），扫描结果按 lastModified 降序确定
    writeSessionFile(sessionDir, 'old', 1_700_000_000_000)
    writeSessionFile(sessionDir, 'new', 1_700_000_100_000)
    const first = scanPiSessions()
    expect(first.map((s) => s.id)).toEqual(['new', 'old'])

    // 消费者就地反转（模拟调用方 sort 污染风险）
    first.reverse()
    expect(first.map((s) => s.id)).toEqual(['old', 'new'])

    // 缓存本体未被污染：再次扫描仍按 lastModified 降序
    expect(scanPiSessions().map((s) => s.id)).toEqual(['new', 'old'])
  })

  it('返回数组浅拷贝：splice 不污染缓存本体', () => {
    writeSessionFile(sessionDir, 's1')
    writeSessionFile(sessionDir, 's2', 1_700_000_100_000)
    const first = scanPiSessions()
    expect(first).toHaveLength(2)
    first.splice(0, 1) // 消费者裁剪
    expect(scanPiSessions()).toHaveLength(2)
  })
})
