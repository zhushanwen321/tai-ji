/**
 * FileService.readFile 真实 fs 集成测试（real 层）。
 *
 * 覆盖越界守门（NFR-AC-S2）：cwd 之外路径（绝对路径 / ~ 展开）必须被 out_of_cwd 拒绝。
 *
 * 运行：cd packages/runtime && npx vitest run test/file-service-real.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileService } from '../src/services/file-service.js'
import { FsExecutor } from '../src/infra/fs-executor.js'
import { FileError } from '../src/services/file-error.js'
import type { ISessionService } from '../src/interfaces.js'

describe('FileService.readFile real fs', () => {
  let tempDir: string
  let service: FileService

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'file-service-real-'))
    const sessionService: ISessionService = {
      getSummary: vi.fn().mockReturnValue({ cwd: tempDir }),
    } as unknown as ISessionService
    service = new FileService({ sessionService, executor: new FsExecutor() })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('E1: cwd 内文件正常读取', async () => {
    const insideFile = join(tempDir, 'inside.md')
    writeFileSync(insideFile, 'inside content')

    const result = await service.readFile('s1', 'inside.md')
    expect(result).toEqual({ content: 'inside content', truncated: false })
  })

  it('E2: cwd 外绝对路径 → FileError(out_of_cwd)', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-outside-'))
    const outsideFile = join(outsideDir, 'outside.md')
    writeFileSync(outsideFile, 'outside content')

    try {
      await expect(service.readFile('s1', outsideFile)).rejects.toMatchObject({
        name: 'FileError',
        code: 'out_of_cwd',
      })
    } finally {
      rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('E3: cwd 外绝对路径抛出的是 FileError 实例（类型守卫）', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-outside-'))
    const outsideFile = join(outsideDir, 'outside.md')
    writeFileSync(outsideFile, 'outside content')

    try {
      await expect(service.readFile('s1', outsideFile)).rejects.toBeInstanceOf(FileError)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
