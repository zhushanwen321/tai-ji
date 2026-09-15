/**
 * [HISTORICAL] 用户数据污染回归测试 — 2026-07-26 事故防护。
 *
 * 事故：pi-provider-store.test.ts 的 beforeEach 漏调 setDiscoveryPath，
 * setSkillPaths 经模块级 discoveryStore 写真实路径 ~/.taiji/agent/discovery.json，
 * 内容是测试 tmp 路径（测试结束 rm 后路径失效），用户重启 app 发现 skill 扫描路径「凭空消失」。
 *
 * 本测试验证防护机制：globalSetup 强制 TAIJI_AGENT_DATA_DIR → tmp，所有 store 的 eager
 * 初始化（getDiscoveryPath/getSettingsPath/getModelsPath）都不指向 ~/.taiji。
 *
 * 若此测试失败，说明：
 *   1. globalSetup 未生效（vitest.config.ts 配置丢失 / globalSetup 没跑）
 *   2. 或 store 模块绕过了 getDataDir / getPiAgentDir（直接硬编码 ~/.taiji）
 * 任一情况都会再次导致用户数据污染。
 */
import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getDiscoveryPath } from '../src/infra/pi/discovery-store.js'
import { getActiveSettingsPath } from '../src/infra/pi/pi-settings-store.js'
import { getSettingsPath } from '../src/infra/pi/pi-paths.js'
import { getDataDir } from '@taiji/shared/paths'

const REAL_DATA_DIR = join(homedir(), '.taiji')

describe('[HISTORICAL] 用户数据污染防护 (2026-07-26 事故)', () => {
  it('process.env.TAIJI_AGENT_DATA_DIR 已被 globalSetup 重定向到 tmp', () => {
    const env = process.env.TAIJI_AGENT_DATA_DIR
    expect(env, 'TAIJI_AGENT_DATA_DIR 应被 globalSetup 设置').toBeTruthy()
    expect(env, 'TAIJI_AGENT_DATA_DIR 不能指向真实数据目录 ~/.taiji').not.toBe(REAL_DATA_DIR)
    expect(env?.endsWith('.taiji'), 'TAIJI_AGENT_DATA_DIR 不能是默认值 ~/.taiji').toBe(false)
  })

  it('getDataDir() 不返回真实数据目录', () => {
    expect(getDataDir()).not.toBe(REAL_DATA_DIR)
  })

  it('discovery-store eager 初始化路径不指向真实用户数据目录', () => {
    const p = getDiscoveryPath()
    expect(p, `discovery path 不能是 ~/.taiji 下: ${p}`).not.toContain(REAL_DATA_DIR)
    // 真实路径形如 <dataDir>/agent/discovery.json，断言不落到这里
    expect(p.endsWith('/.taiji/agent/discovery.json')).toBe(false)
  })

  it('settings-store eager 初始化路径不指向真实用户数据目录', () => {
    // pi-settings-store 的 settingsStore 在模块加载时初始化，getActiveSettingsPath 反映实际绑定路径
    // 注意：若其他测试调过 setSettingsPath 指向 tmp，此处返回的是该 tmp；但全局默认（未调过）应是 globalSetup 路径
    const p = getSettingsPath()
    expect(p, `settings path 不能是 ~/.taiji 下: ${p}`).not.toContain(REAL_DATA_DIR)
    expect(p.endsWith('/.taiji/agent/settings.json')).toBe(false)
  })

  it('getActiveSettingsPath 不指向真实用户数据目录', () => {
    const p = getActiveSettingsPath()
    // 此测试可能晚于其他测试执行，路径可能是某 tmp，但绝不能是真实路径
    expect(p.endsWith('/.taiji/agent/settings.json')).toBe(false)
  })
})
