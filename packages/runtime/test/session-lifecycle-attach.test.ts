import { PiConfigStore } from '../src/infra/pi/pi-config-store.js';
import { readModels, refreshModels, setModelsPath } from '../src/infra/pi/pi-provider-store.js';
import { readSettings, setSettingsPath } from '../src/infra/pi/pi-settings-store.js';
import { ProcessManager } from '../src/infra/pi/process-manager.js';
import { parseSessionHeader } from '../src/infra/pi/session-file-utils.js';
import type { IEventAdapter } from '../src/interfaces.js';
import { AuthStorage } from '../src/services/auth/auth-storage.js';
import { ProviderCredentialResolver } from '../src/services/auth/provider-credential-resolver.js';
import { ConfigService } from '../src/services/config-service.js';
import type { IMessageBus } from '../src/services/message-bus/message-bus.js';
import type { IConfigStore } from '../src/services/ports/config.js';
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js';
import type { ISessionStore } from '../src/services/ports/session.js';
import { reapOrphanPiProcesses, type ReapOrphanOptions } from '../src/services/reap-orphan-pi.js';
import { userStoppedGate } from '../src/services/session/event-interpreter.js';
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js';
import { type ILifecycleSessionOps, ISessionRegisterDeps, type IDispatcherSessionOps } from '../src/services/session/session-internal.js';
import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js';
import { ScannedSession, type IManagedSessionView } from '../src/services/session/types.js';
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js';
import { ServerMessage, type SessionSummary, type ProviderId } from '@taiji/shared';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// fork 目标目录指向测试 tmp（createForkedSessionFile 真实写入，不碰真实数据目录）
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})
const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))


function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now() }
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
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 消费方实际用到的全部），无强转
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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-lifecycle-attach', () => {
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
});

// ======================================================================
// ← test-extra7.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/kill-path-logging.test.ts
// ======================================================================

// ── process-manager 部分的模块级 mock（rpc-client fake + 阻断 execSync/探针 spawn）──

/** 捕获 createSession 注册的 client.onExit 回调（K8 触发入口）。 */
const exitCallbacksRegistry = vi.hoisted(() => ({
  callbacks: [] as Array<(code: number | null, stderr: string) => void>,
}))


vi.mock('../src/infra/pi/rpc-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/rpc-client.js')>()
  class FakeRpcClient {
    exited = false
    constructor(_opts: unknown) {}
    async start(): Promise<void> {}
    onExit(cb: (code: number | null, stderr: string) => void): void {
      exitCallbacksRegistry.callbacks.push(cb)
    }
    async kill(): Promise<void> {}
    async switchSession(_path: string): Promise<void> {}
  }
  // 保留 actual：测试本体 import 的 RpcTimeoutError 等符号须来自真实模块
  return { ...actual, RpcClient: FakeRpcClient }
})


vi.mock('../src/infra/pi/find-pi-executable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/find-pi-executable.js')>()
  return { ...actual, findPiExecutable: vi.fn(() => '/fake/path/pi'), }
})


// ── session-lifecycle 部分原自带同形 pi-paths mock：与文件头部 attach 节的同模块 mock
// 双注册 last-wins（后注册者胜、前节变量不被读取 → C1/C7 fork 写入 not-yet-initialized 路径
// 被 fs-guard 拦截）。此处删除重复注册，两节共用文件头部的 sessionsDirMock（各节 hook
// 先赋值自己节再跑本节用例，顺序执行无竞争）。──


// 模块 mock 声明完毕后再 import 被测对象
type WarnSpy = ReturnType<typeof vi.spyOn>


/** 断言辅助：warn 序列中存在含指定 kill_source 的日志行，返回该行。 */
function findKillLog(spy: WarnSpy, source: string): string | undefined {
  return spy.mock.calls
    .map((c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''))
    .find((line: string) => line.includes(`kill_source=${source}`))
}


// ── K1 / K2：message-dispatcher（harness 同 silent-abort-destroy.test.ts）──

function makeMockSession(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
  }
}


function makeDispatcherMocks(_opts: { abortError?: Error } = {}) {
  const session = makeMockSession()
  const client = {
    abort: vi.fn(async () => {
      if (_opts.abortError) throw _opts.abortError
    }),
  } as unknown as IPiEngine

  const bus = {
    publish: vi.fn((_sid: string, _m: ServerMessage) => {}),
  } as unknown as IMessageBus

  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => session),
    detachSession: vi.fn(),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    removeSessionEntry: vi.fn(),
    ensureActive: vi.fn(),
    getSession: vi.fn(() => undefined),
  }

  const pm = {
    getClient: vi.fn(() => client),
    destroySession: vi.fn(async () => {}),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, svc, pm }
}


// ── K3 / K5：session-lifecycle（harness 同 session-lifecycle-attach.test.ts）──

const currentSourceFile_m2 = vi.hoisted(() => ({ value: '' }))


/** 与 attach 测试同款：target 经真实 parseSessionHeader 从 tmp 文件派生。 */
function makeLifecycleEnv() {
  const client = {
    getState: vi.fn(async () => ({ sessionId: 's-1' })),
    switchSession: vi.fn(async (_sessionPath: string) => {}),
    setSessionName: vi.fn(async () => undefined),
  }
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1,
    })),
    findScannedSession: vi.fn((id: string): ScannedSession | undefined => {
      const filePath = currentSourceFile_m2.value
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
    getActiveSummaries: vi.fn(() => []),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点（session-dead-structural-fixes）：restoreSession 开头查活跃 client；
    // undefined = 无 client → 不短路 → 走全流程 K3 清场（本组用例的目标路径）。
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
    trash: vi.fn(async () => undefined),
    invalidateMetaCache: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, pm }
}


// ── K7：reap-orphan-pi（全依赖注入，零真实进程/等待）──

const REAP_SESSIONS_DIR = '/data/sessions-kill-log-test'


// 判据 v2（四条合取）的清单值 fixture：孤儿 argv 的 --extension 值须 ∈ 注入清单
const MARKER = '/data/staged-pi-spawn-marker'


function orphanRow(pid: number): string {
  // ps 单行：ppid=1（reparent 证据）+ 判据 v2 同形 argv（rpc + no-extensions + 清单值 --extension）
  return `  ${pid}     1 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --approve --extension ${MARKER}`
}


// ======================================================================
// ← test/e1-e3-real-verify.test.ts
// ======================================================================

let fixtureDir: string


let fixtureConfigService: ConfigService


/** E1 的「反向 api」构造：保证新值与当前展示值必不相同（否则断言可能恒真）。 */
function oppositeApi(current: string | undefined): string {
  return current === 'anthropic-messages' ? 'openai-completions' : 'anthropic-messages'
}


/**
 * E1 分体系断言单点（设计 D1③）——始终做真实落盘读取（readModels，绕过缓存）：
 * - custom：provider 级 api 是 custom 的定义权威 → 新值落到 listProviders 与 models.json；
 * - catalog：provider 级 `type` 被忽略（协议是模型级属性）→ 盘上 api 键保持原状（无键仍无键 /
 *   有旧值仍为旧值），派生展示（listProviders().api）保持原状且不等于新传入值。
 */
function assertApiTypeByKind(service: ConfigService, kind: 'custom' | 'catalog', providerId: string): void {
  const before = service.listProviders().find(p => p.id === providerId)
  if (!before) throw new Error(`被测 ${kind} provider 不在 listProviders() 结果中：${providerId}`)
  const newApi = oppositeApi(before.api)
  const rawBefore = readModels().providers[providerId]?.api

  // 无 await 分支（本用例不传 apiKey/models/authMethod）时 setProvider 同步执行到底，
  // 调用后即可读到落盘结果——依赖 setProvider 的同步前缀时序契约（见其实现注释）。
  service.setProvider(providerId, { type: newApi })

  const after = service.listProviders().find(p => p.id === providerId)!
  const rawAfter = readModels().providers[providerId]?.api

  if (kind === 'custom') {
    expect(after.api).toBe(newApi)
    expect(rawAfter).toBe(newApi)
  } else {
    expect(after.api).toBe(before.api)
    expect(after.api).not.toBe(newApi)
    expect(rawAfter).toBe(rawBefore)
    expect(rawAfter).not.toBe(newApi)
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('test-extra7', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('kill-path-logging', () => {
describe('D5① K1/K2：message-dispatcher kill 日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy

  beforeEach(() => {
    vi.clearAllMocks()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('K1: forceQuit（用户强制退出）→ warn 含 kill_source=user_force_quit 与信号链', async () => {
    const { dispatcher } = makeDispatcherMocks()

    await dispatcher.forceQuit('s1')

    const line = findKillLog(warnSpy, 'user_force_quit')
    expect(line).toBeDefined()
    // 信号链要素：谁发起（用户经 session.forceQuit RPC）+ 收敛链
    expect(line).toContain('session s1')
    expect(line).toContain('forceQuit')
  })

})
describe('D5① K3/K5：session-lifecycle kill 日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy
  let dir: string
  let filePath: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = mkdtempSync(join(tmpdir(), 'kill-path-logging-'))
    filePath = join(dir, '2026-08-19T00-00-00-000Z_sess-kill-log.jsonl')
    currentSourceFile_m2.value = filePath
    sessionsDirMock.value = dir
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'sess-kill-log', timestamp: '2026-08-19T00:00:00.000Z', cwd: dir }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-19T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n') + '\n',
      'utf-8',
    )
  })

  afterEach(() => {
    warnSpy.mockRestore()
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('K3: restoreSession 清场杀活跃旧 pi → warn 含 kill_source=restore_clear 与信号链', async () => {
    const { lifecycle, pm } = makeLifecycleEnv()

    // 第一次 restore 注册 session 进 Map；第二次 restore 命中 existing → 清场杀旧 pi 分支
    await lifecycle.restoreSession('sess-kill-log')
    await lifecycle.restoreSession('sess-kill-log')

    const line = findKillLog(warnSpy, 'restore_clear')
    expect(line).toBeDefined()
    expect(line).toContain('sess-kill-log')
    // 信号链要素：清场 → 重开
    expect(line).toContain('safeDestroy')
    // 物理销毁被调：旧 pi 确实被销毁
    expect(pm.destroySession).toHaveBeenCalled()
  })

  it('K5: delete 活跃 session → warn 含 kill_source=delete 与信号链', async () => {
    const { lifecycle, pm } = makeLifecycleEnv()

    // 先 restore 使 session 进 Map（active 分支才有 kill 对象）
    await lifecycle.restoreSession('sess-kill-log')
    warnSpy.mockClear()

    await lifecycle.delete('sess-kill-log')

    const line = findKillLog(warnSpy, 'delete')
    expect(line).toBeDefined()
    expect(line).toContain('sess-kill-log')
    // 物理销毁被调：活跃 pi 确实被销毁
    expect(pm.destroySession).toHaveBeenCalledWith('sess-kill-log')
  })
})
// ── K6 / K8：process-manager（rpc-client 模块已文件级 mock）──

describe('D5① K6/K8：process-manager kill 日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy
  let pm: ProcessManager

  beforeEach(() => {
    vi.clearAllMocks()
    exitCallbacksRegistry.callbacks.length = 0
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pm = new ProcessManager('/fake-project-root')
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('K6: destroyAll 批量销毁 → warn 含 kill_source=destroy_all 与会话清单', async () => {
    // cwd 仅被存入 ManagedProcess（fake rpc-client 不 spawn），无存在性要求
    await pm.createSession('sess-a', '/tmp/kill-path-logging-fake-cwd')
    await pm.createSession('sess-b', '/tmp/kill-path-logging-fake-cwd')

    await pm.destroyAll()

    const line = findKillLog(warnSpy, 'destroy_all')
    expect(line).toBeDefined()
    // 信号链要素：批量扇出 + 会话清单可追溯
    expect(line).toContain('sess-a')
    expect(line).toContain('sess-b')
    expect(pm.size).toBe(0)
  })

  it('K6 空表：无进程时 destroyAll 不打 kill 日志（零 kill 零日志）', async () => {
    await pm.destroyAll()
    expect(findKillLog(warnSpy, 'destroy_all')).toBeUndefined()
  })

  it('K8: client 异常退出回调（非 intentional destroy）→ warn 含 kill_source=exit_converge', async () => {
    await pm.createSession('sess-crash', '/tmp/kill-path-logging-fake-cwd')
    expect(exitCallbacksRegistry.callbacks.length).toBe(1)

    // 模拟 pi 进程自发退出（crash / 外部 kill，exit 143 形态）
    exitCallbacksRegistry.callbacks[0]!(143, 'terminated')

    const line = findKillLog(warnSpy, 'exit_converge')
    expect(line).toBeDefined()
    expect(line).toContain('sess-crash')
    expect(line).toContain('143')
  })
})
describe('D5① K7：reap-orphan-pi 收殓日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy

  beforeEach(() => {
    vi.clearAllMocks()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('K7: 启动孤儿收殓命中孤儿 → warn 含 kill_source=reap_orphan 与信号链', async () => {
    const signalCalls: Array<{ pid: number; signal: 'SIGKILL' }> = []
    const options: ReapOrphanOptions = {
      dataDir: REAP_SESSIONS_DIR,
      ownPid: 999,
      listProcesses: () => Promise.resolve(orphanRow(4242)),
      readSpawnMarkers: () => [MARKER],
      signal: (pid, signal) => {
        signalCalls.push({ pid, signal })
      },
    }

    const result = await reapOrphanPiProcesses(options)

    expect(result.reaped).toEqual([4242])
    const line = findKillLog(warnSpy, 'reap_orphan')
    expect(line).toBeDefined()
    // 信号链要素：孤儿判定 + SIGKILL 直杀
    expect(line).toContain('SIGKILL')
    expect(signalCalls[0]).toEqual({ pid: 4242, signal: 'SIGKILL' })
  })

  it('K7 无孤儿：零收殓不打 kill 日志', async () => {
    const options: ReapOrphanOptions = {
      dataDir: REAP_SESSIONS_DIR,
      ownPid: 999,
      listProcesses: () => Promise.resolve(''),
      readSpawnMarkers: () => [MARKER],
      signal: () => {},
    }
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([])
    expect(findKillLog(warnSpy, 'reap_orphan')).toBeUndefined()
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('e1-e3-real-verify', () => {
/**
 * 自建 fixture（不依赖真实数据目录）：覆盖 E1 的 custom + catalog 两分支与 E3 的默认模型落盘。
 *
 * mkdtemp 自建 models.json（custom 1 个 + catalog 2 个变体）保证两分支可执行证据完整：
 * catalog「无 api 键」与「有旧 api 键」两种落盘形态都断言。写删全部落在 mkdtemp
 * 临时目录内（fs-guard 白名单），不碰真实数据目录。
 */
describe('E1/E3 分体系 real 层持久化（自建 fixture）', () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'e1-kind-fixture-'))
    const piAgentDir = join(fixtureDir, 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    const providers = {
      // catalog（id 命中内置快照），override 无 provider 级 api 键
      anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', models: [] },
      // catalog + 既有 provider 级 api 键（历史冻结值形态）
      openai: { name: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', models: [] },
      // custom（id 不在内置快照）：provider 级 api 是定义权威
      'fixture-custom': {
        name: 'Fixture Custom',
        api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'sk-fixture',
        models: [{ id: 'fixture-model', name: 'Fixture Model' }],
      },
    }
    writeFileSync(join(piAgentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
    writeFileSync(join(piAgentDir, 'settings.json'), '{}')

    setModelsPath(join(piAgentDir, 'models.json'))
    setSettingsPath(join(piAgentDir, 'settings.json'))
    refreshModels()
    const fixtureStore = new PiConfigStore()
    fixtureConfigService = new ConfigService(
      fixtureDir,
      fixtureStore,
      undefined,
      undefined,
      undefined,
      // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（auth.json 路径指向临时目录，
      // 恒 miss；models.json 路径经真 PiConfigStore 读 fixture）
      new ProviderCredentialResolver({
        authService: { getCredential: async () => undefined },
        authStorage: new AuthStorage(join(piAgentDir, 'auth.json')),
        configStore: fixtureStore,
      }),
    )

    // fixture 前提自检：kind 判定符合构造意图，否则下面的分体系断言无意义
    const kinds = new Map(fixtureConfigService.listProviders().map(p => [p.id as string, p.kind]))
    expect(kinds.get('anthropic')).toBe('catalog')
    expect(kinds.get('openai')).toBe('catalog')
    expect(kinds.get('fixture-custom')).toBe('custom')
  })

  afterAll(() => {
    if (fixtureDir && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('E1-fixture/custom: provider 级 api 是 custom 的定义权威 → models.json 落盘新值', () => {
    assertApiTypeByKind(fixtureConfigService, 'custom', 'fixture-custom')
  })

  it('E1-fixture/catalog: provider 级 type 被忽略 → 盘上 api 键保持原状（无键仍无键 / 旧值仍旧值）', () => {
    // 变体一：无 api 键 → 落盘后仍无该键
    assertApiTypeByKind(fixtureConfigService, 'catalog', 'anthropic')
    expect((readModels().providers.anthropic ?? {}) as Record<string, unknown>).not.toHaveProperty('api')

    // 变体二：既有 api 键 → 保持旧值，不被新传入的 type 覆盖
    assertApiTypeByKind(fixtureConfigService, 'catalog', 'openai')
    expect(readModels().providers.openai?.api).toBe('openai-completions')
  })

  it('E3-fixture: setDefaultModel → settings.json 落盘 defaultProvider/defaultModel', () => {
    fixtureConfigService.setDefaultModel('fixture-custom' as ProviderId, 'fixture-model')

    // 直接读盘验证（绕过缓存）：defaultProvider/defaultModel 双键落盘
    const settings = readSettings()
    expect(settings.defaultProvider).toBe('fixture-custom')
    expect(settings.defaultModel).toBe('fixture-model')
  })
})
});
});
