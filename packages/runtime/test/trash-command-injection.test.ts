/**
 * RT-8#2 trash 命令注入修复验证（code-harden 审计批次 1）：
 * 原 `execSync` 模板字符串把 filePath 拼进 shell 命令，路径含 `"` / `$()` 即
 * 逃逸执行任意命令。修复后必须全程数组参数（execFileSync），filePath 作为
 * 单一数组元素原样传入、不经任何 shell 解释；失败回落 osascript 同样数组参数，
 * 且 stderr 并入重抛的错误消息（不再 2>/dev/null 吞真因）。
 *
 * Mock 策略：child_process 整模块 mock（不 spawn 真实进程）+ platform 钉死
 * darwin（走 mac 分支）。buildOutboundChildEnv / logger / toErrorMessage 用
 * 真实实现（纯函数 / 未 initLogger 时 no-op，无文件系统副作用）。
 *
 * 运行：cd packages/runtime && npx vitest run test/trash-command-injection.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'darwin' }
})

import { execFileSync } from 'node:child_process'
import { trash } from '../src/infra/system/trash.js'

const execMock = vi.mocked(execFileSync)

/** 模拟 execFileSync 抛错并携带捕获的 stderr（child_process 真实行为：error.stderr）。 */
function childFailure(message: string, stderr: string): Error {
  const err = new Error(message)
  Object.defineProperty(err, 'stderr', { value: Buffer.from(stderr, 'utf-8') })
  return err
}

describe('RT-8#2: trash 数组参数形态（无 shell 解释面）', () => {
  beforeEach(() => {
    execMock.mockReset().mockReturnValue(Buffer.from(''))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['双引号', '/tmp/evil") && rm -rf ~ #.jsonl'],
    ['命令替换 $()', '/tmp/evil$(touch /tmp/pwned).jsonl'],
    ['空格', '/tmp/my session file.jsonl'],
    ['反引号', '/tmp/evil`touch /tmp/pwned`.jsonl'],
  ])('路径含 %s：trash 收到数组参数，filePath 是唯一元素且原样传入', async (_label, filePath) => {
    await trash(filePath)

    expect(execMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = execMock.mock.calls[0]!
    expect(cmd).toBe('trash')
    // 数组形态 + filePath 作为单一元素原样传入（未被 shell 解释/重排）
    expect(Array.isArray(args)).toBe(true)
    expect(args).toEqual([filePath])
  })

  it('trash 成功即返回，不回落 osascript', async () => {
    await trash('/tmp/normal.jsonl')

    expect(execMock).toHaveBeenCalledTimes(1)
    expect(execMock.mock.calls[0]![0]).toBe('trash')
  })

  it.each([
    ['双引号', '/tmp/evil".jsonl'],
    ['命令替换 $()', '/tmp/evil$(id).jsonl'],
    ['空格', '/tmp/a b.jsonl'],
  ])('trash 失败回落 osascript：路径含 %s 时经 argv 注入、不进 AppleScript 源码', async (_label, filePath) => {
    execMock.mockReset()
    execMock.mockImplementationOnce(() => { throw childFailure('spawn ENOENT', '') })
      .mockReturnValue(Buffer.from(''))

    await trash(filePath)

    expect(execMock).toHaveBeenCalledTimes(2)
    const [fallbackCmd, fallbackArgs] = execMock.mock.calls[1]!
    expect(fallbackCmd).toBe('osascript')
    expect(Array.isArray(fallbackArgs)).toBe(true)
    const [eFlag, script, ...argv] = fallbackArgs as string[]
    // argv 注入形态：-e script + 路径作为独立参数（item 1 of argv），路径绝不拼进 script
    expect(eFlag).toBe('-e')
    expect(script).toContain('on run argv')
    expect(script).not.toContain(filePath)
    expect(argv).toEqual([filePath])
  })

  it('双失败：stderr 内容并入重抛错误消息（不再 2>/dev/null 吞真因），且消息含恢复动作', async () => {
    execMock.mockReset()
    execMock
      .mockImplementationOnce(() => { throw childFailure('trash: not found', '') })
      .mockImplementationOnce(() => {
        throw childFailure('osascript: execution failed', 'Finder got an error: -1728')
      })

    const failure = trash('/tmp/failed.jsonl')
    await expect(failure).rejects.toThrow('移入废纸篓失败')
    await expect(failure).rejects.toThrow('Finder got an error: -1728')
    await expect(failure).rejects.toThrow('文件已保留在原位置')
  })
})
