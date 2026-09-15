/**
 * FileService.readFileFromWhitelist 单测（#7，T6.3/T6.11）。
 *
 * 覆盖：
 * - T6.3 cwd 外非白名单目录 → FileError('out_of_cwd')
 * - T6.11 白名单目录内文件可读（~/.agents/skills 等 BC-3 三目录兼容）
 * - 文件不存在 → FileError('not_found')
 * - >1MB 截断（truncated=true）
 *
 * mock 策略：IFileExecutor + sessionService 注入，不起真实 fs。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/file-read-permission.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FileService, type FileServiceOptions } from '../src/services/file-service.js'
import { FileError } from '../src/services/file-error.js'
import type { IFileExecutor } from '../src/services/ports/file-executor.js'

const executor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
const sessionService = { getSummary: vi.fn() }
const ALLOWED = ['/home/user/.agents/skills', '/data/agent/skills', '/data/agent/npm']

function svc(): FileService {
  return new FileService({
    sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
    executor: executor as unknown as IFileExecutor,
    allowedReadDirs: ALLOWED,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FileService.readFileFromWhitelist (#7 BC-3 白名单)', () => {
  it('T6.11 白名单目录内文件可读（~/.agents/skills 下）', async () => {
    executor.stat.mockResolvedValueOnce({ type: 'file', size: 100 })
    executor.readFile.mockResolvedValueOnce('file content')
    const result = await svc().readFileFromWhitelist('/home/user/.agents/skills/my-skill/SKILL.md')
    expect(result.content).toBe('file content')
    expect(result.truncated).toBe(false)
  })

  it('T6.3 白名单外路径 → FileError(out_of_cwd)', async () => {
    await expect(svc().readFileFromWhitelist('/etc/passwd')).rejects.toMatchObject({
      code: 'out_of_cwd',
    })
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('路径穿越 ../../etc → FileError(out_of_cwd)', async () => {
    await expect(
      svc().readFileFromWhitelist('/home/user/.agents/skills/../../../etc/passwd'),
    ).rejects.toMatchObject({ code: 'out_of_cwd' })
  })

  it('文件不存在 → FileError(not_found)', async () => {
    executor.stat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(
      svc().readFileFromWhitelist('/home/user/.agents/skills/missing.md'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('>1MB 文件 → truncated=true', async () => {
    const big = 'x'.repeat(2_000_000)
    executor.stat.mockResolvedValueOnce({ type: 'file', size: 2_000_000 })
    executor.readFile.mockResolvedValueOnce(big)
    const result = await svc().readFileFromWhitelist('/home/user/.agents/skills/big.md')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBe(1_048_576) // MAX_FILE_SIZE
  })

  it('无 allowedReadDirs 配置 → 任何路径都 out_of_cwd', async () => {
    const svcNoWhitelist = new FileService({
      sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
      executor: executor as unknown as IFileExecutor,
    })
    await expect(svcNoWhitelist.readFileFromWhitelist('/any/path')).rejects.toMatchObject({
      code: 'out_of_cwd',
    })
  })
})

/**
 * FileService.readFile(sessionId, path) 单测（W5 #7 BC-3 扩展：cwd 子树守门）。
 *
 * 覆盖 file.read 有 sessionId 的分流路径（file-message-handler 根据 sessionId 有无分流）：
 * - sessionId 存在 → readFile(sessionId, path) 走 cwd 守门（isUnderOrEqual(cwd, resolvedPath)）
 * - cwd 内文件可读（相对路径 + 绝对路径穿越）
 * - cwd 外路径 → FileError('out_of_cwd')
 * - bad sessionId → FileError('session_not_found')
 * - >1MB 截断
 */
describe('FileService.readFile (W5 #7 cwd 子树守门)', () => {
  const CWD = '/project/sample'

  beforeEach(() => {
    sessionService.getSummary.mockReturnValue({ cwd: CWD })
  })

  it('cwd 内相对路径文件可读', async () => {
    executor.stat.mockResolvedValueOnce({ type: 'file', size: 100 })
    executor.readFile.mockResolvedValueOnce('file content')
    const result = await svc().readFile('sess-1', 'src/index.ts')
    expect(result.content).toBe('file content')
    expect(result.truncated).toBe(false)
  })

  it('cwd 外路径 → FileError(out_of_cwd)', async () => {
    await expect(svc().readFile('sess-1', '../../../etc/passwd')).rejects.toMatchObject({
      code: 'out_of_cwd',
    })
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('bad sessionId（无 cwd）→ FileError(session_not_found)', async () => {
    sessionService.getSummary.mockReturnValueOnce(null)
    await expect(svc().readFile('bad-sess', 'src/index.ts')).rejects.toMatchObject({
      code: 'session_not_found',
    })
  })

  it('>1MB 文件 → truncated=true', async () => {
    const big = 'x'.repeat(2_000_000)
    executor.stat.mockResolvedValueOnce({ type: 'file', size: 2_000_000 })
    executor.readFile.mockResolvedValueOnce(big)
    const result = await svc().readFile('sess-1', 'big.log')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBe(1_048_576)
  })

  it('文件不存在 → FileError(not_found)', async () => {
    executor.stat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(svc().readFile('sess-1', 'missing.ts')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
