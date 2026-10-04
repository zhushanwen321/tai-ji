/**
 * btw 线 spawn options 工厂回落链单测（MF-1-24：原组合根内联回调 36/36 新增行未测的
 * 直测偿还——提取为 createBtwLineSpawnOptionsFactory 后三条决策各一条断言）：
 *   1. preset 回落链：findScannedSession 命中 → 主会话 presetId；缺失 → builtin:full；
 *   2. resolution 回落：skillPaths/extensionPaths 取 resolution 值，缺失回落全局解析；
 *   3. 模型终态：model: undefined + inheritSessionModel: true（不拼 --model，P1 final
 *      gate V1⑤——pi CLI --model 恒优先 entry 恢复）。
 * 全部依赖 fake 注入（BtwLineSpawnOptionsDeps 窄面），零磁盘零进程。
 */
import { describe, it, expect, vi } from 'vitest'
import { BUILTIN_PRESET_IDS } from '@taiji/shared'
import { createBtwLineSpawnOptionsFactory } from '../btw-line-spawn-options.js'
import type { BtwLineSpawnOptionsDeps } from '../btw-line-spawn-options.js'
import type { BtwLineSpawnContext } from '../btw-service.js'
import type { PresetResolution } from '../../preset-service.js'

const CTX: BtwLineSpawnContext = {
  mainSid: 'main-1',
  cwd: '/workspace/proj',
  threadDir: '/tmp/btw-threads/t1',
  snapshotKind: 'forked',
}

/** 最小可用 deps fake：每个用例按断言目标覆写个别字段。 */
function makeDeps(overrides?: Partial<BtwLineSpawnOptionsDeps>): BtwLineSpawnOptionsDeps {
  return {
    migrationGate: vi.fn(async () => undefined),
    findScannedSession: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    getSkillPaths: vi.fn(() => ['global-skill']),
    getExtensionPaths: vi.fn(async () => ['global-ext']),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    ...overrides,
  }
}

/** 最小 resolution fixture（PresetResolution 必填字段全给）。 */
function makeResolution(overrides?: Partial<PresetResolution>): PresetResolution {
  return {
    extensionPaths: ['preset-ext'],
    skillPaths: ['preset-skill'],
    toolArgs: {},
    flags: { noSkills: false, noContextFiles: false },
    ...overrides,
  }
}

describe('createBtwLineSpawnOptionsFactory', () => {
  it('preset 回落链：主会话扫盘命中时取其 launchPresetId 解析 preset', async () => {
    const deps = makeDeps({
      findScannedSession: vi.fn(() => ({ launchPresetId: 'custom-mode' })),
      getLaunchPresetOptions: vi.fn(async () => makeResolution()),
    })
    await createBtwLineSpawnOptionsFactory(deps)(CTX)
    expect(deps.getLaunchPresetOptions).toHaveBeenCalledWith('custom-mode', CTX.cwd)
  })

  it('preset 回落链：扫盘缺失（活跃 sidecar 缺席）回落 builtin:full（FR-10 兜底）', async () => {
    const deps = makeDeps({ findScannedSession: vi.fn(() => undefined) })
    await createBtwLineSpawnOptionsFactory(deps)(CTX)
    expect(deps.getLaunchPresetOptions).toHaveBeenCalledWith(BUILTIN_PRESET_IDS.FULL, CTX.cwd)
  })

  it('skillPaths/extensionPaths 回落：resolution 有值优先，缺失回落全局解析', async () => {
    const withResolution = makeDeps({
      getLaunchPresetOptions: vi.fn(async () => makeResolution({ skillPaths: ['preset-skill'], extensionPaths: ['preset-ext'] })),
    })
    const resolved = await createBtwLineSpawnOptionsFactory(withResolution)(CTX)
    expect(resolved.skillPaths).toEqual(['preset-skill'])
    expect(resolved.extensionPaths).toEqual(['preset-ext'])
    expect(withResolution.getSkillPaths).not.toHaveBeenCalled()
    expect(withResolution.getExtensionPaths).not.toHaveBeenCalled()

    // resolution 未解析（presetService 未注入/解析失败）→ 全局解析兜底
    const noResolution = makeDeps()
    const fallback = await createBtwLineSpawnOptionsFactory(noResolution)(CTX)
    expect(fallback.skillPaths).toEqual(['global-skill'])
    expect(fallback.extensionPaths).toEqual(['global-ext'])
    // skillPaths: undefined（noSkills 模式的合法产出，B1 语义）同样回落全局
    const undefinedSkill = makeDeps({
      getLaunchPresetOptions: vi.fn(async () => makeResolution({ skillPaths: undefined })),
    })
    const fallbackSkill = await createBtwLineSpawnOptionsFactory(undefinedSkill)(CTX)
    expect(fallbackSkill.skillPaths).toEqual(['global-skill'])
  })

  it('模型终态：恒 model undefined + inheritSessionModel true（不拼 --model，entry 恢复优先）', async () => {
    // preset 带 modelOverride——buildPresetClientOptions 会 spread { model }，工厂必须
    // 显式覆盖为 undefined（V1⑤：拼 --model 会把 fork 快照里用户切换过的模型压回）
    const deps = makeDeps({
      getLaunchPresetOptions: vi.fn(async () => makeResolution({ modelOverride: 'prov/m-pressed' })),
    })
    const options = await createBtwLineSpawnOptionsFactory(deps)(CTX)
    expect(options.model).toBeUndefined()
    expect(options.inheritSessionModel).toBe(true)
  })

  it('迁移门先于一切解析（D8-3：provider 迁移完成前禁启动 pi）', async () => {
    const deps = makeDeps()
    await createBtwLineSpawnOptionsFactory(deps)(CTX)
    expect(deps.migrationGate).toHaveBeenCalledTimes(1)
    const gateCalls = vi.mocked(deps.migrationGate).mock.invocationCallOrder[0]
    const presetCalls = vi.mocked(deps.getLaunchPresetOptions).mock.invocationCallOrder[0]
    expect(gateCalls).toBeLessThan(presetCalls)
  })
})
