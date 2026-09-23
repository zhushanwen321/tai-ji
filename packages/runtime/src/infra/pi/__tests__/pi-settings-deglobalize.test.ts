/**
 * settings 去全局化行为测试（code-harden RT-3#12）。
 *
 * 锁定：
 * - PiExtensionSettings / PiRetrySettings 构造函数不再调用 setSettingsPath——模块级
 *   settings.json 写入目标不被「最后构造者」决定（构造任意实例零全局副作用）；
 * - getPackages / getRetryConfig 不再读前 invalidateSettingsCache——JsonStore 指纹校验
 *   下外部写方（pi 子进程 / 测试直写文件）的下一次 read 立即可见；
 * - 实例自有 store（disabled-packages / auto-upgrade）按构造参数落点读写。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-settings-deglobalize.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiExtensionSettings } from '../pi-extension-settings.js'
import { PiRetrySettings } from '../pi-retry-settings.js'
import { setSettingsPath, getActiveSettingsPath, invalidateSettingsCache } from '../pi-settings-store.js'

let dir: string
let dirA: string
let dirB: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-deglob-rt3-12-'))
  dirA = join(dir, 'agent-a')
  dirB = join(dir, 'agent-b')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setSettingsPath(join(dirA, 'settings.json'))
  invalidateSettingsCache()
})

afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('RT-3#12 构造零全局副作用', () => {
  it('构造 PiExtensionSettings(dirB) / PiRetrySettings() 后，全局 settings 路径仍是 dirA', () => {
    expect(getActiveSettingsPath()).toBe(join(dirA, 'settings.json'))

    // 构造副作用断言本身就是用例主体（不使用产物实例）
    void new PiExtensionSettings(dirB)
    void new PiRetrySettings()

    expect(getActiveSettingsPath()).toBe(join(dirA, 'settings.json'))
    // dirB 不因构造被写 settings.json（旧实现会重建 store 触碰 dirB 路径语义）
    expect(join(dirB, 'settings.json')).not.toEqual(getActiveSettingsPath())
  })

  it('两实例互不干扰：extension 域（经全局 settings）+ 实例自有 store（各自目录）', async () => {
    writeFileSync(join(dirA, 'settings.json'), JSON.stringify({ packages: ['npm:x'] }), 'utf-8')
    const ext = new PiExtensionSettings(dirB)
    expect(ext.getPackages()).toEqual(['npm:x'])

    // 实例自有 store 落在构造参数目录（dirB），不落全局 settings 目录（dirA）
    await ext.setEnabled('npm:y', false)
    expect(readFileSync(join(dirB, 'disabled-packages.json'), 'utf-8')).toContain('npm:y')
    expect(ext.getDisabled()).toEqual(['npm:y'])

    const retry = new PiRetrySettings()
    const snapshot = retry.getRetryConfig()
    expect(snapshot.configured).toBe(false)
    expect(snapshot.config.enabled).toBe(true)
  })
})

describe('RT-3#12 读侧指纹可见性（不再读前 invalidate）', () => {
  it('外部直写 settings.json 后，getRetryConfig / getPackages 立即读到新值（无 invalidate）', () => {
    const settingsPath = join(dirA, 'settings.json')
    const ext = new PiExtensionSettings(dirB)
    const retry = new PiRetrySettings()

    // 首读建立缓存
    expect(ext.getPackages()).toEqual([])
    expect(retry.getRetryConfig().configured).toBe(false)

    // 外部写方（模拟 pi 子进程直接落盘）
    writeFileSync(settingsPath, JSON.stringify({ packages: ['npm:ext-1'], retry: { enabled: false } }), 'utf-8')

    // 无任何 invalidateSettingsCache 调用——指纹失配自动重读
    expect(ext.getPackages()).toEqual(['npm:ext-1'])
    expect(retry.getRetryConfig().configured).toBe(true)
    expect(retry.getRetryConfig().config.enabled).toBe(false)
  })
})
