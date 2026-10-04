/**
 * wave3 组合根注入单测：SessionService.setPresetService + getLaunchPresetOptions 委托。
 *
 * 覆盖 4 个 testCase：
 *   - tc2: setPresetService 注入前 getLaunchPresetOptions 返 undefined；注入后委托 presetService
 *   - tc3: 未知 presetId 回落 builtin:full——返回完整 PresetResolution（与直接 resolve builtin:full
 *          逐字段相等）+ 附回落事实 fellBackFromPresetId（回归锁：曾因漏 await 让 `{ ...resolution }`
 *          展开 Promise → 只剩 fellBackFromPresetId 空壳，工具/扩展/提示词字段全丢）
 *   - tc4: builtin:full 正常 resolve，返回 PresetResolution 形状
 *   - tc1: PresetService 在组合根可构造（间接验证 index.ts 不抛错）
 *
 * mock 策略：SessionService 用最小 fake 依赖构造（pm/broker/adapterFactory/extensionService/
 * configStore/sessionStore/gitInfoReader/workspaceService 全部桩实现，参考 session-service.test.ts 模式）。
 * PresetService 用真实实现 + fake configStore（tmpdir）+ fake extensionService（wave2 mock 模式）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_PRESET_IDS, type ExtensionInfo } from '@taiji/shared'
import { PresetService } from '../src/services/preset-service.js'
import { SessionService } from '../src/services/session/session-service.js'
import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type { ServerMessage } from '@taiji/shared'

// ── fakes ────────────────────────────────────────────────────────

/** 最小 fake IProcessManager（只实现 SessionService 构造 + getLaunchPresetOptions 路径用到的）。 */
function makeFakePm(): IProcessManager {
  return {
    onSessionExit: () => {},
    getClient: () => undefined,
    hasClient: () => false,
    // 其余方法桩（SessionService 构造不调用，但类型需满足）
  } as unknown as IProcessManager
}

function makeFakeBroker(): IMessageBroker {
  return {
    send: () => {},
    broadcast: () => {},
    sendError: () => {},
  } as unknown as IMessageBroker
}

function makeFakeAdapterFactory() {
  return (_sessionId: string, _send: (msg: ServerMessage) => void, _cwd?: string): IEventAdapter =>
    ({ attach: () => {}, detach: () => {} } as unknown as IEventAdapter)
}

function makeFakeConfigStore(configDir: string): IConfigStore {
  return { getConfigDir: () => configDir } as unknown as IConfigStore
}

function makeFakeSessionStore(): ISessionStore {
  return {
    scanSessions: () => [],
    extractSessionOutcome: () => null,
    persistSessionEnd: () => {},
  } as unknown as ISessionStore
}

function makeFakeGitInfoReader(): IGitInfoReader {
  return { readGitInfo: () => undefined } as unknown as IGitInfoReader
}

function makeFakeWorkspaceService() {
  return {} as unknown as ConstructorParameters<typeof SessionService>[8]
}

/** wave2 同款 fake extensionService（可控 discovered/disabled）。
 * getDiscoveredAndDisabled 返回全部 userExts（enabled 和 disabled 都含，disabled 进 disabledSet），
 * resolveExtensionPaths 据此本地跑 resolveExtensions + applyPresetMode（builtin npm 化后无
 * 独立路径注入，infrastructure 包随 discovered 进入并由 applyPresetMode 保活）。 */
function makeFakeExtensionService(userExts: ExtensionInfo[]): IExtensionService {
  return {
    scanExtensions: async () => userExts,
    getExtensionPaths: async () => userExts.filter(e => e.enabled).map(e => e.path),
    getDiscoveredAndDisabled: async () => ({
      discovered: userExts.map(e => ({ path: e.path, source: 'user' as const })),
      disabledSet: new Set(userExts.filter(e => !e.enabled).map(e => `npm:${e.name}`)),
    }),
  } as unknown as IExtensionService
}

function makeExt(name: string, enabled: boolean): ExtensionInfo {
  return {
    name,
    displayName: name,
    dirName: name,
    version: '0.0.0-test',
    description: '',
    path: `/fake/ext/${name}`,
    enabled,
    source: 'user-installed',
  }
}

// ── setup ────────────────────────────────────────────────────────

let tmpDir: string
let sessionService: SessionService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'preset-composition-test-'))
  sessionService = new SessionService(
    makeFakePm(),
    makeFakeBroker(),
    makeFakeAdapterFactory(),
    tmpDir, // projectRoot
    makeFakeExtensionService([]),
    makeFakeConfigStore(tmpDir),
    makeFakeSessionStore(),
    makeFakeGitInfoReader(),
    makeFakeWorkspaceService(),
  )
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── tests ────────────────────────────────────────────────────────

describe('SessionService · wave 3 PresetService 注入', () => {

  it('w3-tc2: setPresetService 注入前 getLaunchPresetOptions 返 undefined；注入后委托', async () => {
    // 未注入：返 undefined
    const beforeInjection = await sessionService.getLaunchPresetOptions(BUILTIN_PRESET_IDS.FULL, '/cwd')
    expect(beforeInjection).toBeUndefined()

    // 注入真实 PresetService（带 fake configStore + extensionService）
    const presetService = new PresetService(
      makeFakeConfigStore(tmpDir) as unknown as ConstructorParameters<typeof PresetService>[0],
      makeFakeExtensionService([makeExt('user-ext', true)]) as unknown as ConstructorParameters<typeof PresetService>[1],
    )
    sessionService.setPresetService(presetService)

    // 注入后：builtin:full 能 resolve（委托 presetService.resolve）
    const afterInjection = await sessionService.getLaunchPresetOptions(BUILTIN_PRESET_IDS.FULL, '/cwd')
    expect(afterInjection).toBeDefined()
    expect(afterInjection!.extensionPaths).toEqual([
      '/fake/ext/user-ext',
    ])
    expect(afterInjection!.toolArgs).toEqual({}) // builtin:full toolMode=all
  })

  it('w3-tc3: 未知 presetId fallback 到 builtin:full——返回完整 PresetResolution + 回落事实', async () => {
    // wave 改动：getLaunchPresetOptions 找不到 preset 时 fallback 到 builtin:full（设计 §4.3），
    // 避免 restoreSession 拿到失效 presetId 时退到无 tool/thinking args 的旧行为。
    // builtin:full 永在（DEFAULT_PRESETS 保证），故 fallback 必命中。
    const extensionService = makeFakeExtensionService([makeExt('ext-a', true)])
    const presetService = new PresetService(
      makeFakeConfigStore(tmpDir) as unknown as ConstructorParameters<typeof PresetService>[0],
      extensionService as unknown as ConstructorParameters<typeof PresetService>[1],
    )
    sessionService.setPresetService(presetService)

    const result = await sessionService.getLaunchPresetOptions('nonexistent-id', '/cwd')
    expect(result).toBeDefined()

    // 对照：builtin:full 直接 resolve 的完整产物（不写死值，以真实实现为准）。
    const fullPreset = presetService.getPreset(BUILTIN_PRESET_IDS.FULL)!
    const direct = await presetService.resolve(fullPreset, '/cwd')

    // 回归锁（曾因漏 await 让回落分支 `{ ...resolution }` 展开 Promise → 空壳）：
    // toolArgs / flags / extensionPaths / skillPaths / prompt 必须逐项等于直接 resolve 的产物。
    expect(result!.toolArgs).toEqual(direct.toolArgs) // builtin:full toolMode=all → {}
    expect(result!.toolArgs).toEqual({})
    expect(result!.flags).toEqual(direct.flags)
    expect(result!.flags).toEqual({ noSkills: false, noContextFiles: false })
    expect(Array.isArray(result!.extensionPaths)).toBe(true)
    expect(result!.extensionPaths).toEqual(direct.extensionPaths)
    expect(result!.skillPaths).toEqual(direct.skillPaths)
    expect(result!.prompt).toEqual(direct.prompt)
    // 回落事实不被修丢（restore 路径据此披露「模式已删除，本次以全工具模式启动」）。
    expect(result!.fellBackFromPresetId).toBe('nonexistent-id')
  })

  it('w3-tc4: builtin:full 经 getLaunchPresetOptions 返回完整 PresetResolution 形状', async () => {
    const presetService = new PresetService(
      makeFakeConfigStore(tmpDir) as unknown as ConstructorParameters<typeof PresetService>[0],
      makeFakeExtensionService([makeExt('ext-a', true), makeExt('ext-b', false)]) as unknown as ConstructorParameters<typeof PresetService>[1],
    )
    sessionService.setPresetService(presetService)

    const result = await sessionService.getLaunchPresetOptions(BUILTIN_PRESET_IDS.FULL, '/cwd')
    expect(result).toBeDefined()
    // builtin:full = extensionMode:all + toolMode:all
    expect(result!.extensionPaths).toEqual([
      '/fake/ext/ext-a', // ext-b disabled 被排除
    ])
    expect(result!.toolArgs).toEqual({})
    expect(result!.flags).toEqual({ noSkills: false, noContextFiles: false })
    // B1 修复：builtin:full 的 noSkills 是 undefined（falsy），resolveSkillPaths 返 undefined
    // 让 session-lifecycle 的 `resolution?.skillPaths ?? getSkillPaths(cwd)` 触发 ?? fallback
    // 到现有 getSkillPaths 结果（设计 §2.2）。若返 [] 则 fallback 永不触发、所有 skill 失效。
    expect(result!.skillPaths).toBeUndefined()
    expect(result!.modelOverride).toBeUndefined()
    expect(result!.thinkingLevel).toBeUndefined()
  })

  it('w3-tc1: PresetService 在组合根可构造（不抛错）', () => {
    // 间接验证 index.ts 的 new PresetService(configStore, extensionService) 不抛错
    const configStore = makeFakeConfigStore(tmpDir)
    const extensionService = makeFakeExtensionService([makeExt('x', true)])
    expect(() => {
      const ps = new PresetService(
        configStore as unknown as ConstructorParameters<typeof PresetService>[0],
        extensionService as unknown as ConstructorParameters<typeof PresetService>[1],
      )
      // 构造后立即可用（无 deferred initialization）
      expect(ps.getAllPresets()).toHaveLength(4) // DEFAULT_PRESETS
    }).not.toThrow()
  })
})
