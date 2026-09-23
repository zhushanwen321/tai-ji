/**
 * setSkillPaths 两步写失败回滚测试（code-harden RT-3#8）。
 *
 * 场景：discovery.json 写入成功后，settings.json 投影（updateSettingsFields 跨进程锁）
 * 失败（settings 父目录只读 → lockfile mkdir EACCES）→ discovery 必须回滚为写前内容，
 * 错误原样上抛——否则 pi 读到的 skills 与 taiji 视图分歧到下一次成功写。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-skill-paths-rollback.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSkillPaths, getSkillPaths } from '../pi-skill-paths.js'
import { setSettingsPath, invalidateSettingsCache, readSettings } from '../pi-settings-store.js'
import { setDiscoveryPath, invalidateDiscoveryCache } from '../discovery-store.js'

let dir: string
let agentDir: string
let readonlyDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-paths-rt3-8-'))
  agentDir = join(dir, 'agent')
  readonlyDir = join(dir, 'readonly-agent')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(readonlyDir, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setDiscoveryPath(join(agentDir, 'discovery.json'))
  invalidateDiscoveryCache()
  setSettingsPath(join(readonlyDir, 'settings.json'))
  invalidateSettingsCache()
})

afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('setSkillPaths · 两步写失败回滚（RT-3#8）', () => {
  it('settings 投影失败 → discovery 回滚为写前内容，错误上抛', () => {
    // 前置：discovery 已有一组路径（回滚目标）。路径必须真实存在——partitionByScope
    // 的脏数据过滤会剔除不存在的自定义绝对路径（ADR §5）， fixture 目录真建。
    const origDir = join(dir, 'skills-orig')
    const newDir = join(dir, 'skills-new')
    mkdirSync(origDir)
    mkdirSync(newDir)
    setSkillPaths([{ path: origDir, enabled: true, scope: 'global' }])
    const before = getSkillPaths()

    // settings 父目录只读 → 投影（updateSettingsFields 锁创建）失败
    chmodSync(readonlyDir, 0o555)
    try {
      expect(() => setSkillPaths([{ path: newDir, enabled: true, scope: 'global' }])).toThrow()
      // 回滚：discovery 恢复写前内容（磁盘 + 读侧一致）
      expect(getSkillPaths()).toEqual(before)
      const onDisk = JSON.parse(readFileSync(join(agentDir, 'discovery.json'), 'utf-8'))
      expect(onDisk.skill.globalPaths).toContain(origDir)
      expect(onDisk.skill.globalPaths).not.toContain(newDir)
    } finally {
      chmodSync(readonlyDir, 0o755)
    }
  })

  it('正向对照：两步都成功 → discovery 与 settings.skills 同步', () => {
    // settings 指回可写目录；skill 目录真实存在（脏数据过滤，见上）
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()
    const okDir = join(dir, 'skills-ok')
    mkdirSync(okDir)

    setSkillPaths([{ path: okDir, enabled: true, scope: 'global' }])

    expect(getSkillPaths()).toEqual([okDir])
    expect(readSettings().skills).toEqual([okDir])
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(true)
  })
})
