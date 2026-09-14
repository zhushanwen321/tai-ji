/**
 * file-service.test.ts — searchFilesInCwd cwd 路用例（u2-runtime，landing `$` 候选数据通路）。
 *
 * 历史：原文件还有 F6 describe 测「文件操作超时」，但其断言对象是测试文件内
 * 复制的 withTimeout 副本（非 SUT 私有方法），2026-09 测试舰队审查（r2-16）裁撤；
 * SUT 写骨架 not_implemented 语义由 file-message-handler.test.ts（AC-14.4）覆盖。
 *
 * mock 策略照 file-service-ignore-cache.test.ts 范式（IFileExecutor + ISessionService
 * 构造注入，纯 mock 不触真实 fs）。覆盖验收条款：
 * - 合法 cwd 返回 files（全量递归 + sortNodes 排序）
 * - cwd 不存在（stat ENOENT）/ 非目录（stat type='file'）→ FileError('not_found')
 *   结构化失败（设计 D6 准入边界，不做白名单）
 * - session 路等价回归：searchFiles('s1') ≡ searchFilesInCwd(cwd)（薄包装行为不变），
 *   且 session 不存在仍抛 session_not_found（requireCwd 保留在包装层）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_SEARCH_RESULTS, FileService, type FileServiceOptions } from '../src/services/file-service.js'
import type { IFileExecutor, FsEntry } from '../src/services/ports/file-executor.js'

describe('FileService · searchFilesInCwd cwd 路 + searchFiles 薄包装等价回归', () => {
  const executor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
  const sessionService = { getSummary: vi.fn() }

  const svc = () =>
    new FileService({
      sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
      executor: executor as unknown as IFileExecutor,
    })

  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

  /** /repo stat 目录命中，其余（.gitignore 等）ENOENT → 空 matcher，不读文件。 */
  const statRepoDir = (p: string): Promise<{ type: 'dir'; size: number; mtimeMs: number }> =>
    p === '/repo' ? Promise.resolve({ type: 'dir', size: 0, mtimeMs: 1 }) : Promise.reject(enoent())

  /** 固定小目录树：顶层 b.ts + src/ + a.ts，src/ 下 x.ts。 */
  const listRepo = async (p: string): Promise<FsEntry[]> => {
    if (p === '/repo') {
      return [
        { name: 'b.ts', type: 'file' },
        { name: 'src', type: 'dir' },
        { name: 'a.ts', type: 'file' },
      ]
    }
    if (p === '/repo/src') return [{ name: 'x.ts', type: 'file' }]
    return []
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
  })

  it('cwd 路合法目录：返回扁平 FileNode[]（dir 在前 + name 降序，子目录递归）+ truncated=false', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(listRepo)

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    // sortNodes：dir 在前；同类型 name 降序（x.ts > b.ts > a.ts）
    expect(files.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
    expect(files.every((n) => !n.path.startsWith('/'))).toBe(true) // path 相对 cwd，无前导斜杠
    expect(truncated).toBe(false) // 小目录不触发 DoS 上限（D7）
  })

  it('cwd 不存在（stat ENOENT）→ FileError("not_found")，且不进入递归（准入先行）', async () => {
    executor.stat.mockRejectedValue(enoent())

    await expect(svc().searchFilesInCwd('/gone')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('cwd 是文件非目录（stat type=file）→ FileError("not_found")', async () => {
    executor.stat.mockResolvedValue({ type: 'file', size: 3, mtimeMs: 1 })

    await expect(svc().searchFilesInCwd('/repo')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
  })

  it('session 路等价回归：searchFiles("s1") 与 searchFilesInCwd("…cwd") 结果一致（薄包装行为不变）', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(listRepo)

    const service = svc()
    const viaSession = await service.searchFiles('s1')
    const viaCwd = await service.searchFilesInCwd('/repo')
    expect(viaSession).toEqual(viaCwd.files)
    expect(viaSession.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
  })

  it('session 路回归：session 不存在仍抛 session_not_found（requireCwd 保留在包装层）', async () => {
    sessionService.getSummary.mockReturnValue(undefined)

    await expect(svc().searchFiles('sX')).rejects.toMatchObject({
      name: 'FileError',
      code: 'session_not_found',
    })
  })

  it('session 存在但 cwd 目录已删（stat ENOENT）→ not_found（非 session_not_found，D6 #12）', async () => {
    // beforeEach 已置 getSummary → { cwd: '/repo' }：session 在、目录没了——session 路
    // 照样走 cwd 准入 stat，失败分类为 not_found（错误码语义：目录缺失 ≠ session 缺失）
    executor.stat.mockRejectedValue(enoent())

    await expect(svc().searchFiles('s1')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_found',
    })
    expect(executor.listDir).not.toHaveBeenCalled()
  })

  it('cwd 归一化（D6 #11）：`~/repo` 与带冗余段的 `/repo/./` 均 stat 归一后路径', async () => {
    const home = homedir()
    const statCalls: string[] = []
    // 归一后根有两形：/repo 与 <home>/repo（~ 展开产物）——都按目录命中
    const statNormalizedRepoDir = (p: string): Promise<{ type: 'dir'; size: number; mtimeMs: number }> =>
      p === '/repo' || p === join(home, 'repo')
        ? Promise.resolve({ type: 'dir', size: 0, mtimeMs: 1 })
        : Promise.reject(enoent())
    executor.stat.mockImplementation((p: string) => {
      statCalls.push(p)
      return statNormalizedRepoDir(p)
    })
    executor.readFile.mockRejectedValue(enoent())
    // ~ 展开后的根走 walk：listDir 把 <home>/repo 前缀映射回 /repo 的同一目录树
    const homeRepoPrefix = `${join(home, 'repo')}/`
    executor.listDir.mockImplementation(async (p: string) =>
      p === join(home, 'repo') ? listRepo('/repo') : listRepo(p.startsWith(homeRepoPrefix) ? p.replace(homeRepoPrefix, '/repo/') : p),
    )

    const { files } = await svc().searchFilesInCwd('~/repo')
    expect(files.map((n) => n.path)).toEqual(['src', 'src/x.ts', 'b.ts', 'a.ts'])
    expect(statCalls[0]).toBe(join(home, 'repo')) // ~ 已展开（executor 收到的全是规范绝对路径）

    statCalls.length = 0
    await svc().searchFilesInCwd('/repo/.')
    expect(statCalls[0]).toBe('/repo') // resolve 归一（尾段冗余剥离）
  })

  it('DoS 上限 5000 截止（D7）：同层还有未收集条目 → files 截在 5000 + truncated=true', async () => {
    // 单层 5001 文件：收集到第 5000 个时 cap 截止、本层还剩 1 条未收集（硬信号）
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(async (p: string) =>
      p === '/repo'
        ? Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, i) => ({ name: `f${i}.ts`, type: 'file' }))
        : [],
    )

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    expect(files).toHaveLength(MAX_SEARCH_RESULTS)
    expect(truncated).toBe(true)
  })

  it('DoS 上限边界（D7）：恰 5000 条全量收集完（自然扫完无剩余）→ truncated=false', async () => {
    executor.stat.mockImplementation(statRepoDir)
    executor.readFile.mockRejectedValue(enoent())
    executor.listDir.mockImplementation(async (p: string) =>
      p === '/repo'
        ? Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => ({ name: `f${i}.ts`, type: 'file' }))
        : [],
    )

    const { files, truncated } = await svc().searchFilesInCwd('/repo')

    expect(files).toHaveLength(MAX_SEARCH_RESULTS)
    expect(truncated).toBe(false)
  })
})

/**
 * file.write 骨架契约（#14 AC-14，自 file-write-skeleton.test.ts 并入）。
 *
 * FileService 三个写方法当前为骨架，一律 throw FileError('not_implemented')（#14 G4 实现延后）；
 * handler 侧 catch 后转结构化 { implemented:false } 的语义由 file-message-handler.test.ts AC-14.4 覆盖。
 * 若写实现落地，本 describe 应重写为真实行为测试（而非删除）。
 */
describe('FileService file.write 骨架 (#14 AC-14)', () => {
  const skeletonExecutor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
  const skeletonSessionService = { getSummary: vi.fn() }

  const skeletonSvc = () =>
    new FileService({
      sessionService: skeletonSessionService as unknown as FileServiceOptions['sessionService'],
      executor: skeletonExecutor as unknown as IFileExecutor,
    })

  beforeEach(() => {
    vi.clearAllMocks()
    // 骨架在抛 not_implemented 前先 requireCwd 校验 session 存在
    skeletonSessionService.getSummary.mockReturnValue({ cwd: '/repo' })
  })

  it('AC-14.1~14.3 createFile/renameFile/deleteFile 均抛 FileError(not_implemented) 且不触达 executor', async () => {
    await expect(skeletonSvc().createFile('s1', 'a.txt', 'hi')).rejects.toMatchObject({
      name: 'FileError',
      code: 'not_implemented',
    })
    await expect(skeletonSvc().renameFile('s1', 'a.txt', 'b.txt')).rejects.toMatchObject({
      code: 'not_implemented',
    })
    await expect(skeletonSvc().deleteFile('s1', 'a.txt')).rejects.toMatchObject({
      code: 'not_implemented',
    })
    expect(skeletonExecutor.listDir).not.toHaveBeenCalled()
    expect(skeletonExecutor.readFile).not.toHaveBeenCalled()
  })
})
