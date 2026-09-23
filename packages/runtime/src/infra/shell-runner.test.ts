/**
 * ShellRunner env 出站接线单测（U4-B8，docs/architecture/env-propagation-boundary.md）。
 *
 * 覆盖：execute 传给 spawn 的 env 必须是 buildOutboundChildEnv 输出——
 * 污染父 env（deny 两键）不出站、白名单基座键（PATH/HOME/TAIJI_ 前缀）放行（R2：
 * PATH/HOME 不许静默丢失）。spawn 经构造函数注入 mock，env 断言直取捕获的 options。
 * process.env 一律经 vi.stubEnv 注入/还原（红线 R3：测试禁直接读写真实 env）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/shell-runner.test.ts
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellRunner } from './shell-runner.js'
import { ShellRunnerError } from '../services/ports/shell-runner.js'
import type { SpawnFn } from '../services/ports/shell-runner.js'

/** 构造注入用假 spawn：同步 emit close(0)，并暴露捕获到的 spawn options。 */
function createFakeSpawn() {
  let capturedOptions: Record<string, unknown> | undefined
  const spawnFn = vi.fn((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
    capturedOptions = opts
    const child = new EventEmitter() as unknown as {
      stdout: EventEmitter
      stderr: EventEmitter
      on: EventEmitter['on']
      once: EventEmitter['once']
      emit: EventEmitter['emit']
      kill: (signal?: string) => void
      killed: boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    queueMicrotask(() => child.emit('close', 0))
    return child
  })
  return { spawnFn: spawnFn as unknown as SpawnFn, getOptions: () => capturedOptions }
}

describe('ShellRunner env 出站接线（U4-B8）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('污染 deny 键不入站产出；白名单基座（PATH/HOME/TAIJI_）放行', async () => {
    // 污染：deny 清单两键 + 合法白名单键
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '1')
    vi.stubEnv('TAIJI_RUNTIME_TOKEN', 'secret-token')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    vi.stubEnv('HOME', '/Users/tester')
    vi.stubEnv('TAIJI_AGENT_DEBUG', '1')

    const { spawnFn, getOptions } = createFakeSpawn()
    const runner = new ShellRunner({ spawn: spawnFn })
    // timeout 必传（port 契约）：120_000 = 改造前 infra 暗默认值，保持既有行为不变。
    const result = await runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 120_000 })

    expect(result.exitCode).toBe(0)
    const env = getOptions()?.env as Record<string, string>
    expect(env).toBeTruthy()
    expect(env.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(env.TAIJI_RUNTIME_TOKEN).toBeUndefined()
    // R2：白名单基座保 PATH/HOME，hooks 里不因 env 缺失而 git: command not found
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/tester')
    expect(env.TAIJI_AGENT_DEBUG).toBe('1')
  })

  it('env 为显式构建值而非隐式继承：非白名单键被基座过滤掉', async () => {
    // 隐式继承语义下该键会原样跟随子进程；显式白名单基座下必须消失
    vi.stubEnv('SOME_RANDOM_SESSION_VAR', 'leak-probe')

    const { spawnFn, getOptions } = createFakeSpawn()
    const runner = new ShellRunner({ spawn: spawnFn })
    await runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 120_000 })

    const env = getOptions()?.env as Record<string, string>
    expect(env.SOME_RANDOM_SESSION_VAR).toBeUndefined()
  })
})

/**
 * 构造可手动触发 close 的假 spawn（RT-8#8 信号退出码用例用）：child 不自动 settle，
 * 由用例 emit close(exitCode, signal)。
 */
function createManualSpawn() {
  const children: Array<{ emitClose: (exitCode: number | null, signal: NodeJS.Signals | null) => void }> = []
  const spawnFn = vi.fn(() => {
    // emitter 单独持有：child 被 cast 成窄形状供生产代码消费，emit('close') 经 emitter
    // 触发（从 cast 后的 child 上取 .emit 会丢 EventEmitter 类型，TS2339）
    const emitter = new EventEmitter()
    const child = emitter as unknown as {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: (signal?: string) => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    children.push({
      emitClose: (exitCode: number | null, signal: NodeJS.Signals | null) => {
        emitter.emit('close', exitCode, signal)
      },
    })
    return child
  })
  return { spawnFn: spawnFn as unknown as SpawnFn, children }
}

describe('ShellRunner 信号退出码（RT-8#8：exitCode ?? 0 假成功）', () => {
  it('被信号杀死（exitCode=null + signal=SIGTERM）→ 折算 128+15=143 非 0，stderr 带信号标记', async () => {
    const { spawnFn, children } = createManualSpawn()
    const runner = new ShellRunner({ spawn: spawnFn })
    const pending = runner.execute({ scriptPath: '/tmp/killed.sh', cwd: '/tmp', timeout: 120_000 })
    children[0]!.emitClose(null, 'SIGTERM')

    const result = await pending
    expect(result.exitCode).toBe(143)
    expect(result.stderr).toContain('killed by signal SIGTERM')
  })

  it('未知信号（表外）→ 兜底 128 仍是非 0（保持「非 0 = 失败」语义）', async () => {
    const { spawnFn, children } = createManualSpawn()
    const runner = new ShellRunner({ spawn: spawnFn })
    const pending = runner.execute({ scriptPath: '/tmp/killed.sh', cwd: '/tmp', timeout: 120_000 })
    children[0]!.emitClose(null, 'SIGUSR1')

    const result = await pending
    expect(result.exitCode).toBe(128)
    expect(result.stderr).toContain('killed by signal SIGUSR1')
  })

  it('正常失败（exitCode=1 + signal=null）→ 原样透传 1，不追加信号标记', async () => {
    const { spawnFn, children } = createManualSpawn()
    const runner = new ShellRunner({ spawn: spawnFn })
    const pending = runner.execute({ scriptPath: '/tmp/fail.sh', cwd: '/tmp', timeout: 120_000 })
    children[0]!.emitClose(1, null)

    const result = await pending
    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toContain('killed by signal')
  })
})

describe('ShellRunner 超时用户值生效（timeout-slow-flow-wallclock D4）', () => {
  it('调用方传入的 timeout 驱动超时判定：到期 SIGTERM + ShellRunnerError(timeout)，消息含用户值', async () => {
    // child 永不 close（模拟脚本挂死）；timeout=5ms 远小于旧暗默认 120s——
    // 若实现忽略调用方值回退暗默认，本测试在 vitest 超时内不会收到 reject，直接失败。
    const killSignals: (string | undefined)[] = []
    const neverClosingSpawn = vi.fn((_cmd: string, _args: string[], _opts: Record<string, unknown>) => {
      const c = new EventEmitter() as never as { stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => void }
      c.stdout = new EventEmitter()
      c.stderr = new EventEmitter()
      c.kill = (signal?: string) => { killSignals.push(signal) }
      return c
    })

    const runner = new ShellRunner({ spawn: neverClosingSpawn as unknown as SpawnFn })
    const pending = runner.execute({ scriptPath: '/tmp/hang.sh', cwd: '/tmp', timeout: 5 })
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    expect(killSignals).toContain('SIGTERM')
    // 错误消息回显调用方传入的量级（5ms），证明判定来自用户值而非内部默认
    await expect(pending).rejects.toThrow(/5ms/)
  })

  it('ShellRunnerError.timeout 分类可用（port 契约不变式）', () => {
    const err = new ShellRunnerError('timeout', 'probe')
    expect(err.code).toBe('timeout')
  })
})
