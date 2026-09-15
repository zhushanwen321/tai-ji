/**
 * SkillRegistry watcher 真实 fs 集成测试（real chokidar，不 mock）。
 *
 * 验证不变量：watcher 在「已 watch 的 skill 目录下新建子目录」时必须触发 rescan。
 *
 * [HISTORICAL] 背景（2026-07-27 预存 bug）：chokidar v4 移除 native fsevents 绑定，macOS 上
 * 退化为纯 Node fs.watch，对「新建子目录 / 新文件」事件不可靠（nodejs/node#52601），实测触发率
 * ~40%（flaky）；当时修复为 WATCH_OPTIONS usePolling:true。2026-08-28 复测该缺陷在当前 Node
 * 不再复现，默认回到原生事件（polling 留 TAIJI_AGENT_SKILL_WATCH_POLLING=1 降级开关）——
 * 本测试随之成为原生事件路径的回归守卫，正是它要防的场景。
 *
 * 本文件不 mock chokidar（顶层的 vi.mock('chokidar') 仅作用于 skill-registry.test.ts 同文件作用域，
 * 独立 test 文件默认走真实 chokidar），用真实磁盘 + 跨进程 spawn 创建 skill 子目录，验证 onChange 被触发。
 *
 * 运行：cd packages/runtime && npx vitest run test/skill-registry-watcher-real.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SkillInfo } from '@taiji/shared'

/**
 * watcher 触发检测的挂钟轮询 deadline（reviewer-D WARNING-4 加固）。
 *
 * polling 时代为 interval(1500ms) + debounce(300ms) 的 ~8 次轮询预算；原生事件路径下
 * 检测是事件驱动（亚秒级），12000ms 仅为 CI 抖动留缓冲。
 * 配合 it() timeout（30000ms）确保测试本身不会先于 deadline 超时。
 */
const WATCH_DETECT_DEADLINE_MS = 12000

/**
 * watcher baseline 预热时长（ms）。
 *
 * [HISTORICAL] 该等待源自 polling 时代的 first-tick baseline 竞态（新建文件若先于 first-tick
 * 落盘会被 baseline 吞掉）；原生事件路径无此竞态，保留 1700ms 作为 watcher 建立监听的保守余量，
 * 避免测试依赖隐式时序。
 */
const WATCH_BASELINE_WARMUP_MS = 1700

/**
 * 简易 scanFn：把 skill 容器目录下的子目录当作 skill 返回（每个含 SKILL.md 的子目录一项）。
 * 用于让 onChange 触发后的 globalCache 有可观察内容，不依赖真实 ConfigService 扫描逻辑。
 */
function makeScanFn(skillDir: string) {
  return async (): Promise<SkillInfo[]> => {
    let entries: string[] = []
    try {
      entries = readdirSync(skillDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    } catch {
      entries = []
    }
    return entries.map(name => ({ id: name, name } as SkillInfo))
  }
}

/**
 * 跨进程创建 skill 子目录（模拟用户从 shell / Finder 创建 skill，不经 settings）。
 * 直接用 Node fs 在同进程创建也可，但跨进程更贴近真实场景且能暴露 fs.watch 的进程外事件丢失问题。
 *
 * 用 spawnSync（非 spawn）：spawn 不等待子进程完成也不跟踪 child 引用，测试失败/超时清理时
 * 子进程可能变僵尸（reviewer-D WARNING-5）。创建目录是同步操作，spawnSync 等待完成更简单可靠。
 */
function createSkillSubdir(parentDir: string, skillName: string): void {
  spawnSync('sh', ['-c', `mkdir -p ${join(parentDir, skillName)} && echo body > ${join(parentDir, skillName, 'SKILL.md')}`], { encoding: 'utf-8' })
}

describe('SkillRegistry watcher real fs (W5: 新建 skill 子目录触发 rescan)', () => {
  let tempRoot: string
  let skillDir: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'skill-reg-w5-real-'))
    skillDir = join(tempRoot, 'skills')
    mkdirSync(skillDir, { recursive: true })
    // 预置一个已存在 skill，让 watch 初始非空
    mkdirSync(join(skillDir, 'existing-skill'), { recursive: true })
    writeFileSync(join(skillDir, 'existing-skill', 'SKILL.md'), '---\nname: existing-skill\n---\nbody\n')
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('W5a: 全局 watcher 在已扫描目录下新建 skill 子目录时触发 onChange（rescan + 通知）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [skillDir], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [skillDir] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => ['sid-w5a'] } as never,
      _scanFn: makeScanFn(skillDir),
    } as never)
    try {
      await reg.initGlobal()
      // initGlobal 扫到 1 个 skill（existing-skill）
      expect(reg.getGlobalSkills()).toHaveLength(1)

      // 注册 onChange：捕获 watcher 触发的 rescan 通知
      const events: Array<{ scope: string; affectedSessionIds: string[] }> = []
      reg.onChange(e => events.push({ scope: e.scope, affectedSessionIds: e.affectedSessionIds }))

      // 等 chokidar 轮询建好 baseline（含 existing-skill）。spawnSync 同步写盘，若在 first-tick 前
      // 完成会被 baseline 吞掉（见 WATCH_BASELINE_WARMUP_MS 注释），必须先等 first-tick 跑完。
      await new Promise(r => setTimeout(r, WATCH_BASELINE_WARMUP_MS))

      // 跨进程新建 skill 子目录（不经 settings，模拟用户直接磁盘操作）
      createSkillSubdir(skillDir, 'new-skill-w5a')

      // 等 watcher 触发：usePolling interval(1500ms) + debounce(300ms) + 余量
      // 最长等 WATCH_DETECT_DEADLINE_MS（polling 周期最多触发 8 次，足够稳定，CI 抖动有缓冲）
      const deadline = Date.now() + WATCH_DETECT_DEADLINE_MS
      while (Date.now() < deadline && events.length === 0) {
        await new Promise(r => setTimeout(r, 200))
      }

      // 核心断言：watcher 触发了 rescan → onChange 收到 global scope 通知
      expect(events.length).toBeGreaterThan(0)
      expect(events[0]).toMatchObject({ scope: 'global', affectedSessionIds: ['sid-w5a'] })
      // rescan 后 globalCache 含新 skill
      const skills = reg.getGlobalSkills()
      expect(skills.some(s => s.id === 'new-skill-w5a')).toBe(true)
    } finally {
      reg.dispose()
    }
  }, 30000)

  it('W5b: 项目 watcher 在已扫描目录下新建 skill 子目录时触发 onChange（scope=project）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-w5b-cwd-'))
    const projectSkillDir = join(cwd, '.taiji', 'skills')
    mkdirSync(projectSkillDir, { recursive: true })
    try {
      const reg = new SkillRegistry({
        configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
        configDir: '/cfg',
        sessionService: {
          getActiveSessionIds: () => ['sid-w5b'],
          getSessionCwd: (sid: string) => (sid === 'sid-w5b' ? cwd : undefined),
        } as never,
        _scanFn: makeScanFn(projectSkillDir),
      } as never)
      try {
        await reg.getProjectSkills(cwd)

        const events: Array<{ scope: string; cwd?: string }> = []
        reg.onChange(e => events.push({ scope: e.scope, cwd: e.cwd }))

        // 等 chokidar 轮询建好 baseline（见 WATCH_BASELINE_WARMUP_MS 注释）。
        await new Promise(r => setTimeout(r, WATCH_BASELINE_WARMUP_MS))

        // 跨进程新建项目 skill 子目录
        createSkillSubdir(projectSkillDir, 'new-proj-skill')

        const deadline = Date.now() + WATCH_DETECT_DEADLINE_MS
        while (Date.now() < deadline && events.length === 0) {
          await new Promise(r => setTimeout(r, 200))
        }

        expect(events.length).toBeGreaterThan(0)
        expect(events[0]).toMatchObject({ scope: 'project', cwd })
        const skills = await reg.getProjectSkills(cwd)
        expect(skills.some(s => s.id === 'new-proj-skill')).toBe(true)
      } finally {
        reg.dispose()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }, 30000)
})
