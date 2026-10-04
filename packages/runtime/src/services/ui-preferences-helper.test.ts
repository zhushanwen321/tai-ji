/**
 * ui-preferences-helper 单测（u-locale-channel）——原子写 / 回落 / 同值短路 / last-write-wins。
 *
 * 全部写盘目标 = 本测试自建自删的 `mkdtempSync(join(tmpdir(), ...))`，不触碰真实数据目录
 * （test-guard 白名单 + 工厂注入，见 docs/TEST-STRATEGY.md）。
 *
 * 运行：cd packages/runtime && pnpm test src/services/ui-preferences-helper
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_UI_LOCALE,
  readUiPreferences,
  uiPreferencesPath,
  writeUiPreferences,
} from './ui-preferences-helper.js'

describe('ui-preferences-helper', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ui-prefs-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('写入后文件形状 = { v:1, locale, updatedAt }，且无 tmp 残留（原子写）', () => {
    const result = writeUiPreferences(root, 'zh-CN', 1_700_000_000_000)
    expect(result).toEqual({ ok: true })

    const parsed = JSON.parse(readFileSync(uiPreferencesPath(root), 'utf-8')) as {
      v: number
      locale: string
      updatedAt: number
    }
    expect(parsed).toEqual({ v: 1, locale: 'zh-CN', updatedAt: 1_700_000_000_000 })
    // 原子写：tmp 文件已 rename 掉，目录里只剩正式文件
    expect(readdirSync(root)).toEqual(['ui-preferences.json'])
    expect(readUiPreferences(root)).toBe('zh-CN')
  })

  it('缺失文件：读侧回落默认 en-US（不抛）', () => {
    expect(existsSync(uiPreferencesPath(root))).toBe(false)
    expect(readUiPreferences(root)).toBe(DEFAULT_UI_LOCALE)
    expect(DEFAULT_UI_LOCALE).toBe('en-US')
  })

  it('JSON 损坏：读侧回落默认 en-US + warn', () => {
    writeFileSync(uiPreferencesPath(root), '{ not json', 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
  })

  it('locale 非法 / 顶层非对象：读侧回落默认 en-US', () => {
    writeFileSync(uiPreferencesPath(root), JSON.stringify({ v: 1, locale: 'fr-FR' }), 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
    writeFileSync(uiPreferencesPath(root), JSON.stringify('zh-CN'), 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
    writeFileSync(uiPreferencesPath(root), JSON.stringify(null), 'utf-8')
    expect(readUiPreferences(root)).toBe('en-US')
  })

  it('同值重复推送：短路不重写（updatedAt 保持不变）', () => {
    expect(writeUiPreferences(root, 'zh-CN', 1000)).toEqual({ ok: true })
    // 第二次同值推送带不同 now：短路命中，不落盘
    expect(writeUiPreferences(root, 'zh-CN', 2000)).toEqual({ ok: true })
    const parsed = JSON.parse(readFileSync(uiPreferencesPath(root), 'utf-8')) as { updatedAt: number }
    expect(parsed.updatedAt).toBe(1000)
  })

  it('值变化重写，且多窗口 last-write-wins（最后写入者权威）', () => {
    expect(writeUiPreferences(root, 'zh-CN', 1000).ok).toBe(true)
    expect(writeUiPreferences(root, 'en-US', 2000).ok).toBe(true)
    expect(readUiPreferences(root)).toBe('en-US')
    expect(writeUiPreferences(root, 'zh-CN', 3000).ok).toBe(true)
    expect(readUiPreferences(root)).toBe('zh-CN')
  })

  it('configDir 不存在时自动创建（mkdir recursive）', () => {
    const nested = join(root, 'instances', 'wt-x')
    expect(writeUiPreferences(nested, 'en-US', 1).ok).toBe(true)
    expect(readUiPreferences(nested)).toBe('en-US')
  })

  it('写盘失败：返回 { ok:false, code, error } 不抛（handler 据此走错误信封）', () => {
    // 让 configDir 指向一个已存在的文件 → mkdir recursive 抛 EEXIST/ENOTDIR
    const asFile = join(root, 'not-a-dir')
    writeFileSync(asFile, 'x', 'utf-8')
    const result = writeUiPreferences(asFile, 'zh-CN')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ui_preferences_io_error')
    expect(typeof result.error).toBe('string')
  })
})
