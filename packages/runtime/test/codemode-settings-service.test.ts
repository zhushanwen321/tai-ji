/**
 * PiCodemodeSettings（ICodemodeSettings port 的 infra 实现）测试（codemode 设计 D1/A1）。
 *
 * 锁定（验收条款①：get/set 命令对服务层语义）：
 * - getEnabled：正常读（pi 解析语义激活判定，含混合条目 / 坏值）；损坏错误态数据形状
 *   （enabled=false + corruption 有值）；「不走默认读路径」的行为断言——get 自身不触发
 *   JsonStore 读时隔离改名（A1 核心约束：codemode 读写路径绝不触发或加速隔离）；
 *   隔离副本形态（corruptCopyPath 命中）。
 * - setEnabled：正常写（D2 语义表：开 / 关占位 / 幂等 / 用户条目保留）；损坏拒入
 *   （ok:false 信封 + 文件原样未动 + 结构化告警日志含路径与恢复指引）；修复即恢复
 *   （损坏检测每次现查）。
 * - ConfigService 挂载：port 未注入抛错（同 llmRetrySettings 形态）+ 注入后委托。
 *
 * 运行：pnpm -C packages/runtime test codemode
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiCodemodeSettings } from '../src/infra/pi/pi-codemode-settings.js'
import { ConfigService } from '../src/services/config-service.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ICodemodeSettings } from '../src/services/ports/codemode-settings.js'
import { invalidateSettingsCache, readSettings, setSettingsPath } from '../src/infra/pi/pi-settings-store.js'

let dir: string
let settingsPath: string
const service = new PiCodemodeSettings()

/** 隔离副本完整文件名（json-store quarantineCorruptFile 形态：<原文件名>.corrupt-<ISO 压缩时间戳>）。 */
const corruptCopyName = (iso: string): string => `settings.json.corrupt-${iso.replace(/[:.]/g, '')}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codemode-settings-service-'))
  settingsPath = join(dir, 'settings.json')
  setSettingsPath(settingsPath)
})

afterEach(() => {
  vi.restoreAllMocks()
  invalidateSettingsCache()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 摆盘原始文本（绕过 JsonStore——损坏用例需要非法 JSON 落盘）。 */
function seedRaw(raw: string): void {
  writeFileSync(settingsPath, raw, 'utf-8')
  invalidateSettingsCache()
}

/** 摆盘合法对象并失效缓存。 */
function seed(obj: Record<string, unknown>): void {
  seedRaw(JSON.stringify(obj, null, 2))
}

describe('PiCodemodeSettings.getEnabled（A1 读侧）', () => {
  it('文件不存在（全新安装正常态）→ enabled=false 且 corruption=null', () => {
    expect(service.getEnabled()).toEqual({ enabled: false, corruption: null })
  })

  it('pi 解析语义激活判定：+codemode 开 / -codemode 关 / 混合条目开 / 非数组坏值关', () => {
    seed({ defaultTools: ['+codemode'] })
    expect(service.getEnabled().enabled).toBe(true)
    seed({ defaultTools: ['-codemode'] })
    expect(service.getEnabled().enabled).toBe(false)
    seed({ defaultTools: ['-read', '+codemode'] })
    expect(service.getEnabled().enabled).toBe(true)
    seed({ defaultTools: 'junk' })
    expect(service.getEnabled().enabled).toBe(false)
  })

  it('损坏 → 错误态 { enabled: false, corruption: { filePath, corruptCopyPath: null } }', () => {
    seedRaw('{ invalid json')
    const result = service.getEnabled()
    expect(result.enabled).toBe(false)
    expect(result.corruption).not.toBeNull()
    expect(result.corruption?.filePath).toBe(settingsPath)
    expect(result.corruption?.corruptCopyPath).toBeNull()
  })

  it('损坏时 get 自身不触发隔离改名（不走默认读路径的行为断言，A1 核心约束）', () => {
    const raw = '{ broken'
    seedRaw(raw)
    service.getEnabled()
    // 若误走 readSettings()：JsonStore 会把坏文件 rename 为 .corrupt-* 并重建默认文件——
    // 两者都不得发生（codemode 承诺自己的读写路径绝不触发或加速隔离）
    expect(existsSync(settingsPath)).toBe(true)
    expect(readFileSync(settingsPath, 'utf-8')).toBe(raw)
    expect(readdirSync(dir).filter(name => name.startsWith('.corrupt-'))).toEqual([])
  })

  it('隔离副本形态：原路径不存在 + .corrupt-<ts> 副本 → corruptCopyPath 命中副本', () => {
    mkdirSync(dir, { recursive: true })
    const copyPath = join(dir, corruptCopyName(new Date().toISOString()))
    writeFileSync(copyPath, '{ quarantined', 'utf-8')
    const result = service.getEnabled()
    expect(result.enabled).toBe(false)
    expect(result.corruption?.filePath).toBe(settingsPath)
    expect(result.corruption?.corruptCopyPath).toBe(copyPath)
  })
})

describe('PiCodemodeSettings.setEnabled（D2 语义表 + A1 写点拒入）', () => {
  it('开：空 settings → 落盘 ["+codemode"]，返回 ok:true + 写后终态 enabled=true', () => {
    seed({ model: 'p/m' })
    expect(service.setEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['+codemode'])
    // 用户其他字段零触碰（字段域 merge）
    expect(readSettings().model).toBe('p/m')
  })

  it('开幂等：已激活时重复开不重复追加', () => {
    seed({ defaultTools: ['+codemode'] })
    expect(service.setEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['+codemode'])
  })

  it('关：移除正条目后数组空 → 负条目占位（关闭跨重启持久），返回终态 enabled=false', () => {
    seed({ defaultTools: ['+codemode'] })
    expect(service.setEnabled(false)).toEqual({ ok: true, enabled: false })
    expect(readSettings().defaultTools).toEqual(['-codemode'])
    // 占位幂等：重复关不重复追加
    service.setEnabled(false)
    expect(readSettings().defaultTools).toEqual(['-codemode'])
  })

  it('用户条目保留：[-read] 开 → ["-read","+codemode"]（不整组覆盖）', () => {
    seed({ defaultTools: ['-read'] })
    expect(service.setEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['-read', '+codemode'])
  })

  it('损坏拒入：ok:false 信封（error 含路径与恢复指引）+ 文件原样未动 + 结构化告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = '{ broken'
    seedRaw(raw)
    const result = service.setEnabled(true)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain(settingsPath)
    // error 信封含修复指引（D3 定死文案语义：修复动作 + 无需重启）；「恢复指引」完整句在结构化告警日志（下方断言）
    expect(result.error).toContain('修复或删除该文件后重试')
    expect(result.error).toContain('无需重启')
    expect(result.corruption.filePath).toBe(settingsPath)
    expect(result.corruption.corruptCopyPath).toBeNull()
    // 写点拒入行为断言：坏文件既未被写改也未被隔离（A1 要堵死的「隔离后空基线覆盖」路径）
    expect(readFileSync(settingsPath, 'utf-8')).toBe(raw)
    expect(readdirSync(dir).filter(name => name.startsWith('.corrupt-'))).toEqual([])
    // 结构化告警：含路径与恢复指引（与启动迁移告警同文案结构，统一日志检索）
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain(settingsPath)
    expect(String(warn.mock.calls[0][0])).toContain('恢复指引')
  })

  it('修复即恢复（每次现查语义）：拒入后修复文件，重试开关成功', () => {
    seedRaw('{ broken')
    expect(service.setEnabled(true).ok).toBe(false)
    seed({ defaultTools: ['-codemode'] })
    const result = service.setEnabled(true)
    expect(result).toEqual({ ok: true, enabled: true })
    expect(readSettings().defaultTools).toEqual(['+codemode'])
  })

  it('副本形态损坏同样拒入，error 含隔离副本路径提示', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const copyPath = join(dir, corruptCopyName(new Date().toISOString()))
    writeFileSync(copyPath, '{ quarantined', 'utf-8')
    const result = service.setEnabled(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption.corruptCopyPath).toBe(copyPath)
    expect(result.error).toContain(copyPath)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('ConfigService 挂载（retry 域同形态）', () => {
  it('port 未注入：get/set 抛错且错误消息指向恢复动作', () => {
    const svc = new ConfigService('/tmp/project', {} as unknown as IConfigStore)
    expect(() => svc.getCodemodeEnabled()).toThrow(/\[config-service\] codemodeSettings not available \(getCodemodeEnabled\)/)
    expect(() => svc.setCodemodeEnabled(true)).toThrow(/\[config-service\] codemodeSettings not available \(setCodemodeEnabled\)/)
  })

  it('port 注入后单行委托（get 与 set 均透传返回值）', () => {
    const port: ICodemodeSettings = {
      getEnabled: () => ({ enabled: false, corruption: { filePath: '/x/settings.json', corruptCopyPath: null } }),
      setEnabled: enabled => (enabled ? { ok: true, enabled: true } : { ok: false, error: 'e', corruption: { filePath: '/x', corruptCopyPath: null } }),
    }
    const svc = new ConfigService('/tmp/project', {} as unknown as IConfigStore, undefined, undefined, undefined, undefined, undefined, port)
    expect(svc.getCodemodeEnabled()).toEqual({ enabled: false, corruption: { filePath: '/x/settings.json', corruptCopyPath: null } })
    expect(svc.setCodemodeEnabled(true)).toEqual({ ok: true, enabled: true })
    expect(svc.setCodemodeEnabled(false).ok).toBe(false)
  })
})
