import { spawnSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import {
  isPidAlive,
  killProcessTree,
  getProcessStartTimeSec,
  pidStartMatchesRegistered,
  type ProcessFallbackLogger,
} from './background-task-process'

/** 造一个已死且已被 reap 的 pid（spawnSync 返回时子进程已退出并被收割）。 */
function deadPid(): number {
  const result = spawnSync('true', [], { stdio: 'ignore' })
  if (result.pid === undefined) throw new Error('failed to spawn throwaway process')
  return result.pid
}

function collectFallback(): { steps: string[]; logger: ProcessFallbackLogger } {
  const steps: string[] = []
  return { steps, logger: (step, _err) => steps.push(step) }
}

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
  const describePosix = process.platform === 'win32' ? describe.skip : describe

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
  })
})
