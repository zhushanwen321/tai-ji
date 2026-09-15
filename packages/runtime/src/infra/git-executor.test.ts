/**
 * GitExecutor 单测（perf W16：execFileSync → execFile 异步化后的行为等价验证）。
 *
 * 覆盖 port 契约的四个分支（与同步版语义逐一等价）：
 * - exitCode 0 → {stdout, stderr:'', exitCode:0}
 * - 非零退出 → 原样返回 {exitCode, stderr}，不抛
 * - ENOENT（git 未安装）→ GitExecutorError('git_unavailable')
 * - 超时（killed + SIGTERM）→ GitExecutorError('timeout')
 * 外加：数组参数透传（防注入）、timeoutMs 覆盖（GitStateService 5000ms 收紧用）。
 *
 * 测试框架 vitest，运行命令 npx vitest run。
 */
import { execFile } from 'node:child_process'
import type { ExecFileException, ExecFileOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitExecutor } from './git-executor.js'
import { GitExecutorError } from '../services/ports/git-executor.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const execFileMock = vi.mocked(execFile)

/** execFile 回调错误对象的最小可构造形状（对齐 @types/node ExecFileException 的可选字段）。 */
type FakeExecError = ExecFileException & { killed?: boolean; signal?: string }

/** 触发 execFile mock 回调的错误/成功构造器。 */
function execError(overrides: Partial<FakeExecError>): ExecFileException {
  return Object.assign(new Error('Command failed: git'), overrides)
}

let capturedCallback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | null | undefined

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
