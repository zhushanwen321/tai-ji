/**
 * FileService.readFile 真实 fs 集成测试（real 层）。
 *
 * 覆盖越界守门（NFR-AC-S2）：cwd 之外路径（绝对路径 / ~ 展开）必须被 out_of_cwd 拒绝。
 *
 * 运行：cd packages/runtime && npx vitest run test/file-service-real.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
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

/**
 * symlink 形态不一致场景（A1 实测回归）：session cwd 是前端/DB 记录的词法形态，
 * pi 子进程 process.cwd() 拼出的目标常是解析后物理形态（macOS /tmp → /private/tmp），
 * 纯词法前缀判定误拒同一物理目录内的文件。守门前两侧 realpath 归一后应放行。
 *
 * 构造：realDir（真实目录）+ linkDir（指向 realDir 的 symlink 别名）互为同一物理目录的
 * 两种形态——与 macOS /tmp vs /private/tmp 机制同构且跨平台确定（macOS 上 tmpdir 自身
 * 还叠加 /var → /private/var 一层，realDir 的 mkdtemp 返回值本身即词法形态）。
 */
describe('FileService.readFile symlink 形态不一致（realpath 归一守门）', () => {
  let realDir: string
  let linkParent: string
  let linkDir: string

  beforeEach(() => {
    realDir = mkdtempSync(join(tmpdir(), 'file-service-sym-real-'))
    linkParent = mkdtempSync(join(tmpdir(), 'file-service-sym-link-'))
    linkDir = join(linkParent, 'alias')
    symlinkSync(realDir, linkDir, 'dir')
  })

  afterEach(() => {
    for (const dir of [realDir, linkParent]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  const makeService = (cwd: string): FileService => {
    const sessionService: ISessionService = {
      getSummary: vi.fn().mockReturnValue({ cwd }),
    } as unknown as ISessionService
    return new FileService({ sessionService, executor: new FsExecutor() })
  }

  it('S1: cwd 用别名形态、目标用物理形态（A1 同构）→ 读取成功', async () => {
    writeFileSync(join(realDir, 'plan.md'), 'plan content')
    const result = await makeService(linkDir).readFile('s1', join(realDir, 'plan.md'))
    expect(result).toEqual({ content: 'plan content', truncated: false })
  })

  it('S2: 反向——cwd 用物理形态、目标用别名形态 → 读取成功', async () => {
    writeFileSync(join(realDir, 'plan.md'), 'plan content')
    const result = await makeService(realDir).readFile('s1', join(linkDir, 'plan.md'))
    expect(result).toEqual({ content: 'plan content', truncated: false })
  })

  it('S3: symlink cwd 下目标真在 cwd 外 → 仍 out_of_cwd', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-sym-out-'))
    writeFileSync(join(outsideDir, 'outside.md'), 'outside content')
    try {
      await expect(makeService(linkDir).readFile('s1', join(outsideDir, 'outside.md'))).rejects.toMatchObject({
        name: 'FileError',
        code: 'out_of_cwd',
      })
    } finally {
      rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('S4: 目标不存在（目标侧 realpath 失败退回词法路径）→ 仍 not_found', async () => {
    // A1 同构形态：目标前缀用 realpathSync(realDir) 的物理形态（pi 侧 process.cwd() 拼出
    // /private/tmp/... 的等价物）——realpath(cwd) 归一后与退回词法的目标串同前缀 → 守门通过，
    // not_found 由后续 stat ENOENT 给出。若退词法后误判越界或 realpath 失败抛错，此用例红。
    const physicalDir = realpathSync(realDir)
    await expect(makeService(linkDir).readFile('s1', join(physicalDir, 'missing.md'))).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
  })
})

describe('FileService.readFileFromWhitelist symlink 形态不一致', () => {
  let realDir: string
  let linkParent: string
  let linkDir: string

  beforeEach(() => {
    realDir = mkdtempSync(join(tmpdir(), 'file-service-wl-real-'))
    linkParent = mkdtempSync(join(tmpdir(), 'file-service-wl-link-'))
    linkDir = join(linkParent, 'alias')
    symlinkSync(realDir, linkDir, 'dir')
  })

  afterEach(() => {
    for (const dir of [realDir, linkParent]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  const makeWhitelistService = (allowedReadDirs: string[]): FileService =>
    new FileService({
      sessionService: { getSummary: vi.fn() } as unknown as ISessionService, // 白名单路不触达 sessionService
      executor: new FsExecutor(),
      allowedReadDirs,
    })

  it('W1: 白名单目录用别名形态、目标用物理形态 → 读取成功', async () => {
    writeFileSync(join(realDir, 'SKILL.md'), 'skill body')
    const result = await makeWhitelistService([linkDir]).readFileFromWhitelist(join(realDir, 'SKILL.md'))
    expect(result).toEqual({ content: 'skill body', truncated: false })
  })

  it('W2: 白名单外路径 → 仍 out_of_cwd', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'file-service-wl-out-'))
    writeFileSync(join(outsideDir, 'outside.md'), 'outside content')
    try {
      await expect(
        makeWhitelistService([linkDir]).readFileFromWhitelist(join(outsideDir, 'outside.md')),
      ).rejects.toMatchObject({ name: 'FileError', code: 'out_of_cwd' })
    } finally {
      rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
