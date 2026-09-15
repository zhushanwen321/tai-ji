/**
 * skill-dir-config 单测。
 *
 * 核心：buildDirConfigs 把 preset 候选 + discovery v2 分 scope 结构组合成 UI 用的 SkillDirConfig[]。
 * 重点验证 ADR §5 脏数据过滤 + v2 scope 分组顺序 [project.enabled → global.enabled → project.preset → global.preset]。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import type { SkillDirConfig } from '@taiji/shared'
import {
  buildDirConfigs,
  PRESET_SKILL_DIRS,
  PRESET_AGENT_DIRS,
} from '../src/services/skill-dir-config.js'
import {
  setSkillDirs,
  getSkillDirs,
  getSkillPathScopes,
  setDiscoveryPath,
} from '../src/infra/pi/discovery-store.js'

/** 包装为 project scope。 */
const proj = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'project' })
/** 包装为 global scope。 */
const glob = (path: string): SkillDirConfig => ({ path, enabled: true, scope: 'global' })

describe('skill-dir-config buildDirConfigs', () => {
  let tmpRealDir: string

  beforeEach(() => {
    tmpRealDir = mkdtempSync(join(tmpdir(), 'skill-dircfg-'))
  })

  afterEach(() => {
    rmSync(tmpRealDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('过滤不存在的绝对路径脏数据（/path/a 等 pi 占位符）', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, { projectPaths: [], globalPaths: ['/path/a', '/path/b'] })
    const enabled = configs.filter(c => c.enabled)
    expect(enabled).toHaveLength(0)
    expect(configs.every(c => c.enabled === false)).toBe(true)
  })

  it('保留存在的绝对路径，过滤不存在的', () => {
    const configs = buildDirConfigs([], { projectPaths: [], globalPaths: [tmpRealDir, '/path/a'] })
    const enabledPaths = configs.filter(c => c.enabled).map(c => c.path)
    expect(enabledPaths).toContain(tmpRealDir)
    expect(enabledPaths).not.toContain('/path/a')
  })

  it('~ 路径展开后存在则保留为 enabled（确定性，不依赖测试机环境）', () => {
    // fs-guard：家目录在白名单外不可写。HOME 临时指向 tmp——expandHome 经 os.homedir()
    // 动态读 $HOME，`~` 展开语义原样保留（展开结果落在 fakeHome 下）。
    const realHome = process.env.HOME
    const fakeHome = mkdtempSync(join(tmpdir(), 'skill-home-'))
    process.env.HOME = fakeHome
    try {
      const tmpHomeSubdir = mkdtempSync(join(fakeHome, '.skill-test-'))
      const tildePath = '~/' + basename(tmpHomeSubdir)
      const configs = buildDirConfigs([], { projectPaths: [], globalPaths: [tildePath, '/path/a'] })
      const enabled = configs.filter(c => c.enabled)
      expect(enabled.map(c => c.path)).toContain(tildePath)
      expect(enabled.map(c => c.path)).not.toContain('/path/a')
    } finally {
      process.env.HOME = realHome
      // fakeHome 递归删除已覆盖其下 fixture，无需单独清理 tmpHomeSubdir
      rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('相对路径不检查存在性（project scope，preset 候选语义，buildDirConfigs 不知 cwd）', () => {
    const configs = buildDirConfigs([], { projectPaths: ['.agents/skills', '.taiji/skills'], globalPaths: [] })
    const enabled = configs.filter(c => c.enabled)
    expect(enabled.map(c => c.path)).toEqual(['.agents/skills', '.taiji/skills'])
    // project scope 标注正确
    expect(enabled.every(c => c.scope === 'project')).toBe(true)
  })

  it('preset 全部未启用时，按 scope 分组追加（project preset 在前，global preset 在后）', () => {
    // PRESET_SKILL_DIRS = ['~/.pi/agent/skills'(g), '~/.claude/skills'(g), '~/.agents/skills'(g), '.agents/skills'(p)]
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, { projectPaths: [], globalPaths: [] })
    expect(configs).toHaveLength(PRESET_SKILL_DIRS.length)
    expect(configs.every(c => c.enabled === false)).toBe(true)
    // project preset（'.agents/skills'）在前，global preset（前三个）在后，各自内层按 preset 固定顺序
    expect(configs.map(c => c.path)).toEqual([
      '.agents/skills',
      '~/.pi/agent/skills',
      '~/.claude/skills',
      '~/.agents/skills',
    ])
    expect(configs.find(c => c.path === '.agents/skills')!.scope).toBe('project')
    expect(configs.find(c => c.path === '~/.pi/agent/skills')!.scope).toBe('global')
  })

  it('discovery 启用顺序保留（= 用户拖拽优先级，靠前覆盖靠后）', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'skill-order-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'skill-order-b-'))
    try {
      const configs = buildDirConfigs([], { projectPaths: [], globalPaths: [dirB, dirA] })
      const enabled = configs.filter(c => c.enabled)
      // global 内顺序与传入一致（dirB 在前）
      expect(enabled.map(c => c.path)).toEqual([dirB, dirA])
    } finally {
      rmSync(dirA, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(dirB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('v2 顺序：project.enabled → global.enabled → project.preset → global.preset', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, {
      projectPaths: ['.proj-enabled'],
      globalPaths: [tmpRealDir],
    })
    const enabled = configs.filter(c => c.enabled)
    // project enabled 在最前
    expect(enabled[0]).toEqual({ path: '.proj-enabled', enabled: true, scope: 'project' })
    // global enabled 紧随
    expect(enabled[1]).toEqual({ path: tmpRealDir, enabled: true, scope: 'global' })
    // 之后是 project preset 未启用（'.agents/skills'），再 global preset 未启用
    const disabled = configs.filter(c => !c.enabled)
    expect(disabled.map(c => c.path)).toEqual(['.agents/skills', '~/.pi/agent/skills', '~/.claude/skills', '~/.agents/skills'])
  })

  it('agent preset 结构对称（PRESET_AGENT_DIRS）', () => {
    const configs = buildDirConfigs(PRESET_AGENT_DIRS, { projectPaths: [], globalPaths: [] })
    expect(configs).toHaveLength(PRESET_AGENT_DIRS.length)
    expect(configs.every(c => c.enabled === false)).toBe(true)
  })

  it('preset 成员即使不存在也保留为 enabled（推荐候选语义，防回归）', () => {
    const configs = buildDirConfigs(PRESET_SKILL_DIRS, { projectPaths: [], globalPaths: ['~/.claude/skills'] })
    const claudeEntry = configs.find(c => c.path === '~/.claude/skills')
    expect(claudeEntry).toBeTruthy()
    expect(claudeEntry!.enabled).toBe(true)
    expect(claudeEntry!.scope).toBe('global')
    const otherPresets = configs.filter(c => c.path !== '~/.claude/skills' && !c.enabled)
    expect(otherPresets).toHaveLength(PRESET_SKILL_DIRS.length - 1)
  })
})

describe('discovery-store setSkillDirs 脏数据写入过滤（v2 SkillDirConfig[]，与 buildDirConfigs 对齐，ADR §5）', () => {
  let discoveryPath: string
  let discoveryTmpDir: string
  let realDir: string

  beforeEach(() => {
    discoveryTmpDir = mkdtempSync(join(tmpdir(), 'discovery-filter-'))
    discoveryPath = join(discoveryTmpDir, 'discovery.json')
    setDiscoveryPath(discoveryPath)
    realDir = mkdtempSync(join(tmpdir(), 'skill-real-'))
  })

  afterEach(() => {
    rmSync(discoveryTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(realDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('剔除不存在的绝对路径脏数据（/path/a 等 pi 占位符），保留存在的', () => {
    setSkillDirs([glob('/path/a'), glob('/path/b'), glob(realDir)])
    expect(getSkillDirs()).toEqual([realDir])
  })

  it('preset 成员即使不存在也保留（推荐候选语义，豁免 existsSync）', () => {
    setSkillDirs([glob('~/.claude/skills'), glob('~/.pi/agent/skills'), glob('/path/a')])
    expect(getSkillDirs()).toEqual(['~/.claude/skills', '~/.pi/agent/skills'])
  })

  it('相对路径不检查存在性（project scope，无 cwd 上下文）', () => {
    setSkillDirs([proj('.agents/skills'), proj('.taiji/skills'), glob('/path/a')])
    expect(getSkillDirs()).toEqual(['.agents/skills', '.taiji/skills'])
  })

  it('~ 展开后存在的路径保留（确定性，不依赖测试机）', () => {
    // 同上：HOME 临时指向 tmp（fs-guard 白名单），~ 展开语义保留
    const realHome = process.env.HOME
    const fakeHome = mkdtempSync(join(tmpdir(), 'skill-home-set-'))
    process.env.HOME = fakeHome
    try {
      const tmpHomeSubdir = mkdtempSync(join(fakeHome, '.skill-settest-'))
      const tildePath = '~/' + basename(tmpHomeSubdir)
      setSkillDirs([glob(tildePath), glob('/path/a')])
      expect(getSkillDirs()).toEqual([tildePath])
    } finally {
      process.env.HOME = realHome
      // fakeHome 递归删除已覆盖其下 fixture，无需单独清理 tmpHomeSubdir
      rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('按 scope 分发写 projectPaths/globalPaths（getSkillPathScopes 验证）', () => {
    setSkillDirs([glob(realDir), proj('.agents/skills'), glob('~/.claude/skills')])
    expect(getSkillPathScopes()).toEqual({
      projectPaths: ['.agents/skills'],
      globalPaths: [realDir, '~/.claude/skills'],
    })
  })

  it('合并顺序：project 在前（优先级 > 全局），保留各组内顺序', () => {
    setSkillDirs([glob(realDir), glob('~/.claude/skills'), glob('/path/a'), proj('.agents/skills')])
    // '/path/a' 被过滤；project('.agents/skills') 在前，global(realDir, ~/.claude/skills) 在后
    expect(getSkillDirs()).toEqual(['.agents/skills', realDir, '~/.claude/skills'])
  })
})
