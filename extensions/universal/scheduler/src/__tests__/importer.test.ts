import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

import { getLegacyStorePath, importLegacyStore } from '../importer.js'
import type { ScheduledTask } from '../types.js'

// vi.mock 必须在 import 之前提升。mock 工厂替换 node:fs 命名空间，
// importer.ts 内 `import * as fs` 拿到的就是这 4 个 vi.fn()。
vi.mock('node:fs', () => ({
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

const cwd = '/fake/workspace'
const storePath = getLegacyStorePath(cwd)
const importedPath = storePath + '.imported'
const sessionFile = '/x/sess.json'

/** 构造合法旧 store 任务（参考 types.ts ScheduleSpec / TaskKind 默认值）。 */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'test task',
    prompt: 'do something',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    createdAt: 1000,
    nextRunAt: 2000,
    runCount: 0,
    history: [],
    ...overrides,
  }
}

/** 构造带 code 属性的 ENOENT 错误（模拟 fs.renameSync 源文件不存在）。 */
function enoentError(): Error & { code: string } {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}

describe('importLegacyStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 默认 implementation：rename 成功、existsSync false、readFileSync 空、unlink 无副作用
    vi.mocked(fs.renameSync).mockImplementation(() => {})
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    vi.mocked(fs.unlinkSync).mockImplementation(() => {})
    // 清理 logger mock（logger 默认 no-op，无需抑制输出）
    loggerMock.warn.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── TC1：rename 原子单成功 + 逐任务 append upsert + 删 .imported ──
  it('TC1: rename 成功独占 + 2 任务逐个 appendEntry upsert + 删 .imported', () => {
    const taskA = makeTask({ id: 'aaaa', name: 'A' })
    const taskB = makeTask({ id: 'bbbb', name: 'B' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA, taskB] }),
    )
    const appendEntry = vi.fn()
    // resumed session：sessionFile 已存在（pi flushed=true，append 即时落盘）→ 立即 unlink 安全
    vi.mocked(fs.existsSync).mockImplementation(p => p === sessionFile)

    importLegacyStore(cwd, { appendEntry }, sessionFile)
    // 1) rename 原子独占：scheduler.json → scheduler.json.imported
    expect(fs.renameSync).toHaveBeenCalledTimes(1)
    expect(fs.renameSync).toHaveBeenCalledWith(storePath, importedPath)

    // 2) appendEntry 调 2 次，customType + op 形状正确
    expect(appendEntry).toHaveBeenCalledTimes(2)
    expect(appendEntry).toHaveBeenNthCalledWith(1, 'pi-scheduler:task', {
      op: 'upsert',
      taskId: 'aaaa',
      ownerSessionFile: sessionFile,
      task: expect.objectContaining({ id: 'aaaa', name: 'A' }),
    })
    expect(appendEntry).toHaveBeenNthCalledWith(2, 'pi-scheduler:task', {
      op: 'upsert',
      taskId: 'bbbb',
      ownerSessionFile: sessionFile,
      task: expect.objectContaining({ id: 'bbbb', name: 'B' }),
    })

    // 3) task snapshot 不含 ownerSessionFile/pending（显式剥离）
    const firstOp = appendEntry.mock.calls[0]![1] as { task: Record<string, unknown> }
    expect(firstOp.task).not.toHaveProperty('ownerSessionFile')
    expect(firstOp.task).not.toHaveProperty('pending')

    // 4) unlinkSync 删 .imported
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
    expect(fs.unlinkSync).toHaveBeenCalledWith(importedPath)

    // 5) 进度日志
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('imported legacy tasks'),
      expect.objectContaining({ count: 2 }),
    )
  })

  // ── TC2：.imported 残留崩溃恢复幂等 ──
  it('TC2: scheduler.json 不存在(rename ENOENT) + .imported 残留 → 读 .imported 导入 + 删 .imported', () => {
    // 实现A：scheduler.json 不存在时 renameSync 抛 ENOENT → 走 handleImportedResidue
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw enoentError()
    })
    // .imported 存在 + resumed session（sessionFile 已存在 → 已落盘 → 立即删）
    vi.mocked(fs.existsSync).mockImplementation(p => p === importedPath || p === sessionFile)
    const taskA = makeTask({ id: 'cccc' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA] }),
    )
    const appendEntry = vi.fn()

    importLegacyStore(cwd, { appendEntry }, sessionFile)

    expect(appendEntry).toHaveBeenCalledTimes(1)
    expect(appendEntry).toHaveBeenCalledWith('pi-scheduler:task', {
      op: 'upsert',
      taskId: 'cccc',
      ownerSessionFile: sessionFile,
      task: expect.objectContaining({ id: 'cccc' }),
    })
    expect(fs.unlinkSync).toHaveBeenCalledWith(importedPath)
  })

  // ── TC3：scheduler.json 与 .imported 都不存在 → no-op ──
  it('TC3: 双不存在（rename ENOENT + .imported 不存在）→ no-op，不抛错', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw enoentError()
    })
    vi.mocked(fs.existsSync).mockReturnValue(false) // .imported 也不存在
    const appendEntry = vi.fn()

    expect(() => importLegacyStore(cwd, { appendEntry }, sessionFile)).not.toThrow()
    expect(appendEntry).toHaveBeenCalledTimes(0)
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  // ── TC4：并发单成功者——rename 抛 ENOENT + .imported 也不存在 → skip（S10 并发场景）──
  it('TC4: 并发竞争——rename 抛 ENOENT + .imported 不存在 → 幂等 skip，不抛错', () => {
    // 两进程并发：本进程 rename 时 scheduler.json 已被另一进程 rename 走 → ENOENT
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw enoentError()
    })
    vi.mocked(fs.existsSync).mockReturnValue(false) // 本进程也没看到 .imported
    const appendEntry = vi.fn()

    expect(() => importLegacyStore(cwd, { appendEntry }, sessionFile)).not.toThrow()
    expect(appendEntry).toHaveBeenCalledTimes(0) // 别人已导入，本进程 skip
  })

  // ── TC5：currentSessionFile=undefined（--no-session 模式）→ 早 return skip ──
  it('TC5: currentSessionFile=undefined → 整个 importer skip，不碰 fs', () => {
    const appendEntry = vi.fn()

    importLegacyStore(cwd, { appendEntry }, undefined)

    expect(appendEntry).toHaveBeenCalledTimes(0)
    expect(fs.renameSync).not.toHaveBeenCalled() // 早 return，不碰 fs
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  // ── TC6：JSON 损坏降级（warn 不 rethrow）──
  it('TC6: readFileSync 返回损坏 JSON → console.warn + 不 rethrow，appendEntry 0 次', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not-json{')
    const appendEntry = vi.fn()

    expect(() => importLegacyStore(cwd, { appendEntry }, sessionFile)).not.toThrow()
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('import failed'),
      expect.objectContaining({ error: expect.stringContaining('not valid JSON') }),
    )
    expect(appendEntry).toHaveBeenCalledTimes(0) // parse 失败，无 append
  })

  // ── TC7：owner 归属——upsert op.ownerSessionFile === currentSessionFile（非旧 store 路径）──
  it('TC7: op.ownerSessionFile 严格等于传入的 currentSessionFile，非 getLegacyStorePath 推导路径', () => {
    const ownSession = '/my/session.json'
    const taskA = makeTask({ id: 'dddd' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA] }),
    )
    const appendEntry = vi.fn()

    importLegacyStore(cwd, { appendEntry }, ownSession)

    expect(appendEntry).toHaveBeenCalledTimes(1)
    const op = appendEntry.mock.calls[0]![1] as { ownerSessionFile: string }
    expect(op.ownerSessionFile).toBe(ownSession)
    expect(op.ownerSessionFile).not.toBe(storePath)
    expect(op.ownerSessionFile).not.toBe(importedPath)
  })

  // ── TC8：新 session 未 flush → 延迟 unlink（IMPORT-FLUSH-GUARD，MF-1）──
  it('TC8: 新 session（sessionFile 不存在）→ 不立即 unlink，返回 cleanup；flush 后删，未 flush 保留', () => {
    const taskA = makeTask({ id: 'eeee' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA] }),
    )
    vi.mocked(fs.existsSync).mockReturnValue(false) // 新 session：sessionFile 尚不存在（pi 未 flush，entries 仅内存）
    const appendEntry = vi.fn()

    const cleanup = importLegacyStore(cwd, { appendEntry }, sessionFile)

    // append 已发生，但 unlink 未执行——数据可能仅内存，销毁源文件 = 永久丢失
    expect(appendEntry).toHaveBeenCalledTimes(1)
    expect(fs.unlinkSync).not.toHaveBeenCalled()
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('deferring'),
      expect.objectContaining({ count: 1 }),
    )

    // 情形1：flush 已发生（sessionFile 出现，.imported 仍在）→ cleanup 删除 .imported
    vi.mocked(fs.existsSync).mockImplementation(p => p === sessionFile || p === importedPath)
    cleanup?.()
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
    expect(fs.unlinkSync).toHaveBeenCalledWith(importedPath)

    // 情形2：从未 flush → cleanup 保留 .imported（不 unlink、不抛错，供崩溃恢复重导入）
    vi.mocked(fs.unlinkSync).mockClear()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    expect(() => cleanup?.()).not.toThrow()
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  // ── TC8b：cleanup 幂等 + unlink ENOENT 守卫（MF-2，R2 修复）──
  it('TC8b: cleanup 幂等（已删后 no-op）+ unlink 仅静默 ENOENT，其他 fs 错误向上抛', () => {
    const taskA = makeTask({ id: 'ffff' })
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, tasks: [taskA] }),
    )
    vi.mocked(fs.existsSync).mockReturnValue(false) // 新 session 未 flush → 延迟删除路径
    const appendEntry = vi.fn()

    const cleanup = importLegacyStore(cwd, { appendEntry }, sessionFile)!
    expect(cleanup).toBeDefined()

    // 情形1：flush 已发生 → 正常 unlink
    vi.mocked(fs.existsSync).mockReturnValue(true)
    cleanup()
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
    expect(fs.unlinkSync).toHaveBeenCalledWith(importedPath)

    // 情形2（MF-2）：并发——另一进程已 unlink（unlinkSync 抛 ENOENT）→ 静默吞掉不抛
    vi.mocked(fs.unlinkSync).mockClear()
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw enoentError()
    })
    expect(() => cleanup()).not.toThrow()
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)

    // 情形3（MF-2）：非 ENOENT fs 错误（EACCES）→ 不吞，向上抛（index.ts try/finally 兜底复位）
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    expect(() => cleanup()).toThrow(/EACCES/)

    // 情形4：幂等——.imported 已不存在（本进程或并发已删）→ no-op，不抛
    vi.mocked(fs.unlinkSync).mockClear()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    expect(() => cleanup()).not.toThrow()
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  // ── TC9：0 任务空 store → 无持久化依赖，仍立即 unlink ──
  it('TC9: 空 store（tasks 空数组）→ 0 次 append，直接 unlink .imported（无数据可丢）', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: 1, tasks: [] }))
    vi.mocked(fs.existsSync).mockReturnValue(false) // 新 session 也不影响：0 任务无持久化依赖
    const appendEntry = vi.fn()

    const cleanup = importLegacyStore(cwd, { appendEntry }, sessionFile)

    expect(appendEntry).toHaveBeenCalledTimes(0)
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
    expect(fs.unlinkSync).toHaveBeenCalledWith(importedPath)
    expect(cleanup).toBeUndefined()
  })
})

// ── getLegacyStorePath 双候选探测（合并 feat-auto-name-session-refactor 4b5513b5e 后落实）──
// 候选 1：getAgentDir()（PI_CODING_AGENT_DIR 隔离目录）；候选 2：已发布版 npm 0.1.1 硬编码
// ~/.pi/agent。getAgentDir() 每次调用读 process.env（非模块加载缓存），stubEnv 后直接调用即可。
// fs 已 mock（模块顶部 vi.mock('node:fs')），existsSync 控制探测命中。
describe('getLegacyStorePath 双候选探测', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('TC10a: PI_CODING_AGENT_DIR 隔离目录下旧 store 存在 → 优先 getAgentDir() 路径', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/iso-agent')
    const isoPath = path.join('/tmp/iso-agent', 'scheduler', 'root', 'fake', 'workspace', 'scheduler.json')
    vi.mocked(fs.existsSync).mockImplementation(p => p === isoPath)

    expect(getLegacyStorePath(cwd)).toBe(isoPath)
  })

  it('TC10b: 隔离目录下旧 store 不存在 → fallback 已发布版 ~/.pi/agent 路径', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/iso-agent')
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const legacyPath = path.join(os.homedir(), '.pi', 'agent', 'scheduler', 'root', 'fake', 'workspace', 'scheduler.json')

    expect(getLegacyStorePath(cwd)).toBe(legacyPath)
  })
})
