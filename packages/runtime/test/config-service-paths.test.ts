/**
 * W1 TDD 测试：config-service 的 skill/agent 全局强制目录用动态 getConfigDir()。
 *
 * 背景：config-service.ts 顶层硬编码了强制全局目录：
 *   const FORCED_GLOBAL_SKILL_DIR = '~/.taiji/skills'
 *   const FORCED_GLOBAL_AGENT_DIR = '~/.taiji/agents'
 * 这导致即使设置了 TAIJI_AGENT_DATA_DIR（getDataDir SSOT 读此 env，缺省 ~/.taiji），
 * loadSkills/loadAgents 仍去扫硬编码的 ~/.taiji/skills/agents，而不是用户配置的数据目录。
 * 后果：多实例隔离 / 自定义数据目录时，全局 skill/agent 不生效（pi 实际目录已重定向，
 * 但强制全局目录没跟上）。
 *
 * W1 改动：FORCED_GLOBAL_SKILL_DIR / FORCED_GLOBAL_AGENT_DIR 改为
 *   join(getConfigDir(), 'skills') / join(getConfigDir(), 'agents')
 * （getConfigDir 委托 getDataDir 读 env）。
 *
 * [红灯说明] 当前常量是硬编码 '~/.taiji/skills'，设置 TAIJI_AGENT_DATA_DIR 后
 * loadSkills 不扫该目录 → 断言「能扫到 skill」失败。改为动态 getConfigDir() 后应转绿。
 *
 * 验证方式：设置 TAIJI_AGENT_DATA_DIR=<tmp>，在 <tmp>/skills/ 放一个 SKILL.md，
 * 调 loadSkills 断言扫到。Agent 同理（<tmp>/agents/*.md）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import {
  setModelsPath,
  refreshModels,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'
import { setDiscoveryPath, invalidateDiscoveryCache } from '../src/infra/pi/discovery-store.js'
import { getPiAgentDir, getConfigDir } from '../src/infra/pi/pi-paths.js'

let tmpDataDir: string
let configService: ConfigService
let savedEnv: string | undefined

beforeEach(() => {
  // 每个用例独立临时数据目录
  tmpDataDir = mkdtempSync(join(tmpdir(), 'config-paths-test-'))
  mkdirSync(join(tmpDataDir, 'agent'), { recursive: true })

  // 设置 TAIJI_AGENT_DATA_DIR → getDataDir/getConfigDir/getPiAgentDir 全部基于此
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir

  // 把 pi 各模块的单例路径指向临时目录（避免污染真实 ~/.taiji）
  setModelsPath(join(tmpDataDir, 'agent', 'models.json'))
  setSettingsPath(join(tmpDataDir, 'agent', 'settings.json'))
  setDiscoveryPath(join(tmpDataDir, 'agent', 'discovery.json'))
  refreshModels()
  invalidateDiscoveryCache()

  configService = new ConfigService(tmpDataDir, new PiConfigStore())
})

afterEach(() => {
  // 还原 env
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('W1: config-service skill/agent 全局强制目录跟随 getConfigDir()', () => {
  // ── CP1：loadSkills 扫描 TAIJI_AGENT_DATA_DIR/skills ───────────
  it('CP1: 设 TAIJI_AGENT_DATA_DIR 后，loadSkills 扫描 <datadir>/skills 而非硬编码 ~/.taiji/skills', () => {
    // sanity：getConfigDir 应基于 env
    expect(getConfigDir()).toBe(tmpDataDir)

    // 在 <datadir>/skills/my-env-skill/ 放 SKILL.md（W1 修复后此目录会被强制扫描）
    const skillDir = join(tmpDataDir, 'skills', 'my-env-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: env skill\n---\nbody')

    // 确认该文件确实存在（排除 fs 层面问题）
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)

    const skills = configService.loadSkills(tmpDataDir)
    const names = skills.map((s) => s.name)

    // 当前硬编码 ~/.taiji/skills 时此处扫不到 → 红灯
    expect(names).toContain('my-env-skill')
  })

  // ── CP2：loadAgents 扫描 TAIJI_AGENT_DATA_DIR/agents ───────────
  it('CP2: 设 TAIJI_AGENT_DATA_DIR 后，loadAgents 扫描 <datadir>/agents 而非硬编码 ~/.taiji/agents', () => {
    expect(getPiAgentDir()).toBe(join(tmpDataDir, 'agent'))

    // 在 <datadir>/agents/ 放 agent.md（W1 修复后此目录会被强制扫描）
    const agentsDir = join(tmpDataDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'env-agent.md'), '---\nname: env-agent\ndescription: env agent\n---\nbody')

    const agents = configService.loadAgents(tmpDataDir)
    const ids = agents.map((a) => a.id)

    // 当前硬编码 ~/.taiji/agents 时此处扫不到 → 红灯
    expect(ids).toContain('env-agent')
  })
})

// ── W2（cw-2026-07-21-scan-project-agents-skills）：loadSkills(cwd) 相对路径 resolve ──
// 修复现状 bug：loadSkills(_projectRoot) 忽略 projectRoot 参数，discovery.json 中的相对路径
// （如 .agents/skills）和 FORCED_PROJECT_SKILL_DIR（.taiji/skills）按 runtime 进程 cwd
// 解析错位 → 扫不到用户项目 skill → landing 浮层看不到。
// 修复：相对路径按传入的 projectRoot resolve 扫描。
describe('W2: loadSkills(cwd) relative-path projectRoot resolution', () => {
  let w2DataDir: string
  let w2ProjectDir: string
  let w2Service: ConfigService
  let w2SavedEnv: string | undefined

  beforeEach(() => {
    w2DataDir = mkdtempSync(join(tmpdir(), 'w2-data-'))
    w2ProjectDir = mkdtempSync(join(tmpdir(), 'w2-proj-'))
    mkdirSync(join(w2DataDir, 'agent'), { recursive: true })

    w2SavedEnv = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = w2DataDir

    setModelsPath(join(w2DataDir, 'agent', 'models.json'))
    setSettingsPath(join(w2DataDir, 'agent', 'settings.json'))
    setDiscoveryPath(join(w2DataDir, 'agent', 'discovery.json'))
    refreshModels()
    invalidateDiscoveryCache()

    w2Service = new ConfigService(w2DataDir, new PiConfigStore())
  })

  afterEach(() => {
    if (w2SavedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = w2SavedEnv
    rmSync(w2DataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(w2ProjectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('AC-4: discovery 配 .agents/skills 相对路径 → loadSkills(projectRoot) 扫描 <projectRoot>/.agents/skills', () => {
    // discovery.json 配 .agents/skills 相对路径（用户现状）
    writeFileSync(join(w2DataDir, 'agent', 'discovery.json'), JSON.stringify({
      version: 1, skillDirs: ['.agents/skills'], agentDirs: [],
    }))
    invalidateDiscoveryCache()

    // 项目目录下放一个 skill（<projectRoot>/.agents/skills/proj-skill/SKILL.md）
    const projSkillDir = join(w2ProjectDir, '.agents', 'skills', 'proj-skill')
    mkdirSync(projSkillDir, { recursive: true })
    writeFileSync(join(projSkillDir, 'SKILL.md'), '---\ndescription: proj skill\n---\nbody')

    // 传 projectRoot=w2ProjectDir，应扫到项目 skill
    const skills = w2Service.loadSkills(w2ProjectDir)
    const names = skills.map((s) => s.name)

    // 现状 bug：loadSkills 忽略 projectRoot，相对路径按 runtime 进程 cwd 解析 → 扫不到 → 红灯
    expect(names).toContain('proj-skill')
  })

  it('AC-4 补充：FORCED_PROJECT_SKILL_DIR (.taiji/skills) 也按 projectRoot resolve', () => {
    // 项目目录下放 .taiji/skills/forced-skill/SKILL.md（不配 discovery，靠强制目录）
    const forcedDir = join(w2ProjectDir, '.taiji', 'skills', 'forced-skill')
    mkdirSync(forcedDir, { recursive: true })
    writeFileSync(join(forcedDir, 'SKILL.md'), '---\ndescription: forced skill\n---\nbody')

    const skills = w2Service.loadSkills(w2ProjectDir)
    const names = skills.map((s) => s.name)

    expect(names).toContain('forced-skill')
  })

  it('相对路径在 projectRoot 下不存在时不崩（扫不到但返回空数组或仅全局）', () => {
    writeFileSync(join(w2DataDir, 'agent', 'discovery.json'), JSON.stringify({
      version: 1, skillDirs: ['.agents/skills'], agentDirs: [],
    }))
    invalidateDiscoveryCache()

    // projectRoot 下无 .agents/skills 目录
    const skills = w2Service.loadSkills(w2ProjectDir)
    // 不崩 + 不含项目 skill（可能含全局 skill，这里只断言不含 proj-skill）
    expect(skills.map((s) => s.name)).not.toContain('proj-skill')
  })
})
