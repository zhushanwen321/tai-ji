/**
 * skill-dirs 单测（skill-reload-nondestructive A1 / D7 扫描集对账）。
 *
 * 锁定：project 扫描集补入 pi 原生项目目录 cwd/.pi/skills（注入映射切源后该目录 skill
 * 不再从 pi get_commands 权威消失，防 skill_missing 回归）+ 既有语义不回归（强制目录
 * .taiji/skills / discovery 相对路径按 projectRoot resolve、绝对路径原样保留 / 强制目录
 * 在前 discovery 在后的顺序 / global 集不受影响）。scan 与 watch 同源（resolveProjectSkillDirs
 * SSOT），故此处锁定即双覆盖锁定。
 * 纯函数测试：configStore 以内存 stub 注入，无 fs 读写（测试禁区红线天然满足）。
 * 文件位于 session/__tests__/ 是 A1 单元领地约束（skill-dirs.ts 属 services/ 顶层，
 * 后续如建 services/__tests__/ 可平移）。
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  FORCED_PROJECT_SKILL_DIR,
  resolveGlobalSkillDirs,
  resolveProjectSkillDirs,
  type SkillDirConfigSource,
} from '../../skill-dirs.js'

const makeConfigStore = (scopes: { projectPaths?: string[]; globalPaths?: string[] } = {}): SkillDirConfigSource => ({
  getPiAgentDir: () => '/data/agent',
  getSkillPathScopes: () => ({
    projectPaths: scopes.projectPaths ?? [],
    globalPaths: scopes.globalPaths ?? [],
  }),
})

describe('resolveProjectSkillDirs（D7 扫描集对账）', () => {
  it('project 扫描集含强制目录 .taiji/skills 与 pi 原生项目目录 cwd/.pi/skills（对账新增项）', () => {
    const dirs = resolveProjectSkillDirs('/proj', makeConfigStore())
    expect(dirs).toContain(resolve('/proj', FORCED_PROJECT_SKILL_DIR))
    expect(dirs).toContain(resolve('/proj', '.pi/skills'))
  })

  it('顺序：强制目录（.taiji/skills、.pi/skills）在前，discovery 用户配置在后（对齐 pi defaults 先于 skillPaths 的装载序）', () => {
    const dirs = resolveProjectSkillDirs('/proj', makeConfigStore({ projectPaths: ['.agents/skills'] }))
    expect(dirs).toEqual([
      resolve('/proj', '.taiji/skills'),
      resolve('/proj', '.pi/skills'),
      resolve('/proj', '.agents/skills'),
    ])
  })

  it('discovery 相对路径按 projectRoot resolve，绝对路径原样保留（v2 显式 scope 语义不变）', () => {
    const dirs = resolveProjectSkillDirs('/proj', makeConfigStore({ projectPaths: ['rel/skills', '/abs/skills'] }))
    expect(dirs).toContain(resolve('/proj', 'rel/skills'))
    expect(dirs).toContain('/abs/skills')
  })
})

describe('resolveGlobalSkillDirs（对账不回归）', () => {
  it('global 扫描集不受影响：.pi/skills 只进 project 集，global 仍为 piAgentDir/skills + configDir/skills + discovery globalPaths（~ 展开）', () => {
    const dirs = resolveGlobalSkillDirs(makeConfigStore({ globalPaths: ['~/extra/skills'] }), '/cfg')
    expect(dirs).toEqual([join('/data/agent', 'skills'), join('/cfg', 'skills'), join(homedir(), '/extra/skills')])
    expect(dirs.every((d) => !d.includes('.pi'))).toBe(true)
  })
})
