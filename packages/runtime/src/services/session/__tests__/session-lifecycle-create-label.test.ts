/**
 * SessionLifecycle.create 的 label 持久化分流测试（A' 修正，2026-08-24）。
 *
 * 背景：W1（9dcffa736，v0.9.3 起）把前端 createSessionFlow 派生的 prompt 预览名
 * （首条 prompt 前 10 码点）误当显式名经 set_session_name RPC 持久化到 pi
 * session_info，踩死 pi-rename-session 防覆盖守卫（getSessionName() 非空即 skip）
 * → auto-rename 全量失效。A' 修正：仅语义性命名（options.persistLabel=true：
 * handoff 承接名 / agent-managed 显式命名）持久化；派生预览名 display-only。
 *
 * Mock 策略沿用 session-lifecycle-rename-inactive.test.ts 的 makeEnv 形态：
 * svc/pm/configStore/sessionStore/workspaceService 全 mock，直接 new
 * SessionLifecycle 跑真实 create 编排。锁定契约：
 * - 默认（无 persistLabel）→ setSessionName 不被调，预览名只进内存 label（display）
 * - persistLabel=true → setSessionName(label) 被调（语义性命名持久化）
 * - persistLabel=true 但 label undefined → no-op
 * - setSessionName RPC reject → 不阻断 create（best-effort 降级，W1 语义保留）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-create-label.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

/** 构造最小 create 环境：pi client 只需 getState/setSessionName，svc mock 全链路。 */
function makeCreateEnv() {
  const setSessionName = vi.fn(async (_name: string) => ({ success: true }))
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'pi-sid-1', sessionFile: '/tmp/s.jsonl' })),
    setSessionName,
  }
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  // S2 ISP 化：结构性满足 lifecycle 窄接口，无强转；getExtensionPaths 改 async /
  // toSummary 补必填字段系消强转后暴露的形状修复。S3 写点归位：注册走真
  // registerSession（svc.initializeManagedSession 已从接口移除）。
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    toSummary: vi.fn(() => ({
      id: 'pi-sid-1', label: 'L', cwd: '/w', status: 'active' as const,
      lastActiveAt: 1, modelId: 'prov/model', tokenCount: 0,
    })),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }

  const configStore = { getDefaultModel: vi.fn(() => 'prov/model') } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
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

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, setSessionName }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionLifecycle.create label 持久化分流（A\'）', () => {
  it('A\' 核心：默认（前端派生预览名）不调 setSessionName，预览名只进内存 label（display-only）', async () => {
    const { lifecycle, setSessionName } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-create-'))

    await lifecycle.create(cwd, '修复登录bu…')

    // 持久化零调用——pi 内存 sessionName 保持空，auto-rename 防覆盖守卫照常通过
    expect(setSessionName).not.toHaveBeenCalled()
    // display 不回归：内存 session.label 仍是预览名（侧栏当前会话显示不变）。
    // S3 迁移：断言观察点从 svc.initializeManagedSession 传参随迁为真 registerSession
    // 的注册结果（Map 记录字段），断言语义不变。
    const session = lifecycle.get('pi-sid-1')
    expect(session?.label).toBe('修复登录bu…')
    expect(session?.cwd).toBe(cwd)
    expect(session?.sessionFilePath).toBe('/tmp/s.jsonl')
  })

  it('persistLabel=true（handoff/agent-managed 语义名）→ setSessionName(label) 恰调一次', async () => {
    const { lifecycle, setSessionName } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-persist-'))

    await lifecycle.create(cwd, 'handoff from src', { persistLabel: true })

    expect(setSessionName).toHaveBeenCalledTimes(1)
    expect(setSessionName).toHaveBeenCalledWith('handoff from src')
  })

  it('persistLabel=true 但 label undefined → no-op（agent 未传 label 的 managed session）', async () => {
    const { lifecycle, setSessionName } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-nolabel-'))

    await lifecycle.create(cwd, undefined, { persistLabel: true })

    expect(setSessionName).not.toHaveBeenCalled()
  })

  it('setSessionName RPC reject → 不阻断 create（best-effort 降级，label 留内存显示）', async () => {
    const { lifecycle, setSessionName } = makeCreateEnv()
    setSessionName.mockRejectedValueOnce(new Error('rpc down'))
    const cwd = mkdtempSync(join(tmpdir(), 'aprime-rpcfail-'))

    const summary = await lifecycle.create(cwd, 'handoff from src', { persistLabel: true })

    expect(setSessionName).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ id: 'pi-sid-1' })
  })
})
