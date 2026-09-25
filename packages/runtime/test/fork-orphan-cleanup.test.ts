/**
 * W1 / L5: fork createSession/switchSession/initializeManagedSession 失败后清理孤儿 fork 文件。
 *
 * 背景：forkSession 先 createForkedSessionFile 写出新 JSONL，再 spawn pi 进程切到该文件。
 * 若后续 switchSession 或 initializeManagedSession 失败，原实现只销毁 pi 进程，
 * 不删 fork 文件 → 孤儿文件留在 sessions 目录，污染下次 scanPiSessions 列表。
 *
 * 修复：两个 catch 块各加 unlink(forkedFilePath).catch(() => {})。
 *
 * Mock 策略：createForkedSessionFile / unlink 经 vi.mock 注入 spy；
 * switchSession 或 initializeManagedSession reject 触发 catch 块。
 *
 * 运行：cd packages/runtime && npx vitest run test/fork-orphan-cleanup.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'

// node:fs: existsSync 控制 create 路径守卫（fork 用 source.cwd 判断）
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync,
  readdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  // B7: session-lifecycle 直读/写 JSONL（stripSessionEnd 已删），需 mock 这些同步 fs 操作
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// node:fs/promises: unlink 是本次修复的核心观察对象
const fsPromisesMock = vi.hoisted(() => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('node:fs/promises', () => ({
  unlink: fsPromisesMock.unlink,
}))

// createForkedSessionFile: spy，返回固定 forkedFilePath / forkedId
const forkMock = vi.hoisted(() => ({
  forkedFilePath: '/fake/sessions/forked.jsonl',
  forkedId: 'forked-session-id',
  createForkedSessionFile: vi.fn(async () => ({
    filePath: '/fake/sessions/forked.jsonl',
    sessionId: 'forked-session-id',
  })),
}))
vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: forkMock.createForkedSessionFile,
}))

import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@taiji/shared'

function makeClient(overrides: Partial<IPiEngine> = {}): IPiEngine {
  // [W2 语义变更] mock getState 的 sessionFile 跟随最近一次 switchSession 实参——真实 pi
  // 行为（switch_session 后 get_state.sessionFile 即写目标，ADR-0063 I1）；未 switch 过时
  // 保持原固定值。session-lifecycle 的 attach 断言依赖该语义（原固定假路径会被判 I1 分裂）。
  let lastSwitchTarget: string | undefined
  return {
    getState: vi.fn(async () => ({ sessionId: 'pi-x', sessionFile: lastSwitchTarget ?? '/fake/x.jsonl' })),
    switchSession: vi.fn(async (p: string) => { lastSwitchTarget = p }),
    prompt: vi.fn(async () => ({})),
    setModel: vi.fn(async () => {}),
    getCommands: vi.fn(async () => []),
    getSessionStats: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as IPiEngine
}

interface MakeOpts {
  /** switchSession 抛错（触发第一个 catch 块） */
  switchFails?: boolean
  /** registerSession 抛错（触发第二个 catch 块；S3 迁移后经 adapterFactory 抛错注入） */
  initFails?: boolean
}

function makeLifecycle(opts: MakeOpts = {}) {
  const client = makeClient(
    opts.switchFails
      ? { switchSession: vi.fn(async () => { throw new Error('switch_session failed') }) }
      : {},
  )

  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn(),
    hasClient: vi.fn(),
    rekey: vi.fn(),
  } as unknown as IProcessManager

  const session: IManagedSessionView = {
    id: forkMock.forkedId, cwd: '/repo', label: 'fork', modelId: 'p/m',
    createdAt: 1, lastActiveAt: 1, tokenCount: 0, inputTokens: 0, isGenerating: false, isCompacting: false, isBashRunning: false, bashRunToken: undefined,
  }

  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    // forkSession 调 getLaunchPresetOptions 解析 preset（session-lifecycle L373）。
    // 返回 undefined = 走 fallback（getExtensionPaths/getSkillPaths），不影响 fork 清理逻辑。
    getLaunchPresetOptions: vi.fn(async () => undefined),
    findScannedSession: vi.fn(() => ({
      id: 'src', filePath: '/fake/src.jsonl', cwd: tmpdir(), name: 'src',
      lastModified: 1, timestamp: '', size: 0, outcome: null,
    })),
    // FR-20: forkSession 读源 active session 的 sessionFilePath 判断 parentSession fallback。
    // 源未注册进 Map（未活跃 / 已落盘），走 source.filePath 主路径。
    toSummary: vi.fn((): SessionSummary => ({
      id: session.id, cwd: session.cwd, label: session.label, status: 'idle',
      lastActiveAt: 1, tokenCount: 0, modelId: 'p/m',
    })),
    fetchAndBroadcastContext: vi.fn(async () => {}),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = {
    refreshAll: vi.fn(),
    // W26（D9-1）：fork 成功/失败清理路径新增目录 TTL 缓存失效调用点（ISessionStore 接口新成员）
    invalidateScanCache: vi.fn(),
    // forkSession/create 调 persistPresetBinding 写 .preset.json sidecar（session-lifecycle L170/L411）。
    // fork 清理测试不验证 sidecar 内容，noop 即可。
    persistPresetBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory；initFails 语义 = adapterFactory 抛错（原 stub
  // initializeManagedSession reject 的等价注入点，触发 registerSession reject → 第二个 catch 块）。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => {
      if (opts.initFails) throw new Error('init failed')
      return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
    },
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, pm, svc }
}

describe('W1/L5: forkSession 失败后清理孤儿 fork 文件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.existsSync.mockReturnValue(true)
    forkMock.createForkedSessionFile.mockResolvedValue({
      filePath: forkMock.forkedFilePath,
      sessionId: forkMock.forkedId,
    })
  })

  it('switchSession 失败 → unlink forkedFilePath（清孤儿文件）', async () => {
    const { lifecycle } = makeLifecycle({ switchFails: true })
    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('switch_session failed')

    expect(fsPromisesMock.unlink).toHaveBeenCalledWith(forkMock.forkedFilePath)
  })

  it('registerSession 失败 → unlink forkedFilePath（清孤儿文件）', async () => {
    const { lifecycle } = makeLifecycle({ initFails: true })
    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('init failed')

    expect(fsPromisesMock.unlink).toHaveBeenCalledWith(forkMock.forkedFilePath)
  })

  it('unlink 自身失败不掩盖原始错误（catch 块静默吞 unlink 错误）', async () => {
    // unlink reject → 应被 .catch(() => {}) 吞掉，原始 init failed 错误仍正确抛出
    fsPromisesMock.unlink.mockRejectedValueOnce(new Error('unlink boom'))
    const { lifecycle } = makeLifecycle({ initFails: true })

    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('init failed')
  })
})
