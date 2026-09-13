import { spawnSync } from 'node:child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isPidAlive,
  killProcessTree,
  getProcessStartTimeSec,
  pidStartMatchesRegistered,
  type ProcessFallbackLogger,
} from './background-task-process'

// 真实进程用例（detached spawn / 孙子组 kill）走 libuv reap，满载下延迟不可预估；
// 孙子用例三段轮询串联最坏 15s，默认 5s 超时不够（基线 kill-tree.test 同款放宽）
vi.setConfig({ testTimeout: 20_000 })

// ── node:child_process 部分 mock：spawnSync 全接管（ps / pgrep / taskkill 不真跑）──
// 实现直接 import node:child_process（无依赖注入缝），算法矩阵的失败注入打在模块 mock
// 上；默认经 importOriginal 委托真实实现——真实进程用例（deadPid / detached spawn /
// 孙子组 kill）不受影响，矩阵用例内按需覆写（对齐 runtime
// background-task-reaper-primitives.test.ts 的 mock 边界惯例）
const childMock = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  actual: null as unknown as typeof import('node:child_process'),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  childMock.actual = actual
  childMock.spawnSync.mockImplementation(actual.spawnSync)
  return { ...actual, spawnSync: childMock.spawnSync }
})

const realPlatform = process.platform

beforeEach(() => {
  // 先清调用记录（防跨用例 toHaveBeenCalledWith 串味），再恢复默认委托真实实现
  vi.clearAllMocks()
  childMock.spawnSync.mockImplementation(childMock.actual.spawnSync)
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

/** 临时改写 process.platform（win32 / POSIX 分支在任一测试机上都可达）。 */
function stubProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function errnoLike(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/** 造一个已死且已被 reap 的 pid（spawnSync 返回时子进程已退出并被收割）。 */
function deadPid(): number {
  const result = spawnSync('true', [], { stdio: 'ignore' })
  if (result.pid === undefined) throw new Error('failed to spawn throwaway process')
  return result.pid
}

function collectFallback(): { steps: string[]; errs: unknown[]; logger: ProcessFallbackLogger } {
  const steps: string[] = []
  const errs: unknown[] = []
  return {
    steps,
    errs,
    logger: (step, err) => {
      steps.push(step)
      errs.push(err)
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询直到期望状态出现或超时：真实进程事件（退出 → libuv reap → pid 释放）在满载
 * 下延迟不可预估，固定 sleep 后单次断言是满载 flake 源——等状态而非猜时刻。
 */
async function pollUntil(check: () => boolean, deadlineMs: number, what: string): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}`)
    await sleep(25)
  }
}

/** pgrep -P 组内枚举：列 pid 直接子进程（组内快照，非全机扫描）。 */
function listChildPids(pid: number): number[] {
  const result = spawnSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  // exit 1 = 无匹配（空表正常态）；解析失败按空表处理，由轮询重试兜住 spawn 竞态
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describe('isPidAlive（pid 判据矩阵）', () => {
  it.each([
    ['0', 0],
    ['负数', -1],
    ['非整数', 1.5],
    ['NaN', Number.NaN],
  ])('非法 pid（%s）→ false', (_label, pid) => {
    expect(isPidAlive(pid)).toBe(false)
  })

  it('自身进程 → true', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('已死且被 reap 的 pid → false（ESRCH）', () => {
    expect(isPidAlive(deadPid())).toBe(false)
  })
})

describe('getProcessStartTimeSec', () => {
  it('活进程（自身）返回有限 epoch 秒数', () => {
    const startSec = getProcessStartTimeSec(process.pid)
    expect(typeof startSec).toBe('number')
    expect(startSec).toBeGreaterThan(0)
  })

  it('已死 pid / 非法 pid 返回 undefined（无法校验 → 调用方保守跳过）', () => {
    expect(getProcessStartTimeSec(deadPid())).toBeUndefined()
    expect(getProcessStartTimeSec(0)).toBeUndefined()
  })

  describe('错误注入（mock spawnSync；失败一律 undefined → 调用方保守跳过契约）', () => {
    it('ps 正常：lstart 解析为 epoch 秒（floor），参数带 5s 超时', () => {
      childMock.spawnSync.mockReturnValue({ status: 0, error: undefined, stdout: 'Mon Aug 25 14:23:45 2026\n' })
      const sec = getProcessStartTimeSec(999)
      expect(sec).toBe(Math.floor(Date.parse('Mon Aug 25 14:23:45 2026') / 1000))
      expect(childMock.spawnSync).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '999'], {
        encoding: 'utf8',
        timeout: 5_000,
      })
    })

    it('lstart 输出不可解析（Date.parse NaN）→ undefined', () => {
      childMock.spawnSync.mockReturnValue({ status: 0, error: undefined, stdout: 'garbage output' })
      expect(getProcessStartTimeSec(999)).toBeUndefined()
    })

    it('spawnSync 抛异常 → undefined（catch 兜底）', () => {
      childMock.spawnSync.mockImplementation(() => {
        throw new Error('ps exploded')
      })
      expect(getProcessStartTimeSec(999)).toBeUndefined()
    })

    it('result.error / status!==0 / 空 stdout 三态 → 均 undefined', () => {
      childMock.spawnSync.mockReturnValueOnce({ status: null, error: new Error('spawn failed'), stdout: '' })
      expect(getProcessStartTimeSec(999)).toBeUndefined()
      childMock.spawnSync.mockReturnValueOnce({ status: 1, error: undefined, stdout: '' })
      expect(getProcessStartTimeSec(999)).toBeUndefined()
      childMock.spawnSync.mockReturnValueOnce({ status: 0, error: undefined, stdout: '' })
      expect(getProcessStartTimeSec(999)).toBeUndefined()
    })
  })
})

describe('pidStartMatchesRegistered（宁不杀勿误杀判据矩阵）', () => {
  it('有登记 start time：精确比较（同单位 epoch 秒）', () => {
    expect(pidStartMatchesRegistered(1000, 1000, Date.now())).toBe(true)
    expect(pidStartMatchesRegistered(1001, 1000, Date.now())).toBe(false)
  })

  it('缺登记 start time：startedAtMs 秒级降级（actual ≤ floor(startedAtMs/1000)）', () => {
    expect(pidStartMatchesRegistered(5, undefined, 10_000)).toBe(true)
    expect(pidStartMatchesRegistered(11, undefined, 10_000)).toBe(false)
  })

  it('降级边界含等号：actual = floor(startedAtMs/1000) 仍匹配（floor 单调性，零误跳）', () => {
    expect(pidStartMatchesRegistered(10, undefined, 10_999)).toBe(true)
    expect(pidStartMatchesRegistered(11, undefined, 10_999)).toBe(false)
  })
})

describe('killProcessTree（幂等语义 + onFallback 注入；POSIX 分支）', () => {
  describePosix('POSIX 进程组路径', () => {
    it('对已死 pid 静默成功（不 throw），回退诊断经 onFallback 上报', () => {
      const { steps, logger } = collectFallback()
      expect(() => killProcessTree(deadPid(), logger)).not.toThrow()
      // 进程组 kill 与单 pid kill 均落空（ESRCH），各留一条诊断
      expect(steps).toContain('process-group-kill-missed')
      expect(steps).toContain('single-pid-kill-missed')
    })

    it('不注入 onFallback 时同样静默成功（回调可选）', () => {
      expect(() => killProcessTree(deadPid())).not.toThrow()
    })

    it('onFallback 收到原始 err（ESRCH，供适配方提取 message）', () => {
      let captured: unknown
      killProcessTree(deadPid(), (_step, err) => {
        if (captured === undefined) captured = err
      })
      expect((captured as NodeJS.ErrnoException).code).toBe('ESRCH')
    })

    it('非法 pid 直接返回，不触发任何回退诊断', () => {
      const { steps, logger } = collectFallback()
      killProcessTree(0, logger)
      killProcessTree(-5, logger)
      killProcessTree(1.5, logger)
      expect(steps).toEqual([])
    })

    it('detached 子进程（自成进程组）：进程组 kill 一次命中，进程死亡且无回退诊断', async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
      try {
        const { steps, logger } = collectFallback()
        killProcessTree(child.pid!, logger)
        // 轮询等待进程消亡（SIGKILL 异步生效）
        const deadline = Date.now() + 5000
        while (isPidAlive(child.pid!) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        expect(isPidAlive(child.pid!)).toBe(false)
        // 进程组 kill 命中 → 无任何回退诊断
        expect(steps).toEqual([])
      } finally {
        // 兜底清理（测试体已 kill 时幂等 no-op）
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          /* 已死 */
        }
      }
    })

    it('非 detached 子进程（与测试进程同组）：回退单 pid kill 命中，进程死亡', async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn('sleep', ['30'], { stdio: 'ignore' })
      try {
        const { steps, logger } = collectFallback()
        killProcessTree(child.pid!, logger)
        const deadline = Date.now() + 5000
        while (isPidAlive(child.pid!) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        expect(isPidAlive(child.pid!)).toBe(false)
        // 同组 spawn 下 child.pid 不是 pgid，进程组 kill 落空走单 pid 命中
        expect(steps).toContain('process-group-kill-missed')
        expect(steps).not.toContain('single-pid-kill-missed')
      } finally {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已死 */
        }
      }
    })

    it('detached 进程组整组覆盖含孙子进程（组长 + 两个子 sleep；reparent 不换组 → 组 kill 覆盖）', async () => {
      const { spawn } = await import('node:child_process')
      // 组长 sh + 两个子 sleep：进程组 kill 必须全部覆盖（基线 kill-tree.test 同款形态）
      const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      const pid = child.pid
      if (pid === undefined) throw new Error('no pid')
      try {
        // kill 前轮询等两个孙子真正 fork 出来，并用组内枚举（pgrep -P）记录孙子 pid
        // 快照——kill 后只对记录过的 pid 断言，禁全机 pgrep -f 扫描（满载并行时其他
        // 包测试会真实 spawn 同名命令，跨包互踩）
        let grandchildPids: number[] = []
        await pollUntil(
          () => {
            grandchildPids = listChildPids(pid)
            return isPidAlive(pid) && grandchildPids.length >= 2
          },
          5000,
          'grandchildren to spawn inside the group',
        )
        expect(isPidAlive(pid)).toBe(true)

        const { steps, logger } = collectFallback()
        killProcessTree(pid, logger)
        // 轮询组长死（等 libuv reap）
        await pollUntil(() => !isPidAlive(pid), 5000, 'group leader to die')
        // 覆盖面说明：killProcessTree 是进程组 kill（kill -- -<pgid>），孙子与组长同组、
        // 组长死后 reparent 不换组，故「组 kill + 组内 pid 记录」已覆盖「reparent 后孙子
        // 也能被杀」的原始意图；pid 复用概率在 5s 轮询窗口内可忽略
        await pollUntil(
          () => grandchildPids.every((gpid) => !isPidAlive(gpid)),
          5000,
          'recorded grandchildren to die',
        )
        // 组 kill 命中 → 零回退诊断
        expect(steps).toEqual([])
      } finally {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* 已死 */
        }
      }
    })
  })
})

describe('killProcessTree（Windows taskkill 分支；platform 桩 win32，spawnSync 已 mock → 全平台可跑）', () => {
  it('taskkill /F /T /PID 参数逐项断言；成功无诊断且不做子孙枚举', () => {
    stubProcessPlatform('win32')
    const { steps, logger } = collectFallback()
    childMock.spawnSync.mockReturnValue({ status: 0, error: undefined, stdout: '' })
    killProcessTree(777, logger)
    expect(childMock.spawnSync).toHaveBeenCalledTimes(1)
    expect(childMock.spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '777'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    expect(steps).toEqual([])
  })

  it('taskkill 失败（result.error，进程已死/权限）→ 仅 taskkill-failed 诊断不抛，原始 err 透传', () => {
    stubProcessPlatform('win32')
    const { steps, errs, logger } = collectFallback()
    const failure = errnoLike('ENOENT', 'spawn taskkill ENOENT')
    childMock.spawnSync.mockReturnValue({ status: null, error: failure, stdout: '' })
    expect(() => killProcessTree(777, logger)).not.toThrow()
    expect(steps).toEqual(['taskkill-failed'])
    expect(errs).toEqual([failure])
  })

  it('taskkill spawnSync 抛异常 → 同样仅 taskkill-failed 诊断不抛（收殓路径不中断）', () => {
    stubProcessPlatform('win32')
    const { steps, errs, logger } = collectFallback()
    const boom = new Error('taskkill spawn exploded')
    childMock.spawnSync.mockImplementation(() => {
      throw boom
    })
    expect(() => killProcessTree(777, logger)).not.toThrow()
    expect(steps).toEqual(['taskkill-failed'])
    expect(errs).toEqual([boom])
  })
})

describe('killProcessTree 回退路径（组长已死 → 单 pid kill + pgrep 递归；process.kill spy + mock spawnSync）', () => {
  describePosix('pgrep 递归矩阵', () => {
    it('组长已死（组 kill ESRCH）→ 降级单 pid kill + pgrep 递归，先孙后子顺序', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
        if (pid < 0) throw errnoLike('ESRCH', 'process group gone')
        return true
      })
      const { steps, logger } = collectFallback()
      // 进程树：4321 → {5100, 5101}；5100 → 5200（孙辈）；其余 pgrep 无子
      childMock.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
        const target = args[1]
        if (target === '4321') return { status: 0, error: undefined, stdout: '5100\n5101\n' }
        if (target === '5100') return { status: 0, error: undefined, stdout: '5200\n' }
        return { status: 1, error: undefined, stdout: '' }
      })
      killProcessTree(4321, logger)
      // kill 调用序列（含失败尝试）：组 kill(-4321) 抛错降级 → 单 kill(4321) →
      // 子孙递归先杀孙辈 5200 再杀子辈 5100 / 5101（防孙辈在父死后被 reparent
      // 逃逸枚举的顺序保证）
      expect(killSpy.mock.calls.map((c) => c[0])).toEqual([-4321, 4321, 5200, 5100, 5101])
      expect(childMock.spawnSync).toHaveBeenCalledWith('pgrep', ['-P', '4321'], { encoding: 'utf8' })
      // 全程仅组 kill 一处失败诊断
      expect(steps).toEqual(['process-group-kill-missed'])
    })

    it('单 pid 与子孙 kill 均已死（幂等）→ 仅诊断不抛；pgrep 非 pid 行被 parseInt guard 跳过', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw errnoLike('ESRCH', 'already dead')
      })
      const { steps, logger } = collectFallback()
      childMock.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args[1] === '4321') return { status: 0, error: undefined, stdout: '5100\nnot-a-pid\n\n' }
        return { status: 1, error: undefined, stdout: '' }
      })
      expect(() => killProcessTree(4321, logger)).not.toThrow()
      // 非 pid 行（NaN / 空行）被 parseInt guard 跳过，只对 5100 发 kill
      expect(killSpy.mock.calls.map((c) => c[0])).toEqual([-4321, 4321, 5100])
      expect(steps).toEqual(['process-group-kill-missed', 'single-pid-kill-missed', 'descendant-kill-missed'])
    })

    it('pgrep 抛异常（不可用）→ descendant-enumeration-failed 诊断，放弃子孙枚举', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
        if (pid < 0) throw errnoLike('ESRCH', 'process group gone')
        return true
      })
      const { steps, logger } = collectFallback()
      childMock.spawnSync.mockImplementation(() => {
        throw new Error('pgrep gone')
      })
      expect(() => killProcessTree(4321, logger)).not.toThrow()
      expect(killSpy.mock.calls.map((c) => c[0])).toEqual([-4321, 4321])
      expect(steps).toEqual(['process-group-kill-missed', 'descendant-enumeration-failed'])
    })

    it('pgrep result.error（ENOENT 形态：pgrep 缺失）→ 静默放弃枚举，无枚举诊断', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
        if (pid < 0) throw errnoLike('ESRCH', 'process group gone')
        return true
      })
      const { steps, logger } = collectFallback()
      childMock.spawnSync.mockReturnValue({ status: null, error: errnoLike('ENOENT', 'spawn pgrep ENOENT'), stdout: '' })
      killProcessTree(4321, logger)
      expect(killSpy.mock.calls.map((c) => c[0])).toEqual([-4321, 4321])
      // result.error 走静默 return 分支（区别于抛异常的 descendant-enumeration-failed 诊断）
      expect(steps).toEqual(['process-group-kill-missed'])
    })
  })
})
