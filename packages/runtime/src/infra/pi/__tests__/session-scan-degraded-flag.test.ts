/**
 * [BU5] sessions 扫描降级旗标（scanDegradedFlag.last）——btw 孤儿补账不可逆删除闸的
 * 数据源。覆盖：顶层 readdir EACCES 降级（显式 return []，与「权威空」返回值不可区分 →
 * 旗标区分）/ cwd 分组子目录列举失败（dirFail）/ 健康轮与权威空复位 false。
 *
 * 防线：TAIJI_AGENT_DATA_DIR 钉 mkdtemp tmp（fs-guard 白名单 = tmpdir()）；chmod 只动自建
 * tmp 目录，afterEach finally 恢复权限后再自删（防 000 目录 rm 不掉）；不触碰真实数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-scan-degraded-flag.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPiSessions, scanDegradedFlag } from '../session-file-utils.js'
import { getSessionsDir } from '../pi-paths.js'

let prevDataDir: string | undefined
let dir: string

beforeEach(() => {
  prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'taiji-scan-flag-'))
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

describe('scanDegradedFlag（扫描降级旗标透出，btw 补账闸数据源）', () => {
  it('健康轮 → false；顶层 readdir EACCES 降级（return []）→ true；恢复后复位 false', () => {
    expect(scanPiSessions({ force: true })).toEqual([])
    expect(scanDegradedFlag.last).toBe(false) // 权威空（目录不存在/空目录）可信

    chmodSync(getSessionsDir(), 0o000)
    expect(scanPiSessions({ force: true })).toEqual([]) // 降级空与权威空返回值不可区分
    expect(scanDegradedFlag.last).toBe(true) // 旗标区分 → 补账跳过（BU5）

    chmodSync(getSessionsDir(), 0o755)
    expect(scanPiSessions({ force: true })).toEqual([])
    expect(scanDegradedFlag.last).toBe(false) // 健康轮复位 → 补账恢复
  })

  it('cwd 分组子目录列举失败（dirFail，整组缺失）→ 旗标 true', () => {
    const cwdDir = join(getSessionsDir(), 'proj-a')
    mkdirSync(cwdDir, { recursive: true })
    chmodSync(cwdDir, 0o000)

    expect(scanPiSessions({ force: true })).toEqual([])
    expect(scanDegradedFlag.last).toBe(true)

    chmodSync(cwdDir, 0o755)
    expect(scanPiSessions({ force: true })).toEqual([])
    expect(scanDegradedFlag.last).toBe(false)
  })
})
