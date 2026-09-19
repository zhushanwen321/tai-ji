/**
 * launch-params 直测（S6 迁出批 3）：pi 启动参数组装纯函数族——skill 路径解析
 * （cwd resolve + expandHome + 存在性过滤）、extension 路径（断链 fail-fast / 其余降级）、
 * 替换系统提示词、launch preset 解析（builtin:full fallback）、buildPresetClientOptions
 * 组装（C-RL-6 覆盖优先序 + S-RT-5 thinking 值域校验 + 条件 spread）。
 *
 * 另含两族探针（state-truth-sync U3）：
 * - L2 对账探针（D7/E6）：warnLaunchEffectiveMismatch 纯函数 + create 链消费
 *   （readBackCreateState 读回值 vs create 入参 override）。
 * - ⛔ P2 探针（D3 前提）：出厂 builtin:full（merge 后 getPreset，非 DEFAULT fixture）
 *   与无 preset 路径在完整 launch surface 等价——真实 PresetService + 真实
 *   ExtensionService 跑 resolveCreateLaunch 全链，对比 spawn options 全字段；
 *   不等价 → E8（阻断 D3 透传）。
 *
 * 分层（G2：import 无 session-service）：expandHome 经 vi.mock 可编程（家目录前缀场景），
 * existsSync / resolve / 值域校验等生产逻辑真实执行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const expandHomeMock = vi.hoisted(() => vi.fn((p: string) => p))
vi.mock('../../../utils/path-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/path-utils.js')>()
  return { ...actual, expandHome: expandHomeMock }
})

import {
  resolveSkillPaths,
  resolveExtensionPaths,
  resolveReplaceSystemPrompt,
  resolveEffectiveSystemPrompt,
  resolveAppendSystemPrompt,
  resolveLaunchPresetOptions,
  buildPresetFallbackEnv,
  buildPresetClientOptions,
  warnLaunchEffectiveMismatch,
} from '../launch-params.js'
import { SessionLifecycle, setMigrationGate } from '../session-lifecycle.js'
import { PresetService } from '../../preset-service.js'
import { ExtensionService } from '../../extension-service.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps, ManagedSession } from '../session-internal.js'
import type { IConfigStore } from '../../ports/config.js'
import type { IExtensionService, IConfigService } from '../../../interfaces.js'
import type { PresetService as PresetServiceType, PresetResolution } from '../../preset-service.js'
import type { IInstaller, IExtensionResolver, DiscoveredExtension } from '../../ports/installer.js'
import type { IExtensionSettings } from '../../ports/extension-settings.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IManagedSessionView } from '../types.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { SessionSummary } from '@taiji/shared'
import { PRESET_FALLBACK_ENV_KEYS } from '@taiji/shared'

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

  it('其余意外错误降级空列表（旧版兼容：不阻断会话）', async () => {
    const ext = { getExtensionPaths: vi.fn(async () => { throw new Error('flaky') }) } as unknown as IExtensionService
    await expect(resolveExtensionPaths(ext)).resolves.toEqual([])
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
  /** 最小 resolution 形状（消费面字段）。 */
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

  it('S-RT-5：非法 thinking 值（override 或 preset 侧）warn 后忽略', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = buildPresetClientOptions(
        undefined,
        undefined,
        'ultra-max' as never,
      )
      expect(result.thinkingLevel).toBeUndefined()
      expect(result).toEqual({})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid thinking level'))
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

/** L2 探针 create 链测试环境：SessionLifecycle + mock pi client（getState 可编程）。 */
function makeL2Env() {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0,
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
    notifyMessageComplete: () => {},
  }
  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, getState }
}

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

// ── ⛔ 探针 P2（D3 前提，state-truth-sync U3）─────────────────────────

/**
 * P2 探针环境：真实 PresetService（真实 pi-presets.json 读盘 + mergePresets）+
 * 真实 ExtensionService（真实 resolveExtensions/dedupe/applyPresetMode 过滤链，仅
 * resolver/extSettings 两个数据 port fake）+ SessionLifecycle 真实 resolveCreateLaunch
 * 编排——spawn 参数经 mock pm.createSession 捕获，持久化面经 fake sessionStore 捕获。
 *
 * 扩展布局（真实目录 + 真实 package.json，让 readPkgMeta/tier/loadable 推导真跑）：
 *   normal-a（settings 源，可加载）/ normal-b（settings 源，disabled）/ normal-c（discovery 源）
 * → 预期 loadable 列表 = [normal-a, normal-c]（顺序 = discovered 顺序）。
 */
function makeP2Env(userPresetsFile?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'p2-probe-'))
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
  // 经 sessionStore mock 注入，真实文件仅为环境真实性——V9-④ 根修后 create 路径已放行
  // existsSync 守卫，不再依赖文件存在性）
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
      modelId: s.modelId, tokenCount: 0,
      // binding 扩展字段经 as 读取（ManagedSession 既有 patch 模式，session-internal.ts）
      launchPresetId: (s as ManagedSession).launchPresetId,
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
    notifyMessageComplete: () => {},
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

  it('merge 后 builtin:full 的 resolution 与无 preset 路径逐面直比（纯数据面）', async () => {
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

  it('持久化面：唯一差异 = launchPresetId meta + .preset.json sidecar（D3 声明面，无第三差异）', async () => {
    try {
      const presetEnv = makeP2Env()
      const presetSummary = await presetEnv.lifecycle.create(presetEnv.cwd, 't', { presetId: 'builtin:full' })
      const bareEnv = makeP2Env()
      const bareSummary = await bareEnv.lifecycle.create(bareEnv.cwd, 't', {})

      // meta 面：preset 路径 launchPresetId='builtin:full'，无 preset 路径 undefined；
      // 其余 meta（modelId/thinkingLevel）两路径一致（全局默认播种）
      expect(presetSummary.launchPresetId).toBe('builtin:full')
      expect(bareSummary.launchPresetId).toBeUndefined()
      expect(presetSummary.modelId).toBe(bareSummary.modelId)
      expect(presetSummary.thinkingLevel).toBe(bareSummary.thinkingLevel)
      // sidecar 面：.preset.json 写入条件 = presetId 存在（preset 写 / bare 不写）；
      // V9-④ 根修后 create 路径携 skipJsonlExistsGuard 放行守卫（.jsonl 未 flush 也落盘）
      expect(presetEnv.persistPresetBinding).toHaveBeenCalledWith(presetEnv.sessionFile, 'builtin:full', { skipJsonlExistsGuard: true })
      expect(bareEnv.persistPresetBinding).not.toHaveBeenCalled()
    } finally {
      setMigrationGate(Promise.resolve())
    }
  })
})
