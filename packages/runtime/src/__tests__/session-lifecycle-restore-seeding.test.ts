/**
 * U2/U9 restore/create 播种测试（composer-model-session-isolation 设计 §3.3 D2，r3 校准）。
 *
 * 验证 restoreSession 在 switchSession 成功后 get_state 读回生效 model+thinkingLevel，
 * 通过 registerSession 新参 metaOverride 播种。r3 校准：metaOverride 恒提供（读回成功/
 * 失败两路径同构），每字段独立走「读回值 → 扫描 meta 值 → ''」兜底链——restore 任何
 * 情况不播种全局默认（D2 被否谱系：全局默认播种 = restore 窗口显示他 session 的假值，违 G4）。
 *
 * [缓存治理 U8a W3/W4] restore 播种不再写任何持久层（原写点⑤ sidecar 自愈已退役，
 * 持久层唯一写方 = pi JSONL；兜底扫描 meta 值 U7 起即反向读 JSONL 真值）。原写点③/⑤
 * 正断言随写点退役改写为「磁盘零写入」负守卫。
 *
 * 测试场景（r3 校准后）：
 * 1. 读回成功全字段 → 播种真值
 * 2. 读回成功部分字段 → 缺字段回落扫描 meta 值再 '' 占位
 * 3. 读回失败 + 扫描 meta 部分字段 → 有值字段播种扫描值、缺字段播种 ''
 * 4. 读回失败 + 扫描 meta 双无值 → metaOverride {modelId:'', thinkingLevel:''}（不回落全局默认）
 * 5. hydrateBindingMeta restore='none' 不覆写播种值（D1 生效验证）
 *
 * 运行：cd packages/runtime && pnpm vitest run src/__tests__/session-lifecycle-restore-seeding.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionSummary } from '@taiji/shared'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { IConfigStore } from '../services/ports/config.js'
import type { ISessionStore } from '../services/ports/session.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../services/session/session-internal.js'
import type { IEventAdapter } from '../interfaces.js'
// applyHeaderCwdFallback 自 session-lifecycle 迁出（max-lines 行数合规），权威源在本文件同目录。
import { applyHeaderCwdFallback } from '../services/session/restore-seeding.js'

// ── mock 辅助 ────────────────────────────────────────────────

function makeMockAdapter(): IEventAdapter {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
}

function makeRegisterDeps(): ISessionRegisterDeps {
  return {
    adapterFactory: vi.fn(() => makeMockAdapter()),
    getMessageBus: vi.fn(() => null),
    broadcastGlobal: vi.fn(),
    notifyMessageComplete: vi.fn(),
  }
}

function makeConfigStore(defaultModel?: { provider: string; modelId: string }): IConfigStore {
  return {
    getDefaultModel: vi.fn(() => defaultModel ?? { provider: 'test-provider', modelId: 'test-model' }),
  } as unknown as IConfigStore
}

function makeSessionStore(): ISessionStore {
  return {
    scanSessions: vi.fn(() => []),
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    invalidateMetaCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
    trash: vi.fn(),
  } as unknown as ISessionStore
}

function makeScannedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-session-id',
    filePath: '/test/sessions/test-session-id.jsonl',
    cwd: '/test',
    timestamp: new Date().toISOString(),
    name: 'test-session',
    outcome: null,
    lastModified: Date.now(),
    size: 100,
    launchPresetId: 'builtin:full',
    ...overrides,
  }
}

function makeSvc(overrides: Record<string, unknown> = {}): ILifecycleSessionOps {
  return {
    findScannedSession: vi.fn(() => makeScannedSession()),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    toSummary: vi.fn((s: Record<string, unknown>) => ({ id: s.id, modelId: s.modelId, thinkingLevel: s.thinkingLevel } as SessionSummary)),
    fetchAndBroadcastContext: vi.fn(async () => {}),
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
    ...overrides,
  } as unknown as ILifecycleSessionOps
}

function makePm(clientStateData?: Record<string, unknown> | Error): IProcessManager {
  const client: Partial<IPiEngine> = {
    switchSession: vi.fn(async () => {}),
    getState: vi.fn(async () => {
      if (clientStateData instanceof Error) throw clientStateData
      return clientStateData ?? { sessionId: 'test-session-id', sessionFile: '/test/sessions/test-session-id.jsonl' }
    }),
    setSessionName: vi.fn(async () => {}),
  }
  return {
    createSession: vi.fn(async () => client as IPiEngine),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn(() => undefined),
    rekey: vi.fn(),
    onSessionExit: vi.fn(() => () => {}),
  } as unknown as IProcessManager
}

// ── 测试 ─────────────────────────────────────────────────────

describe('U2 restoreSession 播种（D2 设计）', () => {
  // 动态 import SessionLifecycle（避免 ESM 循环）
  let SessionLifecycle: typeof import('../services/session/session-lifecycle.js').SessionLifecycle
  let assertPiSessionFileMock: ReturnType<typeof vi.fn>
  let normalizeSessionFileInPlaceMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'u2-seeding-'))

    vi.resetModules()
    // mock assertPiSessionFile（附着断言）
    assertPiSessionFileMock = vi.fn(async () => {})
    vi.doMock('../infra/pi/session-attach-assert.js', () => ({
      assertPiSessionFile: assertPiSessionFileMock,
    }))
    // mock normalizeSessionFileInPlace（归一化 noop）。[U8a W3/W4] persistModelBinding
    // 及其骨架转发已随写点退役移除——session-lifecycle / restore-seeding 对本模块的
    // 消费面只剩 cleanupMigrateResidues + normalizeSessionFileInPlace。
    normalizeSessionFileInPlaceMock = vi.fn()
    vi.doMock('../infra/pi/session-file-utils.js', () => ({
      normalizeSessionFileInPlace: normalizeSessionFileInPlaceMock,
      cleanupMigrateResidues: vi.fn(),
    }))
    // mock session-binding-fields（hydrateBindingMeta 实际行为——restore='none' 时 skip modelId/thinkingLevel）
    vi.doMock('../infra/pi/session-binding-fields.js', () => ({
      hydrateBindingMeta: vi.fn((session: Record<string, unknown>, meta: Record<string, unknown>, entry: string) => {
        // 模拟 restore='none'：modelId/thinkingLevel 不回填
        if (entry === 'restore') {
          // 只回填非 modelId/thinkingLevel 的字段
          if (meta.launchPresetId) session.launchPresetId = meta.launchPresetId
          if (meta.projectId) session.projectId = meta.projectId
          if (meta.spawnSource) session.spawnSource = meta.spawnSource
          if (meta.parentAgentSessionId) session.parentAgentSessionId = meta.parentAgentSessionId
          if (meta.handedOffTo) session.handedOffTo = meta.handedOffTo
          // modelId/thinkingLevel 不覆写——D1 裁决
        } else if (entry === 'create') {
          // create='options'：modelId 来自 presetClientOptions
          if (meta.modelId && !(session as Record<string, unknown>).modelId) {
            (session as Record<string, unknown>).modelId = meta.modelId
          }
        }
      }),
    }))

    const mod = await import('../services/session/session-lifecycle.js')
    SessionLifecycle = mod.SessionLifecycle
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  async function runRestore(
    clientStateData: Record<string, unknown> | Error | undefined,
    scannedOverrides: Record<string, unknown> = {},
    svcOverrides: Record<string, unknown> = {},
  ) {
    // 在 tmpDir 创建真实 session JSONL 文件（normalizeInactiveSessionFileIfNeeded 会 readFileSync）
    const sessionFilePath = join(tmpDir, 'test-session-id.jsonl')
    writeFileSync(sessionFilePath, '{"type":"session","cwd":"/test"}\n')

    const pm = makePm(clientStateData)
    const configStore = makeConfigStore()
    const sessionStore = makeSessionStore()
    const svc = makeSvc({
      findScannedSession: vi.fn(() => makeScannedSession({ filePath: sessionFilePath, ...scannedOverrides })),
      ...svcOverrides,
    })
    const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
    const registerDeps = makeRegisterDeps()

    const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
    const summary = await lifecycle.restoreSession('test-session-id')

    // 从 sessions Map 取注册后的 session 记录
    const session = lifecycle.get('test-session-id')

    return { summary, session, pm, svc, registerDeps }
  }

  it('场景 1: get_state 读回成功 → metaOverride 播种真值', async () => {
    const { session } = await runRestore({
      sessionId: 'test-session-id',
      sessionFile: '/test/sessions/test-session-id.jsonl',
      model: { id: 'glm-5.3', provider: 'zai-coding-cn' },
      thinkingLevel: 'high',
    })

    expect(session).toBeDefined()
    expect(session!.modelId).toBe('zai-coding-cn/glm-5.3')
    expect(session!.thinkingLevel).toBe('high')
  })

  it('场景 2: get_state 读回失败 → 兜底扫描 meta 值', async () => {
    const { session } = await runRestore(
      new Error('get_state timeout'),
      // 扫描 meta 值（findScannedSession 返回的 modelId/thinkingLevel，反向读 JSONL 真值）
      { modelId: 'zai-coding-cn/glm-5.3-flash', thinkingLevel: 'max' },
    )

    expect(session).toBeDefined()
    expect(session!.modelId).toBe('zai-coding-cn/glm-5.3-flash')
    expect(session!.thinkingLevel).toBe('max')
  })

  it('场景 2a: 读回仅 thinkingLevel，modelId 回落扫描 meta 值（r3 校准按字段链）', async () => {
    // get_state 只返回 thinkingLevel（无 model/modelId 字段）→ modelId 走扫描 meta 值
    const { session } = await runRestore(
      { sessionId: 'test-session-id', sessionFile: '/test/sessions/test-session-id.jsonl', thinkingLevel: 'high' },
      { modelId: 'zai-coding-cn/glm-5.3-flash' },
    )

    expect(session).toBeDefined()
    expect(session!.modelId).toBe('zai-coding-cn/glm-5.3-flash')
    expect(session!.thinkingLevel).toBe('high')
  })

  it('场景 2b: 读回仅 modelId，thinkingLevel 两级全缺 → 播种空串占位（不再走全局默认）', async () => {
    // get_state 只返回 model（无 thinkingLevel），sidecar 无 thinkingLevel → '' 占位；
    // metaOverride 恒提供使 modelId 读回值正常播种，thinkingLevel='' 不受全局默认影响
    const { session } = await runRestore(
      {
        sessionId: 'test-session-id',
        sessionFile: '/test/sessions/test-session-id.jsonl',
        model: { id: 'glm-5.3', provider: 'zai-coding-cn' },
      },
      {},
    )

    expect(session).toBeDefined()
    expect(session!.modelId).toBe('zai-coding-cn/glm-5.3')
    expect(session!.thinkingLevel).toBe('')
  })

  it('场景 3: 双失败（get_state 失败 + sidecar 无值）→ 空字符串（不回落全局默认）', async () => {
    const sessionFilePath = join(tmpDir, 'test-session-id.jsonl')
    writeFileSync(sessionFilePath, '{"type":"session","cwd":"/test"}\n')

    const configStore = makeConfigStore({ provider: 'default-provider', modelId: 'default-model' })
    const pm = makePm(new Error('get_state timeout'))
    const sessionStore = makeSessionStore()
    const svc = makeSvc({
      findScannedSession: vi.fn(() => makeScannedSession({
        filePath: sessionFilePath,
        // 扫描 meta 无值（历史 session path 上无任何模型 entry）
        modelId: undefined,
        thinkingLevel: undefined,
      })),
    })
    const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
    const registerDeps = makeRegisterDeps()

    const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
    await lifecycle.restoreSession('test-session-id')

    const session = lifecycle.get('test-session-id')
    expect(session).toBeDefined()
    // r3 校准：metaOverride 恒提供（含双失败路径），双无值字段播种 '' 占位——
    // configStore 的 default-model（'default-provider/default-model'）恰好不该出现：
    // 全局默认播种 = restore 窗口显示他 session 的假值（D2 被否谱系，违 G4「不知道显示占位」）
    expect(session!.modelId).toBe('')
    expect(session!.thinkingLevel).toBe('')
  })

  it('场景 4: hydrateBindingMeta restore=none 不覆写播种值（D1 生效验证）', async () => {
    // get_state 成功 → metaOverride 播种真值
    // hydrateBindingMeta restore='none' 跳过 modelId/thinkingLevel 回填
    const { session } = await runRestore({
      sessionId: 'test-session-id',
      sessionFile: '/test/sessions/test-session-id.jsonl',
      model: { id: 'glm-5.3', provider: 'zai-coding-cn' },
      thinkingLevel: 'max',
    })

    expect(session).toBeDefined()
    // 播种值保持不变（hydrateBindingMeta 不覆写）
    expect(session!.modelId).toBe('zai-coding-cn/glm-5.3')
    expect(session!.thinkingLevel).toBe('max')
  })

  it('registerSession metaOverride 优先级高于 modelOverride', async () => {
    const pm = makePm({
      sessionId: 'test-session-id',
      sessionFile: '/test/sessions/test-session-id.jsonl',
    })
    const configStore = makeConfigStore()
    const sessionStore = makeSessionStore()
    const svc = makeSvc()
    const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
    const registerDeps = makeRegisterDeps()

    const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)

    // 直接调 registerSession，modelOverride='preset-model'，metaOverride={ modelId: 'real-model' }
    const client = await pm.createSession('test-session-id', '/test') as IPiEngine
    const session = await (lifecycle as unknown as { registerSession: Function }).registerSession(
      'test-session-id', client, '/test', 'test',
      '/test/sessions/test-session-id.jsonl',
      undefined, undefined, undefined,
      'preset-model',  // modelOverride (9th)
      { modelId: 'real-model', thinkingLevel: 'low' },  // metaOverride (10th)
    )

    // metaOverride 优先级高于 modelOverride
    expect(session.modelId).toBe('real-model')
    expect(session.thinkingLevel).toBe('low')
  })

  it('registerSession 无 metaOverride 时 fallback 到 modelOverride', async () => {
    const pm = makePm({
      sessionId: 'test-session-id',
      sessionFile: '/test/sessions/test-session-id.jsonl',
    })
    const configStore = makeConfigStore()
    const sessionStore = makeSessionStore()
    const svc = makeSvc()
    const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
    const registerDeps = makeRegisterDeps()

    const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)

    const client = await pm.createSession('test-session-id', '/test') as IPiEngine
    const session = await (lifecycle as unknown as { registerSession: Function }).registerSession(
      'test-session-id', client, '/test', 'test',
      '/test/sessions/test-session-id.jsonl',
      undefined, undefined, undefined,
      'preset-model',  // modelOverride
      undefined,  // metaOverride not provided
    )

    // fallback to modelOverride
    expect(session.modelId).toBe('preset-model')
  })

  it('registerSession 两者都无时 fallback 到全局默认', async () => {
    const pm = makePm({
      sessionId: 'test-session-id',
      sessionFile: '/test/sessions/test-session-id.jsonl',
    })
    const configStore = makeConfigStore({ provider: 'default-p', modelId: 'default-m' })
    const sessionStore = makeSessionStore()
    const svc = makeSvc()
    const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
    const registerDeps = makeRegisterDeps()

    const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)

    const client = await pm.createSession('test-session-id', '/test') as IPiEngine
    const session = await (lifecycle as unknown as { registerSession: Function }).registerSession(
      'test-session-id', client, '/test', 'test',
      '/test/sessions/test-session-id.jsonl',
      undefined, undefined, undefined,
      undefined,  // modelOverride
      undefined,  // metaOverride
    )

    // fallback to global default
    expect(session.modelId).toBe('default-p/default-m')
  })

  it('[U8a W4] create 不再写 model sidecar（写点③退役）：磁盘零写入，读回生效值只进内存播种', async () => {
    const sessionFilePath = join(tmpDir, 'created-id.jsonl')
    writeFileSync(sessionFilePath, '{"type":"session","cwd":"/test"}\n')

    const pm = makePm({
      sessionId: 'created-id',
      sessionFile: sessionFilePath,
      model: { id: 'real-model', provider: 'real-p' },
      thinkingLevel: 'max',
    })
    const lifecycle = new SessionLifecycle(
      makeSvc(), pm, makeConfigStore(), makeSessionStore(),
      { record: vi.fn() } as unknown as WorkspaceService, makeRegisterDeps(),
    )
    // 请求值（Landing Chip override）与 pi 读回生效值不同——pattern 引擎静默换模场景，
    // 内存播种仍取读回真值（C-pi-13）
    await lifecycle.create(tmpDir, 'test', { modelOverride: 'requested/model', thinkingOverride: 'low' })

    // 持久层零写入：无 sidecar 产物（初始模型信息由 pi 对话落 JSONL + 扫描反向读提供）
    expect(existsSync(sessionFilePath + '.model.json')).toBe(false)
    expect(lifecycle.get('created-id')?.modelId).toBe('real-p/real-model')
  })

  it('[U8a W3] restore 读回成功不再覆写 .model.json（写点⑤退役）：播种只进内存 metaOverride', async () => {
    const sessionFilePath = join(tmpDir, 'test-session-id.jsonl')
    const sidecarPath = sessionFilePath + '.model.json'
    // 预置历史 sidecar（W6 中途态仍可能存在的旧文件）——restore 后必须原样保留
    writeFileSync(sidecarPath, JSON.stringify({ modelId: 'stale/model', thinkingLevel: 'stale-level', version: 1 }))

    const { session } = await runRestore({
      sessionId: 'test-session-id',
      sessionFile: sessionFilePath,
      model: { id: 'fresh', provider: 'fp' },
      thinkingLevel: 'high',
    })

    // 读回真值照常播种内存 metaOverride（D2 链路不回退）
    expect(session).toBeDefined()
    expect(session!.modelId).toBe('fp/fresh')
    expect(session!.thinkingLevel).toBe('high')
    // 持久层零写入：旧 sidecar 不被覆写（读回失败兜底已由扫描 meta 反向读承担）
    const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    expect(data.modelId).toBe('stale/model')
    expect(data.thinkingLevel).toBe('stale-level')
  })
})

// ── applyHeaderCwdFallback（自 test/session-file-utils.test.ts 并入，随 SUT 归位）──
// F3 归一化管线内 header cwd 降级，纯字符串变换。权威源在本目录 restore-seeding.ts:104。

describe('applyHeaderCwdFallback（F3 归一化管线内 header cwd 降级，纯字符串变换）', () => {
  it('替换首行 session header 的 cwd，其余 entry 原样保留', () => {
    const content = [
      JSON.stringify({ type: 'session', version: 3, id: 'test-id', cwd: '/dead/cwd', timestamp: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [] } }),
    ].join('\n') + '\n'

    const patched = applyHeaderCwdFallback(content, '/home/fallback')

    const lines = patched.split('\n')
    const header = JSON.parse(lines[0])
    expect(header.cwd).toBe('/home/fallback')
    // 其他 header 字段与后续 entry 字节不变（只动 cwd）
    expect(header.id).toBe('test-id')
    expect(header.version).toBe(3)
    expect(lines[1]).toBe(JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [] } }))
    expect(lines[2]).toBe(JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [] } }))
    // 末尾换行保留（pi _persist 期望每行以 \n 结尾，与 stripSessionEndEntries 契约一致）
    expect(patched.endsWith('\n')).toBe(true)
  })

  it('首行非 session 类型 → 原样返回（防御，与原 patchSessionCwd 同语义）', () => {
    const content = JSON.stringify({ type: 'other', cwd: '/old' }) + '\n'
    expect(applyHeaderCwdFallback(content, '/new')).toBe(content)
  })

  it('首行 JSON 损坏 → 原样返回不抛', () => {
    const content = 'not-json\nmore\n'
    expect(applyHeaderCwdFallback(content, '/new')).toBe(content)
  })

  it('空文本 → 原样返回', () => {
    expect(applyHeaderCwdFallback('', '/new')).toBe('')
  })
})
