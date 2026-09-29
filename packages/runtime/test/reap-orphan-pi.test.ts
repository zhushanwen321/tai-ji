/**
 * reapOrphanPiProcesses 收殓状态机定向测试（CRAP 靶子：killOrphan）。
 *
 * 全依赖注入设计（listProcesses / signal / delay / readSpawnMarkers /
 * readProcessStartTime 均可替换），零真实进程、零真实等待、零真实 fs。覆盖
 * killOrphan 处置序列全分支 + 编排层：
 * - SIGTERM 时目标已自行退出（ESRCH）→ 幂等按已回收计
 * - SIGTERM 其他错误（EPERM）→ failed
 * - 宽限后探活：已死（ESRCH）→ reaped（SIGTERM 生效）；探活 EPERM 按活着 → SIGKILL 兜底
 * - SIGKILL 成功 / SIGKILL 时已退出（ESRCH）→ reaped；SIGKILL 失败 → failed
 * - SIGKILL 前 pid 复用复验：lstart 变化 → 跳过 SIGKILL（按已回收计 + warn）；
 *   lstart 读取失败（null）→ 不阻断照常 SIGKILL
 * - 编排层：无孤儿早退（零 signal 调用）、ps 枚举失败降级 unsupported、Windows 平台跳过
 *
 * argv fixture 为判据 v2 四条合取形态（设计 §6.12：--mode rpc + --no-extensions +
 * 清单值 --extension；ppid=1 由 ps 行给位）；清单一律经 readSpawnMarkers 注入，
 * 与真实 <dataDir>/run/pi-spawn-markers.json 隔离（清单读取/降级分支的专测在
 * src/services/reap-orphan-pi.test.ts）。
 *
 * 运行：cd packages/runtime && npx vitest run test/reap-orphan-pi.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { reapOrphanPiProcesses, type ReapOrphanOptions } from '../src/services/reap-orphan-pi.js'

const DATA_DIR = '/data/taiji'

/** spawn 清单 fixture 值（staged 形态即可，本文件只测状态机，形态覆盖在 src 版专测）。 */
const MARKER = '/data/taiji/extensions/pi-agent-ext'

function orphanRow(pid: number): string {
  // ps -axo pid=,ppid=,command= 单行：ppid=1（reparent 证据）+ 判据 v2 同形 argv
  return `  ${pid}     1 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --approve --extension ${MARKER}`
}

/** 清单注入替身（编排层正常路径恒有清单；缺失/坏 JSON 的 fail-safe 分支在 src 版专测）。 */
function markers(): string[] {
  return [MARKER]
}

/** signal 注入工厂：按脚本序列响应（esrch 模拟 throw ESRCH / eperm 模拟 throw EPERM）。 */
function scriptedSignal(script: Array<'ok' | 'esrch' | 'eperm'>) {
  let call = 0
  const calls: Array<{ pid: number; signal: 'SIGTERM' | 'SIGKILL' | 0 }> = []
  const fn = (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => {
    calls.push({ pid, signal })
    const step = script[call] ?? 'ok'
    call += 1
    if (step === 'esrch') {
      const e = new Error(`kill ESRCH ${pid}`) as NodeJS.ErrnoException
      e.code = 'ESRCH'
      throw e
    }
    if (step === 'eperm') {
      const e = new Error(`kill EPERM ${pid}`) as NodeJS.ErrnoException
      e.code = 'EPERM'
      throw e
    }
  }
  return { fn, calls }
}

function makeOptions(script: Array<'ok' | 'esrch' | 'eperm'>, stdout = orphanRow(4242)): {
  options: ReapOrphanOptions
  calls: Array<{ pid: number; signal: 'SIGTERM' | 'SIGKILL' | 0 }>
  delays: number[]
} {
  const signal = scriptedSignal(script)
  const delays: number[] = []
  const options: ReapOrphanOptions = {
    dataDir: DATA_DIR,
    ownPid: 999,
    killGraceMs: 50,
    listProcesses: () => Promise.resolve(stdout),
    signal: signal.fn,
    delay: (ms) => { delays.push(ms); return Promise.resolve() },
    readSpawnMarkers: markers,
    // SIGKILL 前 pid 复用复验的 ps 依赖注入：null = ps 不可用（防线缺席按现状继续）
    readProcessStartTime: () => Promise.resolve(null),
  }
  return { options, calls: signal.calls, delays }
}

describe('killOrphan 处置序列（单孤儿全分支）', () => {
  it('SIGTERM 成功 + 宽限后探活已死（ESRCH）→ reaped（优雅退出路径）', async () => {
    // 调用序：SIGTERM(ok) → 探活 signal 0(esrch=已死) → 不发 SIGKILL
    const { options, calls, delays } = makeOptions(['ok', 'esrch'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(result.failed).toEqual([])
    expect(calls).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 0 },
    ])
    expect(delays).toEqual([50]) // 宽限等待一次
  })

  it('SIGTERM 时目标已自行退出（ESRCH）→ 幂等按已回收计，不再探活', async () => {
    const { options, calls } = makeOptions(['esrch'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGTERM' }]) // 单次调用即收
  })

  it('SIGTERM 失败（EPERM）→ failed（不再探活、不发 SIGKILL）', async () => {
    const { options, calls } = makeOptions(['eperm'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([4242])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
  })

  it('宽限后仍活（探活 ok）→ SIGKILL 兜底成功 → reaped', async () => {
    // 调用序：SIGTERM(ok) → 探活(ok=活着) → SIGKILL(ok)
    const { options, calls } = makeOptions(['ok', 'ok', 'ok'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(calls).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 0 },
      { pid: 4242, signal: 'SIGKILL' },
    ])
  })

  it('探活抛 EPERM（权限受限）按「活着」处理 → 仍走 SIGKILL 兜底（宁多一发强杀不漏收）', async () => {
    const { options, calls } = makeOptions(['ok', 'eperm', 'ok'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(calls[2]).toEqual({ pid: 4242, signal: 'SIGKILL' })
  })

  it('SIGKILL 时目标恰好退出（ESRCH）→ reaped（宽限内死亡幂等）', async () => {
    const { options } = makeOptions(['ok', 'ok', 'esrch'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
  })

  it('SIGKILL 失败（EPERM）→ failed（best-effort 不抛）', async () => {
    const { options } = makeOptions(['ok', 'ok', 'eperm'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([4242])
  })

  it('SIGKILL 前 lstart 变化（pid 已复用）→ 跳过 SIGKILL 按已回收计 + warn（防线①补强）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { options, calls } = makeOptions(['ok', 'ok'])
      // lstart 读取序列：处置起点 1000 → SIGKILL 前复读 2000（变化 = 原孤儿已死、pid 复用）
      const reads = [1000, 2000]
      options.readProcessStartTime = () => Promise.resolve(reads.shift() ?? 2000)
      const result = await reapOrphanPiProcesses(options)
      expect(result.reaped).toEqual([4242])
      expect(result.failed).toEqual([])
      // 未发 SIGKILL（跳过强杀）：全程只有 SIGTERM + 探活两次信号
      expect(calls.filter((c) => c.signal === 'SIGKILL')).toEqual([])
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('reused between scan and SIGKILL'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('SIGKILL 前 lstart 复读失败（ps 不可用返回 null）→ 不阻断，照常 SIGKILL（防线尽力而为）', async () => {
    const { options, calls } = makeOptions(['ok', 'ok', 'ok'])
    options.readProcessStartTime = () => Promise.resolve(null)
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(calls.map((c) => c.signal)).toEqual(['SIGTERM', 0, 'SIGKILL'])
  })
})

describe('reapOrphanPiProcesses 编排层', () => {
  it('无孤儿（进程表无匹配行）→ 零处置零等待早退', async () => {
    const { options, calls, delays } = makeOptions([], '  1     0 /sbin/launchd\n 999 1 zsh --mode rpc\n')
    const result = await reapOrphanPiProcesses(options)
    expect(result).toEqual({ scanned: 2, reaped: [], failed: [], unsupported: false })
    expect(calls).toEqual([])
    expect(delays).toEqual([])
  })

  it('多孤儿逐个处置（各自独立成败汇总）', async () => {
    // 两个孤儿：4242 优雅退出；4243 SIGTERM 即已退出
    const stdout = `${orphanRow(4242)}\n${orphanRow(4243)}`
    const script = scriptedSignal(['ok', 'esrch', 'esrch'])
    const options: ReapOrphanOptions = {
      dataDir: DATA_DIR,
      ownPid: 999,
      killGraceMs: 5,
      listProcesses: () => Promise.resolve(stdout),
      signal: script.fn,
      delay: () => Promise.resolve(),
      readSpawnMarkers: markers,
      readProcessStartTime: () => Promise.resolve(null),
    }
    const result = await reapOrphanPiProcesses(options)
    expect(result.scanned).toBe(2)
    expect([...result.reaped].sort()).toEqual([4242, 4243])
    expect(result.failed).toEqual([])
  })

  it('ps 枚举失败（无 ps / 不可执行）→ unsupported 降级返回，不抛', async () => {
    const result = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: 999,
      listProcesses: () => Promise.reject(new Error('spawn ps ENOENT')),
      signal: () => { throw new Error('should not be called') },
      delay: () => Promise.resolve(),
      readSpawnMarkers: markers,
    })
    expect(result.unsupported).toBe(true)
    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('活跃子进程（ppid=ownPid）与 argv 不同形 pi 不误杀（防线② + 判据 v2）', async () => {
    const stdout = [
      ` 4242 999 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --extension ${MARKER}`, // 本实例活跃子进程
      ` 4243   1 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --extension /other/data/extensions/user-ext`, // 值不在清单（他人/用户路径）
      ` 4244   1 /usr/bin/node /pi/cli.js --mode rpc --extension ${MARKER}`, // 无 --no-extensions（AGENTS.md 实测模板形态）
      orphanRow(4245), // 唯一真孤儿
    ].join('\n')
    const { options, calls } = makeOptions(['ok', 'esrch'], stdout)
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4245])
    expect(calls.every((c) => c.pid === 4245)).toBe(true)
  })

  it('Windows 平台降级 unsupported（不枚举不处置）', async () => {
    // platform 是 getter，vi.spyOn + defineProperty 双保险（vitest 4 下 spyOn get 可用）
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const listProcesses = vi.fn(() => Promise.resolve('should not be called'))
      const result = await reapOrphanPiProcesses({ dataDir: DATA_DIR, ownPid: 1, listProcesses, readSpawnMarkers: markers })
      expect(result.unsupported).toBe(true)
      expect(listProcesses).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
