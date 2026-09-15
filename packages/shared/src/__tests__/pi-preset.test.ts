import { describe, it, expect } from 'vitest'
import {
  BUILTIN_TOOLS,
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  PI_THINKING_LEVELS,
  isPiLaunchPreset,
  type PiLaunchPreset,
  type PresetExportPayload,
  type ToolMode,
  type ExtensionMode,
  type ThinkingLevel,
} from '../pi-preset'

describe('pi-preset 常量', () => {
  it('BUILTIN_TOOLS 含 pi 的 7 个内置工具', () => {
    expect(BUILTIN_TOOLS.length).toBe(7)
    expect([...BUILTIN_TOOLS]).toEqual(['read', 'write', 'bash', 'edit', 'grep', 'find', 'ls'])
  })

  it('BUILTIN_PRESET_IDS 映射正确', () => {
    expect(BUILTIN_PRESET_IDS.FULL).toBe('builtin:full')
    expect(BUILTIN_PRESET_IDS.ORCHESTRATOR).toBe('builtin:orchestrator')
    expect(BUILTIN_PRESET_IDS.READONLY).toBe('builtin:readonly')
  })
})

describe('DEFAULT_PRESETS', () => {
  it('含 3 个内置预设', () => {
    expect(DEFAULT_PRESETS.length).toBe(3)
  })

  it('所有预设 builtin=true 且 order 不重复', () => {
    expect(DEFAULT_PRESETS.every(p => p.builtin === true)).toBe(true)
    const orders = DEFAULT_PRESETS.map(p => p.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('FULL 预设 toolMode=all/extensionMode=all', () => {
    const full = DEFAULT_PRESETS.find(p => p.id === 'builtin:full')!
    expect(full.toolMode).toBe('all')
    expect(full.extensionMode).toBe('all')
  })

  it('ORCHESTRATOR 预设 denylist 排除 read/write/bash/edit', () => {
    const orch = DEFAULT_PRESETS.find(p => p.id === 'builtin:orchestrator')!
    expect(orch.toolMode).toBe('denylist')
    expect(orch.deniedTools).toEqual(['read', 'write', 'bash', 'edit'])
  })

  it('READONLY 预设 allowlist 只读工具', () => {
    const ro = DEFAULT_PRESETS.find(p => p.id === 'builtin:readonly')!
    expect(ro.toolMode).toBe('allowlist')
    expect(ro.allowedTools).toEqual(['read', 'grep', 'find', 'ls'])
  })

  // 测试增强 #1：toolMode 合规性——allowlist 须有非空 allowedTools，denylist 须有非空 deniedTools。
  // 'all'/'none' 模式不强制工具列表（'all' 用默认，'none' 禁全部）。
  it('toolMode=allowlist 时 allowedTools 存在且非空', () => {
    for (const p of DEFAULT_PRESETS) {
      if (p.toolMode === 'allowlist') {
        expect(Array.isArray(p.allowedTools)).toBe(true)
        expect(p.allowedTools!.length).toBeGreaterThan(0)
      }
    }
  })

  it('toolMode=denylist 时 deniedTools 存在且非空', () => {
    for (const p of DEFAULT_PRESETS) {
      if (p.toolMode === 'denylist') {
        expect(Array.isArray(p.deniedTools)).toBe(true)
        expect(p.deniedTools!.length).toBeGreaterThan(0)
      }
    }
  })

  // 测试增强 #2：extensionMode 合规性（与 toolMode 同约束）。
  // 当前内置预设 extensionMode 全是 'all'，此处断言约束在若有 allowlist/denylist 时成立。
  it('extensionMode=allowlist 时 allowedExtensions 存在且非空；denylist 同理', () => {
    for (const p of DEFAULT_PRESETS) {
      if (p.extensionMode === 'allowlist') {
        expect(Array.isArray(p.allowedExtensions)).toBe(true)
        expect(p.allowedExtensions!.length).toBeGreaterThan(0)
      }
      if (p.extensionMode === 'denylist') {
        expect(Array.isArray(p.deniedExtensions)).toBe(true)
        expect(p.deniedExtensions!.length).toBeGreaterThan(0)
      }
    }
  })

  // 测试增强 #3：BUILTIN_PRESET_IDS 的值与 DEFAULT_PRESETS[].id 完全对应。
  it('BUILTIN_PRESET_IDS 的值与 DEFAULT_PRESETS[].id 完全对应', () => {
    const presetIds = new Set(DEFAULT_PRESETS.map(p => p.id))
    const builtinIdValues = Object.values(BUILTIN_PRESET_IDS)
    // 每个 BUILTIN_PRESET_IDS 值都能在 DEFAULT_PRESETS 找到对应
    for (const id of builtinIdValues) {
      expect(presetIds.has(id)).toBe(true)
    }
    // 数量一致（DEFAULT_PRESETS 全是内置预设，故 id 集合 == BUILTIN_PRESET_IDS 值集合）
    expect(DEFAULT_PRESETS.length).toBe(builtinIdValues.length)
  })
})

describe('ThinkingLevel（W2 值域 SSOT：PI_THINKING_LEVELS 全集派生）', () => {
  // 测试增强 #4（W2 更新 7 值）：ThinkingLevel 联合全集覆盖，max 必须在列
  //（A-03：曾缺 'max' 致 composer 最高档被 runtime 白名单静默丢弃）。
  it('覆盖 7 个合法思考级别（含 max）', () => {
    const levels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    expect(levels.length).toBe(7)
    expect(new Set(levels).size).toBe(7)
    // 每个值都是非空字符串（防御性）
    for (const lvl of levels) {
      expect(typeof lvl).toBe('string')
      expect(lvl.length).toBeGreaterThan(0)
    }
  })

  it('PI_THINKING_LEVELS 常量 = pi 0.84.1 dist/cli/args.js:6 全集（顺序一致）', () => {
    // 锚点：node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:6
    // VALID_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]
    expect([...PI_THINKING_LEVELS]).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('ThinkingLevel 类型编译期从常量派生（max 可赋值，回退防漂移用例）', () => {
    // 若 ThinkingLevel 退化回手写 6 值联合，此赋值编译报错（vitest 不做类型检查，
    // 但 packages/shared 的 `pnpm typecheck` 覆盖本文件）。
    const maxLevel: ThinkingLevel = 'max'
    expect(PI_THINKING_LEVELS).toContain(maxLevel)
  })
})

describe('isPiLaunchPreset', () => {
  // 测试增强 #5：类型守卫合法性 + 否定断言。
  it('合法 PiLaunchPreset 对象返回 true', () => {
    expect(isPiLaunchPreset({
      id: 'test',
      name: 'test',
      builtin: false,
      order: 0,
      toolMode: 'all',
      extensionMode: 'all',
    })).toBe(true)
    // 含可选字段也合法
    expect(isPiLaunchPreset({
      id: 'builtin:full',
      name: '全工具',
      builtin: true,
      order: 0,
      toolMode: 'allowlist',
      allowedTools: ['read'],
      extensionMode: 'denylist',
      deniedExtensions: ['foo'],
      modelOverride: 'anthropic/claude-sonnet-4',
      thinkingLevel: 'high',
    })).toBe(true)
    // DEFAULT_PRESETS 每个元素都通过守卫
    for (const p of DEFAULT_PRESETS) {
      expect(isPiLaunchPreset(p)).toBe(true)
    }
  })

  it('缺少必填字段返回 false', () => {
    // 缺 id
    expect(isPiLaunchPreset({ name: 'x', builtin: false, order: 0, toolMode: 'all', extensionMode: 'all' })).toBe(false)
    // 缺 name
    expect(isPiLaunchPreset({ id: 'x', builtin: false, order: 0, toolMode: 'all', extensionMode: 'all' })).toBe(false)
    // 缺 builtin
    expect(isPiLaunchPreset({ id: 'x', name: 'x', order: 0, toolMode: 'all', extensionMode: 'all' })).toBe(false)
    // 缺 order
    expect(isPiLaunchPreset({ id: 'x', name: 'x', builtin: false, toolMode: 'all', extensionMode: 'all' })).toBe(false)
    // 缺 toolMode
    expect(isPiLaunchPreset({ id: 'x', name: 'x', builtin: false, order: 0, extensionMode: 'all' })).toBe(false)
    // 缺 extensionMode
    expect(isPiLaunchPreset({ id: 'x', name: 'x', builtin: false, order: 0, toolMode: 'all' })).toBe(false)
  })

  it('字段类型错误返回 false', () => {
    // id 非 string
    expect(isPiLaunchPreset({ id: 123, name: 'x', builtin: false, order: 0, toolMode: 'all', extensionMode: 'all' })).toBe(false)
    // builtin 非 boolean
    expect(isPiLaunchPreset({ id: 'x', name: 'x', builtin: 'yes', order: 0, toolMode: 'all', extensionMode: 'all' })).toBe(false)
    // order 非 number
    expect(isPiLaunchPreset({ id: 'x', name: 'x', builtin: false, order: '0', toolMode: 'all', extensionMode: 'all' })).toBe(false)
    // toolMode 非法字面量
    expect(isPiLaunchPreset({ id: 'x', name: 'x', builtin: false, order: 0, toolMode: 'invalid', extensionMode: 'all' })).toBe(false)
    // extensionMode 非法字面量
    expect(isPiLaunchPreset({ id: 'x', name: 'x', builtin: false, order: 0, toolMode: 'all', extensionMode: 'invalid' })).toBe(false)
  })

  it('非对象输入返回 false', () => {
    expect(isPiLaunchPreset(null)).toBe(false)
    expect(isPiLaunchPreset(undefined)).toBe(false)
    expect(isPiLaunchPreset('string')).toBe(false)
    expect(isPiLaunchPreset(42)).toBe(false)
    expect(isPiLaunchPreset([])).toBe(false)
  })
})

// ── 编译时类型检查（TC-W1-1/2/3 + PresetExportPayload）──

// 编译时类型检查（TC-W1-1）：可选字段可省略
const _minimalPreset: PiLaunchPreset = {
  id: 'test',
  name: 'test',
  builtin: false,
  order: 0,
  toolMode: 'all',
  extensionMode: 'all',
}
// 编译时类型检查（TC-W1-2/3）：联合类型字面量约束
const _tm: ToolMode = 'all'
const _em: ExtensionMode = 'denylist'
const _tl: ThinkingLevel = 'high'

// 测试增强 #6：PresetExportPayload 编译时形状检查（导出格式只含 3 字段）。
const _exportPayload: PresetExportPayload = {
  presets: [_minimalPreset],
  defaultPresetId: 'builtin:full',
  version: 1,
}
// version 是 number（非字面量 1，因导出 payload 不锁死字面量，便于未来迁移）
const _versionOnly: PresetExportPayload = { presets: [], version: 2 }
// 不应包含 usage 字段（编译时无法直接断言 absence，但赋值会报错——
// 以下一行若取消注释应编译失败，留作人工校验）：
//   const _bad: PresetExportPayload = { presets: [], version: 1, usage: {} }
void _exportPayload
void _versionOnly
