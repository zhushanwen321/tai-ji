/**
 * migrateSettingsSkillsToDiscovery 单测 —— ADR-0021 §1 迁移逻辑回归保护。
 *
 * 关键场景（真实环境踩过的坑）：旧 settings.json.skills 存的是「单 skill 目录」粒度
 * （如 ~/.pi/agent/skills/anysearch），44 条去重父目录后只有 2 个容器。
 * 迁移必须归并为容器粒度，且过滤脏数据（/path/a 等测试残留）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { migrateSettingsSkillsToDiscovery, getSkillPaths, setSkillPaths } from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath, readSettings } from '../src/infra/pi/pi-settings-store.js'
import { setDiscoveryPath, readDiscovery } from '../src/infra/pi/discovery-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string
let piAgentDir: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'migrate-skill-test-'))
  piAgentDir = join(tmpDir, 'agent')
  mkdirSync(piAgentDir, { recursive: true })
  setSettingsPath(join(piAgentDir, 'settings.json'))
  setDiscoveryPath(join(piAgentDir, 'discovery.json'))
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

/** 在 tmpDir 下创建一个 skill 容器（含若干带 SKILL.md 的子目录）。 */
function createSkillContainer(parentDir: string, skillNames: string[]): string {
  mkdirSync(parentDir, { recursive: true })
  for (const name of skillNames) {
    const skillDir = join(parentDir, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---\ndescription: ${name}\n---\n# ${name}`, 'utf-8')
  }
  return parentDir
}

describe('migrateSettingsSkillsToDiscovery', () => {
  it('旧单 skill 路径 → 归并为容器目录（44 条 → 2 容器）', () => {
    // 模拟真实环境：2 个容器，共 44 条单 skill 路径
    const piContainer = createSkillContainer(join(tmpDir, '.pi', 'agent', 'skills'), ['anysearch', 'code-review', 'zcommit'])
    const agentsContainer = createSkillContainer(join(tmpDir, '.agents', 'skills'), ['handoff', 'rethink'])

    // 旧 settings.json.skills 存的是「单 skill 目录」粒度（粒度错误）
    const legacySingleSkillPaths = [
      join(piContainer, 'anysearch'),
      join(piContainer, 'code-review'),
      join(piContainer, 'zcommit'),
      join(agentsContainer, 'handoff'),
      join(agentsContainer, 'rethink'),
    ]
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: legacySingleSkillPaths }), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    // 迁移后 discovery 应是 2 个容器目录（去重父目录），不是 5 条单 skill 路径
    const dirs = getSkillPaths()
    expect(dirs).toHaveLength(2)
    expect(dirs).toContain(piContainer)
    expect(dirs).toContain(agentsContainer)
    // settings.json.skills 应同步投影为容器粒度
    expect(readSettings().skills).toEqual(dirs)
  })

  it('discovery 已有有效容器 → no-op（幂等）', () => {
    const container = createSkillContainer(join(tmpDir, '.pi', 'agent', 'skills'), ['anysearch'])
    setSkillPaths([{ path: container, enabled: true, scope: 'global' }]) // discovery 已有有效容器
    const dirsBefore = getSkillPaths()

    // 即使 settings.json 有旧数据，也不应覆盖 discovery
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(container, 'other')] }), 'utf-8')
    migrateSettingsSkillsToDiscovery()

    expect(getSkillPaths()).toEqual(dirsBefore)
  })

  it('discovery 只有脏数据（非容器）→ 仍执行迁移覆盖', () => {
    // discovery 存了脏数据（/path/a 不存在，非容器）
    setDiscoveryPath(join(piAgentDir, 'discovery.json'))
    const container = createSkillContainer(join(tmpDir, '.agents', 'skills'), ['handoff'])
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(container, 'handoff')] }), 'utf-8')

    // 先注入脏数据
    const dirtyDiscovery = { version: 1, skillDirs: ['/path/a', '/path/b'], agentDirs: [] }
    writeFileSync(join(piAgentDir, 'discovery.json'), JSON.stringify(dirtyDiscovery), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    // 脏数据被有效容器覆盖
    expect(getSkillPaths()).toEqual([container])
  })

  it('settings.json.skills 为空 → no-op', () => {
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [] }), 'utf-8')
    migrateSettingsSkillsToDiscovery()
    expect(getSkillPaths()).toEqual([])
  })

  it('旧路径父目录不是容器（无 SKILL.md 子目录）→ 过滤掉', () => {
    // 父目录存在但不含任何 SKILL.md 子目录 → 不是有效容器，应过滤
    const notContainer = join(tmpDir, 'not-a-container')
    mkdirSync(notContainer, { recursive: true })
    writeFileSync(join(notContainer, 'random.txt'), 'hello', 'utf-8')
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(notContainer, 'random')] }), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    expect(getSkillPaths()).toEqual([])
  })

  it('迁移后 discovery 为 v2 结构（容器进 globalPaths）', () => {
    const container = createSkillContainer(join(tmpDir, '.pi', 'agent', 'skills'), ['s1'])
    writeFileSync(join(piAgentDir, 'settings.json'), JSON.stringify({ skills: [join(container, 's1')] }), 'utf-8')

    migrateSettingsSkillsToDiscovery()

    const d = readDiscovery()
    expect(d.version).toBe(2)
    expect(d.skill.globalPaths).toHaveLength(1)
    expect(d.skill.projectPaths).toEqual([])
    expect(d.agent.projectPaths).toEqual([])
    expect(d.agent.globalPaths).toEqual([])
  })
})
