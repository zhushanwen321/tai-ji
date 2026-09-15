/**
 * W1（restore-fork-attach-fix）附着路径修复测试：fork/restore 直附着正式文件。
 *
 * 背景（P0 数据丢失 bug）：restore/fork 曾把 pi 附着到 $TMPDIR 临时文件后立刻 unlink，
 * 而 pi 的 switch_session 是「永久重绑读写目标」（pi-mono session-manager.ts setSessionFile
 * 把传入路径存为永久 sessionFile，_persist 每轮 appendFileSync 该路径）——此后每轮对话
 * 写进按路径重建的 tmp 孤儿文件，原会话文件永不更新，重启全部丢失。
 *
 * 修复语义（对应验收条款 C1-C8，验收 SSOT =
 * .taiji-harness/2026-08-19-restore-fork-attach-fix/acceptance/w1-acceptance.md）：
 * - C1 fork 直附着：switchSession 收到的路径 === forkedFilePath（sessions 目录内正式文件）
 * - C2 F2 直附着零改写：cwd 活 + 无 session_end → 附着 target.filePath，文件内容与 mtime 不变
 * - C3 F3 归一化（session_end，cwd 活）：strip 后落回同一路径，无 .tmp-migrate- 残留，
 *   header cwd 不动，其余行逐字节保留
 * - C4 F3 归一化（cwd 死，无 session_end）：仅 header 首行 cwd 变 homedir，其余行原样
 * - C5 双条件（session_end + cwd 死）：两种变换都发生
 * - C6 幂等收敛：归一化产物再次 restore → 走 F2（文件零写）
 * - C7 fork cwd 兜底：源 header cwd 死路径 → fork 产物 header cwd 为 homedir
 *   （createForkedSessionFile 单元级用例另见 test/session-fork.test.ts）
 * - C8 语义保留：sidecar unlink 顺序（switchSession 成功后才删 .meta.json）+ catch
 *   safeDestroy + cwdFellBack 时 spawn cwd = homedir
 *
 * 文件系统操作全部真实执行于 mkdtemp tmp 目录（不 mock fs）；svc/pm/client 为 vi.fn
 * mock（不 spawn 真 pi）。target 经真实 parseSessionHeader 从文件派生（C6 第二次 restore
 * 自动看到归一化后的 header，与 scanner 重扫语义一致）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-attach.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

// fork 目标目录指向测试 tmp（createForkedSessionFile 真实写入，不碰真实数据目录）
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})

import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import { userStoppedGate } from '../src/services/session/event-interpreter.js'
import { parseSessionHeader } from '../src/infra/pi/session-file-utils.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IManagedSessionView, ScannedSession } from '../src/services/session/types.js'
import type { SessionSummary } from '@taiji/shared'

const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

/**
 * 测试环境：mock svc/pm/configStore/sessionStore，client 记录 switchSession 收到的路径。
 * findScannedSession 用真实 parseSessionHeader 从 filePath 动态派生 target（C6 幂等语义）。
 */
function makeEnv(opts: {
  switchSessionImpl?: (path: string) => Promise<void>
  /** D4 restore-abort 失败链用例：覆盖 client.abort（默认成功 no-op） */
  abortImpl?: () => Promise<void>
  /** D4 restore-abort 失败链用例：注入 forceQuitFallback（构造第 7 参，组合根 = dispatcher.forceQuit） */
  forceQuitFallback?: (sessionId: string) => Promise<void>
} = {}) {
  const switchCalls: string[] = []
  const client = {
    getState: vi.fn(async () => ({ sessionId: 's-1' })),
    switchSession: vi.fn(async (sessionPath: string) => {
      switchCalls.push(sessionPath)
      await opts.switchSessionImpl?.(sessionPath)
    }),
    setSessionName: vi.fn(async () => undefined),
    abort: vi.fn(opts.abortImpl ?? (async () => undefined)),
  }
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn(() => makeSummary('s-x')),
    // restore/fork 共用：target 从文件真实解析（模拟 scanner 重扫）
    findScannedSession: vi.fn((id: string): ScannedSession | undefined => {
      const filePath = currentSourceFile.value
      const header = parseSessionHeader(filePath)
      if (!header || header.id !== id) return undefined
      return {
        id, filePath, cwd: header.cwd, name: 'target',
        lastModified: Date.now(), timestamp: header.timestamp, size: 0,
      } as ScannedSession
    }),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    notifySessionCreated: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
    getActiveSummaries: vi.fn(() => []),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点（session-dead-structural-fixes）：restoreSession 开头查活跃 client；
    // undefined = 无 client → 不短路 → 走全流程直附着（本组用例的目标路径）。
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    // delete 链（S6 清扫用例）：trash 走 mock（文件本体不真删，清扫断言不依赖它）
    trash: vi.fn(async () => undefined),
    invalidateMetaCache: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(
    svc, pm, configStore, sessionStore, workspaceService, registerDeps,
    // 构造参形如 { forceQuitFallback }（对象包装，非裸函数）
    opts.forceQuitFallback ? { forceQuitFallback: opts.forceQuitFallback } : undefined,
  )
  return { lifecycle, svc, pm, client, switchCalls, sessionStore }
}

/** 当前作为 findScannedSession 数据源的 session 文件（beforeEach 重置）。 */
const currentSourceFile = vi.hoisted(() => ({ value: '' }))

/** 会话文件固定行集：header + u1 + a1（+ 可选 session_end）。 */
function makeLines(cwd: string, opts: { sessionEnd?: boolean } = {}): string[] {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-w1', timestamp: '2026-08-19T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-19T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-19T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
  ]
  if (opts.sessionEnd) {
    lines.push(JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: '2026-08-19T00:00:03.000Z' }))
  }
  return lines
}

describe('W1 restore/fork 直附着正式文件（F1/F2/F3）', () => {
  let dir: string
  let env: ReturnType<typeof makeEnv>
  let filePath: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    env = makeEnv()
    dir = mkdtempSync(join(tmpdir(), 'w1-attach-'))
    filePath = join(dir, '2026-08-19T00-00-00-000Z_sess-w1.jsonl')
    currentSourceFile.value = filePath
    sessionsDirMock.value = dir
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 目录内 .tmp-migrate- 残留清单（C3/C6：应恒为空）。 */
  function tmpMigrateLeftovers(): string[] {
    return readdirSync(dir).filter(f => f.includes('.tmp-migrate-'))
  }

  // ── C2：F2 直附着零改写 ──────────────────────────────────────

  it('C2: cwd 活 + 无 session_end → switchSession 收 target.filePath，文件内容与 mtime 均不变', async () => {
    const content = makeLines(dir).join('\n') + '\n'
    writeFileSync(filePath, content, 'utf-8')
    const mtimeBefore = statSync(filePath).mtimeMs

    await env.lifecycle.restoreSession('sess-w1')

    expect(env.switchCalls).toEqual([filePath])
    // 零改写：内容逐字节不变 + mtime 不变（无任何写操作触碰文件）
    expect(readFileSync(filePath, 'utf-8')).toBe(content)
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore)
    expect(tmpMigrateLeftovers()).toEqual([])
  })

  // ── C3：F3 归一化（session_end，cwd 活）───────────────────────

  it('C3: 含 session_end（cwd 活）→ strip 后落回同一路径，header cwd 不动，其余行逐字节保留', async () => {
    const lines = makeLines(dir, { sessionEnd: true })
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')

    await env.lifecycle.restoreSession('sess-w1')

    // 附着的是原路径（非新文件）
    expect(env.switchCalls).toEqual([filePath])
    // 目录无 .tmp-migrate- 残留（rename 原子完成）
    expect(tmpMigrateLeftovers()).toEqual([])
    // 行级 diff：header / u1 / a1 逐字节保留，仅 session_end 行消失，末尾换行保留
    const after = readFileSync(filePath, 'utf-8')
    const kept = [lines[0]!, lines[1]!, lines[2]!]
    expect(after).toBe(kept.join('\n') + '\n')
    // header cwd 不动（cwd 活不做 fallback）
    expect(JSON.parse(after.split('\n')[0]!).cwd).toBe(dir)
  })

  // ── C4：F3 归一化（cwd 死，无 session_end）────────────────────

  it('C4: cwd 死路径（无 session_end）→ 仅 header 首行 cwd 变 homedir，其余行原样', async () => {
    const deadCwd = join(dir, 'deleted-worktree')
    const lines = makeLines(deadCwd)
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')

    await env.lifecycle.restoreSession('sess-w1')

    expect(env.switchCalls).toEqual([filePath])
    expect(tmpMigrateLeftovers()).toEqual([])
    const after = readFileSync(filePath, 'utf-8')
    const afterLines = after.split('\n')
    // 首行：仅 cwd 字段变为 homedir（其余字段与原行等值）
    const headerAfter = JSON.parse(afterLines[0]!)
    const headerBefore = JSON.parse(lines[0]!)
    expect(headerAfter.cwd).toBe(homedir())
    expect(headerAfter.id).toBe(headerBefore.id)
    expect(headerAfter.timestamp).toBe(headerBefore.timestamp)
    expect(headerAfter.version).toBe(headerBefore.version)
    // 其余行逐字节原样（C8：cwdFellBack 时 spawn cwd = homedir）
    expect(afterLines[1]).toBe(lines[1])
    expect(afterLines[2]).toBe(lines[2])
    expect(env.pm.createSession).toHaveBeenCalledWith('sess-w1', homedir(), expect.anything())
  })

  // ── C5：双条件（session_end + cwd 死）────────────────────────

  it('C5: session_end + cwd 死 → strip 与 cwd fallback 两种变换都发生', async () => {
    const deadCwd = join(dir, 'gone-worktree')
    const lines = makeLines(deadCwd, { sessionEnd: true })
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')

    await env.lifecycle.restoreSession('sess-w1')

    expect(env.switchCalls).toEqual([filePath])
    expect(tmpMigrateLeftovers()).toEqual([])
    const after = readFileSync(filePath, 'utf-8')
    expect(after).not.toContain('session_end')
    expect(JSON.parse(after.split('\n')[0]!).cwd).toBe(homedir())
    expect(after).toContain('"u1"')
    expect(after).toContain('"a1"')
  })

  // ── C6：幂等收敛 ─────────────────────────────────────────────

  it('C6: 归一化产物再次 restore → 走 F2 直附着（文件零写、无第二次归一化）', async () => {
    const deadCwd = join(dir, 'idempotent-worktree')
    const lines = makeLines(deadCwd, { sessionEnd: true })
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')

    // 第一次 restore：F3 归一化（session_end 被 strip + cwd 落 homedir）
    await env.lifecycle.restoreSession('sess-w1')
    const normalized = readFileSync(filePath, 'utf-8')
    const mtimeAfterNormalize = statSync(filePath).mtimeMs
    expect(normalized).not.toContain('session_end')

    // 第二次 restore：findScannedSession 经真实 parseSessionHeader 重读 header
    //（模拟 scanner 重扫）→ cwd 已是 homedir（活）且无 session_end → F2 直附着
    await env.lifecycle.restoreSession('sess-w1')

    expect(env.switchCalls).toEqual([filePath, filePath])
    // 文件零写：内容与 mtime 均不变（第二次未进 F3）
    expect(readFileSync(filePath, 'utf-8')).toBe(normalized)
    expect(statSync(filePath).mtimeMs).toBe(mtimeAfterNormalize)
    expect(tmpMigrateLeftovers()).toEqual([])
  })

  // ── C8：sidecar unlink 顺序 / safeDestroy ────────────────────

  it('C8: .meta.json 在 switchSession 成功后才 unlink（失败时保留旧终态）+ catch safeDestroy', async () => {
    const metaPath = filePath + '.meta.json'
    writeFileSync(filePath, makeLines(dir).join('\n') + '\n', 'utf-8')
    writeFileSync(metaPath, JSON.stringify({ type: 'session_end', outcome: 'done' }), 'utf-8')

    // 失败分支：switchSession 抛错 → .meta.json 保留 + pi 进程被 safeDestroy
    const failEnv = makeEnv({
      switchSessionImpl: async () => { throw new Error('switch failed') },
    })
    currentSourceFile.value = filePath
    await expect(failEnv.lifecycle.restoreSession('sess-w1')).rejects.toThrow('switch failed')
    expect(existsSync(metaPath)).toBe(true)
    expect(failEnv.pm.destroySession).toHaveBeenCalledWith('sess-w1')

    // 成功分支：switchSession 执行瞬间 .meta.json 仍存在（unlink 在成功之后）
    let metaExistedDuringSwitch = false
    const okEnv = makeEnv({
      switchSessionImpl: async () => { metaExistedDuringSwitch = existsSync(metaPath) },
    })
    currentSourceFile.value = filePath
    await okEnv.lifecycle.restoreSession('sess-w1')
    expect(metaExistedDuringSwitch).toBe(true)
    expect(existsSync(metaPath)).toBe(false)
  })

  // ── C1：fork 直附着 ──────────────────────────────────────────

  it('C1: forkSession → switchSession 收到的路径 === sessions 目录内的 forkedFilePath（直附着）', async () => {
    const sourceFile = join(dir, 'src.jsonl')
    writeFileSync(sourceFile, makeLines(dir).join('\n') + '\n', 'utf-8')
    currentSourceFile.value = sourceFile

    await env.lifecycle.forkSession('sess-w1', 'a1', true, 'fork-label')

    // fork 产物真实落在 sessions 目录（getSessionsDir 指向 dir）
    expect(env.switchCalls).toHaveLength(1)
    const attachedPath = env.switchCalls[0]!
    expect(attachedPath.startsWith(dir + '/')).toBe(true)
    expect(attachedPath.endsWith('.jsonl')).toBe(true)
    // 附着路径 = createForkedSessionFile 的产物文件（sessions 目录内正式文件，
    // 非旧 tmp 管线的 taiji-fork- 命名形态）
    expect(attachedPath).not.toContain('taiji-fork-')
    // 产物文件存在且直附着零改写（fork 后文件内容 = fork 时写出的内容）
    expect(existsSync(attachedPath)).toBe(true)
    const forkedContent = readFileSync(attachedPath, 'utf-8')
    expect(forkedContent).toContain('"u1"')
    expect(forkedContent).toContain('"a1"')
    // 显式 label 经 RPC 持久化（fork 流程不受直附着改造影响）
    expect(env.client.setSessionName).toHaveBeenCalledWith('fork-label')
  })

  // ── C7：fork cwd 兜底（集成路径）─────────────────────────────

  it('C7: 源 header cwd 死路径 → fork 产物 header cwd 为 homedir（createForkedSessionFile 生成时兜底）', async () => {
    const deadCwd = join(dir, 'dead-source-worktree')
    const sourceFile = join(dir, 'src-dead-cwd.jsonl')
    writeFileSync(sourceFile, makeLines(deadCwd).join('\n') + '\n', 'utf-8')
    currentSourceFile.value = sourceFile

    await env.lifecycle.forkSession('sess-w1', 'a1', true)

    const attachedPath = env.switchCalls[0]!
    const forkedHeader = JSON.parse(readFileSync(attachedPath, 'utf-8').split('\n')[0]!)
    expect(forkedHeader.cwd).toBe(homedir())
    expect(forkedHeader.cwd).not.toBe(deadCwd)
  })
})

describe('S6 归一化残留清理（差距复审 suggestion 6）', () => {
  let dir: string
  let env: ReturnType<typeof makeEnv>
  let filePath: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    env = makeEnv()
    dir = mkdtempSync(join(tmpdir(), 's6-attach-'))
    filePath = join(dir, '2026-08-19T00-00-00-000Z_sess-s6.jsonl')
    currentSourceFile.value = filePath
    sessionsDirMock.value = dir
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function tmpMigrateLeftovers(): string[] {
    return readdirSync(dir).filter(f => f.includes('.tmp-migrate-'))
  }

  /** 会话文件行集（id 固定 sess-s6，makeLines 本文件上方已有 sess-w1 版本，此处自备）。 */
  function s6Lines(cwd: string, opts: { sessionEnd?: boolean } = {}): string[] {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'sess-s6', timestamp: '2026-08-19T00:00:00.000Z', cwd }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-19T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    ]
    if (opts.sessionEnd) {
      lines.push(JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: '2026-08-19T00:00:03.000Z' }))
    }
    return lines
  }

  it('S6-1: F2 直附着前清扫——正常文件 + 预置崩溃残留 → restore 后残留消失、文件零改写', async () => {
    const content = s6Lines(dir).join('\n') + '\n'
    writeFileSync(filePath, content, 'utf-8')
    // 模拟上次进程在 write 与 rename 之间崩溃留下的残留（合法 session 内容、同 basename）
    const residue = `${filePath}.tmp-migrate-1787139239905.jsonl`
    writeFileSync(residue, content, 'utf-8')
    expect(tmpMigrateLeftovers().length).toBe(1)

    await env.lifecycle.restoreSession('sess-s6')

    expect(tmpMigrateLeftovers()).toEqual([])
    expect(readFileSync(filePath, 'utf-8')).toBe(content)
    expect(env.switchCalls).toEqual([filePath])
  })

  it('S6-2: F3 归一化前清扫——legacy 文件 + 预置旧残留 → 归一化成功且新旧残留都不剩', async () => {
    writeFileSync(filePath, s6Lines(dir, { sessionEnd: true }).join('\n') + '\n', 'utf-8')
    writeFileSync(`${filePath}.tmp-migrate-1111111111111.jsonl`, 'stale\n', 'utf-8')

    await env.lifecycle.restoreSession('sess-s6')

    // 旧残留被清扫 + 本次归一化的临时文件被 rename 消费 → 目录零残留
    expect(tmpMigrateLeftovers()).toEqual([])
    // 归一化本身仍正确：session_end 被 strip
    expect(readFileSync(filePath, 'utf-8')).not.toContain('session_end')
    expect(env.switchCalls).toEqual([filePath])
  })

  it('S6-3: delete 链清扫——session 删除时残留与 sidecar 一并清走', async () => {
    writeFileSync(filePath, s6Lines(dir).join('\n') + '\n', 'utf-8')
    writeFileSync(`${filePath}.tmp-migrate-2222222222222.jsonl`, 'stale\n', 'utf-8')
    writeFileSync(`${filePath}.meta.json`, '{"outcome":"done"}', 'utf-8')
    // 另一个 session 的残留：不被误删（basename 前缀精确匹配）
    const otherResidue = join(dir, '2026-08-19T00-00-00-000Z_sess-other.jsonl.tmp-migrate-3333333333333.jsonl')
    writeFileSync(otherResidue, 'other\n', 'utf-8')

    await env.lifecycle.delete('sess-s6')

    expect(env.sessionStore.trash).toHaveBeenCalledWith(filePath)
    expect(readdirSync(dir)).not.toContain('2026-08-19T00-00-00-000Z_sess-s6.jsonl.tmp-migrate-2222222222222.jsonl')
    expect(readdirSync(dir)).not.toContain('2026-08-19T00-00-00-000Z_sess-s6.jsonl.meta.json')
    expect(readdirSync(dir)).toContain('2026-08-19T00-00-00-000Z_sess-other.jsonl.tmp-migrate-3333333333333.jsonl')
  })
})

// ── D4 restore-abort 失败链（R3 S-3 补测：forceQuitFallback 也失败 → 吞错 + 标记保留 + 环不启动）──
//
// applyRestoreAbortConvergence 的 fallbackErr catch 此前零覆盖：abort RPC 超时 → fallback
// 走 forceQuitSession 完整链，其自身也失败（极端）→ 标记保留 + 环不启动，restore 主体不回滚。
describe('D4 restore-abort 失败链：fallback 也失败吞错（R3 S-3）', () => {
  let dir: string
  let env: ReturnType<typeof makeEnv>
  let filePath: string
  let warnSpy: ReturnType<typeof vi.spyOn>
  const markStore = {
    marks: new Map<string, { source: string }>(),
    markUserStopped: vi.fn((id: string, source: string) => { markStore.marks.set(id, { source }) }),
    hasUserStoppedMark: vi.fn((id: string) => markStore.marks.has(id)),
    clearUserStoppedMark: vi.fn((id: string) => { markStore.marks.delete(id) }),
    clearAllUserStoppedMarks: vi.fn(() => markStore.marks.clear()),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    dir = mkdtempSync(join(tmpdir(), 'w1-restore-abort-'))
    filePath = join(dir, '2026-08-19T00-00-00-000Z_sess-w1.jsonl')
    currentSourceFile.value = filePath
    sessionsDirMock.value = dir
    writeFileSync(filePath, makeLines(dir).join('\n') + '\n', 'utf-8')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markStore.marks.clear()
    markStore.markUserStopped('sess-w1', 'user_force_quit')
    userStoppedGate.configure({ marks: markStore, abortSession: vi.fn(async () => undefined) })
  })

  afterEach(() => {
    userStoppedGate.resetForTest()
    warnSpy.mockRestore()
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('abort 抛错 → fallback 也抛错 → 两段 warn 出声、标记保留、环不启动、restore 照常返回（不向上传播）', async () => {
    const fallback = vi.fn(async () => { throw new Error('force-quit also exploded') })
    env = makeEnv({ abortImpl: vi.fn(async () => { throw new Error('abort rpc timeout') }), forceQuitFallback: fallback })

    // 失败链吞错：restore 主体不可回滚（session 已复活进 Map），收敛细节不泄漏成 restore 失败
    await expect(env.lifecycle.restoreSession('sess-w1')).resolves.toBeDefined()

    expect(env.client.abort).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledWith('sess-w1')
    const warns = warnSpy.mock.calls.map(String).join(' ')
    expect(warns).toContain('restore-abort failed for sess-w1')
    expect(warns).toContain('force-quit fallback also failed for sess-w1')
    // 标记保留（不视为已消费，下次 restore 重试；环未启动 → 无清理发生）
    expect(userStoppedGate.hasUserStoppedMark('sess-w1')).toBe(true)
  })

  it('abort 成功主路径（对照）：启动收敛环，收敛链路无 warn', async () => {
    env = makeEnv()
    await expect(env.lifecycle.restoreSession('sess-w1')).resolves.toBeDefined()
    expect(env.client.abort).toHaveBeenCalledTimes(1)
    // assertPiSessionFile 对无 sessionFile 的 mock client 会 warn（与本链路无关）——只断言收敛链路自身不出声
    expect(warnSpy.mock.calls.map(String).join(' ')).not.toContain('restore-abort failed for')
    // abort 成功 → 环启动、标记存活待收敛（窗满由 UserStoppedGate 状态机清理，见
    // user-stopped-convergence.test.ts 状态机组）
    expect(userStoppedGate.hasUserStoppedMark('sess-w1')).toBe(true)
  })
})
