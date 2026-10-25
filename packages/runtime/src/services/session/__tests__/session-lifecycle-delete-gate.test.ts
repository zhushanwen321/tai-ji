/**
 * SessionLifecycle.delete 生成中拒绝门单测（U8，design-session-lifecycle 缺陷 3）。
 *
 * 锁定：
 * - 活跃会话 turn ∈ {dispatching, generating}（isGenerating=true）→ delete reject，
 *   error.code = 'delete_generating'，消息可操作（指向「先停止生成」）；杀进程前置动作
 *   零执行（detach / destroySession 不被调）。
 * - settling 不在门口径（isGenerating=false）：delete 正常放行（settling 定稿 entry 已
 *   落盘，杀 pi 无内容损失——与归档门口径一字不差）。
 * - 非活跃（scanned）会话：门短路放行，正常删除（deleteByCwd 逐个转调 delete，被门会话
 *   抛错进 failed 数组由既有 catch 承接，批删语义自洽——不另测批删）。
 * - deleteByCwd 聚合（delete-generating-error-localization）：门拒绝会话的 code 透传进
 *   failed[] 条目（renderer 据此查本地化词条），可删会话照常进 deleted。
 *
 * Mock 策略沿用 session-lifecycle-rename-inactive.test.ts / session-artifact-cascade.test.ts
 * 的 makeEnv 形态（svc/pm/sessionStore 全 mock，直接 new SessionLifecycle；活跃记录经真
 * registerSession 造，isGenerating 经 occupancy 原语驱动——唯一写点，不直写字段）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-delete-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLifecycle } from '../session-lifecycle.js'
import { applySessionOccupancyTransition } from '../event-interpreter.js'
import type { IManagedSessionRecord } from '../session-internal.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { ScannedSession } from '../types.js'
import type { SessionSummary } from '@taiji/shared'

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
