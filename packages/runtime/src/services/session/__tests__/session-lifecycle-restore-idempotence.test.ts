/**
 * restoreSession D5② 幂等短路直接测试（review round1 SUGGESTION「短路无直接测试」）。
 *
 * 语义源：session-lifecycle.ts restoreSession 开头的 reuseRestoreSessionSummary——
 * client 已活跃（exists && !exited）+ sessions Map 有条目时，二次 restore 直接返回现有
 * summary，不清场、不杀旧 pi（K3 撞车事故回归锚：restore #2 曾杀掉 restore #1 刚拉起的
 * pi，exit 143 幽灵）。旧 session-pool-restoresession.test.ts 的「二次 restore 清场重开」
 * 用例已被该新语义取代，但新语义此前无直接测试承接。
 *
 * 装置：kill-path-logging.test.ts K3 harness 同款（全协作者 mock，唯一真实 fs = mkdtemp
 * tmp 里的 session 文件，fs-guard 白名单）；与 K3 的关键差异 = pm.getClient 返回活跃
 * client（K3 返回 undefined 走全流程清场，本文件走短路及其两个否定边界）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-restore-idempotence.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})

// 模块 mock 声明完毕后再 import 被测对象
import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js'
import { parseSessionHeader } from '../../../infra/pi/session-file-utils.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { ScannedSession } from '../types.js'
import type { SessionSummary } from '@xyz-agent/shared'

const SID = 'sess-restore-idempotent'
const currentSourceFile = vi.hoisted(() => ({ value: '' }))

type WarnSpy = ReturnType<typeof vi.spyOn>

/** K3 harness 同款：全 svc 面 mock + pm.getClient 恒返回活跃 client（短路判定的命中前提）。 */
function makeRestoreEnv() {
  const activeClient = {
    exited: false,
    getState: vi.fn(async () => ({ sessionId: SID })),
    switchSession: vi.fn(async (_sessionPath: string) => {}),
    setSessionName: vi.fn(async () => undefined),
  }
  // notifyCreated 提取引用（接口类型抹掉 vi.fn 方法面，断言面直接用原 mock）
  const notifyCreated = vi.fn()
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: { id: string; label: string; cwd: string }): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1, modelId: 'p/m', tokenCount: 0,
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
    notifyMessageComplete: () => {},
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

describe('restoreSession D5② 幂等短路', () => {
  let warnSpy: WarnSpy
  let dir: string

  beforeEach(() => {
    setMigrationGate(Promise.resolve())
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = mkdtempSync(join(tmpdir(), 'restore-idempotence-'))
    const filePath = join(dir, `2026-09-15T00-00-00-000Z_${SID}.jsonl`)
    currentSourceFile.value = filePath
    sessionsDirMock.value = dir
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', version: 3, id: SID, timestamp: '2026-09-15T00:00:00.000Z', cwd: dir }),
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
    const first = await lifecycle.restoreSession(SID)
    expect(first.id).toBe(SID)
    expect(pm.createSession).toHaveBeenCalledTimes(1)
    expect(notifyCreated).toHaveBeenCalledTimes(1)

    warnSpy.mockClear()
    notifyCreated.mockClear()

    // #2：client 活跃 + Map 有条目 → 短路，零副作用
    const second = await lifecycle.restoreSession(SID)

    expect(second).toEqual(first) // 返回现有 summary（同一注册记录的投影）
    expect(pm.createSession).toHaveBeenCalledTimes(1) // 未重开进程
    expect(pm.destroySession).not.toHaveBeenCalled() // 未杀旧 pi（K3 撞车回归锚）
    expect(svc.removeSessionEntry).not.toHaveBeenCalled() // 未摘 Map 条目
    expect(notifyCreated).not.toHaveBeenCalled() // 未重复通知
    // 短路命中不产生 kill 日志（错误规格 §3.4；与 kill-path-logging K3 互为正反例）
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain('kill_source=restore_clear')
  })

  it('client 已退出（exited=true）：不短路，走清场重开（D5① K3 路径保持）', async () => {
    const { lifecycle, pm, svc } = makeRestoreEnv()

    await lifecycle.restoreSession(SID) // #1 全流程注册
    pm.getClient.mockReturnValue({ exited: true }) // 旧 pi 已死

    await lifecycle.restoreSession(SID)

    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).some((l: string) => l.includes('kill_source=restore_clear'))).toBe(true)
    expect(pm.destroySession).toHaveBeenCalledWith(SID) // 旧 pi 被清场
    expect(pm.createSession).toHaveBeenCalledTimes(2) // 重开
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(2) // 两次全流程各通知一次
  })

  it('client 活跃但 Map 无条目（registerSession 未完成的半截态）：不短路，走全流程重开', async () => {
    const { lifecycle, pm, svc } = makeRestoreEnv()

    // 首次调用即满足「client 活跃」但 Map 尚无条目 → 短路判定必须放行走全流程
    const summary = await lifecycle.restoreSession(SID)

    expect(summary.id).toBe(SID)
    expect(pm.createSession).toHaveBeenCalledTimes(1) // 全流程 spawn 发生
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
  })
})
