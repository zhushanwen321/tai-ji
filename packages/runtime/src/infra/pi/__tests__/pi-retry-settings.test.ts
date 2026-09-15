/**
 * PiRetrySettings（infra）retry 域读写测试（设计 llm-retry-settings §3.3 D3/D7）。
 *
 * 锁定：
 * - D3 嵌套 merge：顶层/嵌套坏值整体替换（无索引键垃圾）、六已知键只 patch 已知键、
 *   pi 未知子字段保留；
 * - P2 写后立刻读一致（updateSettingsFields 锁内 invalidate+重读，无 TTL 缓存窗口）；
 * - set 后文件实际落盘（setSettingsPath 测试钩子指向临时文件）；
 * - D7 configured 语义与坏值回落默认。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-retry-settings.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRetrySettings } from '../pi-retry-settings.js'
import { invalidateSettingsCache } from '../pi-settings-store.js'

let dir: string
let settingsPath: string
let retrySettings: PiRetrySettings

/** 先摆盘再构造（构造会 setSettingsPath 重建 store、清缓存），保证读到种子内容。 */
function seedFile(retryValue: unknown, extra: Record<string, unknown> = {}): void {
  writeFileSync(settingsPath, JSON.stringify({ ...extra, retry: retryValue }, null, 2), 'utf-8')
  retrySettings = new PiRetrySettings(dir)
}

function readRetryFromDisk(): unknown {
  return JSON.parse(readFileSync(settingsPath, 'utf-8'))['retry']
}

const VALID = { enabled: true, maxRetries: 2, baseDelayMs: 3000 }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-retry-settings-'))
  settingsPath = join(dir, 'settings.json')
  retrySettings = new PiRetrySettings(dir)
})

afterEach(() => {
  invalidateSettingsCache()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('PiRetrySettings · getRetryConfig（D7 缺省合并 + configured 语义）', () => {
  it('文件缺失：全默认值 + configured=false', () => {
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(false)
    expect(config).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
    })
    expect('timeoutMs' in config.provider!).toBe(false)
  })

  it('半配置（仅 provider.maxRetryDelayMs 一键）：configured=true 且其余键合并默认', () => {
    seedFile({ provider: { maxRetryDelayMs: 1800000 } })
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(true)
    expect(config.enabled).toBe(true)
    expect(config.maxRetries).toBe(3)
    expect(config.provider!.maxRetryDelayMs).toBe(1800000)
  })

  it('键在值坏（maxRetries:"abc"）：configured=true 且该键回落默认 3（D7 坏值承接）', () => {
    seedFile({ maxRetries: 'abc' })
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(true)
    expect(config.maxRetries).toBe(3)
  })

  it('顶层 retry 坏值（字符串）：configured=false + 全默认', () => {
    seedFile('abc')
    const { config, configured } = retrySettings.getRetryConfig()
    expect(configured).toBe(false)
    expect(config.enabled).toBe(true)
  })

  it('存量超域数值原样返回（不静默改写为默认）', () => {
    seedFile({ maxRetries: 50 })
    const { config } = retrySettings.getRetryConfig()
    expect(config.maxRetries).toBe(50)
  })
})

describe('PiRetrySettings · setRetryConfig（D3 嵌套 merge + 落盘）', () => {
  it('set 后文件实际落盘且写后立刻读一致（P2）', () => {
    const result = retrySettings.setRetryConfig({ ...VALID, provider: { timeoutMs: 30000, maxRetries: 1, maxRetryDelayMs: 60000 } })
    expect(result).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as Record<string, unknown>
    expect(onDisk).toEqual({
      enabled: true,
      maxRetries: 2,
      baseDelayMs: 3000,
      provider: { timeoutMs: 30000, maxRetries: 1, maxRetryDelayMs: 60000 },
    })
    // P2：写后立刻读（同一 store 实例，锁内 invalidate+重写缓存）应与落盘值一致
    const snapshot = retrySettings.getRetryConfig()
    expect(snapshot.configured).toBe(true)
    expect(snapshot.config.maxRetries).toBe(2)
    expect(snapshot.config.baseDelayMs).toBe(3000)
    expect(snapshot.config.provider!.timeoutMs).toBe(30000)
  })

  it('顶层 retry 坏值（字符串）：整体替换为合法对象，无索引键垃圾', () => {
    seedFile('abc')
    expect(retrySettings.setRetryConfig(VALID)).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as Record<string, unknown>
    expect(onDisk.enabled).toBe(true)
    expect(onDisk.maxRetries).toBe(2)
    expect(onDisk.baseDelayMs).toBe(3000)
    expect(Object.keys(onDisk).every(k => typeof k === 'string' && !/^\d+$/.test(k))).toBe(true)
  })

  it('provider 层坏值（字符串）：provider 整体替换，其余顶层键正常 merge', () => {
    seedFile({ enabled: false, maxRetries: 5, baseDelayMs: 1000, provider: 'abc' })
    expect(retrySettings.setRetryConfig({ ...VALID, provider: { maxRetries: 1 } })).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as Record<string, unknown>
    expect(onDisk.enabled).toBe(true)
    expect(onDisk.maxRetries).toBe(2)
    expect(onDisk.provider).toEqual({ maxRetries: 1 })
  })

  it('六键只 patch 已知键：pi 未知子字段（顶层+provider 层）原样保留', () => {
    seedFile(
      { enabled: false, maxRetries: 5, baseDelayMs: 1000, futureTop: 'keep', provider: { maxRetries: 2, futureSub: 9, maxRetryDelayMs: 0 } },
    )
    expect(retrySettings.setRetryConfig({ ...VALID, provider: { maxRetryDelayMs: 60000 } })).toEqual({ ok: true })
    const onDisk = readRetryFromDisk() as {
      futureTop: string
      provider: Record<string, unknown>
    }
    expect(onDisk.futureTop).toBe('keep')
    expect(onDisk.provider.futureSub).toBe(9)
    expect(onDisk.provider.maxRetries).toBeUndefined() // 入参未设 → 删键（pi 默认 0 语义）
    expect(onDisk.provider.maxRetryDelayMs).toBe(60000)
    expect(onDisk.provider.timeoutMs).toBeUndefined()
  })

  it('D8 越界：ok:false + error 信封，不落盘（文件保持原样）', () => {
    seedFile({ enabled: true })
    const result = retrySettings.setRetryConfig({ ...VALID, baseDelayMs: 99999000 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('baseDelayMs')
    expect(readRetryFromDisk()).toEqual({ enabled: true })
  })

  it('provider.timeoutMs=0 拒绝（0 会透传成 0ms 立即超时）', () => {
    const result = retrySettings.setRetryConfig({ ...VALID, provider: { timeoutMs: 0 } })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('provider.timeoutMs')
  })

  it('写路径 I/O 失败（锁目录创建被拒）→ D10 错误信封 ok:false + error，不抛、不落盘', () => {
    // settings 目录只读 → updateSettingsFields 取锁（mkdir lockfile）即 EACCES
    chmodSync(dir, 0o555)
    try {
      const result = retrySettings.setRetryConfig(VALID)
      expect(result.ok).toBe(false)
      expect(typeof result.error).toBe('string')
      expect(result.error!.length).toBeGreaterThan(0)
      // 写失败无残留：settings.json 不被创建/改写
      expect(existsSync(settingsPath)).toBe(false)
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})
