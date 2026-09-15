import { describe, it, expect } from 'vitest'
import { migrateDiscoveryV1ToV2 } from '../discovery-migrate'
import type { DiscoveryConfigV1 } from '../provider'

describe('migrateDiscoveryV1ToV2', () => {
  it('全相对路径 → 全进 projectPaths，globalPaths 空', () => {
    const v1: DiscoveryConfigV1 = {
      version: 1,
      skillDirs: ['.agents/skills', '.taiji/skills'],
      agentDirs: ['.agents/agents'],
      extensionDirs: ['.taiji/extensions'],
    }
    const v2 = migrateDiscoveryV1ToV2(v1)
    expect(v2).toEqual({
      version: 2,
      skill: { projectPaths: ['.agents/skills', '.taiji/skills'], globalPaths: [] },
      agent: { projectPaths: ['.agents/agents'], globalPaths: [] },
      extension: { projectPaths: ['.taiji/extensions'], globalPaths: [] },
    })
  })

  it('全绝对路径 → 全进 globalPaths，projectPaths 空', () => {
    const v1: DiscoveryConfigV1 = {
      version: 1,
      skillDirs: ['~/.pi/agent/skills', '/abs/skills'],
      agentDirs: ['~/.pi/agent/agents'],
      extensionDirs: ['/abs/extensions'],
    }
    const v2 = migrateDiscoveryV1ToV2(v1)
    expect(v2).toEqual({
      version: 2,
      skill: { projectPaths: [], globalPaths: ['~/.pi/agent/skills', '/abs/skills'] },
      agent: { projectPaths: [], globalPaths: ['~/.pi/agent/agents'] },
      extension: { projectPaths: [], globalPaths: ['/abs/extensions'] },
    })
  })

  it('混合路径 → 各归各位（相对→project / 绝对→global）', () => {
    const v1: DiscoveryConfigV1 = {
      version: 1,
      skillDirs: ['.agents/skills', '~/.pi/agent/skills', '/opt/skills'],
      agentDirs: ['~/.pi/agent/agents', '.agents/agents'],
      extensionDirs: ['.taiji/extensions', '/opt/extensions'],
    }
    const v2 = migrateDiscoveryV1ToV2(v1)
    expect(v2.version).toBe(2)
    expect(v2.skill).toEqual({
      projectPaths: ['.agents/skills'],
      globalPaths: ['~/.pi/agent/skills', '/opt/skills'],
    })
    expect(v2.agent).toEqual({
      projectPaths: ['.agents/agents'],
      globalPaths: ['~/.pi/agent/agents'],
    })
    expect(v2.extension).toEqual({
      projectPaths: ['.taiji/extensions'],
      globalPaths: ['/opt/extensions'],
    })
  })

  it('空数组 → projectPaths 与 globalPaths 均空', () => {
    const v1: DiscoveryConfigV1 = {
      version: 1,
      skillDirs: [],
      agentDirs: [],
      extensionDirs: [],
    }
    const v2 = migrateDiscoveryV1ToV2(v1)
    expect(v2).toEqual({
      version: 2,
      skill: { projectPaths: [], globalPaths: [] },
      agent: { projectPaths: [], globalPaths: [] },
      extension: { projectPaths: [], globalPaths: [] },
    })
  })

  it('纯函数：不修改入参（深比较前后一致）', () => {
    const v1: DiscoveryConfigV1 = {
      version: 1,
      skillDirs: ['.agents/skills', '~/.pi/agent/skills'],
      agentDirs: ['.agents/agents'],
      extensionDirs: [],
    }
    const snapshot = JSON.parse(JSON.stringify(v1)) as DiscoveryConfigV1
    migrateDiscoveryV1ToV2(v1)
    expect(v1).toEqual(snapshot)
  })
})
