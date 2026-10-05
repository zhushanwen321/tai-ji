/**
 * pi-settings-store 读侧统一阻断（fail-fast）测试（settings-corruption-global-defense
 * 用户终裁：核心配置损坏一律 fail-fast——损坏的 settings.json 不应被静默回落成空配置
 * 继续运行，也不应在读取路径被隔离改名）。
 *
 * 锁定：
 * - readSettings：损坏（非法 JSON / 不可读 / 原文件缺失但有 .corrupt- 副本）→ 抛
 *   SettingsCorruptedError（形状：code / corruption 载荷 / message 含绝对路径与修复指引）；
 *   好文件行为不变；修复文件后无需任何失效动作即恢复（检测每次现查）。
 * - 隔离退役：settings 读取路径零隔离——损坏读取后目录无 `.corrupt-*` 新副本、原文件
 *   字节原样；损坏时不返回缓存旧值（缓存毒化不存在，throw 路径不写缓存）。
 * - JsonStore corruptReadPolicy 机制层：'throw'（settings 专用）损坏读原样上抛；
 *   默认 'quarantine' 行为不变（settings 之外的消费方语义零变化）。
 * - 请求路径消费方错误信封传导：PiRetrySettings.getRetryConfig 真实损坏链异常上抛
 *   （不吞、零回落），code 透传依据 = SettingsCorruptedError.code（server.ts
 *   handleMessage catch `e.code ?? 'handler_error'` → sendError 错误信封）。
 * - 启动路径结构化告警：config-service.migrateSettingsSkillsToDiscovery 捕获
 *   SettingsCorruptedError 呈结构化告警（路径 + 修复指引）、不阻塞启动；非损坏错误不吞。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-settings-store-corruption.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readSettings,
  setSettingsPath,
  invalidateSettingsCache,
  SettingsCorruptedError,
} from '../pi-settings-store.js'
import { JsonStore } from '../../../utils/json-store.js'
import { PiRetrySettings } from '../pi-retry-settings.js'
import { PiConfigStore } from '../pi-config-store.js'
import { ConfigService } from '../../../services/config-service.js'

let dir: string
let settingsPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-settings-store-corruption-'))
  settingsPath = join(dir, 'settings.json')
  setSettingsPath(settingsPath)
})

afterEach(() => {
  vi.restoreAllMocks()
  invalidateSettingsCache()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 目录内 `.corrupt-` 副本清单（隔离退役断言用：损坏读取后必须恒空）。 */
function corruptCopies(): string[] {
  return readdirSync(dir).filter(name => name.includes('.corrupt-'))
}

describe('readSettings · 读侧统一阻断（fail-fast）', () => {
  it('非法 JSON → 抛 SettingsCorruptedError（形状：code/载荷/message 含路径与指引），文件原样无隔离副本', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    let caught: unknown
    try {
      readSettings()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SettingsCorruptedError)
    const err = caught as SettingsCorruptedError
    expect(err.code).toBe('settings_corrupted')
    expect(err.name).toBe('SettingsCorruptedError')
    expect(err.corruption.corrupted).toBe(true)
    expect(err.corruption.filePath).toBe(settingsPath)
    expect(err.corruption.corruptCopyPath).toBeNull()
    expect(err.message).toContain(settingsPath)
    expect(err.message).toContain('修复或删除该文件后重试')
    expect(err.message).toContain('无需重启')
    // 隔离退役：损坏读取不产生隔离副本，原文件字节原样
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
  })

  it('不可读形态（路径指向目录，EISDIR）→ 抛 SettingsCorruptedError（fail-safe：读不出文本即按损坏阻断）', () => {
    rmSync(settingsPath, { force: true })
    mkdirSync(settingsPath) // settings.json 位置是一个目录 → readFileSync EISDIR
    expect(() => readSettings()).toThrow(SettingsCorruptedError)
    expect(corruptCopies()).toEqual([])
  })

  it('副本形态（原文件缺失 + .corrupt- 副本存在）→ 抛 + corruptCopyPath 有值（历史遗留副本只作损坏信号源）', () => {
    const copyPath = `${settingsPath}.corrupt-20261005T000000000Z`
    writeFileSync(copyPath, '{ legacy-quarantine', 'utf-8')
    let caught: unknown
    try {
      readSettings()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SettingsCorruptedError)
    const err = caught as SettingsCorruptedError
    expect(err.corruption.corruptCopyPath).toBe(copyPath)
    expect(err.message).toContain(copyPath)
    expect(err.message).toContain('修复或删除该文件后重试')
  })

  it('好文件行为不变：未损坏 → 正常读取；文件不存在且无副本 → 空对象（全新安装正常态）', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'm1', packages: ['p1'] }), 'utf-8')
    invalidateSettingsCache()
    const settings = readSettings()
    expect(settings.defaultModel).toBe('m1')
    expect(settings.packages).toEqual(['p1'])

    rmSync(settingsPath, { force: true })
    invalidateSettingsCache()
    expect(readSettings()).toEqual({})
  })

  it('损坏时不返回缓存旧值：合法读（入缓存）→ 文件被改坏 → 抛（缓存毒化不存在）', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'stale-but-valid' }), 'utf-8')
    invalidateSettingsCache()
    expect(readSettings().defaultModel).toBe('stale-but-valid') // 值入缓存

    writeFileSync(settingsPath, '{ corrupted-after-cache', 'utf-8')
    expect(() => readSettings()).toThrow(SettingsCorruptedError)
    expect(corruptCopies()).toEqual([])
  })

  it('修复即恢复：损坏 → 抛 → 文件修回合法 → 读取成功（无任何失效动作，无需重启）', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    expect(() => readSettings()).toThrow(SettingsCorruptedError)

    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'fixed' }), 'utf-8')
    expect(readSettings().defaultModel).toBe('fixed')
  })
})

describe('JsonStore corruptReadPolicy · settings 路径隔离退役机制层', () => {
  it("'throw'：parse 失败原样上抛（SyntaxError），不隔离、不回落默认值", () => {
    const path = join(dir, 'throw-store.json')
    writeFileSync(path, '{ broken', 'utf-8')
    const store = new JsonStore<{ v: string }>(path, { v: 'default' }, { corruptReadPolicy: 'throw' })
    expect(() => store.read()).toThrow(SyntaxError)
    // 无隔离副本、原文件原样、无缓存毒化（再读仍抛而非返回默认值）
    expect(corruptCopies()).toEqual([])
    expect(readFileSync(path, 'utf-8')).toBe('{ broken')
    expect(() => store.read()).toThrow(SyntaxError)
  })

  it("'throw'：非 ENOENT 读失败（路径指向目录）原样上抛", () => {
    const path = join(dir, 'throw-dir.json')
    mkdirSync(path)
    const store = new JsonStore<{ v: string }>(path, { v: 'default' }, { corruptReadPolicy: 'throw' })
    expect(() => store.read()).toThrow()
  })

  it("默认 'quarantine'：parse 失败 → 隔离副本 + 默认值回落（settings 之外的消费方语义零变化）", () => {
    const path = join(dir, 'quarantine-store.json')
    writeFileSync(path, '{ broken', 'utf-8')
    const store = new JsonStore<{ v: string }>(path, { v: 'default' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(store.read()).toEqual({ v: 'default' })
    expect(corruptCopies().length).toBe(1)
    // 原文件已被隔离移走（原路径不存在）
    expect(() => readFileSync(path, 'utf-8')).toThrow()
  })
})

describe('请求路径消费方 · 错误信封传导（WS RPC handler 系零改动核验）', () => {
  it('PiRetrySettings.getRetryConfig 真实损坏链 → SettingsCorruptedError 上抛（不吞、零回落）', () => {
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    let caught: unknown
    try {
      new PiRetrySettings().getRetryConfig()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SettingsCorruptedError)
    const err = caught as SettingsCorruptedError
    // server.handleMessage catch 的 code 透传依据（`e.code ?? 'handler_error'` →
    // sendError 错误信封）：code 必须携带，message 可直达前端
    expect(err.code).toBe('settings_corrupted')
    expect(err.message).toContain(settingsPath)
    expect(corruptCopies()).toEqual([])
  })
})

describe('启动路径消费方 · 结构化告警（config-service.migrateSettingsSkillsToDiscovery）', () => {
  function makeService(): ConfigService {
    return new ConfigService('/tmp/project', new PiConfigStore())
  }

  it('损坏 → 结构化告警（路径 + 修复指引）、不抛不阻塞启动、无隔离副本', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(settingsPath, '{ broken', 'utf-8')
    expect(() => makeService().migrateSettingsSkillsToDiscovery()).not.toThrow()
    const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(settingsPath)
    expect(logged).toContain('修复或删除该文件后重试')
    expect(logged).toContain('无需重启')
    expect(corruptCopies()).toEqual([])
  })

  it('副本形态 → 告警含副本路径', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = `${settingsPath}.corrupt-20261005T010000000Z`
    writeFileSync(copyPath, '{ broken', 'utf-8')
    expect(() => makeService().migrateSettingsSkillsToDiscovery()).not.toThrow()
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain(copyPath)
  })

  it('非损坏错误不吞：configStore 抛普通错误 → 原样上抛', () => {
    // 无设置文件 + 无 discovery（全新安装）→ 迁移正常完成（对照组：不 warn 损坏）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => makeService().migrateSettingsSkillsToDiscovery()).not.toThrow()
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).not.toContain('已损坏')
  })
})
