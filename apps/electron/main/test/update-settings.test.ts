/**
 * 升级设置存储 SSOT（update-settings）单元测试。
 *
 * 覆盖 update-settings.ts 全部导出：
 *   1. 无文件时 getUpdateSettings 返回默认值 { preDownload: false, updateSource: 'auto' }
 *   2. setUpdateSettings 后 getUpdateSettings 读回
 *   3. 损坏 JSON 时 getUpdateSettings 降级默认值
 *   4. updateSource 配置链（多源 D3）：合法三值写入读回 / 非法值回退 auto / 缺失字段向后兼容
 *
 * Mock 策略参考 pending-update.test.ts：用真实 fs（临时目录），经
 * TAIJI_AGENT_DATA_DIR 重定向 getUpdateSettingsFile() 落点（路径延迟求值，
 * env 先设确保所有后续求值命中 tmp）。env 设好后动态 import 模块拿独立实例。
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-settings.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UpdateSettings, UpdateSourcePref } from '@taiji/shared'

// ── env 先于一切路径求值设置（历史形态要求 import 前设，延迟求值后非硬约束）──
// constants.ts 现经 getUpdateSettingsFile() 延迟求值（getDataDir 读 TAIJI_AGENT_DATA_DIR）。
// 赋值仍放最前（无害），下方模块经动态 import 在 env 就绪后加载。
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'update-settings-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

interface UpdateSettingsModule {
  getUpdateSettings: () => UpdateSettings
  setUpdateSettings: (settings: Partial<UpdateSettings>) => void
  DEFAULT_UPDATE_SETTINGS: UpdateSettings
  UPDATE_SOURCE_PREFS: readonly string[]
  isUpdateSourcePref: (value: unknown) => value is UpdateSourcePref
}

// 动态 import：确保 env 赋值先生效
async function loadModule(): Promise<UpdateSettingsModule> {
  return await import('../update/update-settings.js')
}

/** update-settings.json 落盘路径（与 constants.ts 推导一致） */
const UPDATE_SETTINGS_FILE = path.join(TMP_DATA_DIR, 'update', 'update-settings.json')

describe('update-settings (升级设置存储 SSOT)', () => {
  let mod: UpdateSettingsModule

  beforeEach(async () => {
    mod = await loadModule()
    // 每个用例独立：清掉残留的 update-settings.json
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  afterEach(() => {
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── 1. 无文件时 getUpdateSettings 返回默认值 ────────────────────
  it('getUpdateSettings：无文件时返回默认值 { preDownload: false, autoUpdate: true }（验收④）', () => {
    expect(existsSync(UPDATE_SETTINGS_FILE)).toBe(false)
    const settings = mod.getUpdateSettings()
    expect(settings).toEqual({ preDownload: false, autoUpdate: true, updateSource: 'auto' })
    // 默认值常量与本模块导出一致
    expect(settings).toEqual(mod.DEFAULT_UPDATE_SETTINGS)
    // 验收④：autoUpdate 默认值必须为 true（存量用户现状即自动检查，默认 false 属行为倒退）
    expect(mod.DEFAULT_UPDATE_SETTINGS.autoUpdate).toBe(true)
    // 返回的是副本，修改不影响默认常量
    settings.preDownload = true
    expect(mod.DEFAULT_UPDATE_SETTINGS.preDownload).toBe(false)
  })

  // ── 2. setUpdateSettings 后 getUpdateSettings 读回 ──────────────
  it('setUpdateSettings：写入后 getUpdateSettings 读回相同值', () => {
    mod.setUpdateSettings({ preDownload: true })
    // 文件确实写到了 UPDATE_SETTINGS_FILE
    expect(existsSync(UPDATE_SETTINGS_FILE)).toBe(true)

    const settings = mod.getUpdateSettings()
    expect(settings).toEqual({ preDownload: true, autoUpdate: true, updateSource: 'auto' })
    expect(settings.preDownload).toBe(true)
  })

  it('setUpdateSettings：写入 false 后 getUpdateSettings 读回 false', () => {
    // 先写 true 再写 false，验证覆盖而非追加
    mod.setUpdateSettings({ preDownload: true })
    mod.setUpdateSettings({ preDownload: false })

    const raw = readFileSync(UPDATE_SETTINGS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as UpdateSettings
    expect(parsed.preDownload).toBe(false)

    expect(mod.getUpdateSettings()).toEqual({ preDownload: false, autoUpdate: true, updateSource: 'auto' })
  })

  // ── 2.5 autoUpdate：局部更新合并语义（不覆盖其他开关） ──────────────
  it('setUpdateSettings：仅传 { autoUpdate: true } 读回 autoUpdate true 且 preDownload 保持默认', () => {
    mod.setUpdateSettings({ autoUpdate: true })
    expect(mod.getUpdateSettings()).toEqual({ preDownload: false, autoUpdate: true, updateSource: 'auto' })
  })

  it('setUpdateSettings：局部更新合并——先后写 preDownload 与 autoUpdate 互不覆盖', () => {
    mod.setUpdateSettings({ preDownload: true })
    mod.setUpdateSettings({ autoUpdate: true })
    expect(mod.getUpdateSettings()).toEqual({ preDownload: true, autoUpdate: true, updateSource: 'auto' })
    // 反向顺序同样成立
    mod.setUpdateSettings({ autoUpdate: false })
    expect(mod.getUpdateSettings()).toEqual({ preDownload: true, autoUpdate: false, updateSource: 'auto' })
  })

  // ── 3. 损坏 JSON 时 getUpdateSettings 降级默认值 ────────────────
  it('getUpdateSettings：文件损坏（非法 JSON）→ 降级返回默认值，不抛错', () => {
    const dir = path.dirname(UPDATE_SETTINGS_FILE)
    mkdirSync(dir, { recursive: true })
    writeFileSync(UPDATE_SETTINGS_FILE, 'this is not valid json {{{', 'utf-8')
    expect(existsSync(UPDATE_SETTINGS_FILE)).toBe(true)

    const settings = mod.getUpdateSettings()
    expect(settings).toEqual({ preDownload: false, autoUpdate: true, updateSource: 'auto' })
    // 注意：损坏时不自动清除文件（与 pending-update 不同），但下次读仍降级默认值
    expect(() => mod.getUpdateSettings()).not.toThrow()
  })

  it('getUpdateSettings：preDownload 字段类型错误（非 boolean）→ 降级默认值', () => {
    const dir = path.dirname(UPDATE_SETTINGS_FILE)
    mkdirSync(dir, { recursive: true })
    // preDownload 写成字符串，逐字段校验应回退默认值
    writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify({ preDownload: 'yes' }), 'utf-8')

    const settings = mod.getUpdateSettings()
    expect(settings.preDownload).toBe(false)
  })

  it('getUpdateSettings：autoUpdate 字段类型错误（非 boolean）→ 降级默认值', () => {
    const dir = path.dirname(UPDATE_SETTINGS_FILE)
    mkdirSync(dir, { recursive: true })
    // autoUpdate 写成字符串，逐字段校验应回退默认值
    writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify({ preDownload: true, autoUpdate: 'yes' }), 'utf-8')

    const settings = mod.getUpdateSettings()
    expect(settings.preDownload).toBe(true)
    // 类型错误的 autoUpdate 降级为默认值（批次 4：默认 true）
    expect(settings.autoUpdate).toBe(true)
  })

  // ── 4. updateSource 配置链（多源 update-multi-source D3） ────────────
  it('UPDATE_SOURCE_PREFS：合法值集合恰为三值（读取侧与 handler 校验共用 SSOT，防漂移）', () => {
    expect([...mod.UPDATE_SOURCE_PREFS].sort()).toEqual(['atomgit', 'auto', 'github'])
    // 守卫与集合一致：三值全真、非法全假
    for (const v of mod.UPDATE_SOURCE_PREFS) {
      expect(mod.isUpdateSourcePref(v)).toBe(true)
    }
    expect(mod.isUpdateSourcePref('gitee')).toBe(false)
    expect(mod.isUpdateSourcePref(42)).toBe(false)
    expect(mod.isUpdateSourcePref(null)).toBe(false)
    expect(mod.isUpdateSourcePref(undefined)).toBe(false)
  })

  it('updateSource：合法值 github 写入读回一致（局部更新不覆盖 preDownload）', () => {
    mod.setUpdateSettings({ preDownload: true })
    mod.setUpdateSettings({ updateSource: 'github' })
    expect(existsSync(UPDATE_SETTINGS_FILE)).toBe(true)

    const settings = mod.getUpdateSettings()
    expect(settings.updateSource).toBe('github')
    // 合并语义：仅传 updateSource 不覆盖其他开关的持久化值
    expect(settings.preDownload).toBe(true)
  })

  it('updateSource：合法三值轮转写入读回一致（github → atomgit → auto）', () => {
    const prefs: UpdateSourcePref[] = ['github', 'atomgit', 'auto']
    for (const pref of prefs) {
      mod.setUpdateSettings({ updateSource: pref })
      expect(mod.getUpdateSettings().updateSource).toBe(pref)
    }
    // 落盘内容即最后一次写入
    const raw = JSON.parse(readFileSync(UPDATE_SETTINGS_FILE, 'utf-8')) as UpdateSettings
    expect(raw.updateSource).toBe('auto')
  })

  it('updateSource：落盘非法字符串（gitee）→ 读取回退默认 auto，其他合法字段保留', () => {
    mod.setUpdateSettings({ preDownload: true, updateSource: 'github' })
    // 模拟手改/旧版本写入的非法值（setUpdateSettings 调用方已校验，读取侧兜底）
    writeFileSync(
      UPDATE_SETTINGS_FILE,
      JSON.stringify({ preDownload: true, autoUpdate: false, updateSource: 'gitee' }),
      'utf-8',
    )

    const settings = mod.getUpdateSettings()
    expect(settings.updateSource).toBe('auto')
    // 非法 updateSource 不污染其他字段的读取
    expect(settings.preDownload).toBe(true)
    expect(settings.autoUpdate).toBe(false)
  })

  it('updateSource：落盘非法类型（数字/null）→ 读取回退默认 auto', () => {
    for (const invalid of [42, null]) {
      mkdirSync(path.dirname(UPDATE_SETTINGS_FILE), { recursive: true })
      writeFileSync(
        UPDATE_SETTINGS_FILE,
        JSON.stringify({ preDownload: false, autoUpdate: true, updateSource: invalid }),
        'utf-8',
      )
      expect(mod.getUpdateSettings().updateSource).toBe('auto')
    }
  })

  it('updateSource：老 settings 文件缺失该字段 → 读回 auto（向后兼容），既有开关值不受影响', () => {
    mkdirSync(path.dirname(UPDATE_SETTINGS_FILE), { recursive: true })
    // 多源改造前的老文件形状：只有 preDownload/autoUpdate，无 updateSource
    writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify({ preDownload: true, autoUpdate: false }), 'utf-8')

    const settings = mod.getUpdateSettings()
    expect(settings.updateSource).toBe('auto')
    expect(settings.preDownload).toBe(true)
    expect(settings.autoUpdate).toBe(false)
  })
})
