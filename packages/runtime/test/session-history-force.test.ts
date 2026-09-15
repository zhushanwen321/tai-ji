/**
 * W26（plan M-3 / 05-scan-caching D9-1 审查修正）：路径解析消费方透传 force 绕过目录 TTL 缓存。
 *
 * 验收核心：**刚落盘 session 的 getHistoryTailFromFile 在 TTL 窗口内不返回空**。
 * pi 是外部进程写文件（首个 assistant 后落盘），不在显式失效覆盖内——若路径解析也走
 * 1s TTL 缓存，刚落盘 session 的历史/子代理/workflow 查找会在窗口内静默返回 []。
 *
 * 流程（先 fill TTL 缓存再落盘新 session 文件）：
 *   1. 空目录首次 scanPiSessions（列表消费方）→ 填充 TTL 缓存（空快照）
 *   2. 写新 session JSONL（模拟 pi 落盘，不触发显式失效）
 *   3. TTL 窗口内：列表 scanSessions() 看不到新 session（缓存生效的证据）；
 *      getHistoryTailFromFile（force）必须解析到并返回非空
 *
 * 用真实 PiSessionStore（scanSessions + convertPiHistory 全真实），真实 tmpdir 文件。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-history-force.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// getSessionsDir 指向测试临时目录（真实 fs 扫描，目录内容由测试写入）。
// 部分 mock（importOriginal 保留全部导出）：pi-settings-store 经 pi-provider-store
// 依赖 getSettingsPath 等，缺导出会导致模块初始化失败。
const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/tmp/placeholder') }))
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: pathsMock.getSessionsDir,
  }
})

import { getHistoryTailFromFile } from '../src/services/session-history.js'
import { invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../src/infra/pi/session-file-utils.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

/** 写一个 pi 格式 session JSONL（header + user message），返回 filePath。 */
function writeSessionFile(dir: string, id: string): string {
  const filePath = join(dir, `${id}.jsonl`)
  const content = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2025-01-01T00:00:00Z', cwd: '/proj' }),
    JSON.stringify({ type: 'message', id: `${id}-m1`, parentId: null, timestamp: '2025-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hello from fresh session' }] } }),
  ].join('\n') + '\n'
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('路径解析消费方 force 旁路 TTL（W26 M-3）', () => {
  let sessionDir: string
  let store: PiSessionStore

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'hist-force-'))
    pathsMock.getSessionsDir.mockReturnValue(sessionDir)
    invalidateScanDirCache()
    _resetSessionMetaCacheForTest()
    store = new PiSessionStore()
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    invalidateScanDirCache()
  })

  it('M-3 核心：刚落盘 session 的 getHistoryTailFromFile 在 TTL 窗口内不返回空', async () => {
    // 1. 空目录填充 TTL 缓存（列表消费方）
    expect(store.scanSessions()).toEqual([])

    // 2. 新 session 落盘（pi 外部进程写文件，无显式失效）
    const freshId = 'fresh-session-1'
    writeSessionFile(sessionDir, freshId)

    // 3. TTL 窗口内：列表消费方看不到（缓存生效的证据——测试前提成立）
    expect(store.scanSessions().some((s) => s.id === freshId)).toBe(false)

    // 4. 路径解析消费方（force）：必须查到刚落盘 session 的历史，不返回空
    // [u6] getHistoryFromFile 包装已随 getFullHistory 全量通路退役，force 语义由
    // getHistoryTailFromFile 承接（二者同走 scanSessions({ force: true }) 路径解析）。
    const tail = await getHistoryTailFromFile(freshId, store)
    expect(tail.messages.length).toBeGreaterThan(0)
    expect(tail.messages[0]!.role).toBe('user')
  })

  it('force 只作用路径解析：列表消费方在 TTL 窗口内保持缓存快照', async () => {
    // 先有 s1 填缓存，再落盘 s2
    const s1 = 'persisted-1'
    writeSessionFile(sessionDir, s1)
    expect(store.scanSessions().map((s) => s.id)).toEqual([s1])

    const s2 = 'fresh-session-3'
    writeSessionFile(sessionDir, s2)

    // 窗口内列表仍只见 s1
    expect(store.scanSessions().map((s) => s.id)).toEqual([s1])
    // 路径解析 force 可解析 s2
    const tail = await getHistoryTailFromFile(s2, store)
    expect(tail.messages.length).toBeGreaterThan(0)
  })

  it('invalidateScanCache 后列表消费方立即可见（delete/fork/rename 失效联动）', () => {
    store.scanSessions() // fill TTL 缓存（空快照）
    const freshId = 'fresh-session-4'
    writeSessionFile(sessionDir, freshId)

    // 显式失效（session-lifecycle delete/fork/rename 调用点语义）
    store.invalidateScanCache()
    expect(store.scanSessions().map((s) => s.id)).toEqual([freshId])
  })

  it('getHistoryTailFromFile 对缓存外不存在的 session 仍返回空（不回归）', async () => {
    store.scanSessions()
    const tail = await getHistoryTailFromFile('no-such-session', store)
    expect(tail.messages).toEqual([])
  })
})
