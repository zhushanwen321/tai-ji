/**
 * pi-codemode-settings（infra tools 字段域）测试（codemode 设计 §3.3 D2 全语义表 + A1）。
 *
 * 锁定：
 * - resolveDefaultToolSet / isCodemodeActive：pi 1.0.0 实装语义复刻——语义表由 u1 实施
 *   期 node 探针在实装 dist/core/settings-manager.js 上逐条实测固化（getDefaultTools
 *   调用侧：数组先 filter 剥非字符串元素；非数组含 null → 空激活集；undefined → pi 回落
 *   默认集，对 codemode 判定等价空集；空 name modifier no-op；大小写敏感）。pi bump 由
 *   docs/pi-semantics.json 门禁（U7 登记，guard probe 指向本文件）自动重验。
 * - ensureCodemodeDefaultEntry：字段存在性判定（undefined/null 写默认；任何已配置值含
 *   空数组/坏值不碰）+ 幂等 + 用户字段零触碰。
 * - setCodemodeEntry：开（移负条目 + 幂等判激活）/ 关（移正条目与纯名 + 负条目占位）+
 *   规范化（非数组坏值视为显式配置动作覆盖为增量表达）+ 混合纯名边界 + 用户条目保留。
 * - getSettingsCorruption：两形态（raw 预检非法 JSON / .corrupt- 副本）+ 每次现查 +
 *   检测动作自身绝不触发隔离改名（A1 核心约束）。
 * - runCodemodeStartupMigration：损坏跳过 + 结构化告警；未损坏幂等写入。
 *
 * 运行：pnpm -C packages/runtime test pi-codemode-settings pi-settings-store
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEMODE_DEFAULT_ENTRY,
  CODEMODE_DISABLE_ENTRY,
  PI_DEFAULT_TOOL_NAMES,
  ensureCodemodeDefaultEntry,
  isCodemodeActive,
  resolveDefaultToolSet,
  runCodemodeStartupMigration,
  setCodemodeEntry,
} from '../pi-codemode-settings.js'
import {
  getSettingsCorruption,
  invalidateSettingsCache,
  setSettingsPath,
  type SettingsCorruption,
} from '../pi-settings-store.js'

let dir: string
let settingsPath: string

/** ISO 压缩时间戳形态（json-store quarantineCorruptFile 同款：去冒号/点号）。 */
const corruptCopyName = (iso: string): string => `.corrupt-${iso.replace(/[:.]/g, '')}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-codemode-settings-'))
  settingsPath = join(dir, 'settings.json')
  setSettingsPath(settingsPath)
})

afterEach(() => {
  vi.restoreAllMocks()
  invalidateSettingsCache()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 摆盘 defaultTools（可带其他字段）并失效缓存。raw === undefined 表示字段不写（缺失）。 */
function seed(defaultTools: unknown, extra: Record<string, unknown> = {}): void {
  const body: Record<string, unknown> = { ...extra }
  if (defaultTools !== undefined) body.defaultTools = defaultTools
  writeFileSync(settingsPath, JSON.stringify(body, null, 2), 'utf-8')
  invalidateSettingsCache()
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
}

// ── 1. 激活集解析（目标 1：复刻 pi 实装语义，前提 12）────────────────────────

describe('resolveDefaultToolSet · pi 1.0.0 实装语义表（探针结论固化）', () => {
  it.each([
    // [label, raw, 期望激活集]
    ['字段缺失（undefined）→ 空集（pi 回落默认集，对 codemode 判定等价）', undefined, []],
    ['null → 空激活集（pi getDefaultTools 非数组分支）', null, []],
    ['非数组字符串 → 空激活集', 'bad', []],
    ['非数组数字 → 空激活集', 42, []],
    ['非数组对象 → 空激活集', {}, []],
    ['["+"] 追加 → 默认集 + codemode', ['+codemode'], ['read', 'bash', 'edit', 'write', 'codemode']],
    ['["codemode"] 纯名 → 整体替换默认集', ['codemode'], ['codemode']],
    ['[] 空数组 → 空激活集（禁用全部默认工具）', [], []],
    ['["-codemode"] → 默认集（移除 no-op，不含 codemode）', ['-codemode'], ['read', 'bash', 'edit', 'write']],
    ['["-read","+codemode"] → 顺序应用', ['-read', '+codemode'], ['bash', 'edit', 'write', 'codemode']],
    ['["+codemode","-codemode"] → 后条目赢（不含）', ['+codemode', '-codemode'], ['read', 'bash', 'edit', 'write']],
    ['["-codemode","+codemode"] → 后条目赢（含）', ['-codemode', '+codemode'], ['read', 'bash', 'edit', 'write', 'codemode']],
    ['["codemode","read"] 混合纯名 → 整体替换为纯名集合', ['codemode', 'read'], ['codemode', 'read']],
    ['["codemode", 42] 坏值混入 → 非字符串被剥除后解析（探针：filter 在解析前）', ['codemode', 42], ['codemode']],
    ['[42, "+codemode"] 坏值混入 → 剥除后按 modifier 解析', [42, '+codemode'], ['read', 'bash', 'edit', 'write', 'codemode']],
    ['["-"] 空 name modifier → no-op', ['+', '-'], ['read', 'bash', 'edit', 'write']],
    ['["+CODEMODE"] 大小写敏感（工具名精确匹配）', ['+CODEMODE'], ['read', 'bash', 'edit', 'write', 'CODEMODE']],
  ] as const)('%s', (_label, raw, expected) => {
    expect(resolveDefaultToolSet(raw)).toEqual(expected)
  })

  it('pi DEFAULT_TOOL_NAMES 同构常量（默认集漂移即测试红）', () => {
    expect([...PI_DEFAULT_TOOL_NAMES]).toEqual(['read', 'bash', 'edit', 'write'])
  })
})

describe('isCodemodeActive · 读侧显示判定', () => {
  it.each([
    ['["+codemode"] → 开', ['+codemode'], true],
    ['["codemode"] 纯名形态 → 开', ['codemode'], true],
    ['["-codemode"] → 关', ['-codemode'], false],
    ['字段缺失 → 关', undefined, false],
    ['[] → 关', [], false],
    ['非数组坏值 → 关（D2 读侧）', 'bad', false],
    ['null → 关', null, false],
    ['["+codemode", 42] 坏值混入 → 开（filter 后仍含）', ['+codemode', 42], true],
  ] as const)('%s', (_label, raw, expected) => {
    expect(isCodemodeActive(raw)).toBe(expected)
  })
})

// ── 2. 启动迁移（目标 2：幂等默认写入，D2 存在性判定）────────────────────────

describe('ensureCodemodeDefaultEntry · 字段存在性判定 + 幂等', () => {
  it.each([
    ['字段缺失 → 写 ["+codemode"]（S1 首次启动）', undefined, ['+codemode']],
    ['null = 未配置 → 写 ["+codemode"]（D2：undefined/null 同归未配置）', null, ['+codemode']],
  ] as const)('%s', (_label, seedValue, expected) => {
    seed(seedValue)
    ensureCodemodeDefaultEntry()
    expect(onDisk().defaultTools).toEqual(expected)
  })

  it.each([
    ['空数组 = 已配置 → 不碰（尊重）', []],
    ['["+codemode"] 已是默认 → 幂等不动', ['+codemode']],
    ['["-codemode"] 关闭态 → 不碰（关闭跨重启持久，S4 反向验证）', ['-codemode']],
    ['["codemode"] 危险纯名 → 不碰（不代偿，S6）', ['codemode']],
    ['坏值（字符串）→ 不碰（D2：字段存在即尊重）', 'bad'],
    ['坏值数组（含非字符串元素）→ 不碰', ['codemode', 42]],
    ['用户混合条目 → 不碰', ['-read', '+codemode']],
  ] as const)('%s', (_label, seedValue) => {
    seed(seedValue)
    ensureCodemodeDefaultEntry()
    expect(onDisk().defaultTools).toEqual(seedValue)
  })

  it('重复调用幂等（写后文件字节稳定）', () => {
    seed(undefined)
    ensureCodemodeDefaultEntry()
    const after1 = readFileSync(settingsPath, 'utf-8')
    ensureCodemodeDefaultEntry()
    expect(readFileSync(settingsPath, 'utf-8')).toBe(after1)
  })

  it('只动 tools 域：用户其他字段逐字节保留（字段域 merge）', () => {
    seed(undefined, { defaultModel: 'keep-me', packages: ['p1'], somePiField: { nested: true } })
    ensureCodemodeDefaultEntry()
    const disk = onDisk()
    expect(disk.defaultTools).toEqual(['+codemode'])
    expect(disk.defaultModel).toBe('keep-me')
    expect(disk.packages).toEqual(['p1'])
    expect(disk.somePiField).toEqual({ nested: true })
  })

  it('文件不存在（全新安装态）→ 建文件写 ["+codemode"]', () => {
    expect(existsSync(settingsPath)).toBe(false)
    ensureCodemodeDefaultEntry()
    expect(onDisk().defaultTools).toEqual(['+codemode'])
  })
})

// ── 3. 开关写入（目标 3：D2 开关打开/关闭语义表）─────────────────────────────

describe('setCodemodeEntry(true) · 开关打开', () => {
  it.each([
    ['字段缺失 → 写 ["+codemode"]', undefined, ['+codemode']],
    ['null 非法形态 → 规范化覆盖 ["+codemode"]', null, ['+codemode']],
    ['"bad" 非法形态 → 规范化覆盖 ["+codemode"]（D2：显式配置动作）', 'bad', ['+codemode']],
    ['42 非法形态 → 规范化覆盖 ["+codemode"]', 42, ['+codemode']],
    ['["+codemode"] → 幂等不动', ['+codemode'], ['+codemode']],
    ['["codemode"] 纯名已含 codemode → 幂等不动（D2：含纯名形态）', ['codemode'], ['codemode']],
    ['["-codemode"] → 移除负条目后空集 → 追加 ["+codemode"]', ['-codemode'], ['+codemode']],
    ['["-codemode","-read"] → 用户条目保留、追加到尾部（S5 预期形态）', ['-codemode', '-read'], ['-read', '+codemode']],
    ['["codemode","read"] 混合纯名已含 → 幂等不动', ['codemode', 'read'], ['codemode', 'read']],
    ['[42, "+codemode"] 坏值元素原样保留（不代偿用户数据，解析时才 filter）', [42, '+codemode'], [42, '+codemode']],
    ['[42, "-codemode"] → 剥负条目 + 追加，坏值元素保留', [42, '-codemode'], [42, '+codemode']],
  ] as const)('%s', (_label, seedValue, expected) => {
    seed(seedValue)
    setCodemodeEntry(true)
    expect(onDisk().defaultTools).toEqual(expected)
  })

  it('开启后落盘值经 pi 解析语义激活 codemode（落盘 ⇄ 解析闭环）', () => {
    seed('bad')
    setCodemodeEntry(true)
    expect(isCodemodeActive(onDisk().defaultTools)).toBe(true)
  })
})

describe('setCodemodeEntry(false) · 开关关闭（负条目占位 + 混合纯名边界）', () => {
  it.each([
    ['字段缺失 → 规范化覆盖 ["-codemode"]', undefined, ['-codemode']],
    ['null 非法形态 → 规范化覆盖 ["-codemode"]', null, ['-codemode']],
    ['"bad" 非法形态 → 规范化覆盖 ["-codemode"]', 'bad', ['-codemode']],
    ['["+codemode"] → 移除后空 → ["-codemode"] 占位（字段保留防启动写回，S4）', ['+codemode'], ['-codemode']],
    ['[] → 移除后空 → ["-codemode"] 占位（禁落空数组——pi 空数组 = 全禁默认工具）', [], ['-codemode']],
    ['["codemode"] → 移除纯名后空 → ["-codemode"] 占位（S6 规范化回落）', ['codemode'], ['-codemode']],
    ['["-codemode"] → 幂等（kept 非空保留，不重复追加）', ['-codemode'], ['-codemode']],
    ['["+codemode","-read"] → 移除后非空 → 保留 ["-read"] 不追加占位', ['+codemode', '-read'], ['-read']],
    ['["codemode","read"] 混合纯名边界 → 落盘 ["read"]（D2：纯名语义忠实结果）', ['codemode', 'read'], ['read']],
    ['["+codemode","codemode","-read"] → 正条目与纯名全移，用户条目保留', ['+codemode', 'codemode', '-read'], ['-read']],
    ['[42, "+codemode"] → 坏值元素原样保留', [42, '+codemode'], [42]],
  ] as const)('%s', (_label, seedValue, expected) => {
    seed(seedValue)
    setCodemodeEntry(false)
    expect(onDisk().defaultTools).toEqual(expected)
  })

  it.each([
    ['["+codemode"] → 占位后关闭', ['+codemode']],
    ['["codemode","read"] → 混合纯名移除后关闭', ['codemode', 'read']],
    ['[] → 占位后关闭', []],
  ] as const)('关闭后落盘值经 pi 解析语义不含 codemode（%s）', (_label, seedValue) => {
    seed(seedValue)
    setCodemodeEntry(false)
    expect(isCodemodeActive(onDisk().defaultTools)).toBe(false)
  })

  it('只动 tools 域：用户其他字段保留', () => {
    seed(['+codemode'], { defaultModel: 'keep-me' })
    setCodemodeEntry(false)
    const disk = onDisk()
    expect(disk.defaultTools).toEqual(['-codemode'])
    expect(disk.defaultModel).toBe('keep-me')
  })

  it('关→开→关往返：条目形态稳定（占位与默认条目互斥不堆积）', () => {
    seed(undefined)
    ensureCodemodeDefaultEntry() // ['+codemode']
    setCodemodeEntry(false)
    expect(onDisk().defaultTools).toEqual(['-codemode'])
    setCodemodeEntry(true)
    expect(onDisk().defaultTools).toEqual(['+codemode'])
    setCodemodeEntry(false)
    expect(onDisk().defaultTools).toEqual(['-codemode'])
  })
})

describe('开关写入常量契约', () => {
  it('默认条目为增量语法、占位为负条目（D2：增量条目，不整组覆盖）', () => {
    expect(CODEMODE_DEFAULT_ENTRY).toBe('+codemode')
    expect(CODEMODE_DISABLE_ENTRY).toBe('-codemode')
  })
})

// ── 4. 损坏检测单点（A1：raw 预检 + .corrupt- 副本 + 每次现查）───────────────

describe('getSettingsCorruption · 两形态 + 每次现查 + 不触发隔离', () => {
  function expectNotCorrupted(r: SettingsCorruption, expectedPath = settingsPath): void {
    expect(r.corrupted).toBe(false)
    expect(r.corruptCopyPath).toBeNull()
    expect(r.filePath).toBe(expectedPath)
  }

  it('形态判定基线：好文件 / 文件不存在且无副本 → not corrupted', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'm' }), 'utf-8')
    expectNotCorrupted(getSettingsCorruption())
    rmSync(settingsPath)
    expectNotCorrupted(getSettingsCorruption()) // 全新安装正常态
  })

  it('形态①：原路径存在但 JSON 非法 → corrupted，无副本', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    const r = getSettingsCorruption()
    expect(r.corrupted).toBe(true)
    expect(r.filePath).toBe(settingsPath)
    expect(r.corruptCopyPath).toBeNull()
  })

  it('形态①延伸：原路径存在但不可读（EISDIR——readFileSync 目录）→ corrupted（fail-safe）', () => {
    // settingsPath 位置放一个目录：读错误 = EISDIR（非 ENOENT）——JsonStore 对该类
    // 读失败同样会走隔离，故 raw 预检按损坏拒入（无法证明 JSON 合法）
    rmSync(settingsPath, { force: true })
    mkdirSync(settingsPath)
    const r = getSettingsCorruption()
    expect(r.corrupted).toBe(true)
    expect(r.corruptCopyPath).toBeNull()
  })

  it('形态②：原路径不存在但存在 .corrupt-<时间戳> 副本 → corrupted + 副本路径', () => {
    writeFileSync(join(dir, `settings.json${corruptCopyName('2026-10-04T00:00:00.000Z')}`), '{ broken', 'utf-8')
    const r = getSettingsCorruption()
    expect(r.corrupted).toBe(true)
    expect(r.corruptCopyPath).toBe(join(dir, `settings.json${corruptCopyName('2026-10-04T00:00:00.000Z')}`))
    expect(r.filePath).toBe(settingsPath)
  })

  it('形态②多副本 → 报告最新一个（ISO 压缩时间戳字典序 = 时间序）', () => {
    writeFileSync(join(dir, `settings.json${corruptCopyName('2026-10-01T00:00:00.000Z')}`), '{}', 'utf-8')
    const latest = join(dir, `settings.json${corruptCopyName('2026-10-04T12:00:00.000Z')}`)
    writeFileSync(latest, '{ broken', 'utf-8')
    expect(getSettingsCorruption().corruptCopyPath).toBe(latest)
  })

  it('同名前缀但不匹配 .corrupt- 形态的文件不算副本（.conflict- / 无关文件）', () => {
    writeFileSync(join(dir, 'settings.json.conflict-20261004T000000000Z'), '{}', 'utf-8')
    writeFileSync(join(dir, 'settings.json.bak'), '{}', 'utf-8')
    expectNotCorrupted(getSettingsCorruption())
  })

  it('每次现查（结果不缓存）：好 → 坏 → 修复，三次查询结果如实翻转', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'm' }), 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(false)
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(true)
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'fixed' }), 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(false)
  })

  it('副本出现后现查可见：无 → 有', () => {
    expect(getSettingsCorruption().corrupted).toBe(false)
    writeFileSync(join(dir, `settings.json${corruptCopyName('2026-10-04T01:00:00.000Z')}`), '{', 'utf-8')
    expect(getSettingsCorruption().corrupted).toBe(true)
  })

  it('raw 预检不触发隔离改名：损坏文件原位原样、无新副本产生（A1 核心约束）', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    for (let i = 0; i < 3; i++) getSettingsCorruption()
    expect(existsSync(settingsPath)).toBe(true)
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
    expect(readdirSync(dir).filter(name => name.includes('.corrupt-'))).toEqual([])
  })

  it('filePath 跟随测试重定向路径（getActiveSettingsPath 单一来源）', () => {
    const otherPath = join(dir, 'other', 'settings.json')
    mkdirSync(join(dir, 'other'))
    setSettingsPath(otherPath)
    expect(getSettingsCorruption().filePath).toBe(otherPath)
  })
})

// ── 5. 组合根启动迁移入口（目标 5：损坏跳过 + 告警；未损坏写入）──────────────

describe('runCodemodeStartupMigration · 组合根启动序列编排', () => {
  it('未损坏 + 字段缺失 → 幂等默认写入', () => {
    seed(undefined)
    runCodemodeStartupMigration()
    expect(onDisk().defaultTools).toEqual(['+codemode'])
  })

  it('未损坏 + 已配置（关闭态）→ 不碰', () => {
    seed(['-codemode'])
    runCodemodeStartupMigration()
    expect(onDisk().defaultTools).toEqual(['-codemode'])
  })

  it('损坏 → 跳过迁移（文件不被触碰）+ 结构化告警含路径与恢复指引', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    runCodemodeStartupMigration()
    // 文件原样：迁移没有经 JsonStore 触发隔离、也没有以空基线覆盖
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
    expect(existsSync(settingsPath)).toBe(true)
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(settingsPath)
    expect(logged).toContain('修复或删除该文件后重试')
  })

  it('损坏（副本形态）→ 告警含隔离副本路径', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = join(dir, `settings.json${corruptCopyName('2026-10-04T02:00:00.000Z')}`)
    writeFileSync(copyPath, '{ broken', 'utf-8')
    runCodemodeStartupMigration()
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(copyPath)
    expect(logged).toContain('修复或删除该文件后重试')
  })

  it('迁移失败（写盘错误）不阻塞启动：warn 留痕不抛（ES1 风格）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 目录只读 → updateSettingsFields 取锁（mkdir lockfile）失败
    chmodSync(dir, 0o555)
    try {
      expect(() => runCodemodeStartupMigration()).not.toThrow()
      expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('启动迁移失败')
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})
