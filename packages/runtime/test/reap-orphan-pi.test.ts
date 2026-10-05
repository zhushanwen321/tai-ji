/**
 * reapOrphanPiProcesses 收殓状态机定向测试（CRAP 靶子：killOrphan）。
 *
 * 全依赖注入设计（listProcesses / signal / readSpawnMarkers /
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
  const calls: Array<{ pid: number; signal: 'SIGKILL' }> = []
  const fn = (pid: number, signal: 'SIGKILL') => {
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
  calls: Array<{ pid: number; signal: 'SIGKILL' }>
} {
  const signal = scriptedSignal(script)
  const options: ReapOrphanOptions = {
    dataDir: DATA_DIR,
    ownPid: 999,
    listProcesses: () => Promise.resolve(stdout),
    signal: signal.fn,
    readSpawnMarkers: markers,
    // SIGKILL 前 pid 复用复验的 ps 依赖注入：null = ps 不可用（防线缺席按现状继续）
    readProcessStartTime: () => Promise.resolve(null),
  }
  return { options, calls: signal.calls }
}

describe('killOrphan 处置序列（单孤儿全分支，SIGKILL 直杀）', () => {
  it('SIGKILL 成功 → reaped', async () => {
    const { options, calls } = makeOptions(['ok'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(result.failed).toEqual([])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })

  it('SIGKILL 时目标已自行退出（ESRCH）→ 幂等按已回收计', async () => {
    const { options, calls } = makeOptions(['esrch'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })

  it('SIGKILL 失败（EPERM）→ failed（best-effort 不抛）', async () => {
    const { options, calls } = makeOptions(['eperm'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([4242])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })

  it('SIGKILL 前 lstart 变化（pid 已复用）→ 跳过 SIGKILL 按已回收计 + warn（防线①补强）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { options, calls } = makeOptions([])
      // lstart 读取序列：处置起点 1000 → SIGKILL 前复读 2000（变化 = 原孤儿已死、pid 复用）
      const reads = [1000, 2000]
      options.readProcessStartTime = () => Promise.resolve(reads.shift() ?? 2000)
      const result = await reapOrphanPiProcesses(options)
      expect(result.reaped).toEqual([4242])
      expect(result.failed).toEqual([])
      expect(calls).toEqual([])
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('reused between scan and SIGKILL'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('SIGKILL 前 lstart 复读失败（ps 不可用返回 null）→ 不阻断，照常 SIGKILL（防线尽力而为）', async () => {
    const { options, calls } = makeOptions(['ok'])
    options.readProcessStartTime = () => Promise.resolve(null)
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(result.failed).toEqual([])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })
})

describe('reapOrphanPiProcesses 编排层', () => {
  it('无孤儿（进程表无匹配行）→ 零处置早退', async () => {
    const { options, calls } = makeOptions([], '  1     0 /sbin/launchd\n 999 1 zsh --mode rpc\n')
    const result = await reapOrphanPiProcesses(options)
    expect(result).toEqual({ scanned: 2, reaped: [], failed: [], unsupported: false })
    expect(calls).toEqual([])
  })

  it('多孤儿逐个处置（各自独立成败汇总）', async () => {
    // 两个孤儿：4242 直杀成功；4243 SIGKILL 时已自行退出（幂等按已回收计）
    const stdout = `${orphanRow(4242)}\n${orphanRow(4243)}`
    const script = scriptedSignal(['ok', 'esrch'])
    const options: ReapOrphanOptions = {
      dataDir: DATA_DIR,
      ownPid: 999,
      listProcesses: () => Promise.resolve(stdout),
      signal: script.fn,
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
