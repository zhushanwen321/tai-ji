/**
 * pi 会话启动门禁测试（settings.json 损坏 fail-fast，用户终裁 2026-10-05）。
 *
 * 裁决：settings.json 是 taiji/pi/用户三方共享的核心配置，损坏就不应该能启动 pi——
 * ProcessManager.createSession（pi 进程 spawn 唯一入口）顶部经 getSettingsCorruption()
 * 现查，命中即拒绝且零副作用（进程未 spawn、旧进程不动）。
 *
 * 锁定语义：
 * - 形态①：原路径存在但 JSON 非法 → createSession rejects（code='settings_corrupted'，
 *   消息含文件绝对路径 + 修复指引「修复或删除后重试、无需重启」）+ spawn 未调用。
 * - 现查：同一 ProcessManager 实例内损坏先拒、文件修复后放行（无缓存，无需重启）。
 * - 形态②：原路径缺失但存在 `.corrupt-*` 隔离副本 → 拒绝且消息含副本路径。
 * - withEphemeralPi（短命 pi）同门禁（复用 createSession 单点）。
 * - 恢复链路同门禁：SessionLifecycle.restoreSession（session.restore RPC /
 *   崩溃自动重生 / 惰性恢复 ensureActive 的共同内核）→ spawnRestoreClient →
 *   createSession，损坏时在 spawn 前被拒。
 *
 * Mock 策略：与 process-manager-pi-path-reset.test.ts 同构（mock child_process/fs 周边，
 * 真实 RpcClient 跑在 fakeProc 上）；child_process.spawn 为 vi.fn 以断言「pi 进程未 spawn」；
 * relay-env mock 掉（其首次调用含探针 spawn，会污染 spawn 计数）；settings 路径经
 * setSettingsPath 重定向到 tmp（pi-settings-store 既有测试惯例）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/process-manager-settings-corruption-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProcessManager } from '../infra/pi/process-manager.js'
import { invalidateSettingsCache, setSettingsPath } from '../infra/pi/pi-settings-store.js'
import { SessionLifecycle } from '../services/session/session-lifecycle.js'
import { SETTINGS_CORRUPTED } from '../utils/errors.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../services/session/session-internal.js'
import type { IProcessManager, IPiEngine } from '../services/ports/pi-engine.js'
import type { IConfigStore } from '../services/ports/config.js'
import type { ISessionStore } from '../services/ports/session.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { IEventAdapter } from '../interfaces.js'
import type { IManagedSessionView, ScannedSession } from '../services/session/types.js'
import type { SessionSummary } from '@taiji/shared'

// ── Mocks（process-manager-pi-path-reset.test.ts 同构）──────────────

const procExitHandlers: Array<(code: number | null) => void> = []

/**
 * fakeProc + spawnMock 同块 hoisted（vi.hoisted 回调先于模块顶层语句执行，
 * 交叉引用必须同块内闭环）：spawn 计数锚 = 损坏时必须为 0（「pi 进程未被 spawn」）。
 */
const { fakeProc, spawnMock } = vi.hoisted(() => {
  const proc = {
    exitCode: null as number | null,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
      return proc
    }),
    off: vi.fn(),
    removeListener: vi.fn(),
    once: vi.fn(),
    stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: {
      write: vi.fn(() => true),
      once: vi.fn(),
      on: vi.fn(), // rpc-client 在源头接线 stdin 流错误（stdin.on('error')）
    },
    kill: vi.fn(() => true),
    pid: 12345,
  }
  const spawn = vi.fn(() => proc)
  return { fakeProc: proc, spawnMock: spawn }
})

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execSync: () => {
    throw new Error('execSync mocked: not found')
  },
}))

vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

// relay 探针 spawn 排除：getRelaySpawnEnv 首次调用含探针 spawn，会污染 spawnMock 计数。
vi.mock('../infra/relay/relay-env.js', () => ({ getRelaySpawnEnv: async () => ({}) }))

vi.mock('../infra/pi/find-pi-executable.js', () => ({ findPiExecutable: () => '/fake-tools/pi' }))

// ── fixtures ─────────────────────────────────────────────────────

let dir: string
let settingsPath: string
let pm: ProcessManager

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-settings-gate-'))
  settingsPath = join(dir, 'settings.json')
  setSettingsPath(settingsPath)
  spawnMock.mockClear()
  pm = new ProcessManager('/mock/project')
})

afterEach(async () => {
  await pm.destroyAll()
  invalidateSettingsCache()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})


// ── 1. 形态①：非法 JSON → 拒绝 + spawn 未调用 + 信封三要素 ─────────

describe('pi 会话启动门禁 · 形态①（原路径 JSON 非法）', () => {
  it('损坏时 createSession 拒绝，pi 进程未被 spawn', async () => {
    writeFileSync(settingsPath, '{ broken json', 'utf-8')

    await expect(pm.createSession('s1', dir)).rejects.toMatchObject({
      code: SETTINGS_CORRUPTED,
    })
    // 零副作用：spawn 一次都未发生（进程未创建，也无旧进程清理动作）
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('错误消息含 settings.json 绝对路径与修复指引（修复/删除后重试、无需重启）', async () => {
    writeFileSync(settingsPath, '{ broken json', 'utf-8')

    const err = await pm.createSession('s1', dir).catch((e: unknown) => e as Error)
    expect((err as Error & { code?: string }).code).toBe(SETTINGS_CORRUPTED)
    const msg = (err as Error).message
    expect(msg).toContain(settingsPath) // 文件绝对路径（动态拼接实际值）
    expect(msg).toContain('Fix or delete the file')
    expect(msg).toContain('no restart')
  })
})

// ── 2. 现查语义：同实例先拒后修再放行 ─────────────────────────────

describe('pi 会话启动门禁 · 每次现查（无缓存）', () => {
  it('损坏先拒，文件修复后同一 ProcessManager 实例放行（无需重启）', async () => {
    writeFileSync(settingsPath, '{ broken json', 'utf-8')
    await expect(pm.createSession('s1', dir)).rejects.toMatchObject({
      code: SETTINGS_CORRUPTED,
    })
    expect(spawnMock).not.toHaveBeenCalled()

    // 用户修复文件（写回合法 JSON）——getSettingsCorruption 每次 readFileSync 现查，
    // 同进程内立即放行
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'p/m' }), 'utf-8')
    const client = await pm.createSession('s1', dir)
    expect(client).toBeDefined()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})

// ── 3. 形态②：`.corrupt-*` 隔离副本 → 拒绝且消息含副本路径 ─────────

describe('pi 会话启动门禁 · 形态②（隔离副本）', () => {
  it('原路径缺失但存在 .corrupt-* 副本时拒绝，消息含副本绝对路径，spawn 未调用', async () => {
    const copyPath = join(dir, 'settings.json.corrupt-20261003T000000')
    writeFileSync(copyPath, '{ whatever history }', 'utf-8')

    const err = await pm.createSession('s1', dir).catch((e: unknown) => e as Error)
    expect((err as Error & { code?: string }).code).toBe(SETTINGS_CORRUPTED)
    expect((err as Error).message).toContain(copyPath)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

// ── 4. 短命 pi（withEphemeralPi）同门禁 ──────────────────────────

describe('pi 会话启动门禁 · 短命 pi（withEphemeralPi）', () => {
  it('损坏时 withEphemeralPi 拒绝，spawn 未调用', async () => {
    writeFileSync(settingsPath, '{ broken json', 'utf-8')

    await expect(
      pm.withEphemeralPi(join(dir, 'some-session.jsonl'), async () => undefined),
    ).rejects.toMatchObject({ code: SETTINGS_CORRUPTED })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

// ── 5. 恢复链路同门禁（SessionLifecycle.restoreSession → createSession）──

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

function makeFakeAdapter(): IEventAdapter {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
}

/**
 * 最小 lifecycle 环境（session-lifecycle-gate.test.ts makeEnv 同构），pm 换成**真实
 * ProcessManager**——恢复链路的门禁行为（spawn 前拒绝）因此被端到端锁定。
 */
function makeRestoreEnv(realPm: IProcessManager) {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView) => makeSummary(s.id)),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => makeFakeAdapter(),
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(svc, realPm, configStore, sessionStore, workspaceService, registerDeps)
  return { svc, lifecycle }
}

describe('pi 会话启动门禁 · 恢复链路（restoreSession 同经 createSession 单点）', () => {
  it('损坏时 restoreSession 在 spawn 前被拒（pi 进程未 spawn），code=settings_corrupted', async () => {
    writeFileSync(settingsPath, '{ broken json', 'utf-8')

    // 摆盘一个可恢复的 session 文件 + 扫描 stub（session-lifecycle-gate.test.ts 同构）
    const sessionDir = mkdtempSync(join(tmpdir(), 'pm-gate-restore-'))
    try {
      const filePath = join(sessionDir, 'session.jsonl')
      writeFileSync(filePath, [
        { type: 'session', version: 3, id: 's-gate-restore', timestamp: '2026-10-03T01:00:00.000Z', cwd: sessionDir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-03T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const target = { id: 's-gate-restore', cwd: sessionDir, filePath, name: 'restored', launchPresetId: undefined } as ScannedSession

      const { svc, lifecycle } = makeRestoreEnv(pm)
      svc.findScannedSession = vi.fn(() => target) as never

      await expect(lifecycle.restoreSession('s-gate-restore')).rejects.toMatchObject({
        code: SETTINGS_CORRUPTED,
      })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
