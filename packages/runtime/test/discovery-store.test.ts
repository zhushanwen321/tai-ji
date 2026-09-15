import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { SkillDirConfig } from '@taiji/shared'
import {
  readDiscovery,
  writeDiscovery,
  getSkillDirs,
  getAgentDirs,
  getExtensionDirs,
  getSkillPathScopes,
  setSkillDirs,
  setAgentDirs,
  setExtensionDirs,
  setDiscoveryPath,
  invalidateDiscoveryCache,
} from '../src/infra/pi/discovery-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

/** v2 空配置（六字段全空）。 */
const DEFAULT_V2 = {
  version: 2,
  skill: { projectPaths: [], globalPaths: [] },
  agent: { projectPaths: [], globalPaths: [] },
  extension: { projectPaths: [], globalPaths: [] },
}

/** 包装为 project scope 的 SkillDirConfig。 */
const proj = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'project' })
/** 包装为 global scope 的 SkillDirConfig。 */
const glob = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'global' })

let tmpDir: string
let discoveryPath: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'discovery-store-test-'))
  discoveryPath = join(tmpDir, 'discovery.json')
  setDiscoveryPath(discoveryPath)
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

describe('discovery-store', () => {
  describe('readDiscovery', () => {
    it('returns default empty v2 config when file does not exist', () => {
      expect(readDiscovery()).toEqual(DEFAULT_V2)
    })

    it('reads existing v2 config', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 2,
        skill: { projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] },
        agent: { projectPaths: [], globalPaths: ['~/.agents/agents'] },
        extension: { projectPaths: [], globalPaths: [] },
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['.agents/skills', '~/.pi/agent/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
    })

    it('returns default on corrupt JSON', () => {
      writeFileSync(discoveryPath, '{ broken', 'utf-8')
      expect(readDiscovery()).toEqual(DEFAULT_V2)
    })

    it('returns default on non-object JSON (e.g. array)', () => {
      writeFileSync(discoveryPath, '[1,2,3]', 'utf-8')
      expect(readDiscovery()).toEqual(DEFAULT_V2)
    })

    it('filters non-string entries in v2 projectPaths/globalPaths', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 2,
        skill: { projectPaths: ['ok', 123, null, 'also-ok'], globalPaths: [true, 'glob-ok'] },
        agent: { projectPaths: [], globalPaths: [] },
        extension: { projectPaths: [], globalPaths: [] },
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['ok', 'also-ok', 'glob-ok'])
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['ok', 'also-ok'], globalPaths: ['glob-ok'] })
    })
  })

  describe('v1→v2 migration on read', () => {
    it('全相对路径 → 全 projectPaths', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['.agents/skills', '.taiji/skills'],
        agentDirs: ['.agents/agents'],
        extensionDirs: [],
      }), 'utf-8')
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills', '.taiji/skills'], globalPaths: [] })
      expect(getAgentDirs()).toEqual(['.agents/agents'])
    })

    it('全绝对/~ 路径 → 全 globalPaths', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['~/.pi/agent/skills', '/abs/skills'],
        agentDirs: [],
        extensionDirs: [],
      }), 'utf-8')
      expect(getSkillPathScopes()).toEqual({ projectPaths: [], globalPaths: ['~/.pi/agent/skills', '/abs/skills'] })
    })

    it('混合路径 → 按 isGlobalPath 分流（相对→project / 绝对/~→global）', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['~/.pi/agent/skills', '.agents/skills', '/abs/x', '.taiji/skills'],
        agentDirs: ['~/.agents/agents'],
        extensionDirs: ['.pi/extensions'],
      }), 'utf-8')
      expect(getSkillPathScopes()).toEqual({
        projectPaths: ['.agents/skills', '.taiji/skills'],
        globalPaths: ['~/.pi/agent/skills', '/abs/x'],
      })
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
      expect(getExtensionDirs()).toEqual(['.pi/extensions'])
      // 合并顺序：project 在前，global 在后（项目优先级 > 全局）
      expect(getSkillDirs()).toEqual(['.agents/skills', '.taiji/skills', '~/.pi/agent/skills', '/abs/x'])
    })

    it('空 v1 → 空 v2（六字段全空）', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: [],
        agentDirs: [],
        extensionDirs: [],
      }), 'utf-8')
      expect(readDiscovery()).toEqual(DEFAULT_V2)
    })

    it('v1 迁移后写回落盘为 v2（deserialize 迁移值经 writeDiscovery 持久化）', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['.agents/skills', '~/.pi/agent/skills'],
        agentDirs: [],
        extensionDirs: [],
      }), 'utf-8')
      // 触发读取（deserialize 迁移到 v2）
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
      // 一次写入把迁移结果落盘为 v2
      setSkillDirs([proj('.agents/skills'), glob('~/.pi/agent/skills')])
      invalidateDiscoveryCache()
      const onDisk = JSON.parse(readFileSync(discoveryPath, 'utf-8'))
      expect(onDisk.version).toBe(2)
      expect(onDisk.skill).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
    })
  })

  describe('setSkillDirs / setAgentDirs / setExtensionDirs (SkillDirConfig[])', () => {
    it('按 scope 分发：project 路径进 projectPaths，global 路径进 globalPaths', () => {
      setSkillDirs([proj('.agents/skills'), glob('~/.pi/agent/skills')])
      expect(getSkillPathScopes()).toEqual({ projectPaths: ['.agents/skills'], globalPaths: ['~/.pi/agent/skills'] })
      // 合并：project 在前
      expect(getSkillDirs()).toEqual(['.agents/skills', '~/.pi/agent/skills'])
    })

    it('writes skillDirs and preserves existing agentDirs', () => {
      setSkillDirs([glob('~/.pi/agent/skills'), glob('~/.claude/skills')])
      setAgentDirs([glob('~/.agents/agents')])
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills', '~/.claude/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
    })

    it('overwrites in order (drag-to-reorder writes new array)', () => {
      setSkillDirs([glob('c'), glob('a'), glob('b')])
      expect(getSkillDirs()).toEqual(['c', 'a', 'b'])
    })

    it('persists to disk as v2 (re-read via fresh cache after invalidate)', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      invalidateDiscoveryCache()
      const onDisk = JSON.parse(readFileSync(discoveryPath, 'utf-8'))
      expect(onDisk.version).toBe(2)
      expect(onDisk.skill).toEqual({ projectPaths: [], globalPaths: ['~/.pi/agent/skills'] })
    })

    it('deletes file when all six fields empty', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      expect(existsSync(discoveryPath)).toBe(true)
      // 清空 → 六字段全空 → 删文件
      setSkillDirs([])
      setAgentDirs([])
      setExtensionDirs([])
      expect(existsSync(discoveryPath)).toBe(false)
      // 再读返回默认 v2，不崩
      expect(readDiscovery()).toEqual(DEFAULT_V2)
    })
  })

  describe('setExtensionDirs', () => {
    it('writes extensionDirs and preserves existing skillDirs/agentDirs', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      setAgentDirs([glob('~/.agents/agents')])
      setExtensionDirs([glob('~/.pi/agent/extensions')])
      expect(getExtensionDirs()).toEqual(['~/.pi/agent/extensions'])
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
    })

    it('does not delete file when only extension is non-empty', () => {
      setSkillDirs([glob('~/.pi/agent/skills')])
      setSkillDirs([])
      setAgentDirs([])
      setExtensionDirs([glob('~/.pi/agent/extensions')])
      expect(existsSync(discoveryPath)).toBe(true)
      expect(getExtensionDirs()).toEqual(['~/.pi/agent/extensions'])
      setExtensionDirs([])
      expect(existsSync(discoveryPath)).toBe(false)
    })
  })

  describe('writeDiscovery (full overwrite)', () => {
    it('writes full v2 config object', () => {
      writeDiscovery({
        version: 2,
        skill: { projectPaths: ['x'], globalPaths: ['y'] },
        agent: { projectPaths: [], globalPaths: ['z'] },
        extension: { projectPaths: [], globalPaths: [] },
      })
      expect(readDiscovery()).toEqual({
        version: 2,
        skill: { projectPaths: ['x'], globalPaths: ['y'] },
        agent: { projectPaths: [], globalPaths: ['z'] },
        extension: { projectPaths: [], globalPaths: [] },
      })
    })
  })

  describe('TTL cache', () => {
    it('serves cached value within TTL, ignores external file change', () => {
      setSkillDirs([glob('v1')])
      writeFileSync(discoveryPath, JSON.stringify({
        version: 2,
        skill: { projectPaths: [], globalPaths: ['v2-external'] },
        agent: { projectPaths: [], globalPaths: [] },
        extension: { projectPaths: [], globalPaths: [] },
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['v1'])
      invalidateDiscoveryCache()
      expect(getSkillDirs()).toEqual(['v2-external'])
    })
  })
})
