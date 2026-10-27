import { GitExecutorError } from '../services/ports/git-executor.js';
import { ShellRunnerError, type SpawnFn } from '../services/ports/shell-runner.js';
import { GitExecutor } from './git-executor.js';
import { ShellRunner } from './shell-runner.js';
import { ExecFileOptions, execFile, type ExecFileException } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/git-executor.test.ts
// ======================================================================

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn() }
})


const execFileMock = vi.mocked(execFile)


/** execFile 回调错误对象的最小可构造形状（对齐 @types/node ExecFileException 的可选字段）。 */
type FakeExecError = ExecFileException & { killed?: boolean; signal?: string }


/** 触发 execFile mock 回调的错误/成功构造器。 */
function execError(overrides: Partial<FakeExecError>): ExecFileException {
  return Object.assign(new Error('Command failed: git'), overrides)
}


let capturedCallback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | null | undefined

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('git-executor', () => {
beforeEach(() => {
  // 默认实现：捕获 callback 供用例手动触发（各用例 mockImplementation 覆盖具体行为）
  execFileMock.mockImplementation((_file, _args, _opts, cb) => {
    capturedCallback = cb
    return {} as ReturnType<typeof execFile>
  })
})
afterEach(() => {
  execFileMock.mockReset()
})
describe('GitExecutor.exec（异步化行为等价）', () => {
  it('exitCode 0：返回 {stdout, stderr:"", exitCode:0}，数组参数不经 shell', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb?.(null, ' M a.ts\n', '')
      return {} as ReturnType<typeof execFile>
    })
    const executor = new GitExecutor()

    const result = await executor.exec('/repo', 'status', ['--porcelain'])

    expect(result).toEqual({ stdout: ' M a.ts\n', stderr: '', exitCode: 0 })
    // 防注入核心：command 与 args 以数组元素传给 execFile，不拼 shell 字符串
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({ cwd: '/repo', encoding: 'utf8' }),
      expect.any(Function),
    )
  })

  it('非零退出：原样返回 exitCode + stderr，不抛（非仓库等交由上层按语义判定）', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb?.(
        execError({ code: 128, killed: false, signal: undefined, stdout: '', stderr: 'fatal: not a git repository\n' }),
        '',
        'fatal: not a git repository\n',
      )
      return {} as ReturnType<typeof execFile>
    })
    const executor = new GitExecutor()

    const result = await executor.exec('/not-repo', 'status')

    expect(result).toEqual({ stdout: '', stderr: 'fatal: not a git repository\n', exitCode: 128 })
  })

  it('ENOENT（git 二进制不存在）：抛 GitExecutorError(git_unavailable)', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb?.(execError({ code: 'ENOENT' }), '', '')
      return {} as ReturnType<typeof execFile>
    })
    const executor = new GitExecutor()

    await expect(executor.exec('/repo', 'status')).rejects.toMatchObject({
      name: 'GitExecutorError',
      code: 'git_unavailable',
    })
  })

  it('超时（killed + SIGTERM）：抛 GitExecutorError(timeout)，message 含超时毫秒', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb?.(execError({ code: undefined, killed: true, signal: 'SIGTERM' }), '', '')
      return {} as ReturnType<typeof execFile>
    })
    const executor = new GitExecutor()

    await expect(executor.exec('/repo', 'status')).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(GitExecutorError)
      expect((e as GitExecutorError).code).toBe('timeout')
      expect((e as GitExecutorError).message).toContain('8000')
      return true
    })
  })

  it('默认超时 8000ms；opts.timeoutMs 覆盖（GitStateService snapshotStatus/numstat 用 5000ms）', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      cb?.(null, '', '')
      return {} as ReturnType<typeof execFile>
    })
    const executor = new GitExecutor()

    await executor.exec('/repo', 'status')
    expect(execFileMock).toHaveBeenLastCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ timeout: 8000 }),
      expect.any(Function),
    )

    await executor.exec('/repo', 'status', ['--porcelain'], { timeoutMs: 5000 })
    expect(execFileMock).toHaveBeenLastCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    )
  })

  it('异步性：执行挂起期间事件循环不被阻塞（pending promise 可被并发推进）', async () => {
    const executor = new GitExecutor()
    const pending = executor.exec('/repo', 'status')

    // 执行未完成，但微任务可正常推进（execSync 版本此处会阻塞）
    let ticked = false
    await Promise.resolve().then(() => {
      ticked = true
    })
    expect(ticked).toBe(true)
    expect(pending).toBeInstanceOf(Promise)

    capturedCallback?.(null, '', '')
    await expect(pending).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 })
  })
})
describe('GitExecutor env 出站接线（U4-B8）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('污染 deny 键不入 options.env；白名单基座（PATH/HOME）放行；非白名单键被过滤', async () => {
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '1')
    vi.stubEnv('TAIJI_RUNTIME_TOKEN', 'secret-token')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    vi.stubEnv('HOME', '/Users/tester')
    // 隐式继承语义下该键会原样跟随；显式白名单基座下必须消失
    vi.stubEnv('SOME_RANDOM_SESSION_VAR', 'leak-probe')

    const executor = new GitExecutor()
    const done = executor.exec('/repo', 'status')
    capturedCallback?.(null, '', '')
    await done

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const opts = execFileMock.mock.calls[0][2] as Record<string, unknown>
    const env = opts.env as Record<string, string>
    expect(env).toBeTruthy()
    expect(env.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(env.TAIJI_RUNTIME_TOKEN).toBeUndefined()
    // R2：基座保 PATH/HOME，git hooks / credential helper 不因 env 缺失远距离爆炸
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/tester')
    expect(env.SOME_RANDOM_SESSION_VAR).toBeUndefined()
  })
})
});

// ======================================================================
// ← src/infra/shell-runner.test.ts
// ======================================================================

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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('shell-runner', () => {
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
});
