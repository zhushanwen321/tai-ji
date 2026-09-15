/**
 * FileService .gitignore matcher 缓存测试（D7-1，05-scan-caching §3.3，W24）。
 *
 * 覆盖验收（plan §4 W24）：
 * 1. 同一 .gitignore 文件（mtime 未变）二次 loadMatcher 零读盘零编译（spy 计数）
 * 2. expandDir 双目录（cwd+dir）共享同一根 .gitignore → 命中同一编译结果（读盘/编译 = 1）
 *    （M-1：key = 单个文件 (path,mtimeMs,size)，非目录元组组合键）
 * 3. mtime / size 变化 → 缓存 miss 重读重编译（新规则生效）
 * 4. 容量上限驱逐（IGNORE_MATCHER_CACHE_MAX，LRU）
 * 5. stat 无 mtimeMs（旧式 executor）→ 降级直接读不缓存（行为与旧 readIgnoreSafe 等价）
 *
 * mock 策略：IFileExecutor + ISessionService 构造注入（照 file-service.test.ts 范式）；
 * compileIgnoreRules 经 vi.mock spy 计编译次数（matcher 是私有状态，从 IO/编译计数断言）。
 *
 * 运行：cd packages/runtime && npx vitest run test/file-service-ignore-cache.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/infra/fs/ignore-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/fs/ignore-parser.js')>()
  return { ...actual, compileIgnoreRules: vi.fn(actual.compileIgnoreRules) }
})

import { FileService, IGNORE_MATCHER_CACHE_MAX, type FileServiceOptions } from '../src/services/file-service.js'
import { compileIgnoreRules } from '../src/infra/fs/ignore-parser.js'
import type { IFileExecutor, FsEntry } from '../src/services/ports/file-executor.js'

const executor = { listDir: vi.fn(), stat: vi.fn(), readFile: vi.fn() }
const sessionService = { getSummary: vi.fn() }

function svc(): FileService {
  return new FileService({
    sessionService: sessionService as unknown as FileServiceOptions['sessionService'],
    executor: executor as unknown as IFileExecutor,
  })
}

/** 拒绝（带 code）的 Error，模拟 node:fs/promises 的 errno 错误。 */
function fsErr(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/** stat 形状（含 D7-1 mtimeMs 身份键成分）。 */
function statShape(mtimeMs: number, size: number) {
  return { type: 'file' as const, size, mtimeMs }
}

/** readFile 中指定 .gitignore 路径的调用次数。 */
function ignoreReads(path: string): number {
  return executor.readFile.mock.calls.filter(([p]) => p === path).length
}

/** compileIgnoreRules 以指定内容为参的调用次数（编译计数）。 */
function compileCount(content: string): number {
  return vi.mocked(compileIgnoreRules).mock.calls.filter(([c]) => c === content).length
}

/** 根 .gitignore 存在（内容/身份可变），其余路径一律 ENOENT。 */
function mockRootIgnore(mtimeMs: number, content: string): void {
  executor.stat.mockImplementation(async (p: string) =>
    p === '/repo/.gitignore' ? statShape(mtimeMs, content.length) : Promise.reject(fsErr('ENOENT')),
  )
  executor.readFile.mockImplementation(async (p: string) =>
    p === '/repo/.gitignore' ? content : Promise.reject(fsErr('ENOENT')),
  )
  executor.listDir.mockResolvedValue([{ name: 'a.ts', type: 'file', size: 1 }] as FsEntry[])
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionService.getSummary.mockReturnValue({ cwd: '/repo' })
})

describe('FileService ignore matcher cache (D7-1)', () => {
  it('同一 .gitignore mtime 未变：二次 loadMatcher 零读盘零编译（空结果也缓存）', async () => {
    const s = svc()
    mockRootIgnore(100, 'dist\n')

    await s.expandDir('s1', 'src') // 触发 loadMatcher(/repo, /repo/src)
    expect(ignoreReads('/repo/.gitignore')).toBe(1)
    expect(compileCount('dist\n')).toBe(1)
    expect(compileCount('')).toBe(1) // /repo/src/.gitignore 不存在 → 空 matcher 编译一次

    await s.expandDir('s1', 'src') // 同目录二次展开
    expect(ignoreReads('/repo/.gitignore')).toBe(1) // 零读盘
    expect(compileCount('dist\n')).toBe(1) // 零编译
    expect(compileCount('')).toBe(1) // 不存在的文件同样命中缓存（哨兵身份 -1,-1）
  })

  it('expandDir 双目录共享同一根 .gitignore：命中同一编译结果（读盘/编译 = 1，M-1）', async () => {
    const s = svc()
    mockRootIgnore(100, 'node_modules\n')
    executor.listDir.mockResolvedValue([
      { name: 'node_modules', type: 'dir' },
      { name: 'a.ts', type: 'file', size: 1 },
    ] as FsEntry[])

    const r1 = await s.expandDir('s1', 'src')
    const r2 = await s.expandDir('s1', 'lib')

    // 根 .gitignore 只读一次、编译一次（expandDir 每次 loadMatcher(cwd, dir)，
    // 两个不同展开目录的 cwd 根文件共享同一缓存 entry——单文件 key 而非目录元组）
    expect(ignoreReads('/repo/.gitignore')).toBe(1)
    expect(compileCount('node_modules\n')).toBe(1)
    // 两目录的 ignore 行为一致（共享同一编译结果）
    expect(r1.find((n) => n.name === 'node_modules')?.ignored).toBe(true)
    expect(r2.find((n) => n.name === 'node_modules')?.ignored).toBe(true)
    expect(r1.find((n) => n.name === 'a.ts')?.ignored).toBeUndefined()
    expect(r2.find((n) => n.name === 'a.ts')?.ignored).toBeUndefined()
  })

  it('mtime 变化 → 缓存 miss 重读重编译，新规则生效', async () => {
    const s = svc()
    let mtimeMs = 100
    let content = 'dist\n'
    // 闭包引用可变状态：stat/readFile 实时反映 .gitignore 被改写
    executor.stat.mockImplementation(async (p: string) =>
      p === '/repo/.gitignore' ? statShape(mtimeMs, content.length) : Promise.reject(fsErr('ENOENT')),
    )
    executor.readFile.mockImplementation(async (p: string) =>
      p === '/repo/.gitignore' ? content : Promise.reject(fsErr('ENOENT')),
    )
    executor.listDir.mockResolvedValue([
      { name: 'dist', type: 'dir' },
      { name: 'build', type: 'dir' },
    ] as FsEntry[])

    const r1 = await s.expandDir('s1', 'src')
    expect(r1.find((n) => n.name === 'dist')?.ignored).toBe(true)
    expect(r1.find((n) => n.name === 'build')?.ignored).toBeUndefined()

    mtimeMs = 200 // .gitignore 被写工具改动
    content = 'build\n'
    const r2 = await s.expandDir('s1', 'src')

    expect(ignoreReads('/repo/.gitignore')).toBe(2) // miss 重读
    expect(compileCount('dist\n')).toBe(1)
    expect(compileCount('build\n')).toBe(1) // miss 重编译
    expect(r2.find((n) => n.name === 'build')?.ignored).toBe(true)
    expect(r2.find((n) => n.name === 'dist')?.ignored).toBeUndefined()
  })

  it('size 变化（mtime 不变）→ 缓存 miss 重读重编译', async () => {
    const s = svc()
    let content = 'a\n'
    executor.stat.mockImplementation(async (p: string) =>
      p === '/repo/.gitignore' ? statShape(100, content.length) : Promise.reject(fsErr('ENOENT')),
    )
    executor.readFile.mockImplementation(async (p: string) =>
      p === '/repo/.gitignore' ? content : Promise.reject(fsErr('ENOENT')),
    )
    executor.listDir.mockResolvedValue([{ name: 'a.ts', type: 'file', size: 1 }] as FsEntry[])

    await s.expandDir('s1', 'src')
    expect(ignoreReads('/repo/.gitignore')).toBe(1)

    content = 'bb\n' // 同 mtime，size 2→3
    await s.expandDir('s1', 'src')
    expect(ignoreReads('/repo/.gitignore')).toBe(2)
    expect(compileCount('bb\n')).toBe(1)
  })

  it('容量上限驱逐：第 501 个文件驱逐最旧 entry，重访问被驱逐者触发重读', async () => {
    const s = svc()
    // 全部 .gitignore 统一身份 (1,2)——key 按 path 区分，mtime/size 无需互异
    executor.stat.mockImplementation(async () => statShape(1, 2))
    executor.readFile.mockImplementation(async (p: string) =>
      p.endsWith('.gitignore') ? 'x\n' : Promise.reject(fsErr('ENOENT')),
    )
    executor.listDir.mockResolvedValue([] as FsEntry[])

    const dirs = Array.from({ length: IGNORE_MATCHER_CACHE_MAX }, (_, i) => `d${i}`)
    // 先访问 d0（成为最旧），再填满其余 499 个目录 + 根 .gitignore 共 501 entry → d0 被驱逐
    await s.expandDir('s1', dirs[0])
    for (let i = 1; i < dirs.length; i++) await s.expandDir('s1', dirs[i])

    // 最新访问的 entry（d499 + 根）仍在缓存：重访问零读
    await s.expandDir('s1', dirs[dirs.length - 1])
    expect(ignoreReads(`/repo/${dirs[dirs.length - 1]}/.gitignore`)).toBe(1)
    // 被驱逐的最旧 entry（d0）：重访问触发重读
    await s.expandDir('s1', dirs[0])
    expect(ignoreReads(`/repo/${dirs[0]}/.gitignore`)).toBe(2)
  })

  it('LRU touch：访问最旧 entry 后再插入新 entry，被驱逐的是次旧者而非被 touch 者（A-3）', async () => {
    // W24 审查 A-3：现有驱逐用例只验证「最旧被驱逐」，无法区分 LRU（touch 移尾）与
    // FIFO（touch 无效）——本用例 touch 最旧 entry 后再超限插入：LRU 下被驱逐者是
    // 次旧 entry（touch 过的留在缓存）；FIFO 下被驱逐者仍是 touch 过的 entry（断言失败）。
    const s = svc()
    executor.stat.mockImplementation(async () => statShape(1, 2))
    executor.readFile.mockImplementation(async (p: string) =>
      p.endsWith('.gitignore') ? 'x\n' : Promise.reject(fsErr('ENOENT')),
    )
    executor.listDir.mockResolvedValue([] as FsEntry[])

    // 填满 IGNORE_MATCHER_CACHE_MAX 个 entry：499 个目录 key + 根 .gitignore key
    // （根 key 每次 expandDir 被 touch 移尾，目录 key 按插入序 d0..d498 排列，d0 最旧）
    const dirs = Array.from({ length: IGNORE_MATCHER_CACHE_MAX - 1 }, (_, i) => `d${i}`)
    for (const d of dirs) await s.expandDir('s1', d)

    // touch 最旧 d0（命中缓存 + delete/set 移尾）→ Map 序 = d1..d498, 根, d0
    await s.expandDir('s1', dirs[0])
    expect(ignoreReads(`/repo/${dirs[0]}/.gitignore`)).toBe(1) // 命中缓存（未被驱逐）

    // 插入第 501 个 entry（新目录 d500）→ 触发驱逐：最旧 = d1（次旧），不是被 touch 的 d0
    await s.expandDir('s1', 'd500')

    // 被驱逐者 d1：重访问触发重读
    await s.expandDir('s1', dirs[1])
    expect(ignoreReads(`/repo/${dirs[1]}/.gitignore`)).toBe(2)
    // 被 touch 的 d0 仍在缓存：重访问零读（FIFO 实现下此处 reads=2，断言失败）
    await s.expandDir('s1', dirs[0])
    expect(ignoreReads(`/repo/${dirs[0]}/.gitignore`)).toBe(1)
  })

  it('cwd 尾斜杠归一化：cwd=/repo/ 与 cwd=/repo 共享同一缓存条目（A-4）', async () => {
    // W24 审查 A-4：loadMatcher key 构造前未 resolvePath 归一化时，cwd 带尾斜杠（'/repo/'）
    // 拼出 '/repo//.gitignore'，与 '/repo/.gitignore' 分叉成两个缓存 key——同一 .gitignore
    // 文件被重读重编译，D7-1 文件级缓存退化为目录级缓存。归一化后两者共享同一 entry。
    const s = svc()
    mockRootIgnore(100, 'dist\n')
    executor.listDir.mockResolvedValue([
      { name: 'dist', type: 'dir' },
      { name: 'a.ts', type: 'file', size: 1 },
    ] as FsEntry[])

    // 无尾斜杠 cwd：根 .gitignore 读 1 次，dist 被标 ignored
    const r1 = await s.expandDir('s1', 'src')
    expect(r1.find((n) => n.name === 'dist')?.ignored).toBe(true)
    expect(ignoreReads('/repo/.gitignore')).toBe(1)

    // 切到尾斜杠 cwd（用户配置/拼接产生尾斜杠的常见形态）：key 归一化后命中同一 entry
    sessionService.getSummary.mockReturnValue({ cwd: '/repo/' })
    const r2 = await s.expandDir('s1', 'src')
    // 共享根 matcher：dist 仍被标 ignored（未归一化时走 '/repo//.gitignore' 哨兵空 matcher，
    // 此处 ignored 为 undefined，断言失败）；零重读
    expect(r2.find((n) => n.name === 'dist')?.ignored).toBe(true)
    expect(ignoreReads('/repo/.gitignore')).toBe(1)
  })

  it('stat 无 mtimeMs（旧式 executor）→ 降级直接读不缓存（与旧 readIgnoreSafe 行为等价）', async () => {
    const s = svc()
    executor.stat.mockImplementation(async (p: string) =>
      p === '/repo/.gitignore'
        ? ({ type: 'file', size: 5 } as { type: 'dir' | 'file'; size: number }) // 无 mtimeMs
        : Promise.reject(fsErr('ENOENT')),
    )
    executor.readFile.mockImplementation(async (p: string) =>
      p === '/repo/.gitignore' ? 'dist\n' : Promise.reject(fsErr('ENOENT')),
    )
    executor.listDir.mockResolvedValue([{ name: 'a.ts', type: 'file', size: 1 }] as FsEntry[])

    const r1 = await s.expandDir('s1', 'src')
    expect(r1.find((n) => n.name === 'a.ts')).toBeDefined() // 正常工作

    await s.expandDir('s1', 'src') // 不缓存：每次都读
    expect(ignoreReads('/repo/.gitignore')).toBe(2)
    expect(compileCount('dist\n')).toBe(2)
  })
})
