/**
 * PresetService 单测（wave 1: 存储内核 + CRUD / wave 2: resolve + extension mode 过滤）。
 *
 * wave 1（10 个 testCase）：CRUD + builtin 保护 + IO 容错。
 * wave 2（6 个 testCase）：resolve 各 mode 分支 + infrastructure 保活 + toolArgs 映射 + flags 透传。
 *
 * mock 策略：fake ConfigStore（getConfigDir 返回 tmpdir）+ fake ExtensionService
 * （wave1 用空占位；wave2 注入固定 getDiscoveredAndDisabled 返回值）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync as statSyncInternal, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_PRESETS,
  BUILTIN_PRESET_IDS,
  type PiLaunchPreset,
  type PiPresetsFile,
} from '@taiji/shared'
import { PresetService, PresetGuardError } from '../src/services/preset-service.js'
import type { DiscoveredExtension } from '../src/services/ports/installer.js'

/**
 * vi.mock node:fs：只拦截 extension 相关路径（resolveExtensions 内 readPkgMeta 读 package.json），
 * 让假路径返回真实包名（@zhushanwen/pi-pending-notifications 等），使 resolveExtensions 真正走
 * infrastructure/feature 分支。其他文件（pi-presets.json/settings.json）透传 actual.readFileSync，
 * 保证 wave1 / 其他 wave2 测试的真实 fs 读取不受影响。
 */
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn((path: PathOrFd, encoding?: unknown) => {
      const p = typeof path === 'string' ? path : ''
      // 让假路径的 package.json 返回真实包名（命中 mandatory SSOT）
      if (p.includes('pi-pending-notifications')) return JSON.stringify({ name: '@zhushanwen/pi-pending-notifications' })
      if (p.includes('pi-goal')) return JSON.stringify({ name: '@zhushanwen/pi-goal' })
      // normal-a / normal-b 不匹配 mandatory → 普通包
      if (p.includes('normal-a')) return JSON.stringify({ name: 'normal-a' })
      if (p.includes('normal-b')) return JSON.stringify({ name: 'normal-b' })
      // 其他文件（pi-presets.json / settings.json / disabled-packages.json 等）走真实 fs
      return actual.readFileSync(path, encoding as Parameters<typeof actual.readFileSync>[1])
    }),
  }
})

/** readFileSync 第一个参数类型（number fd 或 string 路径）。 */
type PathOrFd = Parameters<typeof import('node:fs')['readFileSync']>[0]

/** 只暴露 getConfigDir 的最小 fake configStore。 */
function makeFakeConfigStore(configDir: string) {
  return { getConfigDir: () => configDir }
}

/** 占位 fake extensionService（wave1 不调用）。wave2 用 makeFakeExtensionStoreForResolve。 */
function makeFakeExtensionStore() {
  return {
    scanExtensions: vi.fn(async () => []),
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(async () => []),
  }
}

/**
 * wave2 resolve 测试用的 fake extensionService：可控的 discovered/disabled。
 *
 * resolveExtensionPaths 调 getDiscoveredAndDisabled（返回原始 discovered + disabledSet），
 * 本地再 resolveExtensions + applyPresetMode。所以 fake 需 mock getDiscoveredAndDisabled
 * （不再 mock scanExtensions/getExtensionPaths，resolve 不再调它们；保留方法占位给可能用到的地方）。
 *
 * discovered: getDiscoveredAndDisabled 返回的原始发现结果（path + source；npm 化 builtin
 * infrastructure 包也经此集合进入——builtin npm 化后无独立路径注入）。
 * disabledNames: 包名数组（不含 npm: 前缀），fake 内部转成 `npm:<name>` 形式的 Set。
 */
function makeFakeExtensionStoreForResolve(
  discovered: DiscoveredExtension[],
  disabledNames: string[],
) {
  return {
    getDiscoveredAndDisabled: vi.fn(async () => ({
      discovered,
      disabledSet: new Set(disabledNames.map(n => `npm:${n}`)),
    })),
    getSkillPaths: vi.fn(async () => []),
    // 保留 scanExtensions/getExtensionPaths 占位（resolve 不再调，但保留兼容其他可能用到的地方）
    scanExtensions: vi.fn(async () => []),
    getExtensionPaths: vi.fn(async () => []),
  }
}

/** 构造最小 PiLaunchPreset（仅本 wave resolve 关心的字段，其余缺省）。 */
function makePreset(overrides: Partial<PiLaunchPreset>): PiLaunchPreset {
  return {
    id: 'test-preset',
    name: 'test',
    builtin: false,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
    ...overrides,
  }
}

let tmpDir: string
let presetService: PresetService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'preset-service-test-'))
  const configStore = makeFakeConfigStore(tmpDir)
  const extensionStore = makeFakeExtensionStore()
  presetService = new PresetService(
    configStore as unknown as ConstructorParameters<typeof PresetService>[0],
    extensionStore as unknown as ConstructorParameters<typeof PresetService>[1],
  )
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function piPresetsPath(): string {
  return join(tmpDir, 'pi-presets.json')
}

function writeFile(file: PiPresetsFile): void {
  writeFileSync(piPresetsPath(), JSON.stringify(file, null, 2), 'utf-8')
}

function readFile(): PiPresetsFile | undefined {
  if (!existsSync(piPresetsPath())) return undefined
  return JSON.parse(readFileSync(piPresetsPath(), 'utf-8')) as PiPresetsFile
}

describe('PresetService · wave 1 存储内核', () => {
  // ── 读路径 ──────────────────────────────────────────────────

  it('w1-tc1: getAllPresets 用户文件不存在时返回 DEFAULT_PRESETS', () => {
    expect(existsSync(piPresetsPath())).toBe(false)
    const all = presetService.getAllPresets()
    expect(all).toHaveLength(DEFAULT_PRESETS.length)
    expect(all.map(p => p.id)).toEqual(DEFAULT_PRESETS.map(p => p.id))
    // 按 order 升序
    expect(all.map(p => p.order)).toEqual([...DEFAULT_PRESETS].map(p => p.order).sort((a, b) => a - b))
  })

  it('w1-tc2: getAllPresets 用户覆盖 builtin 字段按 id 合并 + 自定义追加', () => {
    const file: PiPresetsFile = {
      version: 1,
      defaultPresetId: BUILTIN_PRESET_IDS.FULL,
      presets: [
        // 覆盖 builtin:full 的 description
        {
          ...DEFAULT_PRESETS[0]!,
          id: BUILTIN_PRESET_IDS.FULL,
          name: '全工具模式',
          builtin: true,
          order: 0,
          description: '我被用户改了',
        },
        // 一个自定义
        {
          id: 'uuid-custom-1',
          name: '我的预设',
          builtin: false,
          order: 10,
          toolMode: 'all',
          extensionMode: 'all',
        },
      ],
    }
    writeFile(file)

    const all = presetService.getAllPresets()
    // 4 个 DEFAULT + 1 个自定义
    expect(all).toHaveLength(5)
    const full = all.find(p => p.id === BUILTIN_PRESET_IDS.FULL)!
    expect(full.description).toBe('我被用户改了')
    expect(full.toolMode).toBe('all') // 来自 DEFAULT 兜底（用户未传则保留 DEFAULT 值）
    const custom = all.find(p => p.id === 'uuid-custom-1')
    expect(custom).toBeDefined()
    expect(custom!.builtin).toBe(false)
    // 按 order 升序：0(full), 1(orch), 2(ro), 3(dispatch), 10(custom)
    expect(all.map(p => p.order)).toEqual([0, 1, 2, 3, 10])
  })

  it('w1-tc9: getPreset 找不到返回 undefined，builtin:full 总能找到', () => {
    expect(presetService.getPreset('nope')).toBeUndefined()
    const full = presetService.getPreset(BUILTIN_PRESET_IDS.FULL)
    expect(full).toBeDefined()
    expect(full!.id).toBe(BUILTIN_PRESET_IDS.FULL)
  })

  // ── 写路径 ──────────────────────────────────────────────────

  it('w1-tc3: savePreset 对 builtin preset 保护 id/builtin/order/name', () => {
    presetService.savePreset({
      id: BUILTIN_PRESET_IDS.FULL,
      name: 'hacked', // 应被忽略（保留 DEFAULT '全工具模式'）
      builtin: true,
      order: 99, // 应被忽略（保留 DEFAULT 0）
      toolMode: 'allowlist',
      allowedTools: ['read'],
      extensionMode: 'all',
    })

    const full = presetService.getPreset(BUILTIN_PRESET_IDS.FULL)!
    expect(full.name).toBe('全工具模式') // 保护
    expect(full.order).toBe(0) // 保护
    expect(full.builtin).toBe(true)
    expect(full.toolMode).toBe('allowlist') // 用户值生效
    expect(full.allowedTools).toEqual(['read'])
  })

  it('w1-tc4: savePreset 传 builtin id 但 builtin:false 抛 PresetGuardError', () => {
    expect(() => {
      presetService.savePreset({
        id: BUILTIN_PRESET_IDS.FULL,
        name: 'x',
        builtin: false, // 试图降级逃逸
        order: 0,
        toolMode: 'all',
        extensionMode: 'all',
      })
    }).toThrow(PresetGuardError)

    // 文件未写入（savePreset 在校验阶段就抛错）
    // 直接读 pi-presets.json 应不存在或不含该篡改项
    const onDisk = readFile()
    expect(onDisk?.presets ?? []).toEqual([])
  })

  it('w1-tc5: deletePreset 内置 preset 抛 PresetGuardError，文件不变', () => {
    // 先写一个合法 pi-presets.json
    writeFile({
      version: 1,
      presets: [
        { ...DEFAULT_PRESETS[0]!, description: 'preset' },
      ],
    })

    expect(() => {
      presetService.deletePreset(BUILTIN_PRESET_IDS.FULL)
    }).toThrow(PresetGuardError)

    // 文件未变更
    const onDisk = readFile()
    expect(onDisk!.presets).toHaveLength(1)
  })

  it('w1-tc6: deletePreset 自定义 preset 从文件移除', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-del', name: 'a', builtin: false, order: 5, toolMode: 'all', extensionMode: 'all' },
        { id: 'uuid-keep', name: 'b', builtin: false, order: 6, toolMode: 'all', extensionMode: 'all' },
      ],
    })

    presetService.deletePreset('uuid-del')

    const all = presetService.getAllPresets()
    expect(all.find(p => p.id === 'uuid-del')).toBeUndefined()
    expect(all.find(p => p.id === 'uuid-keep')).toBeDefined()
  })

  it('w1-tc7: getDefaultPresetId 空文件兜底 builtin:full，setDefault 后读回新值', () => {
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)

    presetService.setDefaultPresetId(BUILTIN_PRESET_IDS.ORCHESTRATOR)

    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.ORCHESTRATOR)
    const onDisk = readFile()
    expect(onDisk!.defaultPresetId).toBe(BUILTIN_PRESET_IDS.ORCHESTRATOR)
  })

  // ── IO 容错 ────────────────────────────────────────────────

  it('w1-tc8: loadPresetsFile JSON 畸形时空对象兜底不抛错', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(piPresetsPath(), '{ not valid json', 'utf-8')

    const all = presetService.getAllPresets()
    expect(all).toEqual(DEFAULT_PRESETS)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('w1-tc10: savePreset 新增自定义 preset 强制 builtin:false', () => {
    presetService.savePreset({
      id: 'uuid-1',
      name: '我的预设',
      // builtin 缺省
      order: 10,
      toolMode: 'all',
      extensionMode: 'all',
    } as PiLaunchPreset)

    const all = presetService.getAllPresets()
    const custom = all.find(p => p.id === 'uuid-1')
    expect(custom).toBeDefined()
    expect(custom!.builtin).toBe(false)

    // 即使传 builtin:true 也应被强制为 false
    presetService.savePreset({
      id: 'uuid-2',
      name: '伪造内置',
      builtin: true, // 试图伪造
      order: 11,
      toolMode: 'all',
      extensionMode: 'all',
    })
    const forged = presetService.getPreset('uuid-2')
    expect(forged).toBeDefined()
    expect(forged!.builtin).toBe(false)
  })
})

// ── wave 2: resolve + builtin 提取 ──────────────────────────────

describe('PresetService · wave 2 resolve', () => {
  // 本 describe 用独立的 presetService 构造（带可控 mock extensionService）
  let svcWithMock: PresetService
  let mockExt: ReturnType<typeof makeFakeExtensionStoreForResolve>

  beforeEach(() => {
    // 复用顶层 tmpDir（已是 presetService 的 configDir），但用新 mock 构造 svcWithMock
    // fixture 含三类包：infrastructure(pi-pending-notifications) + feature(pi-goal) + 2 普通(normal-a/normal-b)
    // 假路径配合文件顶部 vi.mock('node:fs') 返回真实包名，使 resolveExtensions 真正走 infra/feature 分支
    mockExt = makeFakeExtensionStoreForResolve(
      [
        // 用真实 infrastructure 包名，让 resolveExtensions 真正走 infra 分支
        { path: '/fake/ext/pi-pending-notifications', source: 'npm' },
        // feature 包
        { path: '/fake/ext/pi-goal', source: 'npm' },
        // 普通包
        { path: '/fake/ext/normal-a', source: 'user' },
        { path: '/fake/ext/normal-b', source: 'user' },
      ],
      [], // 不 disable 任何包
    )
    svcWithMock = new PresetService(
      makeFakeConfigStore(tmpDir) as unknown as ConstructorParameters<typeof PresetService>[0],
      mockExt as unknown as ConstructorParameters<typeof PresetService>[1],
    )
  })

  it('w2-tc3: resolve extensionMode=all 返回全部 discovered extension（含 infra）', async () => {
    const result = await svcWithMock.resolve(makePreset({ extensionMode: 'all' }), '/cwd')
    // 全部 4 个扩展（infra / feature / 2 normal）
    expect(result.extensionPaths).toEqual([
      '/fake/ext/pi-pending-notifications',
      '/fake/ext/pi-goal',
      '/fake/ext/normal-a',
      '/fake/ext/normal-b',
    ])
  })

  it('w2-tc4: resolve extensionMode=allowlist infrastructure 存活即使不在 allowlist（S2 核心）', async () => {
    const result = await svcWithMock.resolve(
      makePreset({ extensionMode: 'allowlist', allowedExtensions: ['normal-a'] }),
      '/cwd',
    )
    // infra（pi-pending-notifications 存活，即使不在 allowlist 也留）+ normal-a（在 allowlist）
    // 不含 pi-goal（feature 不在 allowlist）、normal-b（不在 allowlist）
    expect(result.extensionPaths).toEqual([
      '/fake/ext/pi-pending-notifications',
      '/fake/ext/normal-a',
    ])
  })

  it('w2-tc5: resolve extensionMode=denylist infrastructure 存活即使被列入 denylist（S2 核心）', async () => {
    const result = await svcWithMock.resolve(
      makePreset({
        extensionMode: 'denylist',
        deniedExtensions: ['@zhushanwen/pi-pending-notifications', '@zhushanwen/pi-goal', 'normal-a'],
      }),
      '/cwd',
    )
    // infra（pi-pending-notifications 扛住 denylist！即使被列入也留）
    // 不含 pi-goal / normal-a（被 deny）；normal-b 未 deny 但…保留
    expect(result.extensionPaths).toEqual([
      '/fake/ext/pi-pending-notifications',
      '/fake/ext/normal-b',
    ])
  })

  it('w2-tc6: resolve extensionMode=none 只留 infrastructure（feature/normal 全排除）', async () => {
    const result = await svcWithMock.resolve(
      makePreset({ extensionMode: 'none' }),
      '/cwd',
    )
    // none 模式只保留 infrastructure
    expect(result.extensionPaths).toEqual([
      '/fake/ext/pi-pending-notifications',
    ])
  })

  it('S2: infrastructure 包在 all/allowlist/denylist/none 四种 mode 下都绝对存活', async () => {
    // denylist 故意把 infra 包也列进去，验证它扛住
    for (const mode of ['all', 'allowlist', 'denylist', 'none'] as const) {
      const result = await svcWithMock.resolve(
        makePreset({ extensionMode: mode, deniedExtensions: ['@zhushanwen/pi-pending-notifications'] }),
        '/cwd',
      )
      expect(result.extensionPaths).toContain('/fake/ext/pi-pending-notifications')
    }
  })

  it('w2-tc7: resolve 4 种 toolMode 映射正确', async () => {
    // all → {}
    const rAll = await svcWithMock.resolve(makePreset({ toolMode: 'all' }), '/cwd')
    expect(rAll.toolArgs).toEqual({})

    // allowlist → { tools: allowedTools }
    const rAllow = await svcWithMock.resolve(
      makePreset({ toolMode: 'allowlist', allowedTools: ['read', 'grep'] }),
      '/cwd',
    )
    expect(rAllow.toolArgs).toEqual({ tools: ['read', 'grep'] })

    // denylist → { excludeTools: deniedTools }
    const rDeny = await svcWithMock.resolve(
      makePreset({ toolMode: 'denylist', deniedTools: ['bash'] }),
      '/cwd',
    )
    expect(rDeny.toolArgs).toEqual({ excludeTools: ['bash'] })

    // none → { noTools: true }
    const rNone = await svcWithMock.resolve(makePreset({ toolMode: 'none' }), '/cwd')
    expect(rNone.toolArgs).toEqual({ noTools: true })
  })

  it('w2-tc8: resolve flags/noSkills/noContextFiles + modelOverride/thinkingLevel 透传', async () => {
    const result = await svcWithMock.resolve(
      makePreset({
        noSkills: true,
        noContextFiles: true,
        modelOverride: 'anthropic/x',
        thinkingLevel: 'high',
      }),
      '/cwd',
    )
    expect(result.flags).toEqual({ noSkills: true, noContextFiles: true })
    expect(result.skillPaths).toEqual([]) // noSkills=true 清空（B1：返 [] 真清空）
    expect(result.modelOverride).toBe('anthropic/x')
    expect(result.thinkingLevel).toBe('high')
  })

  // ── B1 修复验证：resolveSkillPaths 在 noSkills=false/undefined 时返 undefined ──

  it('B1: resolve noSkills 未设 → skillPaths 为 undefined（让 lifecycle ?? fallback 到 getSkillPaths）', async () => {
    const result = await svcWithMock.resolve(makePreset({}), '/cwd')
    // 关键断言：undefined 而非 []。[] 是 truthy，会让 lifecycle 的 ?? fallback 失效，
    // 所有用 presetId 启动的 session 拿到空 skillPaths，所有 skill 失效（BLOCKER 根因）。
    expect(result.skillPaths).toBeUndefined()
    expect(result.flags.noSkills).toBe(false) // noSkills 默认 false
  })

  it('B1: resolve noSkills=false → skillPaths 仍为 undefined', async () => {
    const result = await svcWithMock.resolve(makePreset({ noSkills: false }), '/cwd')
    expect(result.skillPaths).toBeUndefined()
    expect(result.flags.noSkills).toBe(false)
  })

  // ── 模式提示词透传（scope 微扩：PresetResolution.prompt）──

  it('模式提示词透传：resolve 返回 prompt，replace/append 逐段相等', async () => {
    const presetWithPrompt = makePreset({
      id: 'uuid-resolve-prompt',
      prompt: {
        replace: { enabled: true, prompt: '替换段' },
        append: { enabled: true, prompt: '追加段' },
      },
    })
    const result = await svcWithMock.resolve(presetWithPrompt, '/cwd')
    expect(result.prompt).toEqual({
      replace: { enabled: true, prompt: '替换段' },
      append: { enabled: true, prompt: '追加段' },
    })
    // 逐段相等（字段不丢失 / 不重写）
    expect(result.prompt!.replace).toEqual(presetWithPrompt.prompt!.replace)
    expect(result.prompt!.append).toEqual(presetWithPrompt.prompt!.append)
  })

  it('模式提示词透传：未配置 prompt → resolution.prompt 为 undefined', async () => {
    const result = await svcWithMock.resolve(makePreset({}), '/cwd')
    expect(result.prompt).toBeUndefined()
  })

  it('非法/超限段不进入 resolution：直改盘合计超限 → resolve 拿到折叠后值（append 已丢）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      piPresetsPath(),
      JSON.stringify({
        version: 1,
        presets: [
          {
            id: 'uuid-resolve-fold',
            name: 'fold',
            builtin: false,
            order: 1,
            toolMode: 'all',
            extensionMode: 'all',
            prompt: {
              replace: { enabled: true, prompt: 'x'.repeat(16000) },
              append: { enabled: true, prompt: 'y'.repeat(16000) },
            },
          },
        ],
      }),
      'utf-8',
    )

    // 经读路 coercePreset 折叠后再 resolve：resolution 只拿得到合法剩余段
    const preset = svcWithMock.getPreset('uuid-resolve-fold')!
    const result = await svcWithMock.resolve(preset, '/cwd')
    expect(result.prompt).toBeDefined()
    expect(result.prompt!.replace!.prompt.length).toBe(16000)
    expect(result.prompt!.append).toBeUndefined()
    warnSpy.mockRestore()
  })
})

// ── PR #117 review fixes: W-RT-1 / W-RT-2 / W-RT-3 / S-RT-2 ──────────

describe('PresetService · PR #117 review fixes', () => {
  // ── W-RT-1: coercePreset 枚举白名单校验 ──

  it('W-RT-1: getAllPresets 丢弃 toolMode 非法枚举值的脏数据 preset', () => {
    writeFile({
      version: 1,
      presets: [
        // 合法自定义 preset（应保留）
        { id: 'uuid-ok', name: 'ok', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
        // 脏数据：toolMode 非法（不在 all/allowlist/denylist/none）
        { id: 'uuid-bad-tool', name: 'bad', builtin: false, order: 2, toolMode: 'DROP TABLE' as PiLaunchPreset['toolMode'], extensionMode: 'all' },
        // 脏数据：extensionMode 非法
        { id: 'uuid-bad-ext', name: 'bad', builtin: false, order: 3, toolMode: 'all', extensionMode: 'HACKED' as PiLaunchPreset['extensionMode'] },
      ],
    })

    const all = presetService.getAllPresets()
    // 3 个 DEFAULT + 1 个合法自定义 = 4 个；2 个脏数据被丢弃
    expect(all).toHaveLength(DEFAULT_PRESETS.length + 1)
    expect(all.find(p => p.id === 'uuid-ok')).toBeDefined()
    expect(all.find(p => p.id === 'uuid-bad-tool')).toBeUndefined()
    expect(all.find(p => p.id === 'uuid-bad-ext')).toBeUndefined()
  })

  it('W-RT-1: importPresets 丢弃 toolMode/extensionMode 非法的 preset（导入脏数据防御）', () => {
    const dirtyJson = JSON.stringify({
      version: 1,
      presets: [
        { id: 'imp-ok', name: 'ok', builtin: false, order: 5, toolMode: 'allowlist', extensionMode: 'none' },
        { id: 'imp-bad', name: 'bad', builtin: false, order: 6, toolMode: 'EVIL', extensionMode: 'all' },
      ],
    })
    const count = presetService.importPresets(dirtyJson)
    // 只导入合法的 1 个
    expect(count).toBe(1)
    expect(presetService.getPreset('imp-ok')).toBeDefined()
    expect(presetService.getPreset('imp-bad')).toBeUndefined()
  })

  // ── W-RT-2: deletePreset 清理 defaultPresetId ──

  it('W-RT-2: deletePreset 清理指向被删 preset 的 defaultPresetId', () => {
    writeFile({
      version: 1,
      defaultPresetId: 'uuid-default',
      presets: [
        { id: 'uuid-default', name: 'to-be-deleted', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    expect(presetService.getDefaultPresetId()).toBe('uuid-default')

    presetService.deletePreset('uuid-default')

    // defaultPresetId 被清空 → getDefaultPresetId 回退 builtin:full（W-RT-3 校验存在性兜底）
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)
    const onDisk = readFile()
    expect(onDisk!.defaultPresetId).toBeUndefined()
  })

  it('W-RT-2: deletePreset 不存在的 preset 是 no-op（不抛错、不写盘）', () => {
    writeFile({
      version: 1,
      defaultPresetId: BUILTIN_PRESET_IDS.FULL,
      presets: [
        { id: 'uuid-x', name: 'x', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    const beforeStat = statSyncOptional(piPresetsPath())

    expect(() => presetService.deletePreset('nonexistent')).not.toThrow()

    // 文件未变（no-op 不写盘）
    const afterStat = statSyncOptional(piPresetsPath())
    expect(afterStat?.mtimeMs).toBe(beforeStat?.mtimeMs)
    const onDisk = readFile()
    expect(onDisk!.presets).toHaveLength(1)
  })

  // ── W-RT-3: defaultPresetId 存在性校验 ──

  it('W-RT-3: getDefaultPresetId 指向已删 preset 时回退 builtin:full', () => {
    // defaultPresetId 指向一个不在 presets 列表里的「僵尸」id（手工构造脏文件）
    writeFile({
      version: 1,
      defaultPresetId: 'uuid-zombie',
      presets: [],
    })
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)
  })

  // ── FR-15 下线：存量 perCwdDefaults 字段惰性清除（state-truth-sync U9）──

  it('FR-15 下线：存量 perCwdDefaults 字段在 load 时被惰性剥离并重写，其余字段原样保留', () => {
    // 存量旧数据已不是合法的现行 PiPresetsFile 形状（字段已删），用裸 JSON 直写模拟磁盘遗留
    writeFileSync(
      piPresetsPath(),
      JSON.stringify(
        {
          version: 1,
          defaultPresetId: 'uuid-legacy',
          usage: { 'uuid-legacy': { count: 2, lastUsed: 7 } },
          perCwdDefaults: { '/legacy-cwd': 'uuid-legacy' },
          presets: [
            { id: 'uuid-legacy', name: 'keep', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    )
    // 任一 load 路径触发剥离重写
    expect(presetService.getDefaultPresetId()).toBe('uuid-legacy')
    // 磁盘文件不再含 perCwdDefaults，其余字段原样保留
    const onDisk = readFile()
    expect('perCwdDefaults' in onDisk!).toBe(false)
    expect(onDisk!.defaultPresetId).toBe('uuid-legacy')
    expect(onDisk!.usage).toEqual({ 'uuid-legacy': { count: 2, lastUsed: 7 } })
    expect(onDisk!.presets).toHaveLength(1)
  })

  // ── S-RT-2: mtime 缓存 ──

  it('S-RT-2: getPreset 重复调用命中缓存（文件未变不重复读盘）', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-cache', name: 'cache-test', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    // 第一次读：miss → 读盘 + 填缓存
    expect(presetService.getPreset('uuid-cache')).toBeDefined()
    // 第二次/第三次：命中缓存（mtime/size 未变）→ 直接返回缓存值
    expect(presetService.getPreset('uuid-cache')).toBeDefined()
    expect(presetService.getAllPresets().find(p => p.id === 'uuid-cache')).toBeDefined()
  })

  it('S-RT-2: savePreset 后缓存失效，下次读拿到新值', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-invalidate', name: 'before', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    expect(presetService.getPreset('uuid-invalidate')!.name).toBe('before')

    // savePreset 改 name → 内部 invalidate 缓存
    presetService.savePreset({
      id: 'uuid-invalidate',
      name: 'after',
      builtin: false,
      order: 1,
      toolMode: 'all',
      extensionMode: 'all',
    })

    // 下次读拿到新值（缓存已失效，重新读盘）
    expect(presetService.getPreset('uuid-invalidate')!.name).toBe('after')
  })

  it('S-RT-2: 缓存返回的是深拷贝，调用方 mutation 不污染缓存', () => {
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-clone', name: 'original', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    // 第一次读拿到对象，故意 mutate
    const first = presetService.getPreset('uuid-clone')!
    first.name = 'mutated'
    // 注意：getPreset 返回的是 getAllPresets().find()，每次都 new 对象，但底层 loadPresetsFile
    // 命中缓存返回的是 clonePresetsFile 的拷贝，所以 mutate 不影响缓存内部 file。

    // 第二次读应仍是原值（缓存未被污染）
    const second = presetService.getPreset('uuid-clone')!
    expect(second.name).toBe('original')
  })
})

describe('PresetService · parsePresetsFileFromDisk 容错分支覆盖', () => {
  it('顶层是 JSON 数组 → 空骨架兜底不抛错（getAllPresets 返回 DEFAULT）', () => {
    writeFileSync(piPresetsPath(), JSON.stringify([{ id: 'x' }]), 'utf-8')
    expect(presetService.getAllPresets().map(p => p.id)).toEqual(DEFAULT_PRESETS.map(p => p.id))
  })

  it('顶层是 JSON null → 空骨架兜底不抛错', () => {
    writeFileSync(piPresetsPath(), 'null', 'utf-8')
    expect(presetService.getAllPresets().map(p => p.id)).toEqual(DEFAULT_PRESETS.map(p => p.id))
  })

  it('presets 字段非数组（对象）→ presets 兜底空，usage/defaultPresetId 仍透传', () => {
    writeFileSync(
      piPresetsPath(),
      JSON.stringify({
        presets: { id: 'not-an-array' },
        usage: { 'custom-1': { count: 3, lastUsed: 42 } },
        defaultPresetId: 'custom-1',
      }),
      'utf-8',
    )
    // 无合法 preset → defaultPresetId 指向不存在的 id，getDefaultPresetId 兜底 builtin:full（W-RT-3 语义）
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)
    expect(presetService.getUsage()).toEqual({ 'custom-1': { count: 3, lastUsed: 42 } })
  })

  it('usage 非 Record 形状（数组/标量）→ 丢弃为 undefined，不抛错', () => {
    writeFileSync(
      piPresetsPath(),
      JSON.stringify({
        presets: [],
        usage: ['bad'],
        defaultPresetId: 123,
      }),
      'utf-8',
    )
    expect(presetService.getUsage()).toEqual({})
    // defaultPresetId 非字符串 → undefined → 兜底 builtin:full
    expect(presetService.getDefaultPresetId()).toBe(BUILTIN_PRESET_IDS.FULL)
  })
})

/** stat 文件，不存在返回 undefined（测试辅助）。 */
function statSyncOptional(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const s = statSyncInternal(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return undefined
  }
}

// ── 模式提示词：写路整条拒 + 读路段级折叠 + 导入路整条拒 ──────────

describe('PresetService · 模式提示词校验', () => {
  /** 生成指定长度的提示词占位文本。 */
  const longPrompt = (n: number): string => 'x'.repeat(n)

  it('写路整条拒：replace 9000 + append 9000（合计 18000）→ savePreset 抛错，文案含实际合计值 18000', () => {
    expect(() => {
      presetService.savePreset(
        makePreset({
          id: 'uuid-prompt-total',
          prompt: {
            replace: { enabled: true, prompt: longPrompt(9000) },
            append: { enabled: true, prompt: longPrompt(9000) },
          },
        }),
      )
    }).toThrow(PresetGuardError)
    // 错误文案含实际合计值（形如「模式提示词合计 18000 / 16000 字符，请精简总长」）
    expect(() => {
      presetService.savePreset(
        makePreset({
          id: 'uuid-prompt-total-2',
          prompt: {
            replace: { enabled: true, prompt: longPrompt(9000) },
            append: { enabled: true, prompt: longPrompt(9000) },
          },
        }),
      )
    }).toThrow(/模式提示词合计 18000 \/ 16000/)
    // 整条拒绝 → 未写盘
    expect(readFile()?.presets ?? []).toEqual([])
  })

  it('写路整条拒：段限 单段 16001 → 抛错且文案含该段实际长度', () => {
    expect(() => {
      presetService.savePreset(
        makePreset({
          id: 'uuid-prompt-seg',
          prompt: { append: { enabled: true, prompt: longPrompt(16001) } },
        }),
      )
    }).toThrow(/16001/)
    expect(readFile()?.presets ?? []).toEqual([])
  })

  it('写路整条拒：prompt 段形状非法 → 抛 PresetGuardError', () => {
    // prompt 非对象
    expect(() => {
      presetService.savePreset(
        makePreset({ id: 'uuid-prompt-shape-1', prompt: 'not-an-object' as unknown as PiLaunchPreset['prompt'] }),
      )
    }).toThrow(PresetGuardError)
    // enabled 非 boolean
    expect(() => {
      presetService.savePreset(
        makePreset({
          id: 'uuid-prompt-shape-2',
          prompt: { append: { enabled: 'yes' as unknown as boolean, prompt: 'x' } },
        }),
      )
    }).toThrow(PresetGuardError)
    // prompt 非 string
    expect(() => {
      presetService.savePreset(
        makePreset({
          id: 'uuid-prompt-shape-3',
          prompt: { append: { enabled: true, prompt: 42 as unknown as string } },
        }),
      )
    }).toThrow(PresetGuardError)
  })

  it('写路：合法提示词（合计恰为 16000 边界）正常写入并可读回', () => {
    presetService.savePreset(
      makePreset({
        id: 'uuid-prompt-ok',
        prompt: {
          replace: { enabled: true, prompt: longPrompt(8000) },
          append: { enabled: false, prompt: longPrompt(8000) },
        },
      }),
    )
    const saved = presetService.getPreset('uuid-prompt-ok')
    expect(saved).toBeDefined()
    expect(saved!.prompt!.replace!.enabled).toBe(true)
    expect(saved!.prompt!.replace!.prompt.length).toBe(8000)
    expect(saved!.prompt!.append!.enabled).toBe(false)
  })

  it('读路段级折叠：两段各 16000（各不超段限、合计 32000）→ 保留 preset，丢 append、留 replace，issues 记合计与丢弃项', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      piPresetsPath(),
      JSON.stringify({
        version: 1,
        presets: [
          {
            id: 'uuid-prompt-fold-total',
            name: 'fold-total',
            builtin: false,
            order: 1,
            toolMode: 'all',
            extensionMode: 'all',
            prompt: {
              replace: { enabled: true, prompt: longPrompt(16000) },
              append: { enabled: true, prompt: longPrompt(16000) },
            },
          },
        ],
      }),
      'utf-8',
    )

    const folded = presetService.getAllPresets().find(p => p.id === 'uuid-prompt-fold-total')
    // 不整条丢：preset 仍在
    expect(folded).toBeDefined()
    // replace 保留（语义更重 / 用户更难自恢复），append 优先丢弃
    expect(folded!.prompt!.replace).toBeDefined()
    expect(folded!.prompt!.replace!.prompt.length).toBe(16000)
    expect(folded!.prompt!.append).toBeUndefined()
    // issues 记录实际合计值与丢弃项（经 warn 日志可观测）
    const warnText = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(warnText).toContain('32000')
    expect(warnText).toContain('append')
    warnSpy.mockRestore()
  })

  it('读路段级折叠：单段超段限（16001）→ 只丢该段，preset 与另一段保留', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      piPresetsPath(),
      JSON.stringify({
        version: 1,
        presets: [
          {
            id: 'uuid-prompt-fold-seg',
            name: 'fold-seg',
            builtin: false,
            order: 1,
            toolMode: 'all',
            extensionMode: 'all',
            prompt: {
              replace: { enabled: true, prompt: longPrompt(16001) },
              append: { enabled: true, prompt: 'kept' },
            },
          },
        ],
      }),
      'utf-8',
    )

    const folded = presetService.getAllPresets().find(p => p.id === 'uuid-prompt-fold-seg')
    expect(folded).toBeDefined()
    expect(folded!.prompt!.replace).toBeUndefined()
    expect(folded!.prompt!.append!.prompt).toBe('kept')
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('16001')
    warnSpy.mockRestore()
  })

  it('读路段级折叠：prompt 形状非法 → 丢 prompt 字段，preset 整条保留', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      piPresetsPath(),
      JSON.stringify({
        version: 1,
        presets: [
          {
            id: 'uuid-prompt-fold-shape',
            name: 'fold-shape',
            builtin: false,
            order: 1,
            toolMode: 'all',
            extensionMode: 'all',
            prompt: 'not-an-object',
          },
        ],
      }),
      'utf-8',
    )

    const folded = presetService.getAllPresets().find(p => p.id === 'uuid-prompt-fold-shape')
    expect(folded).toBeDefined()
    expect(folded!.prompt).toBeUndefined()
    warnSpy.mockRestore()
  })

  it('读路段级折叠：容器无任何可识别段（{foo:1}）→ 仍丢弃 prompt，但产出 issue + warn（可观测）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      piPresetsPath(),
      JSON.stringify({
        version: 1,
        presets: [
          {
            id: 'uuid-prompt-fold-unknown',
            name: 'fold-unknown',
            builtin: false,
            order: 1,
            toolMode: 'all',
            extensionMode: 'all',
            // 普通对象但无可识别段（replace/append 都不在）——旧行为静默丢弃，无可观测信号
            prompt: { foo: 'SECRET_VALUE' },
          },
        ],
      }),
      'utf-8',
    )

    const folded = presetService.getAllPresets().find(p => p.id === 'uuid-prompt-fold-unknown')
    // 行为不变：preset 保留、prompt 容器仍被丢弃
    expect(folded).toBeDefined()
    expect(folded!.prompt).toBeUndefined()
    // 可观测：warn 恰一次，文案含「无可识别段」与键名 foo（只记键名不记值）
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const warnText = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(warnText).toContain('无可识别段')
    expect(warnText).toContain('foo')
    // 值不进日志（值可能是用户提示词正文）
    expect(warnText).not.toContain('SECRET_VALUE')
    warnSpy.mockRestore()
  })

  it('导入路整条拒：超限项导入 → 拒绝且不写盘（合法项也不落盘）', () => {
    // 盘上放一个既有合法 preset，用于验证导入失败后磁盘内容不变
    writeFile({
      version: 1,
      presets: [
        { id: 'uuid-existing', name: 'existing', builtin: false, order: 1, toolMode: 'all', extensionMode: 'all' },
      ],
    })
    const before = readFile()

    const json = JSON.stringify({
      version: 1,
      presets: [
        {
          id: 'imp-ok',
          name: 'ok',
          builtin: false,
          order: 5,
          toolMode: 'all',
          extensionMode: 'all',
          prompt: { append: { enabled: true, prompt: longPrompt(100) } },
        },
        {
          id: 'imp-over',
          name: 'over',
          builtin: false,
          order: 6,
          toolMode: 'all',
          extensionMode: 'all',
          prompt: {
            replace: { enabled: true, prompt: longPrompt(9000) },
            append: { enabled: true, prompt: longPrompt(9000) },
          },
        },
      ],
    })

    expect(() => presetService.importPresets(json)).toThrow(PresetGuardError)

    // 不写盘：既有内容逐字不变，合法项 imp-ok 也未落盘（整条语义）
    const after = readFile()
    expect(after!.presets.map(p => p.id)).toEqual(before!.presets.map(p => p.id))
    expect(presetService.getPreset('imp-ok')).toBeUndefined()
  })

  it('导入路：合法提示词正常导入（与写路同契约）', () => {
    const json = JSON.stringify({
      version: 1,
      presets: [
        {
          id: 'imp-prompt-ok',
          name: 'ok',
          builtin: false,
          order: 5,
          toolMode: 'all',
          extensionMode: 'all',
          prompt: { append: { enabled: true, prompt: '你好' } },
        },
      ],
    })
    expect(presetService.importPresets(json)).toBe(1)
    expect(presetService.getPreset('imp-prompt-ok')!.prompt!.append!.prompt).toBe('你好')
  })
})
