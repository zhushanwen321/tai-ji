/**
 * F1 回落披露（设计 `.tmp/tech-design/mode-system-composer-density.md` §7.5 E4）：
 * session restore 时锁定的模式定义已不可得 → pi 回落 `builtin:full` 启动，**降级事实必须
 * 随 session 状态上抛**（renderer chip / 声明行据此披露「模式已删除，本次以全工具模式启动」）。
 *
 * 本文件锁两个层次（缺陷可被任一层单独捕获）：
 * 1. **检测层**：真实 `resolveLaunchPresetOptions` + 定义不可得的 presetId → resolution 上附
 *    `fellBackFromPresetId`（原悬空 id）；
 * 2. **携带层**：restore 全链（`resolveLaunchPresetOptions` → `spawnRestoreClient` → 内存态置位）
 *    → 内存 session 与 `buildSessionSummary`（真实投影）产出的 SessionSummary 都携带
 *    `launchPresetFallbackTo = builtin:full`，可从会话状态读回；模式仍可得 → 不置位（不得假陈述）。
 *
 * Mock 策略：preset 服务为内存 fake（检测逻辑真实走 launch-params），svc/pm/sessionStore 注入
 * vi.fn mock；文件系统走真实 tmp 目录（getSessionsDir 指向 tmp——禁触碰真实数据目录）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// getSessionsDir 指向测试 tmp（会话文件真实写入；不碰真实数据目录）
const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))
vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})

import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js'
import { resolveLaunchPresetOptions } from '../launch-params.js'
import { buildSessionSummary } from '../session-summary.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { IGitInfoReader } from '../../ports/git-info.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IManagedSessionView, ScannedSession } from '../types.js'
import type { PresetService, PresetResolution } from '../../preset-service.js'
import type { SessionSummary } from '@taiji/shared'

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

/** 真实 Summary 投影（git 端口 fake；replicated states 空 → tokenCount 走实例基线）。 */
const gitInfoReader = {
  readGitInfo: () => undefined,
  pruneStaleCache: () => {},
} as unknown as IGitInfoReader

function makeSummaryReal(s: IManagedSessionView): SessionSummary {
  return buildSessionSummary(s, gitInfoReader, () => undefined)
}

/** 会话文件行集：header（restore 归一化判定与附着断言的真实输入）。 */
function makeLines(cwd: string): string[] {
  return [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-restore', timestamp: '2026-09-01T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ]
}

function makeEnv(presetService: PresetService, scanned: ScannedSession) {
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
    notifyMessageComplete: () => {},
  }
  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, createSession }
}

/** 取 pm.createSession 第 n 次调用的 options.env（F1b 出站通道断言）。 */
function spawnEnv(createSession: ReturnType<typeof makeEnv>['createSession'], n = 0): Record<string, string> {
  const options = createSession.mock.calls[n]?.[2] as { env?: Record<string, string> } | undefined
  return options?.env ?? {}
}

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
    const env = makeEnv(makePresetService(['builtin:full']), scannedSession(GONE_PRESET_ID))

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
    // 会话状态读回（renderer reload 时 runtime 内存态重投影仍可复现，不依赖一次性广播）
    const active = env.lifecycle.get('sess-restore') as unknown as { launchPresetFallbackTo?: string }
    expect(active.launchPresetFallbackTo).toBe('builtin:full')
    expect(makeSummaryReal(active as unknown as IManagedSessionView).launchPresetFallbackTo).toBe('builtin:full')
  })

  it('模式定义仍可得 → 不置回落事实（不产生假陈述）', async () => {
    const env = makeEnv(makePresetService(['builtin:full', GONE_PRESET_ID]), scannedSession(GONE_PRESET_ID))

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
    const env = makeEnv(makePresetService(['builtin:full']), scannedSession(undefined))

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
