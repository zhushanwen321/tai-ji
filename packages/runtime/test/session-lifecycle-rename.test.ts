/**
 * session-lifecycle-rename.test.ts — W1（数据源治理 P0）label 链路切 pi RPC 验收测试。
 *
 * 背景：活跃 session 的 label 曾由 taiji runtime 直写 pi session JSONL（persistSessionName），
 * 与 pi 进程内 rename-session 扩展的 auto-rename 互不知情，last-write-wins 导致
 * 「用户手动命名的 session 被 auto-rename 静默覆盖」。W1 后活跃 label 的唯一写入口 =
 * pi set_session_name RPC；turn_end/agent_end 的 label 兜底直写机制（含字段标记）整体删除。
 *
 * 四断言组（w1-acceptance「单测验收」）：
 *   1. 活跃 rename 走 RPC：setSessionName 被调 + 不再直写 persistSessionName；
 *      client 不可用（pi 崩溃窗口）/ RPC 失败必须 throw（禁静默丢写）
 *   2. create / forkSession 显式 label 走 RPC（失败不阻断创建）
 *   3. 派生 label（basename(cwd)）不触发 RPC（退役为显示派生，auto-rename 守卫照常通过）
 *   4. 非活跃 rename 经短命 pi（W11：withEphemeralPi 附着 + set_session_name RPC，
 *      persistSessionName 直写已删——绝对写规则全线生效）
 *
 * Mock 边界与 contract-hardening.test.ts 同款：svc/pm/configStore/sessionStore 注入 mock，
 * session-fork 模块 mock（返回受控产物指向真实 tmp 文件）；fs 相关 fixture 用真实 tmp。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-rename.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

// fork 用例 mock 截断函数（真实 createForkedSessionFile 操作 sessions 数据目录，
// 单测无该基建；返回受控 filePath 指向真实 tmp 文件供后续 strip/switch 流程使用）
vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: vi.fn(async () => ({ filePath: '', sessionId: 'fork-1' })),
}))

import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { SessionSummary } from '@taiji/shared'

// ── Mock 协作者 ────────────────────────────────────────────────────

/** lifecycle 实际消费的最小 client 形状（create 用 getState / fork 用 switchSession / 共用 setSessionName）。 */
interface MockClient {
  getState: MockInstance<() => Promise<Record<string, unknown> | undefined>>
  switchSession: MockInstance<(sessionPath: string) => Promise<void>>
  setSessionName: MockInstance<(name: string) => Promise<unknown>>
}

function makeClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
    switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockResolvedValue(undefined),
    setSessionName: vi.fn<(name: string) => Promise<unknown>>().mockResolvedValue(undefined),
    ...overrides,
  }
}

/** 完整 IManagedSessionView 字面量（renameSession 会原地改 label，需真实对象）。 */
function makeSessionView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 'sid-1',
    cwd: '/repo',
    label: '旧名',
    modelId: 'p/m',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    ...overrides,
  }
}

/** 测试装置：lifecycle + 各 mock 依赖 + 可手动挂载的 session/client Map。 */
function makeEnv() {
  // pm.getClient 的数据源（renameSession 活跃分支经 pm.getClient 查 client）
  const clientMap = new Map<string, MockClient>()
  // withEphemeralPi mock 交给 fn 的受控 client（断言组 4 断言其 RPC 调用）
  const ephemeralClient = makeClient()

  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1, modelId: 'p/m', tokenCount: 0,
    })),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => {}),
    notifySessionCreated: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }

  const pm = {
    createSession: vi.fn(async (id: string) => {
      const client = makeClient()
      clientMap.set(id, client)
      return client
    }),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn(() => undefined),
    hasClient: vi.fn(() => false),
    rekey: vi.fn((oldId: string, newId: string) => {
      const c = clientMap.get(oldId)
      if (c) { clientMap.delete(oldId); clientMap.set(newId, c) }
    }),
    onSessionExit: vi.fn(() => {}),
    destroyAll: vi.fn(async () => {}),
    // W11：短命 pi 附着 mock——以受控 ephemeral client 执行 fn（可断言 RPC 调用）
    withEphemeralPi: vi.fn(async <T,>(_sessionFile: string, fn: (c: IPiEngine) => Promise<T>) =>
      fn(ephemeralClient as unknown as IPiEngine)),
  } as unknown as IProcessManager

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
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

  return {
    lifecycle, svc, pm, sessionStore, clientMap, ephemeralClient,
    /**
     * 手动挂载活跃 session + client（rename 用例直入活跃分支）。
     * S3 迁移：挂载从 svc.getSession stub 数据源随迁为真 registerSession（Map 所有者），
     * 返回注册记录供用例持有——renameSession 的内存 label 写发生在该对象上。
     */
    mountActive: async (id: string, client: MockClient, label = '旧名') => {
      clientMap.set(id, client)
      return lifecycle.registerSession(id, client as unknown as IPiEngine, '/repo', label)
    },
  }
}

type Env = ReturnType<typeof makeEnv>

// ── Tests ─────────────────────────────────────────────────────────

describe('SessionLifecycle · W1 label 链路切 pi set_session_name RPC', () => {
  let env: Env
  let tmpDir: string
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    env = makeEnv()
    tmpDir = mkdtempSync(join(tmpdir(), 'w1-rename-'))
    // RPC 降级路径的 console.error 静音（防噪 + 可断言）
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    setMigrationGate(Promise.resolve())
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── 断言组 1：活跃 rename 走 RPC ─────────────────────────────────
  describe('断言组 1：活跃 session rename → set_session_name RPC（不直写）', () => {
    it('活跃 rename 调 client.setSessionName(newName)，不再调 persistSessionName', async () => {
      const client = makeClient()
      const session = await env.mountActive('sid-1', client, '旧名')

      await env.lifecycle.renameSession('sid-1', '重构计划')

      expect(client.setSessionName).toHaveBeenCalledTimes(1)
      expect(client.setSessionName).toHaveBeenCalledWith('重构计划')
      // 直写路径已随 W11 全删（persistSessionName 不存在），回归守卫由 R1 承担
      // 内存 label 更新（label 只有内存态一份数据——label 实例已撤销，PR #185 MF1）
      expect(session.label).toBe('重构计划')
      // 列表缓存失效仍触发（侧栏立即显示新名）
      expect(env.sessionStore.invalidateScanCache).toHaveBeenCalled()
      expect(env.sessionStore.refreshAll).toHaveBeenCalled()
    })

    it('pi client 不可用（崩溃窗口）→ throw，不静默丢写、内存保留旧名', async () => {
      // S3 迁移：真 registerSession 注册（不挂 client：pm.getClient 返回 undefined）
      const session = await env.lifecycle.registerSession('sid-2', {} as unknown as IPiEngine, '/repo', '旧名')

      await expect(env.lifecycle.renameSession('sid-2', '新名')).rejects.toThrow('pi process is not available')

      // 先 RPC 后改内存：失败时旧名保留可重试
      expect(session.label).toBe('旧名')
    })

    it('RPC 失败（success:false / 超时 reject）→ throw 给上层 toast，内存保留旧名', async () => {
      const client = makeClient({
        setSessionName: vi.fn<(name: string) => Promise<unknown>>()
          .mockRejectedValue(new Error('RPC command "set_session_name" failed')),
      })
      const session = await env.mountActive('sid-3', client, '旧名')

      await expect(env.lifecycle.renameSession('sid-3', '新名')).rejects.toThrow('set_session_name')

      expect(session.label).toBe('旧名')
    })
  })

  // ── 断言组 2：create / fork 语义性 label 走 RPC（A' 分流）────────────
  describe('断言组 2：create / forkSession 语义性 label → set_session_name RPC（A\'）', () => {
    it("create(派生预览名，默认无 persistLabel) → setSessionName 不被调（A' display-only，防覆盖守卫恢复）", async () => {
      const client = makeClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>()
          .mockResolvedValue({ sessionId: 'pi-1', sessionFile: join(tmpDir, 'pi-1.jsonl') }),
      })
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.create(tmpDir, '修复登录bu…')

      // A'（2026-08-24）：前端派生预览名不持久化——pi 内存 sessionName 保持空，
      // pi-rename-session 防覆盖守卫照常通过（W1 曾持久化预览名致 auto-rename 全量失效）
      expect(client.setSessionName).not.toHaveBeenCalled()
    })

    it('create(语义性 label + persistLabel=true) → client 就绪后调 setSessionName(label)', async () => {
      const client = makeClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>()
          .mockResolvedValue({ sessionId: 'pi-1', sessionFile: join(tmpDir, 'pi-1.jsonl') }),
      })
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.create(tmpDir, 'handoff from src', { persistLabel: true })

      expect(client.setSessionName).toHaveBeenCalledTimes(1)
      expect(client.setSessionName).toHaveBeenCalledWith('handoff from src')
    })

    it('create 语义性 label 的 RPC 失败不阻断 create（summary 正常返回 + console.error 上报）', async () => {
      const client = makeClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>()
          .mockResolvedValue({ sessionId: 'pi-2', sessionFile: join(tmpDir, 'pi-2.jsonl') }),
        setSessionName: vi.fn<(name: string) => Promise<unknown>>()
          .mockRejectedValue(new Error('RPC command "set_session_name" timed out')),
      })
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      const summary = await env.lifecycle.create(tmpDir, 'handoff from src', { persistLabel: true })

      // 不阻断：session 正常创建，label 留内存显示
      expect(summary.id).toBe('pi-2')
      expect(summary.label).toBe('handoff from src')
      // 上报失败（恢复动作 = 手动 rename 重试）
      expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('forkSession(显式 label) → switchSession 成功后调 setSessionName(label)', async () => {
      const sourceFile = join(tmpDir, 'src.jsonl')
      writeFileSync(sourceFile, '{"type":"session","id":"src-1"}\n')
      const forkedFile = join(tmpDir, 'fork-1.jsonl')
      writeFileSync(forkedFile, '{"type":"session","id":"fork-1"}\n')

      vi.mocked(env.svc.findScannedSession).mockReturnValue({
        id: 'src-1', filePath: sourceFile, cwd: tmpDir, name: 'src',
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      const { createForkedSessionFile } = await import('../src/services/session/session-fork.js')
      vi.mocked(createForkedSessionFile).mockResolvedValue({ filePath: forkedFile, sessionId: 'fork-1', sourceFilePath: sourceFile })

      const client = makeClient()
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.forkSession('src-1', 'e1', true, 'fork 显式名')

      expect(client.setSessionName).toHaveBeenCalledTimes(1)
      expect(client.setSessionName).toHaveBeenCalledWith('fork 显式名')
    })
  })

  // ── 断言组 3：派生 label 不触发 RPC ──────────────────────────────
  describe('断言组 3：派生 label（basename(cwd)）不触发 RPC、不持久化', () => {
    it('create 不传 label → 显示用 basename(cwd)，不调 setSessionName、不直写', async () => {
      const client = makeClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>()
          .mockResolvedValue({ sessionId: 'pi-3', sessionFile: join(tmpDir, 'pi-3.jsonl') }),
      })
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.create(tmpDir)

      // 派生值仅作显示（registerSession 把 basename 落进内存 session.label），不进任何持久化路径。
      // S3 迁移：断言观察点从 svc.initializeManagedSession 传参随迁为真 registerSession 的
      // 注册结果（Map 记录字段），断言语义不变。
      const session = env.lifecycle.get('pi-3')
      expect(session?.cwd).toBe(tmpDir)
      expect(session?.label).toBe(basename(tmpDir))
      expect(session?.sessionFilePath).toBe(join(tmpDir, 'pi-3.jsonl'))
      expect(client.setSessionName).not.toHaveBeenCalled()
    })

    it('forkSession 不传 label → 同样不调 setSessionName', async () => {
      const sourceFile = join(tmpDir, 'src2.jsonl')
      writeFileSync(sourceFile, '{"type":"session","id":"src-2"}\n')
      const forkedFile = join(tmpDir, 'fork-2.jsonl')
      writeFileSync(forkedFile, '{"type":"session","id":"fork-2"}\n')

      vi.mocked(env.svc.findScannedSession).mockReturnValue({
        id: 'src-2', filePath: sourceFile, cwd: tmpDir, name: 'src',
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      const { createForkedSessionFile } = await import('../src/services/session/session-fork.js')
      vi.mocked(createForkedSessionFile).mockResolvedValue({ filePath: forkedFile, sessionId: 'fork-2', sourceFilePath: sourceFile })

      const client = makeClient()
      vi.mocked(env.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

      await env.lifecycle.forkSession('src-2', 'e1', true)

      expect(client.setSessionName).not.toHaveBeenCalled()
    })
  })

  // ── 断言组 4：非活跃分支切短命 pi（W11）───────────────────────────
  describe('断言组 4：非活跃 rename → withEphemeralPi 附着 + set_session_name RPC（W11）', () => {
    it('非活跃 rename → withEphemeralPi(filePath, fn)，fn 内 setSessionName(newName)', async () => {
      const file = join(tmpDir, 'inactive.jsonl')
      writeFileSync(file, '{"type":"session","id":"scan-1"}\n')
      vi.mocked(env.svc.findScannedSession).mockReturnValue({
        id: 'scan-1', filePath: file, cwd: tmpDir, name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })

      await env.lifecycle.renameSession('scan-1', '短命 pi 改名')

      // 附着目标文件（短命 pi spawn → switchSession(file) → RPC → kill 由 pm 负责）
      expect(env.pm.withEphemeralPi).toHaveBeenCalledTimes(1)
      expect(env.pm.withEphemeralPi).toHaveBeenCalledWith(file, expect.any(Function))
      // fn 内经附着的 client 调 set_session_name（session JSONL 由 pi 写）
      expect(env.ephemeralClient.setSessionName).toHaveBeenCalledTimes(1)
      expect(env.ephemeralClient.setSessionName).toHaveBeenCalledWith('短命 pi 改名')
      expect(env.sessionStore.invalidateScanCache).toHaveBeenCalled()
      expect(env.sessionStore.refreshAll).toHaveBeenCalled()
    })

    it('withEphemeralPi 失败（spawn 失败 / 附着超时 / RPC 失败）→ throw，可重试', async () => {
      vi.mocked(env.svc.findScannedSession).mockReturnValue({
        id: 'scan-err', filePath: join(tmpDir, 'missing.jsonl'), cwd: tmpDir, name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      vi.mocked(env.pm.withEphemeralPi).mockRejectedValueOnce(
        new Error('Ephemeral pi attach timed out after 5000ms'))

      await expect(env.lifecycle.renameSession('scan-err', '新名'))
        .rejects.toThrow('Ephemeral pi attach timed out')
      // 失败不触发列表失效（无变更）
      expect(env.sessionStore.invalidateScanCache).not.toHaveBeenCalled()
    })

    it('扫描目标不存在 → throw 含 sessionId 与恢复指引，不附着（p1p4-closure W1 D3：旧静默 no-op 已判缺陷移除）', async () => {
      vi.mocked(env.svc.findScannedSession).mockReturnValue(undefined)

      await expect(env.lifecycle.renameSession('ghost', '新名'))
        .rejects.toThrow(/ghost/)
      await expect(env.lifecycle.renameSession('ghost', '新名'))
        .rejects.toThrow(/refresh the sidebar/)
      expect(env.pm.withEphemeralPi).not.toHaveBeenCalled()
    })
  })
})
