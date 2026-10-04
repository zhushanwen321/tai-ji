/**
 * crash-correlation 单元测试（crash-forensics-and-watchdog §3.3 D6-⑧）。
 *
 * 锁定：
 * - ps 输出解析：pi-darwin 行过滤 + 非法行跳过（fail-open）。
 * - 快照/digest/关联 section 渲染：`[machine-pi-snapshot]` / `[unified-log-correlation]`
 *   前缀可 grep 形态；空集与超限的显式标注（「不知道 ≠ 没打点」）。
 * - 采样门：crash log sink 未启用 → 快照/采样结构性惰性（'' / resolve('')）。
 * - best-effort：ps / log show 失败不抛，失败以显式 unavailable 行落盘。
 * - log show 参数：±5s 窗口 + 本地 naive 时间形态 + 谓词串。
 * - 关联行提取：pi-darwin / Electron proc_exit / signaled service 三类命中，噪声丢弃，
 *   60 行截断。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/__tests__/crash-correlation.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

// 采样门可控化：crash-correlation 从 logger 模块 import isPiCrashLogEnabled——
// 此处 mock 成可翻转移（真实 logger 未初始化态恒 false，无法正向验证采集路径）
const gate = vi.hoisted(() => ({ enabled: false }))
vi.mock('../logger.js', () => ({ isPiCrashLogEnabled: () => gate.enabled }))

import {
  MACHINE_PI_BIN_MARKER,
  MACHINE_PI_DIGEST_MAX_CHARS,
  UNIFIED_LOG_MAX_LINES,
  UNIFIED_LOG_WINDOW_MS,
  parseMachinePiRows,
  formatMachinePiSnapshotSection,
  formatMachinePiDigest,
  captureMachinePiSnapshotSection,
  captureMachinePiDigest,
  extractCorrelationLines,
  formatLogShowTime,
  buildLogShowArgs,
  collectUnifiedLogCorrelation,
} from '../crash-correlation.js'

const PS_FIXTURE = [
  '  33889  40842 /Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64 --mode rpc --no-extensions --approve',
  '  34100  33889 /Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64 --mode rpc --session sub',
  '  34101     1 /Users/dev/worktree/apps/electron/resources/pi/pi-darwin-arm64 --mode rpc --no-extensions',
  '    520     1 /usr/sbin/SomeDaemon',
  '  34200   40842 node /usr/local/bin/pi --mode rpc',
  'garbage-line-no-pid',
  'abc def not-enough-columns /x/pi-darwin-arm64',
].join('\n')

describe('parseMachinePiRows：ps 输出解析 + taiji 家族过滤', () => {
  it('只保留含 pi-darwin-arm64 的合法行，pid/ppid 数值化', () => {
    const rows = parseMachinePiRows(PS_FIXTURE)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ pid: 33889, ppid: 40842 })
    expect(rows[2]).toMatchObject({ pid: 34101, ppid: 1 })
    expect(rows.every((r) => r.command.includes(MACHINE_PI_BIN_MARKER))).toBe(true)
  })

  it('npm 安装的裸 pi（二进制名不含 pi-darwin-arm64）不匹配——只关心 taiji 家族', () => {
    const rows = parseMachinePiRows('  34200   40842 node /usr/local/bin/pi --mode rpc')
    expect(rows).toHaveLength(0)
  })

  it('非法行跳过（fail-open），空输出返回空数组', () => {
    expect(parseMachinePiRows('garbage\n\nabc def /x/pi-darwin-arm64')).toHaveLength(0)
    expect(parseMachinePiRows('')).toHaveLength(0)
  })
})

describe('渲染：快照 section / journal digest', () => {
  const rows = parseMachinePiRows(PS_FIXTURE)

  it('快照 section：每行 [machine-pi-snapshot] 前缀 + aliveCount 显式（空集也是证据）', () => {
    const section = formatMachinePiSnapshotSection(rows, 40842, '2026-09-20T05:37:13.200Z')
    const lines = section.split('\n')
    expect(lines[0]).toBe('[machine-pi-snapshot] capturedAt=2026-09-20T05:37:13.200Z selfPid=40842 aliveCount=3')
    expect(lines[1]).toContain('[machine-pi-snapshot] pid=33889 ppid=40842 cmd=')

    const empty = formatMachinePiSnapshotSection([], null, '2026-09-20T05:37:13.200Z')
    expect(empty.split('\n')[0]).toContain('selfPid=null aliveCount=0')
  })

  it('快照 section：超 16 行截断并标注省略数', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      pid: 1000 + i,
      ppid: 1,
      command: `/x/pi-darwin-arm64 --session s${i}`,
    }))
    const section = formatMachinePiSnapshotSection(many, null, '2026-09-20T05:37:13.200Z')
    expect(section).toContain('truncated=true (+4 rows omitted)')
    expect(section.split('\n')).toHaveLength(1 + 16 + 1)
  })

  it('journal digest：alive=N 头 + [pid/ppid] 行形态，装不下的行丢弃并保留 more 尾注', () => {
    const digest = formatMachinePiDigest(rows)
    expect(digest).toMatch(/^alive=3; \[33889\/40842\] /)
    expect(digest.length).toBeLessThanOrEqual(MACHINE_PI_DIGEST_MAX_CHARS)

    const big = Array.from({ length: 40 }, (_, i) => ({
      pid: i,
      ppid: 1,
      command: `x`.repeat(200) + ' pi-darwin-arm64',
    }))
    const bigDigest = formatMachinePiDigest(big)
    expect(bigDigest.length).toBeLessThanOrEqual(MACHINE_PI_DIGEST_MAX_CHARS)
    expect(bigDigest).toMatch(/^alive=40; /)
    expect(bigDigest).toMatch(/; \+\d+ more$/)
  })
})

describe('captureMachinePiSnapshotSection：采样门 + best-effort', () => {
  it('crash log sink 未启用：不采样（结构性惰性，不 spawn ps）', () => {
    gate.enabled = false
    const runPs = vi.fn(() => PS_FIXTURE)
    const section = captureMachinePiSnapshotSection(1, runPs)
    expect(section).toBe('')
    expect(runPs).not.toHaveBeenCalled()
  })

  it('ps 失败：显式 unavailable 行，不抛', () => {
    gate.enabled = true
    const section = captureMachinePiSnapshotSection(1, () => {
      throw new Error('ps disappeared')
    })
    expect(section).toContain('[machine-pi-snapshot]')
    expect(section).toContain('unavailable: ps disappeared')
  })

  it('ps 成功：幸存者行 + selfPid 在场', () => {
    gate.enabled = true
    const section = captureMachinePiSnapshotSection(40842, () => PS_FIXTURE)
    expect(section).toContain('aliveCount=3')
    expect(section).toContain('pid=33889 ppid=40842')
  })
})

describe('captureMachinePiDigest：journal 扩展字段采集', () => {
  it('ps 失败返回空串（journal 字段全可空语义），不抛', () => {
    expect(captureMachinePiDigest(() => {
      throw new Error('no ps')
    })).toBe('')
  })

  it('ps 成功返回紧凑摘要', () => {
    expect(captureMachinePiDigest(() => PS_FIXTURE)).toMatch(/^alive=3; /)
  })
})

describe('extractCorrelationLines：三类证据命中 + 噪声丢弃 + 截断', () => {
  it('命中 pi-darwin / Electron proc_exit / signaled service，丢弃无关行', () => {
    const stdout = [
      '2026-09-20 05:37:13.168 mDNSResponder DNSServiceCreateConnection STOP PID[33224](pi-darwin-arm64)',
      '2026-09-20 05:37:13.463 runningboardd [anon<Electron>(501):32442] termination reported by proc_exit',
      '2026-09-20 05:37:13.144 launchd [pid/32924/com.apple.MTLCompilerService...] signaled service: Killed: 9',
      '2026-09-20 05:37:13.001 WindowServer noise line',
      '2026-09-20 05:37:13.002 runningboardd [osservice<com.apple.contactsd>:33431] termination reported by launchd (0, 0, 0)',
    ].join('\n')
    const { lines, truncated } = extractCorrelationLines(stdout)
    expect(lines).toHaveLength(3)
    expect(truncated).toBe(false)
    expect(lines[0]).toContain('pi-darwin-arm64')
    expect(lines[1]).toContain('<Electron>(501):32442')
    expect(lines[2]).toContain('signaled service')
  })

  it('超 60 行截断标注', () => {
    const many = Array.from({ length: 70 }, (_, i) => `line ${i} pi-darwin-arm64 x`).join('\n')
    const { lines, truncated } = extractCorrelationLines(many)
    expect(lines).toHaveLength(UNIFIED_LOG_MAX_LINES)
    expect(truncated).toBe(true)
  })
})

describe('formatLogShowTime / buildLogShowArgs：窗口与形态', () => {
  it('本地 naive 形态 YYYY-MM-DD HH:MM:SS（补零）', () => {
    // 2026-09-20 05:37:13 本地（构造经本地组件，锁定格式而非时区数学）
    const d = new Date()
    d.setFullYear(2026, 8, 20)
    d.setHours(5, 37, 13, 0)
    expect(formatLogShowTime(d.getTime())).toBe('2026-09-20 05:37:13')

    const d2 = new Date()
    d2.setFullYear(2026, 0, 3)
    d2.setHours(7, 8, 9, 0)
    expect(formatLogShowTime(d2.getTime())).toBe('2026-01-03 07:08:09')
  })

  it('buildLogShowArgs：±5s 窗口 + compact + 谓词', () => {
    const base = Date.UTC(2026, 8, 19, 21, 37, 13)
    const args = buildLogShowArgs(base)
    const start = new Date(base - UNIFIED_LOG_WINDOW_MS)
    const end = new Date(base + UNIFIED_LOG_WINDOW_MS)
    const p = (n: number): string => String(n).padStart(2, '0')
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    expect(args).toContain('--style')
    expect(args).toContain('compact')
    expect(args).toContain(fmt(start))
    expect(args).toContain(fmt(end))
    expect(args.join(' ')).toContain('runningboardd')
    expect(args.join(' ')).toContain('pi-darwin-arm64')
  })
})

describe('collectUnifiedLogCorrelation：门 + 失败显式化', () => {
  it('非 darwin：未采样（空串，不调 log show）', async () => {
    const runLogShow = vi.fn(() => Promise.resolve(''))
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => false,
      sinkEnabled: () => true,
      runLogShow,
    })
    expect(section).toBe('')
    expect(runLogShow).not.toHaveBeenCalled()
  })

  it('sink 未启用：未采样', async () => {
    const runLogShow = vi.fn(() => Promise.resolve(''))
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => false,
      runLogShow,
    })
    expect(section).toBe('')
    expect(runLogShow).not.toHaveBeenCalled()
  })

  it('log show 成功：匹配行渲染为 section（含窗口 ISO）', async () => {
    const stdout = '2026-09-20 05:37:13.463 runningboardd [anon<Electron>(501):32442] termination reported by proc_exit'
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => true,
      runLogShow: () => Promise.resolve(stdout),
    })
    expect(section).toContain('[unified-log-correlation] matched=1 truncated=false')
    expect(section).toContain('[unified-log-correlation] 2026-09-20 05:37:13.463')
    expect(section).toContain('window=')
  })

  it('log show 失败（超时等）：unavailable 行显式落盘，不 reject', async () => {
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => true,
      runLogShow: () => Promise.reject(new Error('timeout exceeded')),
    })
    expect(section).toContain('[unified-log-correlation]')
    expect(section).toContain('unavailable: timeout exceeded')
  })

  it('零匹配也是显式阴性证据（matched=0）', async () => {
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => true,
      runLogShow: () => Promise.resolve('nothing relevant'),
    })
    expect(section).toContain('matched=0 truncated=false')
  })
})
