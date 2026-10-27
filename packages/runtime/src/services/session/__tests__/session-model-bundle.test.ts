import type { IConfigService, IEventAdapter, IExtensionService } from '../../../interfaces.js';
import { ENGINE_MODEL_MISSING, MODEL_NOT_FOUND, PROVIDER_CREDENTIAL_MISSING, SESSION_ACTIVATE_FAILED, SESSION_NOT_FOUND } from '../../../utils/errors.js';
import { ExtensionService } from '../../extension-service.js';
import type { IConfigStore } from '../../ports/config.js';
import type { IExtensionSettings } from '../../ports/extension-settings.js';
import type { IInstaller, IExtensionResolver, DiscoveredExtension } from '../../ports/installer.js';
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js';
import type { ISessionStore } from '../../ports/session.js';
import { type PresetResolution, PresetService, type PresetService as PresetServiceType } from '../../preset-service.js';
import type { WorkspaceService } from '../../workspace/workspace-service.js';
import { resolveSkillPaths, resolveExtensionPaths, resolveReplaceSystemPrompt, resolveEffectiveSystemPrompt, resolveAppendSystemPrompt, resolveLaunchPresetOptions, buildPresetFallbackEnv, buildPresetClientOptions, warnLaunchEffectiveMismatch } from '../launch-params.js';
import { createModelOverrideQuery } from '../model-override-query.js';
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js';
import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js';
import { SessionModelControl, classifyActivationError, isPiModelNotFoundError } from '../session-model-control.js';
import { isModelInRegistry, providerHasCredential } from '../session-model-guards.js';
import type { SessionReplicatedStates } from '../session-state-projection.js';
import type { IManagedSessionView, ScannedSession } from '../types.js';
import { type ProviderId, type SessionSummary, PRESET_FALLBACK_ENV_KEYS } from '@taiji/shared';
import { RECORD_EVENTS_SUFFIX, RUN_EVENTS_SUFFIX, getSubagentRecordsDir, recordEventsPath } from '@zhushanwen/subagent-core';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/session/__tests__/session-model-control.test.ts
// ======================================================================

/** 可变 session 视图（断言直写双派生视图）。 */
function makeSession(): { modelId: string; thinkingLevel: string } & IManagedSessionView {
  return { modelId: 'old/provider-old', thinkingLevel: 'medium' } as unknown as IManagedSessionView & { modelId: string; thinkingLevel: string }
}


interface FixtureOptions {  // oe-exempt:20261027:test:
  getStateImpl?: () => Promise<unknown>
  /** session 视图返回（默认 makeSession()）。 */
  session?: unknown
  /** 激活后 Map 仍无条目（内部不变量破坏用例）。 */
  noSession?: boolean
  /** ensureActive 实现（默认立即返回存活 client）。 */
  ensureActiveImpl?: () => Promise<IPiEngine>
  isModelRegistered?: (provider: string, modelId: string) => boolean
  hasProviderCredential?: (provider: string) => boolean
}


function makeFixture(optsOrGetState: FixtureOptions | (() => Promise<unknown>) = {}) {
  // 兼容两种调用风格：对象选项 / 直接传 getState 实现（既有用例写法）
  const opts: FixtureOptions = typeof optsOrGetState === 'function'
    ? { getStateImpl: optsOrGetState }
    : optsOrGetState
  const session = opts.noSession ? undefined : (opts.session ?? makeSession())
  const markDirty = { modelId: vi.fn(), usage: vi.fn(), thinkingLevel: vi.fn() }
  const states = { modelId: { markDirty: markDirty.modelId }, usage: { markDirty: markDirty.usage }, thinkingLevel: { markDirty: markDirty.thinkingLevel } } as unknown as SessionReplicatedStates
  const client = {
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ model: { id: 'effective-m', provider: 'p2' }, thinkingLevel: 'high' } as unknown)),
    exited: false,
  }
  if (opts.getStateImpl) client.getState.mockImplementation(opts.getStateImpl)
  const ensureActive = vi.fn(opts.ensureActiveImpl ?? (async () => client as unknown as IPiEngine))
  const syncTraceEntries = vi.fn()
  const control = new SessionModelControl({
    getSession: vi.fn(() => session as IManagedSessionView),
    getReplicatedStates: vi.fn(() => states),
    syncTraceEntries,
    ensureActive,
    isModelRegistered: opts.isModelRegistered ?? (() => true),
    hasProviderCredential: opts.hasProviderCredential ?? (() => true),
  })
  return { control, session: session as { modelId: string; thinkingLevel: string }, markDirty, client, syncTraceEntries, ensureActive }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-model-control', () => {
describe('switchModel — 激活前置（U2/D5）', () => {
  it('回收态（session 不在 Map 的等价形态：getSession 先空后非空）仍先 ensureActive 再 setModel', async () => {
    const { control, client, ensureActive, session, markDirty } = makeFixture()
    const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
    expect(ensureActive).toHaveBeenCalledWith('s1')
    // 顺序：激活先于 set RPC（激活是 set 的前置，不再有「无 client → 假成功」早退）
    expect(ensureActive.mock.invocationCallOrder[0]).toBeLessThan(client.setModel.mock.invocationCallOrder[0])
    expect(result).toBe('p2/effective-m')
    expect(session.modelId).toBe('p2/effective-m')
    expect(markDirty.modelId).toHaveBeenCalledTimes(1)
  })

  it('ensureActive 无码失败 → 包 SESSION_ACTIVATE_FAILED，零 set RPC 零失效', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({
        ensureActiveImpl: async () => { throw new Error('Restore succeeded but client not available') },
      })
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.client.setModel).not.toHaveBeenCalled()
      expect(fixture.markDirty.modelId).not.toHaveBeenCalled()
      expect(fixture.session.modelId).toBe('old/provider-old')
    } finally {
      errors.mockRestore()
    }
  })

  it('ensureActive 既有码（SESSION_NOT_FOUND）原样透传，不重包', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({
        ensureActiveImpl: async () => {
          const e = new Error('session file not found') as Error & { code: string }
          e.code = SESSION_NOT_FOUND
          throw e
        },
      })
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_NOT_FOUND, message: 'session file not found' })
    } finally {
      errors.mockRestore()
    }
  })

  it('激活返回已死 client（exited）→ SESSION_ACTIVATE_FAILED，不把死 client 交给 set RPC', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture()
      ;(fixture.client as { exited: boolean }).exited = true
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.client.setModel).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('激活成功但 Map 仍无条目（内部不变量破坏）→ SESSION_ACTIVATE_FAILED，不静默', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({ noSession: true })
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.client.setModel).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})
describe('switchModel — Model not found 三型分型（U2/§3.4）', () => {
  const piError = (): Error => new Error('Model not found: p1/m')

  async function expectCode(opts: FixtureOptions, code: string): Promise<void> {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture(opts)
      ;(fixture.client.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(piError())
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toMatchObject({ code })
      expect(fixture.markDirty.modelId).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  }

  it('模型不在 taiji 注册表 → MODEL_NOT_FOUND', async () => {
    await expectCode({ isModelRegistered: () => false }, MODEL_NOT_FOUND)
  })

  it('模型在注册表、provider 无凭据 → PROVIDER_CREDENTIAL_MISSING', async () => {
    await expectCode({ isModelRegistered: () => true, hasProviderCredential: () => false }, PROVIDER_CREDENTIAL_MISSING)
  })

  it('模型在注册表、凭据齐备 → ENGINE_MODEL_MISSING（快照未同步或配置坏，双因文案）', async () => {
    await expectCode({ isModelRegistered: () => true, hasProviderCredential: () => true }, ENGINE_MODEL_MISSING)
  })

  it('非 Model not found 文本错误原样透传（不吞不重包）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture()
      ;(fixture.client.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc transport down'))
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toThrow('rpc transport down')
    } finally {
      errors.mockRestore()
    }
  })

  it('判定函数单测：前缀匹配 + 激活分型（导出清单，供 PS 探针与上层复用）', () => {
    expect(isPiModelNotFoundError(new Error('Model not found: a/b'))).toBe(true)
    expect(isPiModelNotFoundError(new Error('modelX not found'))).toBe(false)
    const passthrough = Object.assign(new Error('x'), { code: SESSION_NOT_FOUND })
    expect(classifyActivationError(passthrough, 's1')).toBe(passthrough)
    expect((classifyActivationError(new Error('boom'), 's1') as { code: string }).code).toBe(SESSION_ACTIVATE_FAILED)
  })
})
describe('switchModel — 回执与失效（既有语义）', () => {
  it('回执普查：pattern 换模时返回/直写 get_state 生效值（≠ 请求值）+ 三实例失效 + trace 补充拉取', async () => {
    const { control, session, markDirty, syncTraceEntries, client } = makeFixture()
    const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
    expect(client.setModel).toHaveBeenCalledWith('p1', 'requested-m')
    expect(result).toBe('p2/effective-m')
    expect(session.modelId).toBe('p2/effective-m')
    expect(markDirty.modelId).toHaveBeenCalledTimes(1)
    expect(markDirty.usage).toHaveBeenCalledTimes(1)
    expect(markDirty.thinkingLevel).toHaveBeenCalledTimes(1)
    expect(syncTraceEntries).toHaveBeenCalledWith('s1', 'set_model')
  })

  it('get_state 读回失败：fallback 请求值（不反噬主链路），失效仍发 + 警告行（S2 断言依赖）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { control, session, markDirty } = makeFixture(async () => { throw new Error('state rpc down') })
      const result = await control.switchModel('s1', 'p1' as ProviderId, 'requested-m')
      expect(result).toBe('p1/requested-m')
      expect(session.modelId).toBe('p1/requested-m')
      expect(markDirty.modelId).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('switchModel get_state read-back failed'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('setModel 非分型 RPC 失败：不失效不直写（pi 侧未生效，实例保持旧快照）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture()
      ;(fixture.client.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc fail'))
      await expect(fixture.control.switchModel('s1', 'p1' as ProviderId, 'm')).rejects.toThrow('rpc fail')
      expect(fixture.markDirty.modelId).not.toHaveBeenCalled()
      expect(fixture.markDirty.usage).not.toHaveBeenCalled()
      expect(fixture.markDirty.thinkingLevel).not.toHaveBeenCalled()
      expect(fixture.syncTraceEntries).not.toHaveBeenCalled()
      expect(fixture.session.modelId).toBe('old/provider-old')
    } finally {
      error.mockRestore()
    }
  })
})
describe('setThinkingLevel — 同激活语义（U2/D7）', () => {
  it('钳制读回：返回 get_state 生效值并直写 session.thinkingLevel + trace 补充拉取', async () => {
    const { control, session, syncTraceEntries, ensureActive } = makeFixture(async () => ({ thinkingLevel: 'high' }))
    const result = await control.setThinkingLevel('s1', 'max')
    expect(ensureActive).toHaveBeenCalledWith('s1')
    expect(result).toBe('high')
    expect(session.thinkingLevel).toBe('high')
    expect(syncTraceEntries).toHaveBeenCalledWith('s1', 'set_thinking_level')
  })

  it('get_state thinkingLevel 非 string：fallback 请求值', async () => {
    const { control, session } = makeFixture(async () => ({ thinkingLevel: undefined }))
    const result = await control.setThinkingLevel('s1', 'low')
    expect(result).toBe('low')
    expect(session.thinkingLevel).toBe('low')
  })

  it('无活跃进程不再「请求值兜底 + 直写」假成功 → 激活失败显性化', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fixture = makeFixture({
        ensureActiveImpl: async () => { throw new Error('no client') },
      })
      await expect(fixture.control.setThinkingLevel('s1', 'medium'))
        .rejects.toMatchObject({ code: SESSION_ACTIVATE_FAILED })
      expect(fixture.session.thinkingLevel).toBe('medium') // 未被本方法改写（保持原值）
      expect(fixture.client.setThinkingLevel).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-model-guards.test.ts
// ======================================================================

/** 被测函数消费的最小 provider 形态（ProviderInfo 的子集，避免构造无关字段）。 */
interface ProviderStub {  // oe-exempt:20261027:test:
  id: string
  models?: Array<{ id: string }>
  apiKeySet?: boolean
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
}


/**
 * 最小 configService stub——只实装被测函数消费的 listProviders()。
 * IConfigService 是大型接口，测试只注入单一依赖范围（与消费方测试的注入风格一致）。
 */
function makeConfigService(
  providers: ProviderStub[],
  listProvidersImpl?: () => ProviderStub[],
): IConfigService {
  return {
    listProviders: listProvidersImpl ?? (() => providers),
  } as unknown as IConfigService
}


/** console.warn spy 集中管理（fail-open 路径断言有痕 + 不污染测试输出）。 */
let warnSpy: ReturnType<typeof vi.spyOn> | undefined


function stubWarn(): ReturnType<typeof vi.spyOn> {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return warnSpy
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-model-guards', () => {
afterEach(() => {
  warnSpy?.mockRestore()
  warnSpy = undefined
})
describe('isModelInRegistry — 注册表派生视图判定', () => {
  it('configService 未注入（null）→ true（fail-open，落双因文案）', () => {
    expect(isModelInRegistry(null, 'p1', 'm1')).toBe(true)
  })

  it('provider 不在 listProviders → false（真不在注册表）', () => {
    const cs = makeConfigService([{ id: 'p2', models: [{ id: 'm2' }] }])
    expect(isModelInRegistry(cs, 'p1', 'm1')).toBe(false)
  })

  it('provider 在但 model 不在 → false', () => {
    const cs = makeConfigService([{ id: 'p2', models: [{ id: 'm2' }, { id: 'm3' }] }])
    expect(isModelInRegistry(cs, 'p2', 'm9')).toBe(false)
  })

  it('provider 与 model 均命中 → true', () => {
    const cs = makeConfigService([{ id: 'p2', models: [{ id: 'm2' }, { id: 'm3' }] }])
    expect(isModelInRegistry(cs, 'p2', 'm3')).toBe(true)
  })

  it('listProviders 抛错 → catch fail-open true，且 console.warn 有痕', () => {
    const warn = stubWarn()
    const cs = makeConfigService([], () => {
      throw new Error('catalog read failed')
    })
    expect(isModelInRegistry(cs, 'p1', 'm1')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('model registry check failed (fail-open)'),
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog read failed'))
  })
})
describe('providerHasCredential — 凭据齐备判定', () => {
  it('configService 未注入（null）→ true（fail-open）', () => {
    expect(providerHasCredential(null, 'p1')).toBe(true)
  })

  it('provider 缺失 → false', () => {
    const cs = makeConfigService([{ id: 'p2' }])
    expect(providerHasCredential(cs, 'p1')).toBe(false)
  })

  it('apiKeySet=true → true（apiKey 落盘，authMethod 无关）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: true }])
    expect(providerHasCredential(cs, 'p1')).toBe(true)
  })

  it('apiKeySet=false 但 authMethod=ambient → true（凭据由 pi 运行时解析）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false, authMethod: 'ambient' }])
    expect(providerHasCredential(cs, 'p1')).toBe(true)
  })

  it('apiKeySet=false 但 authMethod=env_var → true（$ENV 引用形态）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false, authMethod: 'env_var' }])
    expect(providerHasCredential(cs, 'p1')).toBe(true)
  })

  it('apiKeySet=false 且 authMethod 非上述两形态 → false（api_key 形态）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false, authMethod: 'api_key' }])
    expect(providerHasCredential(cs, 'p1')).toBe(false)
  })

  it('apiKeySet=false 且 authMethod 未标注 → false', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false }])
    expect(providerHasCredential(cs, 'p1')).toBe(false)
  })

  it('listProviders 抛错 → catch fail-open true，且 console.warn 有痕', () => {
    const warn = stubWarn()
    const cs = makeConfigService([], () => {
      throw new Error('auth.json unreadable')
    })
    expect(providerHasCredential(cs, 'p1')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('credential check failed (fail-open)'),
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auth.json unreadable'))
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/model-override-query.test.ts
// ======================================================================

let tmpDir: string


/** 最小 deps：数据根指到测试注入的目录（两域目录都由分区键 sessionId 派生，
 *  [session-store-layout-inversion D2/D3] 无需 sessionStore 定位锚）。 */
function makeQuery(_scanResult: Array<{ id: string; cwd?: string; filePath?: string }> = []) {
  void _scanResult
  return createModelOverrideQuery({ dataDir: tmpDir })
}


/** 事件文件首行头行（与 core toRecordEventHeader 落盘形态同构；该符号未出 barrel，此处字面同形）。 */
function recordEventsHeaderLine(recordId: string): string {
  return JSON.stringify({ type: 'record-events', id: recordId })
}


/** record 事件文件写入口（头行 + 事件行，与 core createRecordEventStream 落盘形态同构）。 */
function writeRecordEventsFile(recordsDir: string, recordId: string, events: Array<Record<string, unknown>>): string {
  mkdirSync(recordsDir, { recursive: true })
  const filePath = recordEventsPath(recordsDir, recordId)
  const lines = [recordEventsHeaderLine(recordId), ...events.map((e) => JSON.stringify(e))]
  writeFileSync(filePath, lines.join('\n') + '\n')
  return filePath
}


function overrideEvent(seq: number, provider: string, modelId: string, thinkingLevel?: string): Record<string, unknown> {
  return {
    type: 'record-model-override',
    seq,
    ts: 1000 + seq,
    ref: { provider, modelId },
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    setAt: 1000 + seq,
  }
}


/** run journal 写入口（行 = run 事件帧；parser 逐行独立，无头行形态）。 */
function writeRunJournal(runsDir: string, runId: string, lines: Array<Record<string, unknown>>): string {
  mkdirSync(runsDir, { recursive: true })
  const filePath = join(runsDir, `${runId}${RUN_EVENTS_SUFFIX}`)
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return filePath
}


/** run journal 目录（`<root>/<sid>/workflow/runs/`，root = 测试注入的数据根）。 */
function runRunsDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'ext-sessions', sessionId, 'workflow', 'runs')
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-override-query', () => {
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'model-override-query-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('getRecordOverride — chat 域记录覆盖查询', () => {
  it('覆盖帧在场 → wire 状态（canonical ref 串 + thinkingLevel 透传）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
    writeRecordEventsFile(recordsDir, 'sa-1', [
      { type: 'record-created', seq: 1, ts: 1, id: 'sa-1', agent: 'w', task: 't', slug: 'w', origin: 'tool', rootSessionId: 'main-1', depth: 0, mode: 'background', startedAt: 1 },
      overrideEvent(2, 'p-new', 'm-new', 'high'),
    ])
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toEqual({ model: 'p-new/m-new', thinkingLevel: 'high' })
  })

  it('多条覆盖帧 → 尾向最新胜出（后写整替，不变量 2）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
    writeRecordEventsFile(recordsDir, 'sa-1', [
      overrideEvent(1, 'p-a', 'm-a'),
      overrideEvent(2, 'p-b', 'm-b'),
      overrideEvent(3, 'p-c', 'm-c'),
    ])
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toEqual({ model: 'p-c/m-c' })
  })

  it('无覆盖帧（事件文件只有 created）→ undefined（不造键）', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
    writeRecordEventsFile(recordsDir, 'sa-1', [
      { type: 'record-created', seq: 1, ts: 1, id: 'sa-1', agent: 'w', task: 't', slug: 'w', origin: 'tool', rootSessionId: 'main-1', depth: 0, mode: 'background', startedAt: 1 },
    ])
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toBeUndefined()
  })

  it('事件文件不存在（覆盖从未下达）→ undefined', () => {
    const query = makeQuery([{ id: 'main-1', cwd: '/w/never' }])
    expect(query.getRecordOverride('main-1', 'sa-404')).toBeUndefined()
  })

  it('session 不在扫描结果 → undefined（定位锚缺席）', () => {
    const query = makeQuery([])
    expect(query.getRecordOverride('ghost', 'sa-1')).toBeUndefined()
  })

  it('尾部半写残行（无换行结尾）按坏行跳过，命中更早的合法覆盖帧', () => {
    const cwd = '/w/proj'
    const recordsDir = getSubagentRecordsDir('main-1', tmpDir)
    const filePath = recordEventsPath(recordsDir, 'sa-1')
    mkdirSync(recordsDir, { recursive: true })
    const lines = [
      recordEventsHeaderLine('sa-1'),
      JSON.stringify(overrideEvent(1, 'p-ok', 'm-ok')),
      '{"type":"record-model-override","seq":2,"ts":10', // 半写行（无尾随换行）
    ]
    writeFileSync(filePath, lines.join('\n'))
    const query = makeQuery([{ id: 'main-1', cwd }])
    expect(query.getRecordOverride('main-1', 'sa-1')).toEqual({ model: 'p-ok/m-ok' })
  })
})
describe('getRunOverride — run 域 journal 覆盖查询', () => {
  it('journal 覆盖帧在场 → wire 状态（session 存储树 runs 目录布局）', () => {
    const runsDir = runRunsDir(tmpDir, 'main-1')
    writeRunJournal(runsDir, 'run-1', [
      { type: 'model-override', seq: 2, ts: 10, model: { provider: 'p-run', modelId: 'm-run' }, thinkingLevel: 'low' },
    ])
    const query = makeQuery()
    expect(query.getRunOverride('main-1', 'run-1')).toEqual({ model: 'p-run/m-run', thinkingLevel: 'low' })
  })

  it('无覆盖帧 / journal 不存在 → undefined（ENOENT = 合法缺省，静默不 warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const query = makeQuery()
      expect(query.getRunOverride('main-1', 'run-404')).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('journal stat 失败（EACCES 非 ENOENT）→ warn 留痕后 undefined（不静默同判无覆盖）', () => {
    const runsDir = runRunsDir(tmpDir, 'main-1')
    mkdirSync(runsDir, { recursive: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      chmodSync(runsDir, 0o000) // 父目录无搜索权限 → statSync(journal) EACCES
      const query = makeQuery()
      expect(query.getRunOverride('main-1', 'run-1')).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('stat failed')
    } finally {
      // 权限恢复先于自删（chmod 000 目录 rm 枚举会 EACCES，session-scan-degraded-tolerance 同款）
      chmodSync(runsDir, 0o755)
      warnSpy.mockRestore()
    }
  })

  it('非法 runId（路径穿越形态）→ warn 留痕（run id rejected）后 undefined', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const query = makeQuery()
      expect(query.getRunOverride('main-1', '../evil')).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('run id rejected')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('覆盖帧早于 256KB 尾读窗口起点（尾部被 worker-log 堆积淹没）→ undefined（miss = 按无覆盖显示、不虚报、无报错）', () => {
    const runsDir = runRunsDir(tmpDir, 'main-1')
    mkdirSync(runsDir, { recursive: true })
    const journalPath = join(runsDir, `run-1${RUN_EVENTS_SUFFIX}`)
    // 覆盖帧在文件头 + worker-log 堆积 >256KB 在后：尾读窗口（OVERRIDE_TAIL_WINDOW_KB）
    // 起点落在堆积段内、覆盖帧出窗 → 窗口内无命中（代码注释登记的 miss 语义）。
    const head = `${JSON.stringify({ type: 'model-override', seq: 2, ts: 10, model: { provider: 'p-run', modelId: 'm-run' } })}\n`
    const fillerLines: string[] = []
    let fillerBytes = 0
    let seq = 3
    while (fillerBytes <= 256 * 1024) {
      const line = JSON.stringify({ type: 'worker-log', seq, ts: 11, entry: { level: 'warn', message: 'x'.repeat(200) } })
      fillerLines.push(line)
      fillerBytes += line.length + 1
      seq += 1
    }
    writeFileSync(journalPath, head + fillerLines.join('\n') + '\n')
    const query = makeQuery()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(query.getRunOverride('main-1', 'run-1')).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('record 事件文件后缀与 run journal 后缀互不混用（RECORD_EVENTS_SUFFIX ≠ RUN_EVENTS_SUFFIX）', () => {
    expect(RECORD_EVENTS_SUFFIX).toBe('.events')
    expect(RUN_EVENTS_SUFFIX).toBe('.record.jsonl')
  })
})
describe('两域目录派生（[session-store-layout-inversion D2/D3] 分区键 = sessionId）', () => {
  it('run journal 落 session 存储树 runs 目录（不经会话文件路径反推）', () => {
    writeRunJournal(runRunsDir(tmpDir, 'main-2'), 'run-9', [
      { type: 'model-override', seq: 1, ts: 5, model: { provider: 'p-run', modelId: 'm-run' } },
    ])
    const query = makeQuery()
    expect(query.getRunOverride('main-2', 'run-9')).toEqual({ model: 'p-run/m-run' })
  })

  it('窄口第三参（resolved 定位锚）对 run 域不再影响落点（布局反转后无定位必需项）', () => {
    writeRunJournal(runRunsDir(tmpDir, 'main-3'), 'run-1', [
      { type: 'model-override', seq: 1, ts: 5, model: { provider: 'p-run', modelId: 'm-run' } },
    ])
    const query = makeQuery()
    // 传入空锚 / 传入会话文件路径锚：结果一致（目录由 sid 派生，与锚无关）
    expect(query.getRunOverride('main-3', 'run-1', {})).toEqual({ model: 'p-run/m-run' })
    expect(query.getRunOverride('main-3', 'run-1', { filePath: join(tmpDir, 'elsewhere.jsonl') })).toEqual({
      model: 'p-run/m-run',
    })
    // 非归属 sid 的锚不得把请求路由到别处的 journal
    expect(query.getRunOverride('main-other', 'run-1', { filePath: join(tmpDir, 'elsewhere.jsonl') })).toBeUndefined()
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/mode-prompt-spawn-options.test.ts
// ======================================================================

// getSessionsDir 指向测试 tmp（fork 产物真实写入；不碰真实数据目录）
const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})


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
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now() }
}


/** 会话文件行集：header + u1 + a1（fork 树回溯用）。 */
function makeLines(cwd: string): string[] {
  return [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-src', timestamp: '2026-09-01T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
  ]
}


interface EnvOptions {  // oe-exempt:20261027:test:
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
  }
  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, svc, pm, createSession, resolveCalls }
}


/** 取本路径 spawn pi 时传入的 options（createSession 第三参）。 */
function spawnOptions(createSession: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(createSession).toHaveBeenCalledTimes(1)
  return createSession.mock.calls[0]![2] as Record<string, unknown>
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mode-prompt-spawn-options', () => {
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
});

// ======================================================================
// ← src/services/session/__tests__/launch-params.test.ts
// ======================================================================

const expandHomeMock = vi.hoisted(() => vi.fn((p: string) => p))

vi.mock('../../../utils/path-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/path-utils.js')>()
  return { ...actual, expandHome: expandHomeMock }
})


function makeConfigStore(paths: string[]): IConfigStore {
  return { getSkillPaths: () => paths } as unknown as IConfigStore
}


function makePresetService(presets: Record<string, unknown>, resolveImpl?: (preset: unknown, cwd: string) => PresetResolution): PresetServiceType {
  const impl = resolveImpl ?? ((preset: unknown) => preset as PresetResolution)
  return {
    getPreset: (id: string) => presets[id],
    // 真实 PresetService.resolve 是 async：fake 必须同为 async。同步 fake 会让
    // resolveLaunchPresetOptions 里「漏 await」不可观测（回落分支 `{ ...resolution }`
    // 展开 Promise 得空壳、静默丢字段，而本文件仍全绿）[HISTORICAL]
    resolve: async (preset: unknown, cwd: string) => impl(preset, cwd),
  } as unknown as PresetServiceType
}


/** L2 探针 create 链测试环境：SessionLifecycle + mock pi client（getState 可编程）。 */
function makeL2Env() {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(),
    })),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    getActiveSummaries: vi.fn(() => []),
  }
  const getState = vi.fn(async (): Promise<Record<string, unknown>> => ({ sessionId: 'sess-1', sessionFile: undefined }))
  const client = {
    getState,
    setSessionName: vi.fn(async () => undefined),
  }
  const createSession = vi.fn(async (_id: string, _cwd: string, _opts?: unknown) => client)
  const pm = {
    createSession,
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, getState }
}


// ── ⛔ 探针 P2（D3 前提，state-truth-sync U3）─────────────────────────

/**
 * P2 探针环境：真实 PresetService（真实 pi-presets.json 读盘 + mergePresets）+
 * 真实 ExtensionService（真实 resolveExtensions/dedupe/applyPresetMode 过滤链，仅
 * resolver/extSettings 两个数据 port fake）+ SessionLifecycle 真实 resolveCreateLaunch
 * 编排——spawn 参数经 mock pm.createSession 捕获，持久化路径经 fake sessionStore 捕获。
 *
 * 扩展布局（真实目录 + 真实 package.json，让 readPkgMeta/tier/loadable 推导真跑）：
 *   normal-a（settings 源，可加载）/ normal-b（settings 源，disabled）/ normal-c（discovery 源）
 * → 预期 loadable 列表 = [normal-a, normal-c]（顺序 = discovered 顺序）。
 */
function makeP2Env(userPresetsFile?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'p2-env-'))
  const configDir = join(root, 'config')
  mkdirSync(configDir)
  if (userPresetsFile !== undefined) {
    writeFileSync(join(configDir, 'pi-presets.json'), JSON.stringify(userPresetsFile))
  }
  // 真实扩展目录
  const makeExt = (name: string): string => {
    const dir = join(root, name)
    mkdirSync(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
    return dir
  }
  const extA = makeExt('normal-a')
  const extB = makeExt('normal-b')
  const extC = makeExt('normal-c')
  const discovered: DiscoveredExtension[] = [
    { path: extA, source: 'settings' },
    { path: extB, source: 'settings' },
    { path: extC, source: 'discovery' },
  ]
  // 数据 port fake：resolver 只注入发现的目录集合（过滤链真实），settings 注入 disabled 名单
  const resolver = {
    resolve: () => ({ extensionDirs: discovered }),
    isValidPiExtension: () => true,
  } as unknown as IExtensionResolver
  const extSettings = {
    getPackages: () => [],
    getDisabled: () => ['npm:normal-b'],
  } as unknown as IExtensionSettings
  const extService = new ExtensionService({
    settingsDir: configDir,
    projectRoot: root,
    packaged: false,
    installer: {} as IInstaller,
    resolver,
    extensionSettings: extSettings,
    extensionsDir: join(root, 'ext-user'),
    npmDir: join(root, 'ext-npm'),
    tmpDir: join(root, 'ext-tmp'),
  })
  const presetService = new PresetService(
    { getConfigDir: () => configDir } as unknown as IConfigStore,
    extService,
  )
  // skill 目录（真实存在，resolveSkillPaths 存在性过滤真跑）
  const skillDir = join(root, 'skills')
  mkdirSync(skillDir)
  const configStore = {
    getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }),
    getSkillPaths: () => [skillDir],
  } as unknown as IConfigStore
  // 真实存在的 pi session 文件（P2 探针环境模拟已 flush 的 session；persistPresetBinding
  // 经 sessionStore mock 注入，真实文件仅为环境真实性——V9-④ 从根源修复后 create 路径已放行
  // existsSync 检查，不再依赖文件存在性）
  const sessionFile = join(root, 'pi-session.jsonl')
  writeFileSync(sessionFile, '{"type":"session"}\n')
  // svc 三方法委托真实实现链（resolveCreateLaunch 编排真实执行）
  const svc: ILifecycleSessionOps = {
    getLaunchPresetOptions: (presetId: string, cwd: string) => resolveLaunchPresetOptions(presetService, presetId, cwd),
    getExtensionPaths: (cwd: string) => resolveExtensionPaths(extService, cwd),
    getSkillPaths: (cwd: string) => resolveSkillPaths(configStore, cwd),
    getReplaceSystemPrompt: () => undefined,
    toSummary: (s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: 'test', cwd: s.cwd, status: 'idle', lastActiveAt: Date.now(),
      // launchPresetId 已收编进 IManagedSessionView（types.ts），直接读
      launchPresetId: s.launchPresetId,
    }),
    notifySessionCreated: vi.fn(),
    findScannedSession: () => undefined,
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    getActiveSummaries: vi.fn(() => []),
  }
  const getState = vi.fn(async () => ({ sessionId: 'sess-p2', sessionFile }))
  const client = { getState, setSessionName: vi.fn(async () => undefined) }
  const createSession = vi.fn(async (_id: string, _cwd: string, _opts?: unknown) => client)
  const pm = {
    createSession,
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager
  const sessionStore = {
    refreshAll: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return {
    lifecycle,
    createSession,
    persistPresetBinding: sessionStore.persistPresetBinding as ReturnType<typeof vi.fn>,
    cwd: root,
    skillDir,
    extA,
    extC,
    sessionFile,
    presetService,
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('launch-params', () => {
describe('resolveSkillPaths', () => {
  beforeEach(() => { expandHomeMock.mockImplementation((p: string) => p) })

  it('相对路径按 session cwd resolve 成绝对路径，不存在路径过滤掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-params-test-'))
    mkdirSync(join(dir, 'project-skills'))
    const result = resolveSkillPaths(
      makeConfigStore(['./project-skills', './missing-skill']),
      dir,
    )
    expect(result).toEqual([resolve(dir, 'project-skills')])
  })

  it('绝对路径直通（不与 cwd resolve）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-params-test-'))
    mkdirSync(join(dir, 'global-skills'))
    const absolute = join(dir, 'global-skills')
    const result = resolveSkillPaths(makeConfigStore([absolute]), '/other/cwd')
    expect(result).toEqual([absolute])
  })

  it('~ 前缀先 expandHome 展开再判绝对性（R1：相对 cwd 错位修复）', () => {
    const home = mkdtempSync(join(tmpdir(), 'fake-home-'))
    mkdirSync(join(home, 'agents-skills')) // 展开后的绝对路径真实存在（存在性过滤真跑）
    expandHomeMock.mockImplementation((p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p))
    const result = resolveSkillPaths(makeConfigStore(['~/agents-skills']), '/session/cwd')
    // 展开后是绝对路径，不再 resolve(cwd, ...) 错位
    expect(result).toEqual([join(home, 'agents-skills')])
  })
})
describe('resolveExtensionPaths', () => {
  it('正常透传 ExtensionService 结果', async () => {
    const ext = { getExtensionPaths: vi.fn(async () => ['/a', '/b']) } as unknown as IExtensionService
    await expect(resolveExtensionPaths(ext, '/cwd')).resolves.toEqual(['/a', '/b'])
    expect(ext.getExtensionPaths).toHaveBeenCalledWith('/cwd')
  })

  it('打包产物断链（BUILTIN_EXTENSIONS_MISSING）rethrow 不降级（fail-fast）', async () => {
    const err = Object.assign(new Error('builtin staged dir missing'), { code: 'BUILTIN_EXTENSIONS_MISSING' })
    const ext = { getExtensionPaths: vi.fn(async () => { throw err }) } as unknown as IExtensionService
    await expect(resolveExtensionPaths(ext)).rejects.toBe(err)
  })

  it('「无可装扩展」（resolve 出空列表）保持 no-op 返回 []（合法两态之一）', async () => {
    const ext = { getExtensionPaths: vi.fn(async () => []) } as unknown as IExtensionService
    await expect(resolveExtensionPaths(ext)).resolves.toEqual([])
  })

  it('[RT-4#5] 装载器异常 rethrow（与 BUILTIN_MISSING 同族 fail-fast），消息带恢复指引', async () => {
    const cause = new Error('EACCES: discovery dir unreadable')
    const ext = { getExtensionPaths: vi.fn(async () => { throw cause }) } as unknown as IExtensionService
    const rejection = await resolveExtensionPaths(ext).then(
      () => { throw new Error('should reject') },
      (e: unknown) => e,
    )
    // 不可与「无可装扩展」（上例 no-op []）同形：错误冒泡 + 原始异常保留 + 恢复指引内嵌
    expect(rejection).toBeInstanceOf(Error)
    const msg = (rejection as Error).message
    expect(msg).toContain('extension loader failed')
    expect(msg).toContain('recovery:')
    expect((rejection as Error).cause).toBe(cause)
  })
})
describe('resolveReplaceSystemPrompt', () => {
  it('未注入 ConfigService → undefined（pi 走默认系统提示词）', () => {
    expect(resolveReplaceSystemPrompt(null)).toBeUndefined()
    expect(resolveReplaceSystemPrompt(undefined)).toBeUndefined()
  })

  it('注入时委托 ConfigService.getReplaceSystemPrompt', () => {
    const config = { getReplaceSystemPrompt: () => 'custom prompt' } as unknown as IConfigService
    expect(resolveReplaceSystemPrompt(config)).toBe('custom prompt')
  })
})
describe('resolveEffectiveSystemPrompt / resolveAppendSystemPrompt（D3 优先级取值 helper）', () => {
  /**
   * 最小 resolution 形状（仅 prompt 面参与本组断言）。
   *
   * flags 两个必填字段显式补全（不用 `as` 断言）：`flags: {}` 会让字面量类型与
   * PresetResolution 的重叠不足 → TS2352，而补全后字面量**本就**可赋给 PresetResolution
   * （skillPaths 可为 undefined / toolArgs 全可选 / prompt 可选）——去掉断言让 fixture 保留
   * 对真实类型的编译期强度，不用 `as` 绕过。
   */
  function resolution(prompt?: PresetResolution['prompt']): PresetResolution {
    return { skillPaths: undefined, extensionPaths: [], toolArgs: {}, flags: { noSkills: false, noContextFiles: false }, prompt }
  }

  it('模式 replace 启用且非空 → 返回模式文本（全局值被压）', () => {
    const r = resolution({ replace: { enabled: true, prompt: '模式替换' } })
    expect(resolveEffectiveSystemPrompt(r, '全局替换')).toBe('模式替换')
  })

  it('模式 replace 未启用 / 文本空白 / 未配置 / resolution 缺失 → 回落全局值', () => {
    expect(resolveEffectiveSystemPrompt(resolution({ replace: { enabled: false, prompt: '模式替换' } }), '全局替换')).toBe('全局替换')
    expect(resolveEffectiveSystemPrompt(resolution({ replace: { enabled: true, prompt: '   \n ' } }), '全局替换')).toBe('全局替换')
    expect(resolveEffectiveSystemPrompt(resolution({}), '全局替换')).toBe('全局替换')
    expect(resolveEffectiveSystemPrompt(undefined, '全局替换')).toBe('全局替换')
  })

  it('模式 replace 启用且非空但全局未配置 → 模式文本；两侧皆无 → undefined（pi 默认）', () => {
    expect(resolveEffectiveSystemPrompt(resolution({ replace: { enabled: true, prompt: '模式替换' } }), undefined)).toBe('模式替换')
    expect(resolveEffectiveSystemPrompt(resolution({}), undefined)).toBeUndefined()
    expect(resolveEffectiveSystemPrompt(undefined, undefined)).toBeUndefined()
  })

  it('模式 append 启用且非空 → 文本；未启用 / 空白 / 未配置 / resolution 缺失 → undefined（无全局对手）', () => {
    expect(resolveAppendSystemPrompt(resolution({ append: { enabled: true, prompt: '模式追加' } }))).toBe('模式追加')
    expect(resolveAppendSystemPrompt(resolution({ append: { enabled: false, prompt: '模式追加' } }))).toBeUndefined()
    expect(resolveAppendSystemPrompt(resolution({ append: { enabled: true, prompt: '  \n ' } }))).toBeUndefined()
    expect(resolveAppendSystemPrompt(resolution({}))).toBeUndefined()
    expect(resolveAppendSystemPrompt(undefined)).toBeUndefined()
  })

  it('append 与 replace 互不影响：仅 append 启用时替换仍回落全局', () => {
    const r = resolution({ append: { enabled: true, prompt: '追加' } })
    expect(resolveEffectiveSystemPrompt(r, '全局替换')).toBe('全局替换')
    expect(resolveAppendSystemPrompt(r)).toBe('追加')
  })

  it('取值阶段不加 \\n 前缀（前缀统一落在 spawn-args argv 拼装处，两条通道同处覆盖）', () => {
    expect(resolveEffectiveSystemPrompt(resolution({ replace: { enabled: true, prompt: 'AGENTS.md' } }), undefined)).toBe('AGENTS.md')
    expect(resolveAppendSystemPrompt(resolution({ append: { enabled: true, prompt: 'AGENTS.md' } }))).toBe('AGENTS.md')
  })
})
describe('resolveLaunchPresetOptions', () => {
  it('presetService 未注入 → undefined', async () => {
    await expect(resolveLaunchPresetOptions(null, 'p1', '/cwd')).resolves.toBeUndefined()
  })

  it('preset 存在 → PresetService.resolve(preset, cwd)', async () => {
    const resolution = {} as PresetResolution
    const resolveSpy = vi.fn(() => resolution)
    const svc = makePresetService({ 'builtin:minimal': { id: 'builtin:minimal' } }, resolveSpy)
    await expect(resolveLaunchPresetOptions(svc, 'builtin:minimal', '/cwd')).resolves.toBe(resolution)
    expect(resolveSpy).toHaveBeenCalledWith({ id: 'builtin:minimal' }, '/cwd')
  })

  it('preset 被删/失效 → fallback builtin:full（全工具模式兜底，§4.3）+ 回落事实随 resolution 上抛（F1/E4）', async () => {
    const full = { id: 'builtin:full' }
    const resolveSpy = vi.fn((preset: unknown) => preset as PresetResolution)
    const svc = makePresetService({ 'builtin:full': full }, resolveSpy)
    const resolution = await resolveLaunchPresetOptions(svc, 'deleted-preset', '/cwd')
    // 回落事实（原悬空 id）——restore 路径据此置 SessionSummary.launchPresetFallbackTo 披露
    expect(resolution?.fellBackFromPresetId).toBe('deleted-preset')
    // 其余字段仍是 builtin:full 的 resolve 产物（回落语义不变）
    expect(resolution).toMatchObject(full)
    expect(resolveSpy).toHaveBeenCalledWith(full, '/cwd')
  })

  it('preset 存在 → 不附回落事实（fellBackFromPresetId undefined，且保持 resolve 对象同一性）', async () => {
    const resolution = {} as PresetResolution
    const resolveSpy = vi.fn(() => resolution)
    const svc = makePresetService({ 'mode-live': { id: 'mode-live' } }, resolveSpy)
    const result = await resolveLaunchPresetOptions(svc, 'mode-live', '/cwd')
    expect(result?.fellBackFromPresetId).toBeUndefined()
    // 无回落不新建对象（既有 .toBe 身份断言与调用方不变）
    expect(result).toBe(resolution)
  })

  it('builtin:full 也取不到（理论不可达）→ undefined', async () => {
    const svc = makePresetService({})
    await expect(resolveLaunchPresetOptions(svc, 'p1', '/cwd')).resolves.toBeUndefined()
  })
})
describe('buildPresetFallbackEnv（F1b：回落事实 → pi 出站 env）', () => {
  it('回落 → FROM=原悬空 id / TO=builtin:full（两键齐备，trace 据此记 presetFallback）', () => {
    const resolution = { fellBackFromPresetId: 'custom:gone-uuid' } as PresetResolution
    expect(buildPresetFallbackEnv(resolution)).toEqual({
      [PRESET_FALLBACK_ENV_KEYS.FROM]: 'custom:gone-uuid',
      [PRESET_FALLBACK_ENV_KEYS.TO]: 'builtin:full',
    })
  })

  it('未回落 / resolution undefined → 两键写空串（显式清除父 env 可能继承的陈旧值，防假披露）', () => {
    const empty = {
      [PRESET_FALLBACK_ENV_KEYS.FROM]: '',
      [PRESET_FALLBACK_ENV_KEYS.TO]: '',
    }
    expect(buildPresetFallbackEnv(undefined)).toEqual(empty)
    expect(buildPresetFallbackEnv({} as PresetResolution)).toEqual(empty)
  })

  it('键名与 shared SSOT 一致（写读两侧字面量镜像的权威端）', () => {
    expect(PRESET_FALLBACK_ENV_KEYS.FROM).toBe('TAIJI_PRESET_FALLBACK_FROM')
    expect(PRESET_FALLBACK_ENV_KEYS.TO).toBe('TAIJI_PRESET_FALLBACK_TO')
  })
})
describe('buildPresetClientOptions', () => {
  /** 最小 resolution 形状（消费方字段）。 */
  function resolution(overrides: Partial<PresetResolution> = {}): PresetResolution {
    return {
      skillPaths: [],
      extensionPaths: [],
      toolArgs: {},
      flags: {},
      ...overrides,
    } as PresetResolution
  }

  it('resolution 与 override 全空 → 空对象（仅 override 生效语义的边界）', () => {
    expect(buildPresetClientOptions(undefined, undefined, undefined)).toEqual({})
  })

  it('preset 字段条件 spread：undefined/false 不出现（空数组是 truthy，按现状会透传）', () => {
    const result = buildPresetClientOptions(resolution({
      toolArgs: { tools: ['bash'], excludeTools: [] },
      flags: { noSkills: true, noContextFiles: false },
    }), undefined, undefined)
    expect(result).toEqual({ tools: ['bash'], excludeTools: [], noSkills: true })
    expect('noContextFiles' in result).toBe(false)
  })

  it('C-RL-6 优先序：Landing override > preset 同名字段', () => {
    const result = buildPresetClientOptions(
      resolution({ modelOverride: 'preset/model', thinkingLevel: 'high' } as Partial<PresetResolution>),
      'landing/model',
      'low',
    )
    expect(result.model).toBe('landing/model')
    expect(result.thinkingLevel).toBe('low')
  })

  it('override 缺省时继承 preset 字段', () => {
    const result = buildPresetClientOptions(
      resolution({ modelOverride: 'preset/model', thinkingLevel: 'high' } as Partial<PresetResolution>),
      undefined,
      undefined,
    )
    expect(result.model).toBe('preset/model')
    expect(result.thinkingLevel).toBe('high')
  })

  it('S-RT-5：非法 thinking 值（override 或 preset 侧）warn 后忽略（不透传，pi 对非法档位不报错只 warning）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // override 侧非法值
      const fromOverride = buildPresetClientOptions(undefined, undefined, 'ultra-max' as never)
      expect(fromOverride.thinkingLevel).toBeUndefined()
      expect(fromOverride).toEqual({})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid thinking level'))
      // preset 侧非法值（Landing 未传 override 时 preset 字段直达本函数）
      warn.mockClear()
      const fromPreset = buildPresetClientOptions(
        { toolArgs: {}, flags: {}, thinkingLevel: 'ultra-max' } as unknown as PresetResolution,
        undefined,
        undefined,
      )
      expect(fromPreset.thinkingLevel).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid thinking level'))
    } finally {
      warn.mockRestore()
    }
  })

  it('空串 thinking 值 → 不落字段（不在词表，同走非法值路径）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = buildPresetClientOptions(undefined, undefined, '' as never)
      expect(result.thinkingLevel).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('noTools 真值映射为 true（flag 布尔语义）', () => {
    const result = buildPresetClientOptions(resolution({
      toolArgs: { noTools: true },
    }), undefined, undefined)
    expect(result.noTools).toBe(true)
  })
})
// ── L2 对账探针（D7/E6，state-truth-sync U3）──────────────────────────

describe('warnLaunchEffectiveMismatch（L2 探针纯函数）', () => {
  it('两字段皆不一致 → warn 恰一次，格式含 requested/effective 两侧值', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnLaunchEffectiveMismatch(
        { model: 'p/m1', thinkingLevel: 'high' },
        { modelId: 'p/m2', thinkingLevel: 'low' },
      )
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        '[launch-config] effective mismatch: requested=p/m1,high effective=p/m2,low',
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('两字段皆一致 → 无 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnLaunchEffectiveMismatch(
        { model: 'p/m', thinkingLevel: 'high' },
        { modelId: 'p/m', thinkingLevel: 'high' },
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('仅 thinking 不一致 → warn（model 一致不拦触发）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnLaunchEffectiveMismatch(
        { model: 'p/m', thinkingLevel: 'high' },
        { modelId: 'p/m', thinkingLevel: 'low' },
      )
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('requested=p/m,high'))
    } finally {
      warn.mockRestore()
    }
  })

  it('requested 字段 undefined 跳过该字段（create 未传 override 不比，agent-managed 形态）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnLaunchEffectiveMismatch({}, { modelId: 'pi/default', thinkingLevel: 'off' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('读回侧缺失（undefined）不判 mismatch——无法断定漂移不记', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnLaunchEffectiveMismatch(
        { model: 'p/m', thinkingLevel: 'high' },
        { modelId: undefined, thinkingLevel: undefined },
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
describe('L2 探针 create 链（readBackCreateState 消费）', () => {
  beforeEach(() => { setMigrationGate(Promise.resolve()) })

  it('读回值 ≠ create 入参 override → warn 单行结构化（requested=入参 effective=读回）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { lifecycle, getState } = makeL2Env()
      getState.mockResolvedValue({
        sessionId: 'sess-1', sessionFile: undefined,
        model: { provider: 'p', id: 'other' }, thinkingLevel: 'low',
      })
      const cwd = mkdtempSync(join(tmpdir(), 'l2-mismatch-'))
      await lifecycle.create(cwd, 't', { modelOverride: 'p/m', thinkingOverride: 'high' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        '[launch-config] effective mismatch: requested=p/m,high effective=p/other,low',
      )
    } finally {
      warn.mockRestore()
      setMigrationGate(Promise.resolve())
    }
  })

  it('读回值 = create 入参 → 无 warn（正常路径零噪音）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { lifecycle, getState } = makeL2Env()
      getState.mockResolvedValue({
        sessionId: 'sess-1', sessionFile: undefined,
        model: { provider: 'p', id: 'm' }, thinkingLevel: 'high',
      })
      const cwd = mkdtempSync(join(tmpdir(), 'l2-match-'))
      await lifecycle.create(cwd, 't', { modelOverride: 'p/m', thinkingOverride: 'high' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      setMigrationGate(Promise.resolve())
    }
  })

  it('不传 override（agent-managed create 形态）→ 无 warn（requested 侧跳过）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { lifecycle, getState } = makeL2Env()
      getState.mockResolvedValue({
        sessionId: 'sess-1', sessionFile: undefined,
        model: { provider: 'p', id: 'default-model' }, thinkingLevel: 'off',
      })
      const cwd = mkdtempSync(join(tmpdir(), 'l2-nooverride-'))
      await lifecycle.create(cwd, 't', {})
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      setMigrationGate(Promise.resolve())
    }
  })
})
describe('⛔ 探针 P2（D3 前提）：出厂 builtin:full 与无 preset 路径 launch surface 等价', () => {
  beforeEach(() => { setMigrationGate(Promise.resolve()) })

  /**
   * 两存储场景（merge 路径真实，非 DEFAULT fixture 直用）：
   * 1. pi-presets.json 不存在 → loadPresetsFile 空骨架 + mergePresets 全 DEFAULT
   * 2. 用户保存过 builtin:full 副本（launch 字段=出厂值）+ 混入自定义预设 →
   *    mergePresets 字段级合并路径真实执行（覆写人群空转通过的反面场景）
   */
  const scenarios: Array<[string, unknown]> = [
    ['存储空（纯 DEFAULT merge）', undefined],
    ['用户覆写副本字段=出厂 + 混入自定义预设', {
      presets: [
        {
          id: 'builtin:full', name: '全工具模式', description: '所有工具和扩展可用，适合大部分任务',
          builtin: true, order: 0, toolMode: 'all', extensionMode: 'all',
        },
        {
          id: 'custom-1', name: '我的预设', builtin: false, order: 5,
          toolMode: 'denylist', deniedTools: ['bash'], extensionMode: 'all',
        },
      ],
    }],
  ]

  it.each(scenarios)('%s：带 override 组 spawn options 全字段相等', async (_name, userFile) => {
    try {
      // 同一 env 两次 create（路径同源可比；双 env 的 mkdtemp 前缀不同会让绝对路径面误红）
      const env = makeP2Env(userFile)
      await env.lifecycle.create(env.cwd, 't', { presetId: 'builtin:full', modelOverride: 'p/m', thinkingOverride: 'high' })
      await env.lifecycle.create(env.cwd, 't', { modelOverride: 'p/m', thinkingOverride: 'high' })

      const presetOpts = env.createSession.mock.calls[0][2] as Record<string, unknown>
      const bareOpts = env.createSession.mock.calls[1][2] as Record<string, unknown>
      // 完整 launch surface 一次对比：presetClientOptions 全字段（出厂 full 应无 tools 族字段，
      // model/thinkingLevel 来自 override）+ extensionPaths（含顺序，disabled 过滤后 [a, c]）
      // + skillPaths + systemPrompt
      expect(presetOpts).toEqual(bareOpts)
      expect(presetOpts.extensionPaths).toEqual([env.extA, env.extC])
      expect(presetOpts.skillPaths).toEqual([env.skillDir])
      expect(presetOpts.model).toBe('p/m')
      expect(presetOpts.thinkingLevel).toBe('high')
    } finally {
      setMigrationGate(Promise.resolve())
    }
  })

  it.each(scenarios)('%s：无 override 组 spawn options 全字段相等（preset 档全空）', async (_name, userFile) => {
    try {
      const env = makeP2Env(userFile)
      await env.lifecycle.create(env.cwd, 't', { presetId: 'builtin:full' })
      await env.lifecycle.create(env.cwd, 't', {})

      const presetOpts = env.createSession.mock.calls[0][2] as Record<string, unknown>
      const bareOpts = env.createSession.mock.calls[1][2] as Record<string, unknown>
      expect(presetOpts).toEqual(bareOpts)
      // 出厂 full 的 toolMode='all' → 无 tools/excludeTools/noTools 字段；
      // 无 modelOverride/thinkingLevel → 不透传 model/thinkingLevel（pi 走全局默认）
      expect(presetOpts.model).toBeUndefined()
      expect(presetOpts.thinkingLevel).toBeUndefined()
    } finally {
      setMigrationGate(Promise.resolve())
    }
  })

  it('merge 后 builtin:full 的 resolution 与无 preset 路径逐面直比（纯数据范围）', async () => {
    const env = makeP2Env()
    // 路径 A：merge 后 getPreset('builtin:full')（真实存储态）→ resolve 展开
    const preset = env.presetService.getPreset('builtin:full')
    expect(preset).toBeDefined()
    const resolution = await env.presetService.resolve(preset!, env.cwd)
    const presetClientOptions = buildPresetClientOptions(resolution, 'p/m', 'high')
    // 路径 B：无 preset
    const bareClientOptions = buildPresetClientOptions(undefined, 'p/m', 'high')

    // 面 1：presetClientOptions 全字段（出厂 full 无 tools/flags 字段，仅 override 透出）
    expect(presetClientOptions).toEqual(bareClientOptions)
    expect(presetClientOptions).toEqual({ model: 'p/m', thinkingLevel: 'high' })
    // 面 2：extensionPaths（含顺序）——preset 链 applyPresetMode('all') vs getExtensionPaths
    expect(resolution.extensionPaths).toEqual([env.extA, env.extC])
    // 面 3：skillPaths——出厂 full noSkills 未设 → resolution.skillPaths=undefined（create 侧
    // `resolution?.skillPaths ?? getSkillPaths(cwd)` 与无 preset 路径同一 fallback 表达式）
    expect(resolution.skillPaths).toBeUndefined()
  })

  it('持久化路径：唯一差异 = launchPresetId meta + .preset.json sidecar（D3 声明侧，无第三差异）', async () => {
    try {
      const presetEnv = makeP2Env()
      const presetSummary = await presetEnv.lifecycle.create(presetEnv.cwd, 't', { presetId: 'builtin:full' })
      const bareEnv = makeP2Env()
      const bareSummary = await bareEnv.lifecycle.create(bareEnv.cwd, 't', {})

      // meta 面：preset 路径 launchPresetId='builtin:full'，无 preset 路径 undefined；
      // 其余 meta（modelId/thinkingLevel）两路径一致（全局默认播种）——W3 起三状态
      // 字段不在 SessionSummary 上，同值断言改读 lifecycle 注册表记录（双写缓存同源）。
      expect(presetSummary.launchPresetId).toBe('builtin:full')
      expect(bareSummary.launchPresetId).toBeUndefined()
      const presetRecord = presetEnv.lifecycle.get(presetSummary.id)
      const bareRecord = bareEnv.lifecycle.get(bareSummary.id)
      expect(presetRecord?.modelId).toBe(bareRecord?.modelId)
      expect(presetRecord?.thinkingLevel).toBe(bareRecord?.thinkingLevel)
      // sidecar 面：.preset.json 写入条件 = presetId 存在（preset 写 / bare 不写）；
      // V9-④ 从根源修复后 create 路径携 skipJsonlExistsGuard 放行检查（.jsonl 未 flush 也落盘）
      expect(presetEnv.persistPresetBinding).toHaveBeenCalledWith(presetEnv.sessionFile, 'builtin:full', { skipJsonlExistsGuard: true })
      expect(bareEnv.persistPresetBinding).not.toHaveBeenCalled()
    } finally {
      setMigrationGate(Promise.resolve())
    }
  })
})
});
