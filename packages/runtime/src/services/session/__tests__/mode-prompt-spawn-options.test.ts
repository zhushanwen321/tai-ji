/**
 * 模式提示词两通道 spawn options 回归锁（session-lifecycle 级）。
 *
 * 背景（设计文档 .tmp/tech-design/mode-system-composer-density.md §7.2）：
 * 模式提示词经 pi spawn options 的 `systemPrompt`（replace）与 `appendSystemPrompt`（append）
 * 两条通道下发。取值 helper（resolveEffectiveSystemPrompt / resolveAppendSystemPrompt）与
 * RpcClient argv 拼装各有单测，但**三条 spawn 路径**（create / restore / fork）是否真的把
 * 「本路径解析出的 resolution」接到各自 options 上，此前无 session-lifecycle 级断言——
 * 注释承诺 ≠ 不变量，将来「改一处、漏另两处」无机器拦截。
 *
 * 本文件锁定差异点（三条路径的解析来源不同）：
 * - create：`options.presetId` → `resolveCreateLaunch` 的 `resolution`
 * - restore：`target.launchPresetId ?? builtin:full` → `spawnRestoreClient` 的 `resolution`
 * - fork：源 session 继承的 `forkPresetId` → `resolveForkLaunch` 的 **`forkResolution`**
 *   （最易漏的一条——fork 与 restore 代码形态高度同构）
 *
 * 每条路径注入**互不相同**的模式文本（且都不等于全局替换提示词），
 * 断言 spawn options 精确命中本路径 preset——任一路径漏接/接错来源即红。
 *
 * Mock 策略：svc/pm/configStore/sessionStore 注入 vi.fn mock；文件系统走真实 tmp 目录
 *（restore 归一化判定与 fork 截断写文件真实执行，getSessionsDir 指向 tmp——
 *禁触碰真实数据目录）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// getSessionsDir 指向测试 tmp（fork 产物真实写入；不碰真实数据目录）
const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))
vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})

import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IManagedSessionView, ScannedSession } from '../types.js'
import type { PresetResolution } from '../../preset-service.js'
import type { SessionSummary } from '@taiji/shared'

/** 全局替换系统提示词（与三条路径的模式文本全部不同——模式生效时必须压掉它）。 */
const GLOBAL_REPLACE = 'GLOBAL_REPLACE'

const CREATE_MODE = 'CREATE_REPLACE'
const CREATE_APPEND = 'CREATE_APPEND'
const RESTORE_MODE = 'RESTORE_REPLACE'
const RESTORE_APPEND = 'RESTORE_APPEND'
const FORK_MODE = 'FORK_REPLACE'
const FORK_APPEND = 'FORK_APPEND'

/** 构造两通道皆启用的模式 resolution（仅 prompt 面参与本组断言）。 */
function modeResolution(replace: string, append: string): PresetResolution {
  return {
    skillPaths: undefined,
    extensionPaths: [],
    toolArgs: {},
    flags: { noSkills: false, noContextFiles: false },
    prompt: {
      replace: { enabled: true, prompt: replace },
      append: { enabled: true, prompt: append },
    },
  }
}

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

/** 会话文件行集：header + u1 + a1（fork 树回溯用）。 */
function makeLines(cwd: string): string[] {
  return [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-src', timestamp: '2026-09-01T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
  ]
}

interface EnvOptions {
  resolutions: Record<string, PresetResolution>
  scanned?: ScannedSession
}

function makeEnv(opts: EnvOptions) {
  const resolveCalls: Array<{ presetId: string; cwd: string }> = []
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'pi-s1' })),
    switchSession: vi.fn(async () => undefined),
    setSessionName: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  }
  const createSession = vi.fn(async () => client)
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => GLOBAL_REPLACE),
    getLaunchPresetOptions: vi.fn(async (presetId: string, cwd: string) => {
      resolveCalls.push({ presetId, cwd })
      return opts.resolutions[presetId]
    }),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => makeSummary(s.id)),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => opts.scanned),
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
  return { lifecycle, svc, pm, createSession, resolveCalls }
}

/** 取本路径 spawn pi 时传入的 options（createSession 第三参）。 */
function spawnOptions(createSession: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(createSession).toHaveBeenCalledTimes(1)
  return createSession.mock.calls[0]![2] as Record<string, unknown>
}

describe('模式提示词两通道：三条 spawn 路径各自接对 resolution', () => {
  let dir: string

  beforeEach(() => {
    setMigrationGate(Promise.resolve())
    dir = mkdtempSync(join(tmpdir(), 'mode-prompt-spawn-'))
    sessionsDirMock.value = dir
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('create：options.presetId 解析出的 resolution → systemPrompt=模式文本（压掉全局）/ appendSystemPrompt 透传', async () => {
    const env = makeEnv({ resolutions: { 'mode-create': modeResolution(CREATE_MODE, CREATE_APPEND) } })
    await env.lifecycle.create(dir, 't', { presetId: 'mode-create' })

    const opts = spawnOptions(env.createSession)
    // replace 通道走 D3 优先级：模式文本压掉全局替换提示词（≠ GLOBAL_REPLACE 即证）
    expect(opts.systemPrompt).toBe(CREATE_MODE)
    expect(opts.systemPrompt).not.toBe(GLOBAL_REPLACE)
    // append 通道只有模式一段
    expect(opts.appendSystemPrompt).toBe(CREATE_APPEND)
    // 解析来源 = options.presetId
    expect(env.resolveCalls).toEqual([{ presetId: 'mode-create', cwd: dir }])
  })

  it('restore：target.launchPresetId 解析出的 resolution → 两通道取该 resolution（≠ 全局 / ≠ create）', async () => {
    const filePath = join(dir, 'sess-restore.jsonl')
    writeFileSync(filePath, makeLines(dir).join('\n') + '\n', 'utf-8')
    const scanned: ScannedSession = {
      id: 'sess-restore', filePath, cwd: dir, timestamp: '2026-09-01T00:00:00.000Z',
      name: 'target', lastModified: Date.now(), size: 0, outcome: null, launchPresetId: 'mode-restore',
    }
    const env = makeEnv({ resolutions: { 'mode-restore': modeResolution(RESTORE_MODE, RESTORE_APPEND) }, scanned })

    await env.lifecycle.restoreSession('sess-restore')

    const opts = spawnOptions(env.createSession)
    expect(opts.systemPrompt).toBe(RESTORE_MODE)
    expect(opts.systemPrompt).not.toBe(GLOBAL_REPLACE)
    expect(opts.appendSystemPrompt).toBe(RESTORE_APPEND)
    // 解析来源 = target.launchPresetId（不是 builtin:full 兜底）
    expect(env.resolveCalls).toEqual([{ presetId: 'mode-restore', cwd: dir }])
  })

  it('fork：源 session 继承的 forkPresetId 解析出的 **forkResolution** → 两通道取该 resolution（最易漏路径）', async () => {
    const sourceFile = join(dir, 'src.jsonl')
    writeFileSync(sourceFile, makeLines(dir).join('\n') + '\n', 'utf-8')
    const source: ScannedSession = {
      id: 'src', filePath: sourceFile, cwd: dir, timestamp: '2026-09-01T00:00:00.000Z',
      name: 'src', lastModified: Date.now(), size: 0, outcome: null, launchPresetId: 'mode-fork',
    }
    const env = makeEnv({ resolutions: { 'mode-fork': modeResolution(FORK_MODE, FORK_APPEND) }, scanned: source })

    await env.lifecycle.forkSession('src', 'a1', true, 'forked')

    const opts = spawnOptions(env.createSession)
    // fork 用的是 resolveForkLaunch 返回的 forkResolution（不是 create/restore 的 resolution）
    expect(opts.systemPrompt).toBe(FORK_MODE)
    expect(opts.systemPrompt).not.toBe(GLOBAL_REPLACE)
    expect(opts.appendSystemPrompt).toBe(FORK_APPEND)
    // 解析来源 = 源 session 继承的 preset（resolveForkInheritedBindings → source.launchPresetId）
    expect(env.resolveCalls).toEqual([{ presetId: 'mode-fork', cwd: dir }])
  })

  it('反例锁：三条路径的模式文本互不相同——assertion 不会因「某处硬编码同一值」假绿', () => {
    const texts = [CREATE_MODE, RESTORE_MODE, FORK_MODE, CREATE_APPEND, RESTORE_APPEND, FORK_APPEND]
    expect(new Set(texts).size).toBe(texts.length)
  })
})
