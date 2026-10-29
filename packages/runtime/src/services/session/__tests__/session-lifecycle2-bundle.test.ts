import { PiConfigStore } from '../../../infra/pi/pi-config-store.js';
import { persistSessionEnd, parseSessionHeader } from '../../../infra/pi/session-file-utils.js';
import { PiSessionStore } from '../../../infra/pi/session-store.js';
import type { IEventAdapter, IExtensionService } from '../../../interfaces.js';
import { SessionManagerHandler } from '../../../transport/session-manager-handler.js';
import type { IConfigStore } from '../../ports/config.js';
import type { IGitInfoReader } from '../../ports/git-info.js';
import { IPiEngine, type IProcessManager } from '../../ports/pi-engine.js';
import type { ISessionStore } from '../../ports/session.js';
import { type PresetService, PresetResolution } from '../../preset-service.js';
import type { WorkspaceService } from '../../workspace/workspace-service.js';
import type { BtwLineRecord } from '../btw-service.js';
import { applySessionOccupancyTransition } from '../event-interpreter.js';
import { resolveLaunchPresetOptions } from '../launch-params.js';
import type { SessionDeliveryRegistry } from '../session-delivery-registry.js';
import { ISessionRegisterDeps, ManagedSession, type ILifecycleSessionOps, type IManagedSessionRecord } from '../session-internal.js';
import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js';
import { SessionListQueryService } from '../session-list-query.js';
import { SessionService } from '../session-service.js';
import { buildSessionSummary } from '../session-summary.js';
import type { ScannedSession, IManagedSessionView } from '../types.js';
import type { SessionSummary, SessionGroup } from '@taiji/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/session/__tests__/session-lifecycle-delete-gate.test.ts
// ======================================================================

const SID = 's-delete-gate'


/** 构造最小 lifecycle 环境（delete 门路径）：svc 提供 getActiveSummaries（deleteByCwd 收集面）*/
function makeEnv(
  scanned?: ScannedSession,
  opts?: { activeSummaries?: SessionSummary[]; scanResults?: ScannedSession[] },
) {
  const svc: ILifecycleSessionOps = {
    findScannedSession: vi.fn(() => scanned ?? undefined),
    toSummary: vi.fn(),
    getSkillPaths: vi.fn(),
    getExtensionPaths: vi.fn(),
    getReplaceSystemPrompt: vi.fn(),
    getLaunchPresetOptions: vi.fn(),
    fetchAndBroadcastContext: vi.fn(),
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
    getActiveSummaries: vi.fn(() => opts?.activeSummaries ?? []),
  }
  const destroySession = vi.fn(async () => {})
  const pm = { destroySession } as unknown as IProcessManager
  const sessionStore = {
    trash: vi.fn(async () => {}),
    trashDirectory: vi.fn(async () => {}),
    invalidateMetaCache: vi.fn(),
    invalidateScanCache: vi.fn(),
    refreshAll: vi.fn(),
    scanSessions: vi.fn(() => opts?.scanResults ?? []),
  } as unknown as ISessionStore
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(
    svc,
    pm,
    { getDefaultModel: vi.fn(() => null) } as unknown as IConfigStore,
    sessionStore,
    {} as unknown as WorkspaceService,
    registerDeps,
  )
  return { lifecycle, destroySession }
}


/** 造活跃会话记录（真 registerSession 汇聚点）并置 isGenerating（occupancy 原语唯一写点） */
async function makeGeneratingSession(lifecycle: SessionLifecycle, mode: 'dispatching' | 'settling'): Promise<IManagedSessionRecord> {
  const client = { prompt: vi.fn() } as unknown as Parameters<typeof lifecycle.registerSession>[1]
  const record = await lifecycle.registerSession(SID, client, '/proj', 'gate-test', undefined, undefined)
  // dispatching → isGenerating=true；settling → isGenerating=false（门口径不含 settling）
  applySessionOccupancyTransition(record, null, mode)
  return record
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-lifecycle-delete-gate', () => {
beforeEach(() => {
  vi.clearAllMocks()
})
describe('SessionLifecycle.delete 生成中拒绝门（U8）', () => {
  it('dispatching（isGenerating=true）：reject delete_generating + 可操作文案，杀进程前置零执行', async () => {
    const { lifecycle, destroySession } = makeEnv()
    await makeGeneratingSession(lifecycle, 'dispatching')

    const err = await lifecycle.delete(SID).then(
      () => { throw new Error('delete 应被门拒绝') },
      (e: Error & { code?: string | number }) => e,
    )
    expect(err.code).toBe('delete_generating')
    expect(err.message).toContain('生成中')
    expect(err.message).toContain('停止生成')
    // 门在 userStoppedGate/fireDeathDisposition/detach 之前：杀进程链零触达
    expect(destroySession).not.toHaveBeenCalled()
  })

  it('settling（isGenerating=false）：门口径不含 settling，删除放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u8-delete-gate-'))
    try {
      const filePath = join(dir, `${SID}.jsonl`)
      writeFileSync(filePath, '{"type":"session"}\n', 'utf-8')
      const { lifecycle, destroySession } = makeEnv()
      await makeGeneratingSession(lifecycle, 'settling')
      // 活跃分支的级联（trashSessionTree 经 cascade）走 sessionStore.trash mock——不校验盘上终态，
      // 本用例只锁「门放行」（到达 destroySession = 门未拦）
      await expect(lifecycle.delete(SID)).resolves.toBeUndefined()
      expect(destroySession).toHaveBeenCalledWith(SID)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('scanned（非活跃）会话：门短路放行，正常删除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u8-delete-gate-'))
    try {
      const filePath = join(dir, `${SID}.jsonl`)
      writeFileSync(filePath, '{"type":"session"}\n', 'utf-8')
      const scanned: ScannedSession = {
        id: SID, filePath, cwd: '/proj', timestamp: new Date().toISOString(),
        name: 'gate', outcome: null, lastModified: Date.now(), size: 100,
      } as ScannedSession
      const { lifecycle } = makeEnv(scanned)
      await expect(lifecycle.delete(SID)).resolves.toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // delete-generating-error-localization：deleteByCwd 聚合把门拒绝的 code 透传进 failed[]
  // 条目（renderer 据此查 i18n 词条，不再插值 runtime 原文）；意外错误无 code 字段缺失回落
  // 原文由 renderer 侧测试覆盖。
  it('deleteByCwd：门拒绝会话进 failed[] 并透传 code=delete_generating，其余会话照常进 deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u8-delete-bycwd-'))
    try {
      const filePath = join(dir, 's-deletable.jsonl')
      writeFileSync(filePath, '{"type":"session"}\n', 'utf-8')
      const deletable: ScannedSession = {
        id: 's-deletable', filePath, cwd: '/proj', timestamp: new Date().toISOString(),
        name: 'bycwd', outcome: null, lastModified: Date.now(), size: 10,
      } as ScannedSession
      const { lifecycle } = makeEnv(deletable, {
        // 收集面：生成中活跃会话（registerSession 后门拒绝）+ 同 cwd 的可删 scanned 会话
        activeSummaries: [{ id: SID, cwd: '/proj' } as SessionSummary],
        scanResults: [deletable],
      })
      await makeGeneratingSession(lifecycle, 'dispatching')

      const res = await lifecycle.deleteByCwd('/proj')
      expect(res.cwd).toBe('/proj')
      expect(res.deleted).toEqual(['s-deletable'])
      expect(res.failed).toHaveLength(1)
      expect(res.failed[0]?.sessionId).toBe(SID)
      expect(res.failed[0]?.code).toBe('delete_generating')
      // error 原文保留——renderer 未命中码时的回落源，日志同源
      expect(res.failed[0]?.error).toContain('生成中')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-lifecycle-preset-fallback-disclosure.test.ts
// ======================================================================

// [session-cold-switch-perf §3.3-2] restoreSession 消费预热槽：槽空回退现状 spawn 链时
// 「顺带补位」会经同一构造链再调一次 pm.createSession（后台），干扰本文件 restore 主链的
// spawn 计数断言。槽本体由 src/__tests__/warmup-pi-slot.test.ts 覆盖，此处 mock 恒空槽
//（take 恒 empty、零补位）。
vi.mock('../warmup-pi-slot.js', () => {
  return {
    WARMUP_SLOT_SESSION_ID: 'warmup-pi-slot',
    WarmupPiSlot: class {
      take(): { kind: 'empty' } { return { kind: 'empty' } }
      warm(): void {}
    },
  }
})

// getSessionsDir 指向测试 tmp（会话文件真实写入；不碰真实数据目录）
const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})
/** 定义不可得的悬空 presetId（模拟用户删除的自定义模式）。 */
const GONE_PRESET_ID = 'custom:gone-uuid'


/** 内存 fake preset 服务：getPreset 命中与否驱动真实 resolveLaunchPresetOptions 的回落检测。 */
function makePresetService(availableIds: readonly string[]): PresetService {
  const resolution: PresetResolution = {
    skillPaths: undefined,
    extensionPaths: [],
    toolArgs: {},
    flags: { noSkills: false, noContextFiles: false },
  }
  return {
    getPreset: (id: string) => (availableIds.includes(id) ? { id } : undefined),
    resolve: () => resolution,
  } as unknown as PresetService
}


/** 真实 Summary 派生视图（git 端口 fake；W3 起三状态字段已删，无 states 读点）。 */
const gitInfoReader = {
  readGitInfo: () => undefined,
  pruneStaleCache: () => {},
} as unknown as IGitInfoReader


function makeSummaryReal(s: IManagedSessionView): SessionSummary {
  return buildSessionSummary(s, gitInfoReader)
}


/** 会话文件行集：header（restore 归一化判定与附着断言的真实输入）。 */
function makeLines(cwd: string): string[] {
  return [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-restore', timestamp: '2026-09-01T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ]
}


function makeEnv_m2(presetService: PresetService, scanned: ScannedSession) {
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'pi-restore' })),
    switchSession: vi.fn(async () => undefined),
    setSessionName: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  }
  const createSession = vi.fn(async (_sessionId: string, _cwd: string, _options?: unknown) => client)
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    // 真实检测链：resolveLaunchPresetOptions 决定是否附 fellBackFromPresetId
    getLaunchPresetOptions: (presetId: string, cwd: string) => resolveLaunchPresetOptions(presetService, presetId, cwd),
    toSummary: makeSummaryReal,
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => scanned),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    getActiveSummaries: vi.fn(() => []),
  }
  const pm = {
    createSession,
    destroySession: vi.fn(async () => undefined),
    getClient: vi.fn(() => undefined),
    rekey: vi.fn(),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
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
  return { lifecycle, createSession }
}


/** 取 pm.createSession 第 n 次调用的 options.env（F1b 出站通道断言）。 */
function spawnEnv(createSession: ReturnType<typeof makeEnv_m2>['createSession'], n = 0): Record<string, string> {
  const options = createSession.mock.calls[n]?.[2] as { env?: Record<string, string> } | undefined
  return options?.env ?? {}
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-lifecycle-preset-fallback-disclosure', () => {
describe('restore 回落披露（F1 / 设计 §7.5 E4）', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    setMigrationGate(Promise.resolve())
    dir = mkdtempSync(join(tmpdir(), 'preset-fallback-'))
    sessionsDirMock.value = dir
    filePath = join(dir, 'sess-restore.jsonl')
    writeFileSync(filePath, makeLines(dir).join('\n') + '\n', 'utf-8')
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function scannedSession(launchPresetId: string | undefined): ScannedSession {
    return {
      id: 'sess-restore', filePath, cwd: dir, timestamp: '2026-09-01T00:00:00.000Z',
      name: 'target', lastModified: Date.now(), size: 0, outcome: null, launchPresetId,
    }
  }

  it('模式定义不可得 → 回落事实置位并可从会话状态 / SessionSummary 读回（launchPresetFallbackTo=builtin:full）', async () => {
    // 只有 builtin:full 可得（悬空 id 定义不可得 → 真实回落检测命中）
    const env = makeEnv_m2(makePresetService(['builtin:full']), scannedSession(GONE_PRESET_ID))

    const summary = await env.lifecycle.restoreSession('sess-restore')

    // F1b 出站通道：回落事实随 spawn env 到达 pi 子进程（trace 扩展据此写 presetFallback）
    expect(spawnEnv(env.createSession, 0)).toMatchObject({
      TAIJI_PRESET_FALLBACK_FROM: GONE_PRESET_ID,
      TAIJI_PRESET_FALLBACK_TO: 'builtin:full',
    })

    // 携带层：summary 披露回落（renderer chip/声明行据此显示「本次以全工具模式启动」）
    expect(summary.launchPresetFallbackTo).toBe('builtin:full')
    // 原悬空 id 仍保留（chip 才能同时报「模式已删除（id）」）
    expect(summary.launchPresetId).toBe(GONE_PRESET_ID)
    // 会话状态读回（renderer reload 时 runtime 内存态重派生视图仍可复现，不依赖一次性广播）
    const active = env.lifecycle.get('sess-restore') as unknown as { launchPresetFallbackTo?: string }
    expect(active.launchPresetFallbackTo).toBe('builtin:full')
    expect(makeSummaryReal(active as unknown as IManagedSessionView).launchPresetFallbackTo).toBe('builtin:full')
  })

  it('模式定义仍可得 → 不置回落事实（不产生假陈述）', async () => {
    const env = makeEnv_m2(makePresetService(['builtin:full', GONE_PRESET_ID]), scannedSession(GONE_PRESET_ID))

    const summary = await env.lifecycle.restoreSession('sess-restore')

    expect(summary.launchPresetId).toBe(GONE_PRESET_ID)
    expect(summary.launchPresetFallbackTo).toBeUndefined()
    // F1b 出站通道：无回落 → 两键空串（不得对 pi 假披露）
    expect(spawnEnv(env.createSession, 0)).toMatchObject({
      TAIJI_PRESET_FALLBACK_FROM: '',
      TAIJI_PRESET_FALLBACK_TO: '',
    })
    const active = env.lifecycle.get('sess-restore') as unknown as { launchPresetFallbackTo?: string }
    expect(active.launchPresetFallbackTo).toBeUndefined()
  })

  it('历史 session 无 launchPresetId（builtin:full 兜底，非回落）→ 不置回落事实', async () => {
    const env = makeEnv_m2(makePresetService(['builtin:full']), scannedSession(undefined))

    const summary = await env.lifecycle.restoreSession('sess-restore')

    expect(summary.launchPresetId).toBe('builtin:full')
    expect(summary.launchPresetFallbackTo).toBeUndefined()
    // 历史 session 的 builtin:full 兜底不是「回落」——env 两键空串
    expect(spawnEnv(env.createSession, 0)).toMatchObject({
      TAIJI_PRESET_FALLBACK_FROM: '',
      TAIJI_PRESET_FALLBACK_TO: '',
    })
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-lifecycle-restore-idempotence.test.ts
// ======================================================================

const sessionsDirMock_m2 = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))


vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock_m2.value }
})
const SID_m2 = 'sess-restore-idempotent'

const currentSourceFile = vi.hoisted(() => ({ value: '' }))


type WarnSpy = ReturnType<typeof vi.spyOn>


/** K3 harness 同款：全 svc 面 mock + pm.getClient 恒返回活跃 client（短路判定的命中前提）。 */
function makeRestoreEnv() {
  const activeClient = {
    exited: false,
    getState: vi.fn(async () => ({ sessionId: SID_m2 })),
    switchSession: vi.fn(async (_sessionPath: string) => {}),
    setSessionName: vi.fn(async () => undefined),
  }
  // notifyCreated 提取引用（接口类型抹掉 vi.fn 方法侧，断言范围直接用原 mock）
  const notifyCreated = vi.fn()
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: { id: string; label: string; cwd: string }): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1,
    })),
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
    notifySessionCreated: notifyCreated,
    getActiveSummaries: vi.fn(() => []),
  }
  const pm = {
    createSession: vi.fn(async () => activeClient),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点：生产中 client 活跃 = pm 注册表命中；这里恒返回活跃 client，
    // 使「client 活跃」前提成立，短路与否定边界只由 sessions Map / exited 分流。
    getClient: vi.fn(() => activeClient),
  } as unknown as IProcessManager & {
    createSession: ReturnType<typeof vi.fn>
    destroySession: ReturnType<typeof vi.fn>
    getClient: ReturnType<typeof vi.fn>
  }
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
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(
    svc,
    pm,
    configStore,
    sessionStore,
    { record: vi.fn() } as unknown as WorkspaceService,
    registerDeps,
  )
  return { lifecycle, pm, svc, notifyCreated }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-lifecycle-restore-idempotence', () => {
describe('restoreSession D5② 幂等短路', () => {
  let warnSpy: WarnSpy
  let dir: string

  beforeEach(() => {
    setMigrationGate(Promise.resolve())
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = mkdtempSync(join(tmpdir(), 'restore-idempotence-'))
    const filePath = join(dir, `2026-09-15T00-00-00-000Z_${SID}.jsonl`)
    currentSourceFile.value = filePath
    sessionsDirMock_m2.value = dir
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', version: 3, id: SID_m2, timestamp: '2026-09-15T00:00:00.000Z', cwd: dir }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-15T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n') + '\n',
      'utf-8',
    )
  })

  afterEach(() => {
    warnSpy.mockRestore()
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('client 活跃时二次 restore 短路：返回原 summary，不重开、不杀旧 pi、不摘条目、不重复通知', async () => {
    const { lifecycle, pm, svc, notifyCreated } = makeRestoreEnv()

    // #1：Map 为空 → 走全流程（spawn + 注册 + 通知）
    const first = await lifecycle.restoreSession(SID_m2)
    expect(first.id).toBe(SID_m2)
    expect(pm.createSession).toHaveBeenCalledTimes(1)
    expect(notifyCreated).toHaveBeenCalledTimes(1)

    warnSpy.mockClear()
    notifyCreated.mockClear()

    // #2：client 活跃 + Map 有条目 → 短路，零副作用
    const second = await lifecycle.restoreSession(SID_m2)

    expect(second).toEqual(first) // 返回现有 summary（同一注册记录的派生视图）
    expect(pm.createSession).toHaveBeenCalledTimes(1) // 未重开进程
    expect(pm.destroySession).not.toHaveBeenCalled() // 未杀旧 pi（K3 撞车回归锚）
    expect(svc.removeSessionEntry).not.toHaveBeenCalled() // 未摘 Map 条目
    expect(notifyCreated).not.toHaveBeenCalled() // 未重复通知
    // 短路命中不产生 kill 日志（错误规格 §3.4；与 kill-path-logging K3 互为正反例）
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain('kill_source=restore_clear')
  })

  it('client 已退出（exited=true）：不短路，走清场重开（D5① K3 路径保持）', async () => {
    const { lifecycle, pm, svc } = makeRestoreEnv()

    await lifecycle.restoreSession(SID_m2) // #1 全流程注册
    pm.getClient.mockReturnValue({ exited: true }) // 旧 pi 已死

    await lifecycle.restoreSession(SID_m2)

    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).some((l: string) => l.includes('kill_source=restore_clear'))).toBe(true)
    expect(pm.destroySession).toHaveBeenCalledWith(SID_m2) // 旧 pi 被清场
    expect(pm.createSession).toHaveBeenCalledTimes(2) // 重开
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(2) // 两次全流程各通知一次
  })

  it('client 活跃但 Map 无条目（registerSession 未完成的半截态）：不短路，走全流程重开', async () => {
    const { lifecycle, pm, svc } = makeRestoreEnv()

    // 首次调用即满足「client 活跃」但 Map 尚无条目 → 短路判定必须放行走全流程
    const summary = await lifecycle.restoreSession(SID_m2)

    expect(summary.id).toBe(SID_m2)
    expect(pm.createSession).toHaveBeenCalledTimes(1) // 全流程 spawn 发生
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-outcome-first-terminal.test.ts
// ======================================================================

let runDir: string


/** 真 SessionService 最小装置（session-service-plugin-data-clear.test.ts createSetup 同款）。 */
function createService(): { service: SessionService; sessionStore: PiSessionStore } {
  const client = { lastActivityAt: 1, exited: false } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
    destroySession: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  }
  const sessionStore = new PiSessionStore()
  vi.spyOn(sessionStore, 'refreshAll').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'invalidateScanCache').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'trash').mockImplementation(async () => undefined)
  const service = new SessionService(
    pm as unknown as IProcessManager,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    sessionStore,
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
  return { service, sessionStore }
}


/** 经 lifecycle Map 塞入带 sessionFilePath 的最小记录（persistSessionOutcome 的定位路径）。 */
function registerSessionRecord(
  service: SessionService,
  sid: string,
  filePath: string,
  overrides: Partial<ManagedSession> = {},
): void {
  const lifecycle = (service as unknown as { lifecycle: SessionLifecycle }).lifecycle
  const sessions = (lifecycle as unknown as { sessions: Map<string, IManagedSessionRecord> }).sessions
  sessions.set(sid, {
    id: sid,
    cwd: runDir,
    label: 't',
    modelId: 'm',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false },
    sessionFilePath: filePath,
    ...overrides,
  } as IManagedSessionRecord)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-outcome-first-terminal', () => {
beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'session-outcome-first-terminal-'))
})
afterAll(() => {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('persistSessionOutcome 第一终态优先（chat-flow-consistency 缺陷 2 方案 2）', () => {
  it('已有 done 终态 → 后写 stopped 跳过（settling 窗口 abort 不覆盖自然完成的 done）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-done.jsonl')
    writeFileSync(filePath, '{}\n')
    persistSessionEnd(filePath, 'done', 'natural finish')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')

    registerSessionRecord(service, 's1', filePath)
    service.persistSessionOutcome('s1', 'stopped', 'User aborted')
    // 第一终态优先：done 不被覆盖（会话不误标 stopped、不骗出恢复入口）
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')
  })

  it('已有 error 终态 → 后写 stopped/done 均跳过', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-error.jsonl')
    writeFileSync(filePath, '{}\n')
    persistSessionEnd(filePath, 'error', 'first failure')
    registerSessionRecord(service, 's2', filePath)
    service.persistSessionOutcome('s2', 'stopped', 'User aborted')
    service.persistSessionOutcome('s2', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error')
  })

  it('无既有终态 → 正常写入（首终态落盘通路不拦）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-fresh.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's3', filePath)
    service.persistSessionOutcome('s3', 'stopped', 'User aborted')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('先写者赢的竞态口径：stopped 先写 → 后到 agent_end 的 done 跳过（对齐进程退出链「abort reason 更具诊断价值」）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-race.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's4', filePath)
    service.persistSessionOutcome('s4', 'stopped', 'User aborted')
    service.persistSessionOutcome('s4', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
  })
})
describe('跨回合终态放行（dmg-r1-1：新回合受理入口清旧终态 sidecar）', () => {
  it('stopped 先写 → 新回合受理 clearSessionOutcome → 新回合正常完成 done 应覆盖', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-cross-stopped.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's7', filePath)
    // 上一回合：用户 abort → stopped 落盘
    service.persistSessionOutcome('s7', 'stopped', 'User aborted')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
    // 新回合受理（message-dispatcher.runAcceptance 受理成功后的调用点）：清旧终态
    service.clearSessionOutcome('s7')
    expect(sessionStore.extractSessionOutcome(filePath)).toBeNull()
    // 新回合正常完成：done 不再被旧 stopped 拦截（重启后侧栏按新终态显示）
    service.persistSessionOutcome('s7', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')
  })

  it('error → done 同型：新回合受理清旧 error 后，新回合完成 done 应覆盖', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-cross-error.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's8', filePath)
    service.persistSessionOutcome('s8', 'error', 'LLM failed')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error')
    service.clearSessionOutcome('s8')
    service.persistSessionOutcome('s8', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')
  })

  it('未受理新回合（不清除）时第一终态优先保护原样生效：done 仍被旧 stopped 拦截（同回合竞态口径回归锚）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-cross-guard.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's9', filePath)
    service.persistSessionOutcome('s9', 'stopped', 'User aborted')
    service.persistSessionOutcome('s9', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('clearSessionOutcome 对无 sidecar 的会话幂等无害（进行中会话常态）', () => {
    const { service } = createService()
    const filePath = join(runDir, 's-cross-nometa.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's10', filePath)
    expect(() => service.clearSessionOutcome('s10')).not.toThrow()
  })
})
describe('session-manager send 通路受理清旧终态（session-manager-send-sidecar-stale，第二受理点对齐 dmg-r1-1）', () => {
  /**
   * handler 装置：真 SessionService（受理清 sidecar 走真删 + 真缓存失效，归属校验走真
   * getSummary 派生）+ mock delivery（sendChecked 受理形态可控）。sendExtensionUiResponse
   * 捕获 respond JSON 断言回包。
   */
  function makeHandler(service: SessionService, sendChecked: () => Promise<unknown>): {
    handler: SessionManagerHandler
    respond: ReturnType<typeof vi.fn>
  } {
    const respond = vi.fn(() => true)
    const delivery = {
      getOrCreateDelivery: () => ({ sendChecked: vi.fn(sendChecked) }),
    } as unknown as SessionDeliveryRegistry
    const handler = new SessionManagerHandler({
      sessionService: service,
      delivery,
      sendExtensionUiResponse: respond,
      broadcastSessionList: () => {},
    })
    return { handler, respond }
  }

  it('send 受理成功（queued）→ 旧终态 sidecar 被清，新回合终态不再被拦', async () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-agent-send.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's11', filePath, {
      spawnSource: 'agent',
      parentAgentSessionId: 'parent-1',
    })
    // 上一回合：abort → stopped 落盘
    service.persistSessionOutcome('s11', 'stopped', 'User aborted')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')

    const { handler, respond } = makeHandler(service, async () => undefined)
    await handler.handle('req-sm-1', 'parent-1', 'send', { sessionId: 's11', prompt: 'continue' })
    // 受理成功回包（queued，无 notifyId → willNotify false）
    expect(respond).toHaveBeenCalledTimes(1)
    expect(JSON.parse(respond.mock.calls[0][2] as string)).toEqual({ queued: true, willNotify: false })
    // 受理清旧终态：sidecar 已删，新周期 done 可正常写入
    expect(sessionStore.extractSessionOutcome(filePath)).toBeNull()
    service.persistSessionOutcome('s11', 'done')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('done')
  })

  it('send 受理失败（sendChecked throw）→ 旧终态保留（被拒的提交不开启新周期）', async () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-agent-send-fail.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's12', filePath, {
      spawnSource: 'agent',
      parentAgentSessionId: 'parent-1',
    })
    service.persistSessionOutcome('s12', 'stopped', 'User aborted')

    const { handler, respond } = makeHandler(service, async () => {
      throw new Error('target unreachable')
    })
    await handler.handle('req-sm-2', 'parent-1', 'send', { sessionId: 's12', prompt: 'continue' })
    // 失败回包走 error + hint（hint 恢复指引），旧终态原样保留
    const payload = JSON.parse(respond.mock.calls[0][2] as string) as Record<string, unknown>
    expect(payload['error']).toBe('target unreachable')
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('stopped')
  })
})
describe('handleTurnEndSideEffects willRetry 中间失败跳终态（chat-flow-consistency 缺陷 1 方案 A）', () => {
  it('willRetry=true → persistSessionOutcome 不调用（attempt 级失败不落盘终态）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-retry.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's5', filePath)
    const outcomeSpy = vi.spyOn(service, 'persistSessionOutcome')
    service.handleTurnEndSideEffects('s5', 'error', true)
    expect(outcomeSpy).not.toHaveBeenCalled()
    expect(sessionStore.extractSessionOutcome(filePath)).toBeNull()
  })

  it('willRetry=false/缺省 → 终态照写（stopReason error → error）', () => {
    const { service, sessionStore } = createService()
    const filePath = join(runDir, 's-final.jsonl')
    writeFileSync(filePath, '{}\n')
    registerSessionRecord(service, 's6', filePath)
    service.handleTurnEndSideEffects('s6', 'error', false)
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error')
    service.handleTurnEndSideEffects('s6', undefined)
    expect(sessionStore.extractSessionOutcome(filePath)).toBe('error') // 已有终态，first wins
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-list-query.test.ts
// ======================================================================

function line(piSessionId: string, mainSid: string, createdAt: number, cwd = '/repo/a'): BtwLineRecord {
  return {
    piSessionId,
    mainSid,
    cwd,
    label: 'basename-cwd', // 旧形态：全部同名——label 重定义后不再使用该字段
    threadDir: `/root/${mainSid}/btw`,
    sessionFilePath: `/root/${mainSid}/btw/${piSessionId}.jsonl`,
    snapshotKind: 'forked',
    surface: 'btw',
    createdAt,
    pendingInteraction: false,
    contractRounds: 1,
  }
}


function summary(id: string, cwd: string, lastActiveAt: number): SessionSummary {
  return { id, label: id, cwd, status: 'idle', lastActiveAt, surface: 'sidebar' }
}


/** 侧栏分组（scanner.listPersistedSessions 的产物形态：cwd 分组 + 组内 lastActiveAt 降序） */
const SIDEBAR_GROUPS: SessionGroup[] = [
  { cwd: '/repo/a', sessions: [summary('main-a1', '/repo/a', 300), summary('main-a2', '/repo/a', 100)] },
  { cwd: '/repo/b', sessions: [summary('main-b1', '/repo/b', 200)] },
]


function makeService(lines: BtwLineRecord[], generating: ReadonlySet<string> = new Set()): SessionListQueryService {
  return new SessionListQueryService({
    listSidebarGroups: () => SIDEBAR_GROUPS.map((g) => ({ cwd: g.cwd, sessions: [...g.sessions] })),
    listBtwLines: () => lines,
    isLineGenerating: (id) => generating.has(id),
  })
}


/** SessionGroup[] → 扁平 id 清单（保序） */
function ids(groups: SessionGroup[]): string[] {
  return groups.flatMap((g) => g.sessions.map((s) => s.id))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-list-query', () => {
describe('session-list-query：{surface:"btw", mainSessionId} 过滤（验收项 12①，含负例）', () => {
  const lines = [
    line('line-a1', 'main-a1', 10),
    line('line-a2', 'main-a1', 20),
    line('line-b1', 'main-b1', 15),
  ]

  it('只返回该主会话名下的线，id 为线 pi 真实会话 id', () => {
    const groups = makeService(lines).list({ surface: 'btw', mainSessionId: 'main-a1' })
    expect(ids(groups)).toEqual(['line-a1', 'line-a2'])
    // 全部条目 surface 恒 'btw'（侧栏条目不得混入）
    expect(groups.every((g) => g.sessions.every((s) => s.surface === 'btw'))).toBe(true)
  })

  it('负例：传 B 主会话 id 不得返回 A 名下的线', () => {
    const groups = makeService(lines).list({ surface: 'btw', mainSessionId: 'main-b1' })
    expect(ids(groups)).toEqual(['line-b1'])
    expect(ids(groups)).not.toContain('line-a1')
    expect(ids(groups)).not.toContain('line-a2')
  })

  it('未知 mainSessionId → 空结果（不回落全量）', () => {
    expect(makeService(lines).list({ surface: 'btw', mainSessionId: 'ghost-main' })).toEqual([])
  })
})
describe('session-list-query：{surface:"sidebar"} 与侧栏口径逐条一致（验收项 12②）', () => {
  it('组序/组内序/条目对象与侧栏分组原样一致（同一 owner 派生）', () => {
    const groups = makeService([line('line-a1', 'main-a1', 10)]).list({ surface: 'sidebar' })
    expect(groups).toEqual(SIDEBAR_GROUPS)
    // 侧栏口径不含任何 btw 线条目
    expect(groups.flatMap((g) => g.sessions).some((s) => s.surface === 'btw')).toBe(false)
  })

  it('无参 = 全量：侧栏条目 + 全部线条目并存（供抽屉/调试用）', () => {
    const groups = makeService([line('line-a1', 'main-a1', 10), line('line-b1', 'main-b1', 15)]).list({})
    expect(ids(groups)).toEqual(['main-a1', 'main-a2', 'line-a1', 'line-b1', 'main-b1'])
  })

  it('{surface:"btw"} 无 mainSessionId = 全部主会话的线（全局按 createdAt 升序）', () => {
    const groups = makeService([
      line('line-a2', 'main-a1', 20),
      line('line-b1', 'main-b1', 15),
      line('line-a1', 'main-a1', 10),
    ]).list({ surface: 'btw' })
    expect(ids(groups)).toEqual(['line-a1', 'line-b1', 'line-a2'])
  })
})
describe('session-list-query：线条目合成规则（§5-W4b 必填字段派生）', () => {
  it('label = btw-<序号>（同主会话按 createdAt 升序编号，跨主会话独立编号）+ cwd/status/lastActiveAt 派生', () => {
    const lines = [
      line('line-a2', 'main-a1', 20),
      line('line-a1', 'main-a1', 10),
      line('line-b1', 'main-b1', 15),
    ]
    const groups = makeService(lines).list({ surface: 'btw' })
    const entries = groups.flatMap((g) => g.sessions)
    // 全局按 createdAt 升序（10 → 15 → 20）；序号按**所属主会话内**创建次序独立编号
    expect(entries.map((s) => [s.id, s.label])).toEqual([
      ['line-a1', 'btw-1'],
      ['line-b1', 'btw-1'],
      ['line-a2', 'btw-2'],
    ])
    // cwd = 线 cwd（= 所属主会话 cwd）；lastActiveAt = 线 createdAt；sessionFile 透传
    const a1 = entries.find((s) => s.id === 'line-a1')
    expect(a1).toMatchObject({
      cwd: '/repo/a',
      status: 'idle',
      lastActiveAt: 10,
      surface: 'btw',
      sessionFile: '/root/main-a1/btw/line-a1.jsonl',
    })
  })

  it('status 派生：lifecycle 记录 isGenerating → active（不伪造、不恒 idle）', () => {
    const groups = makeService(
      [line('line-a1', 'main-a1', 10), line('line-a2', 'main-a1', 20)],
      new Set(['line-a2']),
    ).list({ surface: 'btw', mainSessionId: 'main-a1' })
    expect(groups[0]?.sessions.map((s) => [s.id, s.status])).toEqual([
      ['line-a1', 'idle'],
      ['line-a2', 'active'],
    ])
  })

  it('组内次序：侧栏条目在前 + 线条目按 createdAt 升序追加（flatten 后最新线在末位）', () => {
    const groups = makeService([
      line('line-a2', 'main-a1', 20),
      line('line-a1', 'main-a1', 10),
    ]).list({})
    const groupA = groups.find((g) => g.cwd === '/repo/a')
    expect(groupA?.sessions.map((s) => s.id)).toEqual(['main-a1', 'main-a2', 'line-a1', 'line-a2'])
  })
})
});
