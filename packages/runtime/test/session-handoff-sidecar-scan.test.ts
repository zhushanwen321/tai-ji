/**
 * handoff sidecar × 扫描链测试（W11，数据源治理——persistHandedOff 迁 .handoff.json）。
 *
 * 锁定（plan W11 步骤 4 / 验收 4）：
 * - scanSessionMeta 消费不变：handedOffTo 仍经 extractHandedOff 提取进 ScannedSessionMeta
 * - 写后失效 sessionMetaCache：sidecar 变更不变 JSONL 的 (mtime,size)，不失效会命中
 *   stale 缓存（对齐 persistSessionEnd 模式）
 * - 存量旧 session（JSONL 内 handoff_marker）经扫描链仍可读（fallback 兼容）
 * - 扫描侧 label 一致派生（plan W11 步骤 5 / 验收 4）：未命名 session 的 label =
 *   basename(扫描 cwd)——死路径 cwd 下为 basename(死路径)（非空非 undefined）
 *
 * 环境与 scan-pi-sessions-cache.test.ts 同款：getSessionsDir mock 指向用例临时目录。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-handoff-sidecar-scan.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// getSessionsDir 指向测试临时目录（每个用例独立 mkdtemp，dir 键防串）
const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/tmp/placeholder') }))
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: pathsMock.getSessionsDir }
})

import {
  scanPiSessions,
  persistHandoffSidecar,
  invalidateScanDirCache,
  _resetSessionMetaCacheForTest,
} from '../src/infra/pi/session-file-utils.js'

/** 写一个 pi 格式 session JSONL（header + assistant message，已 flush 形态）。 */
function writeSessionFile(dir: string, id: string, cwd: string): string {
  const filePath = join(dir, `${id}.jsonl`)
  writeFileSync(filePath, [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-01T00:00:00Z', cwd }),
    JSON.stringify({ type: 'message', id: `${id}-a1`, parentId: null, timestamp: '2026-08-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n') + '\n')
  return filePath
}

describe('handoff sidecar × 扫描链（W11）', () => {
  let sessionDir: string

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'w11-handoff-'))
    pathsMock.getSessionsDir.mockReturnValue(sessionDir)
    invalidateScanDirCache()
    _resetSessionMetaCacheForTest()
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('persistHandoffSidecar 后扫描提取 handedOffTo（scanSessionMeta 消费不变 + 写后缓存失效）', () => {
    const filePath = writeSessionFile(sessionDir, 'h-1', '/proj')

    // 第一次扫描：无交接标记（缓存写入）
    expect(scanPiSessions().find(s => s.id === 'h-1')?.handedOffTo).toBeUndefined()

    persistHandoffSidecar(filePath, 'handoff-target-9')

    // sidecar 变更不变 JSONL 的 (mtime,size)——写后失效保证下次扫描读到新值
    const meta = scanPiSessions({ force: true }).find(s => s.id === 'h-1')
    expect(meta?.handedOffTo).toBe('handoff-target-9')
  })

  it('存量旧 session（JSONL 内 handoff_marker entry）经扫描链可读（fallback 兼容）', () => {
    const filePath = join(sessionDir, 'legacy-h.jsonl')
    writeFileSync(filePath, [
      JSON.stringify({ type: 'session', version: 3, id: 'legacy-h', timestamp: '2026-08-01T00:00:00Z', cwd: '/proj' }),
      JSON.stringify({ type: 'message', id: 'legacy-h-a1', parentId: null, timestamp: '2026-08-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
      // W11 前的直写形态：JSONL 尾部 handoff_marker entry
      JSON.stringify({ type: 'handoff_marker', handedOffTo: 'legacy-target', timestamp: '2026-08-10T00:00:00Z' }),
    ].join('\n') + '\n')

    const meta = scanPiSessions().find(s => s.id === 'legacy-h')
    expect(meta?.handedOffTo).toBe('legacy-target')
  })

  it('扫描侧 label 一致派生：死路径 cwd 的未命名 session，label 派生 = basename(死路径)（W11 步骤 5 接受的行为差异）', () => {
    // patchSessionCwd 迁 tmp 后源文件 header 永久保持死路径 cwd；scanner label fallback
    // （scannedToSummary 的 s.name ?? basename(s.cwd)）按真实历史值派生。断言扫描结果
    // 的 cwd/name 满足该派生（name=null → label=basename(cwd)，非空非 undefined）。
    const deadCwd = '/gone/dead-worktree-foo'
    writeSessionFile(sessionDir, 'dead-cwd', deadCwd)

    const meta = scanPiSessions().find(s => s.id === 'dead-cwd')
    expect(meta).toBeDefined()
    expect(meta?.name).toBeNull()
    expect(meta?.cwd).toBe(deadCwd)
    // 一致派生（与 session-scanner.ts:73 label: s.name ?? basename(s.cwd) 同式）
    const label = meta?.name ?? basename(meta?.cwd ?? '')
    expect(label).toBe(basename(deadCwd))
    expect(label).toBeTruthy()
    expect(label).not.toBe(basename(homedir()))
  })
})
