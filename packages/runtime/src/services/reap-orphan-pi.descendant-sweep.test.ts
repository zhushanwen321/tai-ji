/**
 * 孤儿 pi 收殓——后代枚举默认实现链单测（defaultGetDescendantPids / queryChildPids，
 * 真实 execFile('pgrep -P') BFS）。
 *
 * 既有收殓用例（reap-orphan-pi.test.ts）全部注入 getDescendantPids 替身，默认链的
 * 四个分支无覆盖：① 成功解析（含噪声行过滤）/ ② pgrep 退出码 1（无子进程，常态，
 * resolve('') 放行）/ ③ ENOENT（缺 pgrep，warn 一次全局降级）/ ④ 其他错误（reject →
 * warn 后按空表继续）。本文件 mock node:child_process 后走「不注入 getDescendantPids」
 * 路径逐分支锁定，另锁 BFS 环防护（root 回环不入队）与后代 SIGKILL 硬失败留痕。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/reap-orphan-pi.descendant-sweep.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { reapOrphanPiProcesses, type PsRow } from './reap-orphan-pi.js'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

// 只替换 execFile（收殓模块的唯一子进程出口）；其余导出保持原实现，防图谱内其他模块踩空。
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: execFileMock,
}))

/** 本实例数据目录（判据不消费 sessions 路径，任意绝对串即可；清单走注入替身）。 */
const DATA_DIR = '/Users/tester/.taiji'
const OWN_PID = 100
const MARKERS = ['/extensions/pi-agent-ext'] as const

/** 孤儿 pi argv（判据 v2 形态：--mode rpc + --no-extensions + 清单值精确相等）。 */
function piCmd(): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --extension ${MARKERS[0]}`
}

function row(pid: number, ppid = 1): PsRow {
  return { pid, ppid, command: piCmd() }
}

function psStdout(rows: PsRow[]): string {
  return rows.map(r => `  ${r.pid}   ${r.ppid} ${r.command}`).join('\n') + '\n'
}

/** pgrep 退出码错误形态（execFile 回调错误的 code 运行时是数字退出码）。 */
function pgrepExit(code: number): NodeJS.ErrnoException {
  // execFile 回调错误的 code 运行时是数字退出码（ErrnoException 类型声明为 string，经 unknown 中转比对）
  return Object.assign(new Error(`pgrep exited ${code}`), { code: code as unknown as string })
}

/** pgrep 系统级错误形态（ENOENT = 二进制缺失；EPERM 等为其他失败）。 */
function pgrepErrno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}`), { code })
}

/** 回调异步化（真实 execFile 异步回调形态，避免伪同步穿透 await 语义）。 */
function respond(cb: (err: NodeJS.ErrnoException | null, out?: string) => void, err: NodeJS.ErrnoException | null, out: string): void {
  queueMicrotask(() => cb(err, out))
}

/** 默认 pgrep 路由：未登记的 pid 按真实 pgrep 无子进程形态回退出码 1 + 空输出。 */
function routePgrep(childrenOf: Record<string, string | { err: NodeJS.ErrnoException; out: string }>): void {
  execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: NodeJS.ErrnoException | null, out?: string) => void) => {
    if (_file !== 'pgrep') throw new Error(`unexpected execFile target: ${_file}`)
    const entry = childrenOf[args[1]!] ?? { err: pgrepExit(1), out: '' }
    if (typeof entry === 'string') respond(cb, null, entry)
    else respond(cb, entry.err, entry.out)
  })
}

let warnSpy: MockInstance<typeof console.warn>
let logSpy: MockInstance<typeof console.log>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  execFileMock.mockReset()
})

describe('reapOrphanPiProcesses 后代枚举默认链（pgrep -P BFS）', () => {
  it('默认 BFS：成功解析 + 噪声行过滤 + 环防护（root 回环不入队），树按层序全量收口', async () => {
    routePgrep({
      '900': '901\n902\n',
      '901': '903\nnot-a-pid\n-7\n0\n', // 噪声行：非数字/负数/0 一律过滤
      // 902 无子进程（路由缺省 → 退出码 1 空表）
      '903': '900\n', // 环防护：echo 处置起点（root 已在 visited，不再入队）
    })
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(900)]),
      signal,
      delay: async () => {},
      readProcessStartTime: async () => 1234, // 两时点同值：不复用，走 SIGKILL 正常链
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([900])
    expect(res.reapedDescendants).toEqual([901, 902, 903])
    // BFS 层序 + visited 去重：900 → [901,902] → 901 探 [903] → 903 探到 900 不入队
    const pgrepPids = execFileMock.mock.calls.filter(c => c[0] === 'pgrep').map(c => (c[1] as string[])[1])
    expect(pgrepPids).toEqual(['900', '901', '902', '903'])
    // 噪声行不产生信号（-7 / 0 不被当成后代）
    const swept = signal.mock.calls.filter(c => c[1] === 'SIGKILL').map(c => c[0])
    expect(swept).toEqual([900, 901, 902, 903])
  })

  it('pgrep 缺失（ENOENT）：warn 一次 + 后代清扫降级为不扫，pi 本体照常收殓', async () => {
    // 两个孤儿同轮：每次 killOrphan 都会枚举后代 → ENOENT 触发两次，warn 只落一次
    routePgrep({
      '910': { err: pgrepErrno('ENOENT'), out: '' },
      '911': { err: pgrepErrno('ENOENT'), out: '' },
    })
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(910), row(911)]),
      signal,
      delay: async () => {},
      readProcessStartTime: async () => null, // lstart 防线缺席：按现状继续（既有语义）
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([910, 911])
    expect(res.reapedDescendants).toBeUndefined() // 空表清扫：字段缺席（toEqual 形状兼容）
    const enoentWarns = warnSpy.mock.calls.filter(c => String(c[0]).includes('pgrep not available'))
    expect(enoentWarns).toHaveLength(1) // 模块级 warn-once，逐 pid 刷屏不再发生
    // 后代零信号：触达的 pid 只有 pi 本体（SIGTERM / 探活 0 / SIGKILL）
    const touched = signal.mock.calls.map(c => c[0])
    expect(touched.every(pid => pid === 910 || pid === 911)).toBe(true)
  })

  it('pgrep 其他失败（非退出码 1 / 非 ENOENT）：reject → warn 留痕后按空表继续，不阻断收殓', async () => {
    routePgrep({ '920': { err: pgrepErrno('EPERM'), out: '' } })
    const signal = vi.fn()
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(920)]),
      signal,
      delay: async () => {},
      readProcessStartTime: async () => 1234,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([920])
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('pgrep -P 920 failed'))).toBe(true)
    expect(res.reapedDescendants).toBeUndefined()
  })

  it('后代 SIGKILL 硬失败（非 ESRCH）：warn 留痕、不计入 swept（观测面只收实际发信号的 pid）', async () => {
    routePgrep({ '930': '931\n' })
    const signal = vi.fn((pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0) => {
      if (sig === 'SIGKILL' && pid === 931) throw pgrepErrno('EPERM')
    })
    const res = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: OWN_PID,
      listProcesses: async () => psStdout([row(930)]),
      signal,
      delay: async () => {},
      readProcessStartTime: async () => 1234,
      readSpawnMarkers: () => [...MARKERS],
    })
    expect(res.reaped).toEqual([930]) // pi 本体 SIGKILL 成功（只对 931 失败）
    expect(res.reapedDescendants).toBeUndefined() // 931 SIGKILL 失败 → 无 swept
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('SIGKILL failed for descendant pid=931'))).toBe(true)
    expect(logSpy.mock.calls.some(c => String(c[0]).startsWith('[orphan-reap] swept'))).toBe(false) // 空清扫不虚报
  })
})
