/**
 * sessions 扫描降级容错行为测试（原扫描降级旗标测试改写——旗标随零消费方退役，
 * 扫描容错语义保留守护）：顶层 readdir EACCES / cwd 分组子目录列举失败（dirFail）
 * 时降级为返回结果（不抛进程级异常），顶层降级经 console.error 留痕。
 *
 * 防线：TAIJI_AGENT_DATA_DIR 钉 mkdtemp tmp（fs-guard 白名单 = tmpdir()）；chmod 只动自建
 * tmp 目录，afterEach finally 恢复权限后再自删（防 000 目录 rm 不掉）；不触碰真实数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-scan-degraded-tolerance.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPiSessions } from '../session-file-utils.js'
import { getSessionsDir } from '../pi-paths.js'

let prevDataDir: string | undefined
let dir: string

beforeEach(() => {
  prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'taiji-scan-degraded-'))
  process.env.TAIJI_AGENT_DATA_DIR = dir
  mkdirSync(getSessionsDir(), { recursive: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  // 权限恢复先于自删（chmod 000 目录 rm 枚举会 EACCES）；已删/已恢复则吞掉。
  try { chmodSync(getSessionsDir(), 0o755) } catch { /* noop */ }
  if (prevDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.restoreAllMocks()
})

describe('scanPiSessions 降级容错（读取故障不炸进程，降级留痕）', () => {
  it('健康轮 → []；顶层 readdir EACCES → 降级 [] 不抛 + console.error 留痕；恢复后正常', () => {
    expect(scanPiSessions({ force: true })).toEqual([])
    expect(console.error).not.toHaveBeenCalled()

    chmodSync(getSessionsDir(), 0o000)
    expect(scanPiSessions({ force: true })).toEqual([]) // 降级空与权威空返回值同形，不抛 EACCES
    expect(console.error).toHaveBeenCalled()

    chmodSync(getSessionsDir(), 0o755)
    expect(scanPiSessions({ force: true })).toEqual([])
  })

  it('cwd 分组子目录列举失败（dirFail，整组缺失）→ 降级为缺失该组，不抛异常', () => {
    const cwdDir = join(getSessionsDir(), 'proj-a')
    mkdirSync(cwdDir, { recursive: true })
    chmodSync(cwdDir, 0o000)

    expect(scanPiSessions({ force: true })).toEqual([])

    chmodSync(cwdDir, 0o755)
    expect(scanPiSessions({ force: true })).toEqual([])
  })
})
