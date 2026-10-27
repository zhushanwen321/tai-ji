import builtinData from '../src/generated/builtin-providers.json';
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js';
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js';
import { NpmInstallError, installPackage, uninstallPackage } from '../src/infra/installers/npm-installer.js';
import { invalidateDiscoveryCache, setDiscoveryPath } from '../src/infra/pi/discovery-store.js';
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js';
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js';
import { getConfigDir, getPiAgentDir } from '../src/infra/pi/pi-paths.js';
import { ModelsStoreCorruptedError, findValidDefaultModel, getAllModels, getDefaultModel, getDefaultThinkingLevel, getEnabledModels, getProviderConfig, getProviderNames, getSkillPaths, isModelsStoreCorrupted, readModels, readSettings, refreshModels, removeProvider, setDefaultModel, setDefaultThinkingLevel, setEnabledModels, setModelsPath, setSkillPaths, type PiModelsConfig, type PiProviderConfig, upsertProvider, writeModels } from '../src/infra/pi/pi-provider-store.js';
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js';
import { IEventAdapter, IExtensionService, type IMessageBroker } from '../src/interfaces.js';
import { loadAppConfig, saveAppConfig } from '../src/services/app-config-store.js';
import { ConfigService } from '../src/services/config-service.js';
import { ExtensionService } from '../src/services/extension-service.js';
import type { IConfigStore } from '../src/services/ports/config.js';
import type { IGitInfoReader } from '../src/services/ports/git-info.js';
import { IPiEngine, PiEventListener, type IProcessManager } from '../src/services/ports/pi-engine.js';
import type { ISessionStore } from '../src/services/ports/session.js';
import { PresetGuardError, PresetService, PresetStoreCorruptedError } from '../src/services/preset-service.js';
import { SessionService } from '../src/services/session/session-service.js';
import { ConfigPreferencesMessageHandler } from '../src/transport/config-preferences-message-handler.js';
import { PresetMessageHandler, type PresetHandlerContext } from '../src/transport/preset-message-handler.js';
import type { SettingsHandlerContext } from '../src/transport/settings-message-handler.js';
import { ToolPermissionsMessageHandler } from '../src/transport/tool-permissions-message-handler.js';
import { BUILTIN_PRESET_IDS, DEFAULT_PRESETS, PiLaunchPreset, type ClientMessage, type ExtensionInfo, type ProviderId, type ServerMessage } from '@taiji/shared';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtemp, mkdtempSync, readFileSync, readdirSync, rm, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/extension-service-system-prompt.test.ts
// ======================================================================

vi.mock('../src/infra/installers/npm-installer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/installers/npm-installer.js')>()
  return { ...actual, installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  }, }
})


vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''), }
})


const mockedInstallPackage = vi.mocked(installPackage)

const mockedUninstallPackage = vi.mocked(uninstallPackage)

const mockedExecFileSync = vi.mocked(execFileSync)


let tmpRoot: string

let projectRoot: string

let settingsDir: string

let service: ExtensionService

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-service-system-prompt', () => {
beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = mkdtempSync(join(tmpdir(), 'ext-system-prompt-'))
  projectRoot = join(tmpRoot, 'apps', 'electron')
  settingsDir = join(tmpRoot, 'settings')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(settingsDir, { recursive: true })

  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf-8')
  setSettingsPath(join(settingsDir, 'settings.json'))
  setModelsPath(join(settingsDir, 'models.json'))
  refreshModels()

  service = new ExtensionService({
    settingsDir,
    projectRoot,
    packaged: false,
    installer: new NpmGitInstaller(),
    resolver: new ExtensionResolver({
      settingsDir,
      thirdPartyDir: join(settingsDir, 'extensions'),
      // Phase 1 路径迁移：npmDir 已从 settingsDir 子树迁出，注入回 settingsDir/npm 避免触碰真实 dataDir。
      npmDir: join(settingsDir, 'npm'),
    }),
    extensionSettings: new PiExtensionSettings(settingsDir),
    // Phase 1 路径迁移：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
    // 注入回 settingsDir 子目录让测试目录自洽（不依赖/污染真实 ~/.taiji）。
    extensionsDir: join(settingsDir, 'extensions'),
    npmDir: join(settingsDir, 'npm'),
    tmpDir: join(settingsDir, 'tmp'),
  })
})
afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    // ignore cleanup errors
  }
})
describe('ExtensionService 扩展加载', () => {
  it('getExtensionPaths 返回空数组（旧文件型扩展已移除）', async () => {
    const paths = await service.getExtensionPaths()
    // 新的扩展通过 mandatory-extensions.json 机制加载，不在 getExtensionPaths 中
    expect(paths).toEqual([])
  })
})
});

// ======================================================================
// ← test/preset-service-composition.test.ts
// ======================================================================

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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('preset-service-composition', () => {
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
});

// ======================================================================
// ← test/preset-store-corruption.test.ts
// ======================================================================

let tmpDir_m2_m2_m2_m2_z2: string


function makeService(): PresetService {
  // 最小 fake：app-config 路径经 getConfigDir 注入（PresetService 只用这一个 port 方法）
  return new PresetService(
    { getConfigDir: () => tmpDir_m2_m2_m2_m2_z2 } as unknown as ConstructorParameters<typeof PresetService>[0],
    {} as unknown as ConstructorParameters<typeof PresetService>[1],
  )
}


/** 找到 pi-presets.json 的 .corrupt-<ts> 隔离副本路径（无则 undefined）。 */
function findCorruptCopy(): string | undefined {
  return readdirSync(tmpDir_m2_m2_m2_m2_z2).find(name => name.startsWith('pi-presets.json.corrupt-'))
}


/** 合法自定义 preset fixture（id 不与 DEFAULT 冲突 → 走 custom 写路径）。 */
function makeCustomPreset(): PiLaunchPreset {
  return {
    id: 'corruption-test-custom',
    name: 'Corruption Test',
    builtin: false,
    order: 99,
    toolMode: 'all',
    extensionMode: 'all',
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('preset-store-corruption', () => {
beforeEach(() => {
  tmpDir_m2_m2_m2_m2_z2 = mkdtempSync(join(tmpdir(), 'preset-corruption-'))
})
afterEach(() => {
  rmSync(tmpDir_m2_m2_m2_m2_z2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('RT-7#2 PresetService：损坏读隔离 + 拒绝空骨架覆写', () => {
  it('JSON 畸形：读取回 DEFAULT 兜底 + 隔离副本保现场；savePreset 抛带 code 错误', () => {
    const broken = '{ "presets": [ {"id": "custom-a", '
    writeFileSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'), broken, 'utf-8')
    const service = makeService()

    // 触发读取：降级态下读侧仍可用（DEFAULT_PRESETS 兜底，只读降级不炸应用）
    expect(service.getAllPresets()).toEqual(DEFAULT_PRESETS)

    // ① 原损坏内容未被空骨架覆盖：被隔离为 .corrupt-* 副本、原信息可找回
    const copyName = findCorruptCopy()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(tmpDir_m2_m2_m2_m2_z2, copyName!), 'utf-8')).toBe(broken)
    expect(existsSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'))).toBe(false)

    // ② savePreset 抛错而非成功：code 供 error envelope、message 指明副本路径
    expect(() => service.savePreset(makeCustomPreset())).toThrowError(PresetStoreCorruptedError)
    let caught: unknown
    try {
      service.savePreset(makeCustomPreset())
    } catch (e) {
      caught = e
    }
    expect((caught as PresetStoreCorruptedError).code).toBe('preset_store_corrupted')
    expect((caught as PresetStoreCorruptedError).message).toContain(copyName!)
    // 拒绝写盘：原位文件未被空骨架重建
    expect(existsSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'))).toBe(false)
  })

  it('顶层非对象（字符串）：同样隔离 + 各写方法全部拒绝', () => {
    writeFileSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'), '"scalar-top-level"', 'utf-8')
    const service = makeService()
    service.getAllPresets() // 触发读取 → 隔离 + 置降级态

    expect(() => service.deletePreset('custom-a')).toThrowError(PresetStoreCorruptedError)
    expect(() => service.setDefaultPresetId('builtin:full')).toThrowError(PresetStoreCorruptedError)
    expect(() => service.recordUsage('builtin:full')).toThrowError(PresetStoreCorruptedError)
    expect(() => service.importPresets(JSON.stringify({ presets: [makeCustomPreset()] })))
      .toThrowError(PresetStoreCorruptedError)
    expect(existsSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'))).toBe(false)
  })

  it('降级态在文件恢复健康后自愈：写方法恢复可用', () => {
    writeFileSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'), 'not-json', 'utf-8')
    const service = makeService()
    service.getAllPresets()
    expect(() => service.savePreset(makeCustomPreset())).toThrowError(PresetStoreCorruptedError)

    // 用户从 .corrupt 副本找回原预设写回原位 → 下一次读取清降级态 → 写恢复
    writeFileSync(
      join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'),
      JSON.stringify({ presets: [makeCustomPreset()], version: 1 }),
      'utf-8',
    )
    expect(service.getAllPresets().map(p => p.id)).toContain('corruption-test-custom')
    expect(() => service.savePreset(makeCustomPreset())).not.toThrow()
    const onDisk = JSON.parse(readFileSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'), 'utf-8'))
    expect(onDisk.presets).toHaveLength(1)
  })

  it('无文件全新环境不受降级语义影响：savePreset 正常写入', () => {
    const service = makeService()
    service.savePreset(makeCustomPreset())
    const onDisk = JSON.parse(readFileSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'), 'utf-8'))
    expect(onDisk.presets[0].id).toBe('corruption-test-custom')
  })

  it('builtin 保护仍先于降级态检查（既有语义不因本修复漂移）', () => {
    writeFileSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'), 'not-json', 'utf-8')
    const service = makeService()
    service.getAllPresets()
    expect(() => service.deletePreset(DEFAULT_PRESETS[0]!.id)).toThrowError(PresetGuardError)
  })
})
describe('RT-7#2 RPC 错误透传：损坏态 preset.create 回包为 error 信封带 code', () => {
  it('preset.create → sendError(code=preset_store_corrupted)，不 reply 成功', async () => {
    writeFileSync(join(tmpDir_m2_m2_m2_m2_z2, 'pi-presets.json'), '{ broken', 'utf-8')
    const service = makeService()

    const replies: unknown[] = []
    const sendErrorCalls: Array<{ code: string; message: string; id?: string }> = []
    const ctx = {
      reply: vi.fn((_ws: unknown, _id: string | undefined, _type: string, payload: unknown) => {
        replies.push(payload)
      }),
      sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
        sendErrorCalls.push({ code, message, id })
      }),
      presetService: service,
    }
    const handler = new PresetMessageHandler(ctx as unknown as PresetHandlerContext)
    const request = {
      type: 'preset.create',
      id: 'm1',
      payload: { preset: makeCustomPreset() },
    } as unknown as ClientMessage

    const handled = await handler.handlePresetMessage(request, {} as never)

    expect(handled).toBe(true)
    expect(sendErrorCalls).toHaveLength(1)
    expect(sendErrorCalls[0]!.code).toBe('preset_store_corrupted')
    expect(sendErrorCalls[0]!.message).toContain('pi-presets.json.corrupt-')
    expect(replies).toHaveLength(0)
  })
})
});

// ======================================================================
// ← test/pi-provider-store.test.ts
// ======================================================================

// 快照 catalog 数据构建时刻（D5 三态测试的 staleness 判定基准）
const GENERATED_AT = (builtinData as { catalogGeneratedAt?: number }).catalogGeneratedAt ?? 0


const mkdtempP = promisify(mkdtemp)

const rmP = promisify(rm)


let tmpDir_m2_m2_m2_m2_z3: string


const anthropic: PiProviderConfig = {
  apiKey: 'sk-test',
  models: [
    { id: 'claude-sonnet', name: 'Sonnet' },
    { id: 'claude-opus', name: 'Opus' },
  ],
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-provider-store', () => {
beforeEach(async () => {
  tmpDir_m2_m2_m2_m2_z3 = await mkdtempP(join(tmpdir(), 'pi-provider-store-test-'))
  mkdirSync(join(tmpDir_m2_m2_m2_m2_z3, 'agent'), { recursive: true })
  // overlay 读侧（provider-catalog-refresh）与 auth.json 读经 getDataDir()/getPiAgentDir()
  // 实时解析 env，必须隔离到 tmpDir_m2_m2_m2_m2_z3——否则 findValidDefaultModel 三态判定会读到真实
  // ~/.taiji 的 overlay 缓存，态归属随开发机环境漂移（非确定性测试）。
  process.env.TAIJI_AGENT_DATA_DIR = tmpDir_m2_m2_m2_m2_z3
  setModelsPath(join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'models.json'))
  setSettingsPath(join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'settings.json'))
  // [HISTORICAL] discovery.json 也必须隔离，否则 setSkillPaths 写真实路径污染用户数据。
  // 2026-07-26 事故：本用例 skillPaths round-trip 调 setSkillPaths([tmpDir_m2_m2_m2_m2_z3/skills-a, ...])，
  // 但 beforeEach 漏了 setDiscoveryPath，导致 discovery-store 模块级变量绑定的真实路径
  // (~/.taiji/agent/discovery.json) 被写成 tmp 路径；afterEach rm(tmpDir_m2_m2_m2_m2_z3) 后路径失效，
  // 用户重启 app 发现 skill 扫描路径「凭空消失」。
  setDiscoveryPath(join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'discovery.json'))
  refreshModels()
})
afterEach(async () => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  await rmP(tmpDir_m2_m2_m2_m2_z3, { recursive: true, force: true })
})
describe('pi-provider-store — models.json', () => {
  describe('readModels / writeModels', () => {
    it('returns empty providers when models.json does not exist', () => {
      expect(readModels()).toEqual({ providers: {} })
    })

    it('writes and reads back providers', () => {
      writeModels({ providers: { anthropic } })
      const read = readModels()
      expect(Object.keys(read.providers)).toEqual(['anthropic'])
      expect(read.providers.anthropic?.models?.length).toBe(2)
    })

    it('returns fallback on corrupt JSON', () => {
      const path = join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'models.json')
      writeFileSync(path, '{ broken', 'utf-8')
      refreshModels()
      expect(readModels()).toEqual({ providers: {} })
    })

    it('returns fallback on schema mismatch (providers not object)', () => {
      const path = join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'models.json')
      writeFileSync(path, JSON.stringify({ providers: 'not-an-object' }), 'utf-8')
      refreshModels()
      expect(readModels()).toEqual({ providers: {} })
    })

    it('serves external file change on next read (revision fingerprint)', () => {
      writeModels({ providers: { anthropic } })
      // 外部改盘：指纹失配 → 下一次 read 重读，外部改动立即可见
      writeFileSync(
        join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'models.json'),
        JSON.stringify({ providers: { openai: { models: [{ id: 'gpt' }] } } }),
        'utf-8',
      )
      expect(getProviderNames()).toEqual(['openai'])
    })

    it('re-reads disk after refreshModels', () => {
      writeModels({ providers: { anthropic } })
      writeFileSync(
        join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'models.json'),
        JSON.stringify({ providers: { openai: { models: [{ id: 'gpt' }] } } }),
        'utf-8',
      )
      refreshModels()
      expect(getProviderNames()).toEqual(['openai'])
    })
  })

  describe('queries', () => {
    beforeEach(() => {
      writeModels({ providers: { anthropic } })
      refreshModels()
    })

    it('getProviderNames lists provider ids', () => {
      expect(getProviderNames()).toEqual(['anthropic'])
    })

    it('getProviderConfig returns deep copy (not reference)', () => {
      const cfg = getProviderConfig('anthropic')
      expect(cfg?.apiKey).toBe('sk-test')
      // 确认是深拷贝：改返回值不影响内部
      cfg!.apiKey = 'mutated'
      expect(getProviderConfig('anthropic')?.apiKey).toBe('sk-test')
    })

    it('getProviderConfig returns undefined for missing provider', () => {
      expect(getProviderConfig('nonexistent')).toBeUndefined()
    })

    it('getAllModels flattens provider models', () => {
      const all = getAllModels()
      expect(all).toHaveLength(2)
      expect(all.map(m => m.id).sort()).toEqual(['claude-opus', 'claude-sonnet'])
      expect(all[0]?.providerId).toBe('anthropic')
    })
  })

  describe('upsertProvider', () => {
    beforeEach(() => {
      writeModels({ providers: { anthropic } })
      refreshModels()
    })

    it('adds a new provider', () => {
      upsertProvider('openai', { models: [{ id: 'gpt-4' }] })
      refreshModels()
      expect(getProviderNames().sort()).toEqual(['anthropic', 'openai'].sort())
    })

    it('replaces an existing provider', () => {
      writeModels({ providers: { anthropic } })
      refreshModels()
      upsertProvider('anthropic', { models: [{ id: 'claude-new' }] })
      refreshModels()
      expect(getProviderConfig('anthropic')?.models?.map(m => m.id)).toEqual(['claude-new'])
    })

    it('非 catalog provider 显式 models:[] 清空模型 → default 删除且无回退（无其他有 models 的 provider）', () => {
      // 用非 catalog id：catalog provider 的 models:[] 只代表清 override，builtin 模型仍有效
      //（见下方 catalog union 用例），「清空 = provider 无模型」语义只对非 catalog provider 成立
      writeModels({ providers: { 'my-custom-llm': { apiKey: 'sk-x', models: [{ id: 'm1' }] } } })
      refreshModels()
      setDefaultModel('my-custom-llm' as ProviderId, 'm1')
      upsertProvider('my-custom-llm', { apiKey: 'sk-x', models: [] })
      // defaultModel 失效应被修复
      const def = getDefaultModel()
      expect(def).toBeNull() // 无其他有 model 的 provider
    })

    it('partial upsert（无 models 键）保留 defaultProvider/defaultModel（spec §8 OAuth 检查）', () => {
      // builtin override-only provider：models.json 条目本无 models 数组（models undefined），
      // 模拟 clearApiKey 剥离 apiKey / quota 覆写 / QuickSetup 保存不携带 models 的真实场景。
      writeModels({
        providers: {
          anthropic: { apiKey: 'sk-test' }, // 无 models 键
          openai: { models: [{ id: 'gpt-4' }] }, // 有 models 的 provider（fallback 候选）
        },
      })
      refreshModels()
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet')

      const outcome = upsertProvider('anthropic', { name: 'Anthropic', apiKey: 'sk-test-2' })

      // 检查契约：models 未参与本次更新 → 不触碰 settings 的 default，无 newDefault 回退
      expect(outcome).toEqual({})
      const settings = readSettings()
      expect(settings.defaultProvider).toBe('anthropic')
      expect(settings.defaultModel).toBe('claude-sonnet')
    })

    it('非 catalog provider 显式 models: [] 删除默认并回退到第一个有 models 的 provider', () => {
      writeModels({
        providers: {
          'my-custom-llm': { apiKey: 'sk-x', models: [{ id: 'm1' }] },
          openai: { models: [{ id: 'gpt-4' }] },
        },
      })
      refreshModels()
      setDefaultModel('my-custom-llm' as ProviderId, 'm1')

      const outcome = upsertProvider('my-custom-llm', { name: 'Custom', apiKey: 'sk-x-2', models: [] })

      // 显式空数组 ≠ undefined：仍走默认校验 → 删除失效默认 → 回退第一个有 models 的 provider
      expect(outcome).toEqual({ newDefault: { provider: 'openai', modelId: 'gpt-4' } })
      const settings = readSettings()
      expect(settings.defaultProvider).toBe('openai')
      expect(settings.defaultModel).toBe('gpt-4')
    })

    it('catalog provider 保存 override-only 条目（B-2）：builtin 默认模型仍是有效 default，不被改写/删除', () => {
      // round 1 review must-fix #1：B-2 前端保存 catalog provider 只回传 override 条目
      //（无 override 时为 []），builtin 模型不在回传列表——default 校验须以
      // 「override ∪ builtin catalog」判定有效性，否则 builtin 默认模型被静默重置。
      // anthropic 是 catalog provider（builtin-providers.json，含 claude-sonnet-4-6）。
      writeModels({
        providers: {
          anthropic: { apiKey: 'sk-test' }, // catalog provider 条目：无 override models
          openai: { models: [{ id: 'gpt-4' }] },
        },
      })
      refreshModels()
      // 默认模型取 builtin 列表内的模型（models.json 条目中不存在）
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet-4-6')

      // 场景 ②：保存含 override 条目（用户新加自定义模型）→ defaultModel 不被改为 override 首项
      const outcomeA = upsertProvider('anthropic', { apiKey: 'sk-test', models: [{ id: 'my-override-model' }] })
      expect(outcomeA).toEqual({ newDefault: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' } })
      let settings = readSettings()
      expect(settings.defaultProvider).toBe('anthropic')
      expect(settings.defaultModel).toBe('claude-sonnet-4-6')

      // 场景 ①：保存无 override（models: []）→ 不删除 default（builtin 模型仍有效）
      const outcomeB = upsertProvider('anthropic', { apiKey: 'sk-test', models: [] })
      expect(outcomeB).toEqual({ newDefault: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' } })
      settings = readSettings()
      expect(settings.defaultProvider).toBe('anthropic')
      expect(settings.defaultModel).toBe('claude-sonnet-4-6')
    })

    it('catalog provider 默认模型真失效（不在 override ∪ builtin 并集）→ 仍回退到有效列表首项', () => {
      writeModels({
        providers: { anthropic: { apiKey: 'sk-test', models: [{ id: 'my-override-model' }] } },
      })
      refreshModels()
      // defaultModel 既不在 override 也不在 builtin anthropic 模型列表 → 应回退
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet')

      const outcome = upsertProvider('anthropic', { apiKey: 'sk-test', models: [{ id: 'my-override-model' }] })

      expect(outcome).toEqual({ newDefault: { provider: 'anthropic', modelId: 'my-override-model' } })
      const settings = readSettings()
      expect(settings.defaultModel).toBe('my-override-model')
    })
  })

  describe('removeProvider', () => {
    it('removes provider and returns removed:true', () => {
      writeModels({ providers: { anthropic, openai: { models: [{ id: 'gpt' }] } } })
      refreshModels()
      const result = removeProvider('openai')
      expect(result.removed).toBe(true)
      refreshModels()
      expect(getProviderNames()).toEqual(['anthropic'])
    })

    it('returns removed:false for missing provider', () => {
      const result = removeProvider('nonexistent')
      expect(result.removed).toBe(false)
    })

    it('migrates defaultModel to another provider when current is removed', () => {
      writeModels({
        providers: {
          anthropic,
          openai: { models: [{ id: 'gpt-4' }] },
        },
      })
      refreshModels()
      setDefaultModel('anthropic' as ProviderId, 'claude-sonnet')
      const result = removeProvider('anthropic')
      expect(result.removed).toBe(true)
      expect(result.newDefault?.provider).toBe('openai')
    })
  })

  describe('findValidDefaultModel', () => {
    it('returns null when no providers have models', () => {
      expect(findValidDefaultModel().result).toBeNull()
    })

    it('returns first available provider/model when no default set', () => {
      writeModels({ providers: { anthropic } })
      refreshModels()
      const { result, wasFixed } = findValidDefaultModel()
      expect(result).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet' })
      expect(wasFixed).toBe(true)
    })
  })

  describe('settings interactions', () => {
    beforeEach(() => {
      writeModels({ providers: { anthropic } })
      refreshModels()
    })

    it('setDefaultModel / getDefaultModel round-trip', () => {
      setDefaultModel('anthropic' as ProviderId, 'claude-opus')
      expect(getDefaultModel()).toEqual({ provider: 'anthropic', modelId: 'claude-opus' })
    })

    it('D5 态 3 演进：default 无效且 overlay 从未见过 → pass-through 不改写（原「auto-fix 回退首个 model」被 D5 取代）', () => {
      setDefaultModel('anthropic' as ProviderId, 'nonexistent-model')
      // 本用例不构造任何 overlay 条目（TAIJI_AGENT_DATA_DIR 已隔离到空 tmpDir_m2_m2_m2_m2_z3）→ anthropic
      // 处于 never-seen 态。D5 裁定：pass-through 不判定有效性、不 auto-fix、不改写
      // settings，`--model` 直传 pi 由执行侧解析。旧行为（回退 provider 第一个 model 并
      // 落盘改写）正是设计文档「失败模式 A」同族：静默改写用户显式配置。
      const settingsPath = join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'settings.json')
      const before = readFileSync(settingsPath, 'utf-8')

      const result = getDefaultModel()

      expect(result).toEqual({ provider: 'anthropic', modelId: 'nonexistent-model' })
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before) // settings 逐字节不变（禁改写）
    })

    it('D5 态 1 对照：overlay 新鲜 → 无效 default 仍 auto-fix 回退 override 首项（原测试意图的三态存续形态）', () => {
      // anthropic 的 fresh overlay 条目（lastModified 晚于快照 catalogGeneratedAt）→
      // 合并视图裁定生效：nonexistent-model 不在合并视图 → 真无效 → 允许 auto-fix，
      // 回退 override 首项（即原断言值 claude-sonnet）
      writeFileSync(
        join(tmpDir_m2_m2_m2_m2_z3, 'provider-catalog-overlay.json'),
        JSON.stringify({
          version: 1,
          entries: {
            anthropic: {
              models: [{ id: 'claude-from-overlay' }],
              checkedAt: 1,
              lastModified: GENERATED_AT + 1000,
            },
          },
        }),
      )
      setDefaultModel('anthropic' as ProviderId, 'nonexistent-model')

      const result = getDefaultModel()

      expect(result).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet' })
      expect(readSettings().defaultModel).toBe('claude-sonnet') // auto-fix 落盘
    })

    it('enabledModels round-trip', () => {
      setEnabledModels(['anthropic/*', 'openai/gpt-4'])
      expect(getEnabledModels()).toEqual(['anthropic/*', 'openai/gpt-4'])
    })

    it('defaultThinkingLevel defaults to high', () => {
      expect(getDefaultThinkingLevel()).toBe('high')
    })

    it('defaultThinkingLevel round-trip', () => {
      setDefaultThinkingLevel('low')
      expect(getDefaultThinkingLevel()).toBe('low')
    })

    it('skillPaths round-trip', () => {
      // 用真实存在的目录验证 round-trip（脏数据 /path/a 等不存在的路径会被 setSkillDirs 过滤，
      // 这是 ADR §5 的新行为——非 preset 绝对路径不存在则剔除）
      const realDir1 = join(tmpDir_m2_m2_m2_m2_z3, 'skills-a')
      const realDir2 = join(tmpDir_m2_m2_m2_m2_z3, 'skills-b')
      mkdirSync(realDir1, { recursive: true })
      mkdirSync(realDir2, { recursive: true })
      setSkillPaths([
        { path: realDir1, enabled: true, scope: 'global' },
        { path: realDir2, enabled: true, scope: 'global' },
      ])
      expect(getSkillPaths()).toEqual([realDir1, realDir2])
    })
  })

  describe('atomic write integrity', () => {
    it('write produces valid JSON file on disk', () => {
      writeModels({ providers: { anthropic } })
      const raw = readFileSync(join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'models.json'), 'utf-8')
      const parsed = JSON.parse(raw) as PiModelsConfig
      expect(parsed.providers.anthropic).toBeDefined()
    })

    it('write creates parent dirs if missing', () => {
      // 指向更深的不存在路径
      const deepPath = join(tmpDir_m2_m2_m2_m2_z3, 'deep', 'nested', 'models.json')
      setModelsPath(deepPath)
      writeModels({ providers: { anthropic } })
      expect(existsSync(deepPath)).toBe(true)
    })
  })

  // W1：provider/model 级 enabled 字段序列化。
  // enabled 字段用于 provider 级 / model 级启停（默认 true 向上兼容存量）。
  // 需保证写 models.json → 读回时 enabled 值正确保留。
  describe('enabled 字段序列化（W1）', () => {
    it('provider 级 enabled=false 经写盘读回后保留', () => {
      writeModels({
        providers: {
          anthropic: {
            apiKey: 'sk-test',
            enabled: false,
            models: [
              { id: 'claude-sonnet', name: 'Sonnet' },
            ],
          },
        },
      })
      refreshModels()
      const cfg = getProviderConfig('anthropic')
      expect(cfg?.enabled).toBe(false)
    })

    it('provider 级 enabled=true 经写盘读回后保留', () => {
      writeModels({
        providers: {
          openai: {
            apiKey: 'sk-openai',
            enabled: true,
            models: [{ id: 'gpt-4' }],
          },
        },
      })
      refreshModels()
      const cfg = getProviderConfig('openai')
      expect(cfg?.enabled).toBe(true)
    })

    it('model 级 enabled 经写盘读回后保留', () => {
      writeModels({
        providers: {
          anthropic: {
            apiKey: 'sk-test',
            models: [
              { id: 'claude-sonnet', name: 'Sonnet', enabled: false },
              { id: 'claude-opus', name: 'Opus', enabled: true },
            ],
          },
        },
      })
      refreshModels()
      const cfg = getProviderConfig('anthropic')
      expect(cfg?.models?.[0]?.enabled).toBe(false)
      expect(cfg?.models?.[1]?.enabled).toBe(true)
    })

    it('盘上 JSON 文件含 enabled 字段（端到端序列化）', () => {
      writeModels({
        providers: {
          anthropic: {
            enabled: false,
            models: [{ id: 'sonnet', enabled: true }],
          },
        },
      })
      const raw = readFileSync(join(tmpDir_m2_m2_m2_m2_z3, 'agent', 'models.json'), 'utf-8')
      const parsed = JSON.parse(raw) as PiModelsConfig
      expect(parsed.providers.anthropic?.enabled).toBe(false)
      expect(parsed.providers.anthropic?.models?.[0]?.enabled).toBe(true)
    })
  })
})
});

// ======================================================================
// ← test/pi-provider-store-corruption.test.ts
// ======================================================================

let tmpDir_m2_z2: string

let agentDir: string

let savedEnv: string | undefined


const modelsPath = (): string => join(agentDir, 'models.json')


/** 找到 models.json 的 .corrupt-<ts> 隔离副本路径（无则 undefined）。 */
function findCorruptCopy_m2_z2(): string | undefined {
  return readdirSync(agentDir).find(name => name.startsWith('models.json.corrupt-'))
}


const SAMPLE_PROVIDER: PiProviderConfig = {
  name: 'Sample',
  api: 'anthropic-messages',
  apiKey: 'sk-sample',
  models: [{ id: 'sample-model' }],
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-provider-store-corruption', () => {
beforeEach(() => {
  tmpDir_m2_z2 = mkdtempSync(join(tmpdir(), 'pi-provider-corruption-'))
  agentDir = join(tmpDir_m2_z2, 'agent')
  mkdirSync(agentDir, { recursive: true })
  // overlay 读侧（provider-catalog-refresh）与 auth.json 读经 getDataDir()/getPiAgentDir()
  // 实时解析 env，必须隔离到 tmpDir_m2_z2（复用 pi-provider-store.test.ts 的隔离模式）
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDir_m2_z2
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  refreshModels()
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDir_m2_z2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('RT-3#4 schema 不匹配路径（deserialize 补隔离）', () => {
  it('providers 非对象：读回空骨架 + 隔离保现场；upsert/writeModels 拒绝并抛带 code 错误', () => {
    const broken = '{"providers": "not-an-object", "leftover": true}'
    writeFileSync(modelsPath(), broken, 'utf-8')

    // 触发读取：空骨架（不炸消费方）
    expect(readModels()).toEqual({ providers: {} })
    expect(getProviderConfig('sample')).toBeUndefined()

    // ① 原损坏内容未被空骨架覆盖：被隔离为 .corrupt-* 副本、原信息可找回
    const copyName = findCorruptCopy_m2_z2()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(agentDir, copyName!), 'utf-8')).toBe(broken)
    expect(existsSync(modelsPath())).toBe(false)

    // ② setter/save 抛错而非成功；降级标志下发面为 true
    expect(() => upsertProvider('sample', SAMPLE_PROVIDER)).toThrowError(ModelsStoreCorruptedError)
    let caught: unknown
    try {
      upsertProvider('sample', SAMPLE_PROVIDER)
    } catch (e) {
      caught = e
    }
    expect((caught as ModelsStoreCorruptedError).code).toBe('models_store_corrupted')
    expect((caught as ModelsStoreCorruptedError).message).toContain(copyName!)
    expect(() => writeModels({ providers: { sample: SAMPLE_PROVIDER } })).toThrowError(ModelsStoreCorruptedError)
    expect(isModelsStoreCorrupted()).toBe(true)
    // 拒绝写盘：原位文件未被空骨架重建
    expect(existsSync(modelsPath())).toBe(false)
  })

  it('providers 为 null / 顶层非对象：同样按损坏隔离（穿透原 typeof 检查的形态）', () => {
    writeFileSync(modelsPath(), '{"providers": null}', 'utf-8')
    expect(readModels()).toEqual({ providers: {} })
    expect(findCorruptCopy_m2_z2()).toBeDefined()
    expect(isModelsStoreCorrupted()).toBe(true)
  })
})
describe('RT-3#4 JSON 畸形路径（JsonStore 既有隔离）', () => {
  it('非法 JSON：JsonStore 隔离后降级态判定同样成立、写同样拒绝', () => {
    const broken = '{ "providers": { "p1": { "apiKey": "sk-'
    writeFileSync(modelsPath(), broken, 'utf-8')

    expect(readModels()).toEqual({ providers: {} })
    const copyName = findCorruptCopy_m2_z2()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(agentDir, copyName!), 'utf-8')).toBe(broken)

    expect(() => upsertProvider('sample', SAMPLE_PROVIDER)).toThrowError(ModelsStoreCorruptedError)
    expect(isModelsStoreCorrupted()).toBe(true)
  })
})
describe('RT-3#4 降级态判定边界', () => {
  it('全新环境（无文件无副本）：非降级态，写入正常', () => {
    expect(isModelsStoreCorrupted()).toBe(false)
    upsertProvider('sample', SAMPLE_PROVIDER)
    expect(getProviderConfig('sample')?.apiKey).toBe('sk-sample')
    expect(isModelsStoreCorrupted()).toBe(false)
  })

  it('用户把副本内容写回原位：降级态自愈，写入恢复可用', () => {
    writeFileSync(modelsPath(), 'not-json', 'utf-8')
    readModels()
    expect(isModelsStoreCorrupted()).toBe(true)

    writeFileSync(modelsPath(), JSON.stringify({ providers: { sample: SAMPLE_PROVIDER } }), 'utf-8')
    expect(readModels().providers.sample?.apiKey).toBe('sk-sample')
    expect(isModelsStoreCorrupted()).toBe(false)
    expect(() => upsertProvider('other', SAMPLE_PROVIDER)).not.toThrow()
  })
})
});

// ======================================================================
// ← test/config-service-paths.test.ts
// ======================================================================

let tmpDataDir: string

let configService: ConfigService

let savedEnv_m2_z2: string | undefined

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-service-paths', () => {
beforeEach(() => {
  // 每个用例独立临时数据目录
  tmpDataDir = mkdtempSync(join(tmpdir(), 'config-paths-test-'))
  mkdirSync(join(tmpDataDir, 'agent'), { recursive: true })

  // 设置 TAIJI_AGENT_DATA_DIR → getDataDir/getConfigDir/getPiAgentDir 全部基于此
  savedEnv_m2_z2 = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir

  // 把 pi 各模块的单例路径指向临时目录（避免污染真实 ~/.taiji）
  setModelsPath(join(tmpDataDir, 'agent', 'models.json'))
  setSettingsPath(join(tmpDataDir, 'agent', 'settings.json'))
  setDiscoveryPath(join(tmpDataDir, 'agent', 'discovery.json'))
  refreshModels()
  invalidateDiscoveryCache()

  configService = new ConfigService(tmpDataDir, new PiConfigStore())
})
afterEach(() => {
  // 还原 env
  if (savedEnv_m2_z2 === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv_m2_z2
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('W1: config-service skill/agent 全局强制目录跟随 getConfigDir()', () => {
  // ── CP1：loadSkills 扫描 TAIJI_AGENT_DATA_DIR/skills ───────────
  it('CP1: 设 TAIJI_AGENT_DATA_DIR 后，loadSkills 扫描 <datadir>/skills 而非硬编码 ~/.taiji/skills', () => {
    // sanity：getConfigDir 应基于 env
    expect(getConfigDir()).toBe(tmpDataDir)

    // 在 <datadir>/skills/my-env-skill/ 放 SKILL.md（W1 修复后此目录会被强制扫描）
    const skillDir = join(tmpDataDir, 'skills', 'my-env-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: env skill\n---\nbody')

    // 确认该文件确实存在（排除 fs 层面问题）
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)

    const skills = configService.loadSkills(tmpDataDir)
    const names = skills.map((s) => s.name)

    // 当前硬编码 ~/.taiji/skills 时此处扫不到 → 红灯
    expect(names).toContain('my-env-skill')
  })

  // ── CP2：loadAgents 扫描 TAIJI_AGENT_DATA_DIR/agents ───────────
  it('CP2: 设 TAIJI_AGENT_DATA_DIR 后，loadAgents 扫描 <datadir>/agents 而非硬编码 ~/.taiji/agents', () => {
    expect(getPiAgentDir()).toBe(join(tmpDataDir, 'agent'))

    // 在 <datadir>/agents/ 放 agent.md（W1 修复后此目录会被强制扫描）
    const agentsDir = join(tmpDataDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'env-agent.md'), '---\nname: env-agent\ndescription: env agent\n---\nbody')

    const agents = configService.loadAgents(tmpDataDir)
    const ids = agents.map((a) => a.id)

    // 当前硬编码 ~/.taiji/agents 时此处扫不到 → 红灯
    expect(ids).toContain('env-agent')
  })
})
// ── W2（cw-2026-07-21-scan-project-agents-skills）：loadSkills(cwd) 相对路径 resolve ──
// 修复现状 bug：loadSkills(_projectRoot) 忽略 projectRoot 参数，discovery.json 中的相对路径
// （如 .agents/skills）和 FORCED_PROJECT_SKILL_DIR（.taiji/skills）按 runtime 进程 cwd
// 解析错位 → 扫不到用户项目 skill → landing 浮层看不到。
// 修复：相对路径按传入的 projectRoot resolve 扫描。
describe('W2: loadSkills(cwd) relative-path projectRoot resolution', () => {
  let w2DataDir: string
  let w2ProjectDir: string
  let w2Service: ConfigService
  let w2SavedEnv: string | undefined

  beforeEach(() => {
    w2DataDir = mkdtempSync(join(tmpdir(), 'w2-data-'))
    w2ProjectDir = mkdtempSync(join(tmpdir(), 'w2-proj-'))
    mkdirSync(join(w2DataDir, 'agent'), { recursive: true })

    w2SavedEnv = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = w2DataDir

    setModelsPath(join(w2DataDir, 'agent', 'models.json'))
    setSettingsPath(join(w2DataDir, 'agent', 'settings.json'))
    setDiscoveryPath(join(w2DataDir, 'agent', 'discovery.json'))
    refreshModels()
    invalidateDiscoveryCache()

    w2Service = new ConfigService(w2DataDir, new PiConfigStore())
  })

  afterEach(() => {
    if (w2SavedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = w2SavedEnv
    rmSync(w2DataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(w2ProjectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('AC-4: discovery 配 .agents/skills 相对路径 → loadSkills(projectRoot) 扫描 <projectRoot>/.agents/skills', () => {
    // discovery.json 配 .agents/skills 相对路径（用户现状）
    writeFileSync(join(w2DataDir, 'agent', 'discovery.json'), JSON.stringify({
      version: 1, skillDirs: ['.agents/skills'], agentDirs: [],
    }))
    invalidateDiscoveryCache()

    // 项目目录下放一个 skill（<projectRoot>/.agents/skills/proj-skill/SKILL.md）
    const projSkillDir = join(w2ProjectDir, '.agents', 'skills', 'proj-skill')
    mkdirSync(projSkillDir, { recursive: true })
    writeFileSync(join(projSkillDir, 'SKILL.md'), '---\ndescription: proj skill\n---\nbody')

    // 传 projectRoot=w2ProjectDir，应扫到项目 skill
    const skills = w2Service.loadSkills(w2ProjectDir)
    const names = skills.map((s) => s.name)

    // 现状 bug：loadSkills 忽略 projectRoot，相对路径按 runtime 进程 cwd 解析 → 扫不到 → 红灯
    expect(names).toContain('proj-skill')
  })

  it('AC-4 补充：FORCED_PROJECT_SKILL_DIR (.taiji/skills) 也按 projectRoot resolve', () => {
    // 项目目录下放 .taiji/skills/forced-skill/SKILL.md（不配 discovery，靠强制目录）
    const forcedDir = join(w2ProjectDir, '.taiji', 'skills', 'forced-skill')
    mkdirSync(forcedDir, { recursive: true })
    writeFileSync(join(forcedDir, 'SKILL.md'), '---\ndescription: forced skill\n---\nbody')

    const skills = w2Service.loadSkills(w2ProjectDir)
    const names = skills.map((s) => s.name)

    expect(names).toContain('forced-skill')
  })

  it('相对路径在 projectRoot 下不存在时不崩（扫不到但返回空数组或仅全局）', () => {
    writeFileSync(join(w2DataDir, 'agent', 'discovery.json'), JSON.stringify({
      version: 1, skillDirs: ['.agents/skills'], agentDirs: [],
    }))
    invalidateDiscoveryCache()

    // projectRoot 下无 .agents/skills 目录
    const skills = w2Service.loadSkills(w2ProjectDir)
    // 不崩 + 不含项目 skill（可能含全局 skill，这里只断言不含 proj-skill）
    expect(skills.map((s) => s.name)).not.toContain('proj-skill')
  })
})
});

// ======================================================================
// ← test/app-config-corruption.test.ts
// ======================================================================

let tmpDir_m2_z3: string

let savedEnv_m2_z3: string | undefined


/** 找到 config.json 的 .corrupt-<ts> 隔离副本路径（无则 undefined）。 */
function findCorruptCopy_m2_z3(): string | undefined {
  return readdirSync(tmpDir_m2_z3).find(name => name.startsWith('config.json.corrupt-'))
}


function makeConfigService(): ConfigService {
  return new ConfigService(tmpDir_m2_z3, new PiConfigStore())
}


/** 最小 handler ctx（真实 ConfigService + mock reply/sendError，验证错误信封透传）。 */
function makeHandlerCtx(configService: ConfigService): {
  ctx: SettingsHandlerContext
  replies: unknown[]
  sendErrorCalls: Array<{ code: string; message: string; id?: string }>
} {
  const replies: unknown[] = []
  const sendErrorCalls: Array<{ code: string; message: string; id?: string }> = []
  const ctx = {
    reply: vi.fn((_ws: unknown, _id: string | undefined, _type: string, payload: unknown) => {
      replies.push(payload)
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      sendErrorCalls.push({ code, message, id })
    }),
    configService,
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, sendErrorCalls }
}


function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS = {} as never

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('app-config-corruption', () => {
beforeEach(() => {
  tmpDir_m2_z3 = mkdtempSync(join(tmpdir(), 'app-config-corruption-'))
  savedEnv_m2_z3 = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDir_m2_z3
  // pi 各模块单例路径隔离（ConfigService 构造需要 IConfigStore；app-config 路径 =
  // getConfigDir() = dataDir 根，本测试只读写 <tmpDir_m2_z3>/config.json）
  setModelsPath(join(tmpDir_m2_z3, 'agent', 'models.json'))
  setSettingsPath(join(tmpDir_m2_z3, 'agent', 'settings.json'))
  refreshModels()
})
afterEach(() => {
  if (savedEnv_m2_z3 === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv_m2_z3
  rmSync(tmpDir_m2_z3, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('RT-7#1 app-config-store 纯函数层：损坏读隔离 + 拒绝空骨架覆写', () => {
  it('JSON 畸形：读回 {} + 隔离副本保现场；save 拒绝覆写并返回错误', () => {
    const broken = '{ "worktreeRootDir": "oop'
    writeFileSync(join(tmpDir_m2_z3, 'config.json'), broken, 'utf-8')

    expect(loadAppConfig(tmpDir_m2_z3)).toEqual({})

    // ① 原损坏内容未被空骨架覆盖：被隔离为 .corrupt-* 副本、原信息可找回
    const copyName = findCorruptCopy_m2_z3()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(tmpDir_m2_z3, copyName!), 'utf-8')).toBe(broken)
    expect(existsSync(join(tmpDir_m2_z3, 'config.json'))).toBe(false)

    // ② save 返回错误而非成功；错误消息含恢复指引与副本路径
    const result = saveAppConfig(tmpDir_m2_z3, { worktreeRootDir: '/new' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('app_config_corrupted')
    expect(result.error).toContain(copyName!)
    // 拒绝写盘：原位文件不因被拒绝的 save 重建
    expect(existsSync(join(tmpDir_m2_z3, 'config.json'))).toBe(false)
  })

  it('顶层非对象（数组）：同样隔离 + 拒绝覆写', () => {
    const broken = '[1, 2, 3]'
    writeFileSync(join(tmpDir_m2_z3, 'config.json'), broken, 'utf-8')

    expect(loadAppConfig(tmpDir_m2_z3)).toEqual({})
    expect(readFileSync(join(tmpDir_m2_z3, findCorruptCopy_m2_z3()!), 'utf-8')).toBe(broken)

    const result = saveAppConfig(tmpDir_m2_z3, { k: 'v' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('app_config_corrupted')
  })

  it('健康文件：load 正常返回 + save ok；降级态在文件恢复健康后自愈', () => {
    // 先制造降级态
    writeFileSync(join(tmpDir_m2_z3, 'config.json'), 'not-json', 'utf-8')
    loadAppConfig(tmpDir_m2_z3)
    expect(saveAppConfig(tmpDir_m2_z3, { k: 'v' }).ok).toBe(false)

    // 用户从 .corrupt 副本找回原配置写回原位 → 下一次 load 清降级态 → save 恢复可用
    writeFileSync(join(tmpDir_m2_z3, 'config.json'), JSON.stringify({ recovered: true }), 'utf-8')
    expect(loadAppConfig(tmpDir_m2_z3)).toEqual({ recovered: true })
    const result = saveAppConfig(tmpDir_m2_z3, { recovered: true, extra: 1 })
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(tmpDir_m2_z3, 'config.json'), 'utf-8'))).toEqual({ recovered: true, extra: 1 })
  })

  it('文件不存在：load 返回 {} 且 save 正常写入（全新环境不受降级语义影响）', () => {
    expect(loadAppConfig(tmpDir_m2_z3)).toEqual({})
    const result = saveAppConfig(tmpDir_m2_z3, { fresh: true })
    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(tmpDir_m2_z3, 'config.json'), 'utf-8'))).toEqual({ fresh: true })
  })
})
describe('RT-7#1 ConfigService setter：损坏态拒绝空骨架覆写', () => {
  it('updateToolPermissions / setWorktreeRootDir 在降级态返回 {ok:false} 且不写盘', () => {
    const broken = '{ "toolPermissions": "x'
    writeFileSync(join(tmpDir_m2_z3, 'config.json'), broken, 'utf-8')
    const service = makeConfigService()

    // 触发读取（setter 内部 load → 隔离 + 置降级态）
    const r1 = service.updateToolPermissions({ 'bash(npm:*)': 'allow' })
    expect(r1.ok).toBe(false)
    expect(r1.code).toBe('app_config_corrupted')

    // 降级态粘滞：第二个 setter 同样拒绝（隔离后原位文件已移走，load 不再重检）
    const r2 = service.setWorktreeRootDir('/tmp/wt')
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('app_config_corrupted')

    // ① 原损坏内容可找回：.corrupt 副本保留原始字节，原位未被空骨架重建
    expect(readFileSync(join(tmpDir_m2_z3, findCorruptCopy_m2_z3()!), 'utf-8')).toBe(broken)
    expect(existsSync(join(tmpDir_m2_z3, 'config.json'))).toBe(false)
  })
})
describe('RT-7#1 RPC 错误透传：损坏态回包为 error 信封带 code', () => {
  it('config.setWorktreeRootDir → sendError(code=app_config_corrupted)，不 reply 成功', async () => {
    writeFileSync(join(tmpDir_m2_z3, 'config.json'), '[[[', 'utf-8')
    const { ctx, replies, sendErrorCalls } = makeHandlerCtx(makeConfigService())
    const handler = new ConfigPreferencesMessageHandler(ctx)

    const handled = await handler.handle(
      msg('config.setWorktreeRootDir', { dir: '/tmp/wt' }),
      WS,
    )

    expect(handled).toBe(true)
    expect(sendErrorCalls).toHaveLength(1)
    expect(sendErrorCalls[0]!.code).toBe('app_config_corrupted')
    expect(sendErrorCalls[0]!.message).toContain('config.json.corrupt-')
    expect(replies).toHaveLength(0)
  })

  it('config.setToolPermissions → sendError(code=app_config_corrupted)，不 reply saved:true', async () => {
    writeFileSync(join(tmpDir_m2_z3, 'config.json'), '"scalar-top-level"', 'utf-8')
    const { ctx, replies, sendErrorCalls } = makeHandlerCtx(makeConfigService())
    const handler = new ToolPermissionsMessageHandler(ctx)

    const handled = await handler.handle(
      msg('config.setToolPermissions', { permissions: { 'bash(git:*)': 'allow' } }),
      WS,
    )

    expect(handled).toBe(true)
    expect(sendErrorCalls).toHaveLength(1)
    expect(sendErrorCalls[0]!.code).toBe('app_config_corrupted')
    expect(replies).toHaveLength(0)
  })
})
});
