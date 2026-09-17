/**
 * [U2 / cache-governance 1-4] SkillRegistry 周期兜底重扫单测（fake timers）。
 *
 * G5「失效机制故障可自愈」：watcher 熔断后现状「冻结到重启」——兜底定时器按固定周期
 * （FALLBACK_RESCAN_INTERVAL_MS = 5min）无条件重扫 globalCache + 全部活跃 projectCache cwd：
 *  - F1: watcher 正常 → 兜底周期到也重扫（无条件重扫语义）；值未变不广播（广播链下游 =
 *        reloadOrchestrator 全量 idle session pi reload + renderer 重拉，无差别周期广播违背
 *        「watcher 正常时兜底成本可忽略」的设计成本口径）
 *  - F2: watcher 熔断 → 兜底周期内重扫收敛、新 skill 出现在列表并经 onChange 广播（A6 单测化）
 *  - F3: 熔断 → 兜底 → 再熔断循环不发散（扫描次数线性、定时器不累积、通知只随值变化、
 *        dispose 后定时器清零不再扫）
 *  - F4: LRU 驱逐窗口失明 → 兜底重扫收敛（设计 1-4 的第三种发散形态）
 *  - F5: 启动扫描失败（initGlobal reject）兜底定时器仍武装——下个周期自愈补上 globalCache
 *
 * mock 策略对齐 test/skill-registry.test.ts / skill-registry-watcher-lru.test.ts：
 * vi.mock('chokidar')（不真挂 watcher，熔断用 fake watcher emit error 模拟）；扫描走 _scanFn mock；
 * mkdtempSync 临时目录自建自删（遵守测试禁触真实数据目录红线，不触 ~/.taiji / ~/.pi）。
 *
 * 运行：cd packages/runtime && npx vitest run test/skill-registry-fallback-rescan.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { SkillInfo } from '@taiji/shared'

interface FakeWatcher extends EventEmitter {
  close: ReturnType<typeof vi.fn>
}

/** 每次 chokidar.watch() 产物按序记录（熔断断言按位取 watcher） */
const createdWatchers: FakeWatcher[] = []

vi.mock('chokidar', () => ({
  watch: vi.fn((): FakeWatcher => {
    const ee = new EventEmitter() as FakeWatcher
    ee.close = vi.fn(() => Promise.resolve())
    createdWatchers.push(ee)
    return ee
  }),
}))

import { SkillRegistry, type SkillScanFn, type SkillRegistrySessionService } from '../src/services/skill-registry.js'

/** LRU 容量常量镜像（与 skill-registry.ts MAX_PROJECT_WATCHERS 同值） */
const MAX_PROJECT_WATCHERS = 8

/** 设计锚点镜像：兜底周期 5min（skill-registry.ts FALLBACK_RESCAN_INTERVAL_MS） */
const FALLBACK_INTERVAL_MS = 5 * 60 * 1000

/** EMFILE 错误工厂（熔断用，与 skill-registry.test.ts U5 同款） */
const emfile = () => Object.assign(new Error('too many open files'), { code: 'EMFILE' })

function makeSkill(id: string): SkillInfo {
  return { id, name: id, description: '', enabled: true, source: 'test', triggers: [] }
}

/** 注册表与临时目录统一登记，afterEach 统一清理（dispose 先于 useRealTimers，见 afterEach 顺序） */
const registries: SkillRegistry[] = []
const tempDirs: string[] = []

function mkTemp(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `skill-fb-${tag}-`))
  tempDirs.push(dir)
  return dir
}

/** mkdtemp 一个含 .taiji/skills 的 cwd（挂 project watcher 的最小形态） */
function mkCwd(tag: string): string {
  const cwd = mkTemp(tag)
  mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
  return cwd
}

interface RegistryOpts {
  globalPaths?: string[]
  sessionIds?: string[]
  cwdOf?: (sid: string) => string | undefined
}

function makeRegistry(scanFn: SkillScanFn, opts: RegistryOpts = {}): SkillRegistry {
  const sessionService: SkillRegistrySessionService = { getActiveSessionIds: () => opts.sessionIds ?? [] }
  if (opts.cwdOf) sessionService.getSessionCwd = opts.cwdOf
  const reg = new SkillRegistry({
    configStore: {
      getSkillPaths: () => [],
      getPiAgentDir: () => '/pi',
      getSkillPathScopes: () => ({ projectPaths: [], globalPaths: opts.globalPaths ?? [] }),
    } as never,
    configDir: '/cfg',
    sessionService,
    _scanFn: scanFn,
  } as never)
  registries.push(reg)
  return reg
}

describe('skillRegistry 周期兜底重扫（U2 / cache-governance G5）', () => {
  beforeEach(() => {
    createdWatchers.length = 0
  })

  afterEach(() => {
    // 顺序：先 dispose（清 fake 定时器）→ 恢复真实时钟 → 清临时目录
    for (const reg of registries) reg.dispose()
    registries.length = 0
    vi.useRealTimers()
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tempDirs.length = 0
  })

  it('F1: watcher 正常 → 兜底周期到也重扫（global + project 各一次）；值未变不广播', async () => {
    vi.useFakeTimers()
    const cwd = mkCwd('f1')
    const scanFn = vi.fn((_root: string): Promise<SkillInfo[]> => Promise.resolve([]))
    const reg = makeRegistry(scanFn)
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)

    await reg.initGlobal() // scan ''
    await reg.getProjectSkills(cwd) // scan cwd（挂 project watcher）
    const callsWith = (root: string) => scanFn.mock.calls.filter(([r]) => r === root).length
    expect(callsWith('')).toBe(1)
    expect(callsWith(cwd)).toBe(1)
    // 仅兜底定时器一个（chokidar mock 无定时器；幂等武装不堆叠）
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)

    // 无条件重扫：与 watcher 健康状态无关，global + 活跃 projectCache cwd 各再扫一次
    expect(callsWith('')).toBe(2)
    expect(callsWith(cwd)).toBe(2)
    // 值未变不广播：onChange 下游 = reloadOrchestrator（global 通知 = 全量 idle session pi reload）
    // + renderer 失效重拉，无差别周期广播违背「watcher 正常时兜底成本可忽略」
    expect(onChangeSpy).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('F2: watcher 熔断 → 兜底周期内重扫收敛，新 skill 出现在列表并经 onChange 广播（A6 单测化）', async () => {
    vi.useFakeTimers()
    const cwd = mkCwd('f2')
    const projectValue: SkillInfo[] = []
    // scanFn 每次返回拷贝：生产 scanFn（ConfigService.loadSkills）每次构建新数组，
    // 返回活引用会让缓存与 mock 数组同引用（push 直接改缓存），值变化判定失真（伪绿）
    const scanFn = vi.fn((root: string): Promise<SkillInfo[]> =>
      Promise.resolve(root === cwd ? [...projectValue] : []))
    const reg = makeRegistry(scanFn, {
      sessionIds: ['sid-f2'],
      cwdOf: sid => (sid === 'sid-f2' ? cwd : undefined),
    })
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)

    // 兜底定时器锚定 initGlobal 武装点，先激活再建项目缓存
    await reg.initGlobal()
    await reg.getProjectSkills(cwd)
    expect(createdWatchers).toHaveLength(1)
    const watcher = createdWatchers[0]
    // 连续 5 次同类错误 → 熔断 close（现状行为：此后该 scope 冻结，只能靠兜底收敛）
    for (let i = 0; i < 5; i++) watcher.emit('error', emfile())
    expect(watcher.close).toHaveBeenCalledTimes(1)
    expect(onChangeSpy).toHaveBeenCalledTimes(1) // W4 熔断终态通知
    onChangeSpy.mockClear()

    // 熔断后（事件驱动已停）用户在项目 skill 目录新建 skill
    projectValue.push(makeSkill('fresh-skill'))

    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)

    // 兜底重扫收敛：新 skill 出现在列表（公开读路径可见，无需重启 runtime）
    expect((await reg.getProjectSkills(cwd)).some(s => s.id === 'fresh-skill')).toBe(true)
    // 且经现有 onChange 通知链广播（renderer 刷新可见）
    expect(onChangeSpy).toHaveBeenCalledWith({ scope: 'project', cwd, affectedSessionIds: ['sid-f2'] })
  })

  it('F3: 熔断 → 兜底 → 再熔断循环不发散（扫描线性 / 定时器不累积 / 通知只随值变化 / dispose 清零）', async () => {
    vi.useFakeTimers()
    // 存在的全局 skill 目录（挂全局 watcher，供熔断）
    const globalDir = mkTemp('f3-global')
    mkdirSync(join(globalDir, 'g-skill'), { recursive: true })
    const cwd = mkCwd('f3')
    const projectValue: SkillInfo[] = []
    // 同 F2：scanFn 返回拷贝，防缓存与 mock 数组同引用致值变化判定失真
    const scanFn = vi.fn((root: string): Promise<SkillInfo[]> =>
      Promise.resolve(root === cwd ? [...projectValue] : []))
    const reg = makeRegistry(scanFn, { globalPaths: [globalDir] })
    const events: Array<{ scope: string; cwd?: string }> = []
    reg.onChange(e => events.push({ scope: e.scope, cwd: e.cwd }))

    await reg.initGlobal()
    await reg.getProjectSkills(cwd)
    expect(createdWatchers).toHaveLength(2)
    // 全局 + 项目 watcher 双双熔断（模拟最坏持续故障）
    for (const w of createdWatchers) {
      for (let i = 0; i < 5; i++) w.emit('error', emfile())
      expect(w.close).toHaveBeenCalledTimes(1)
    }
    events.length = 0 // 清掉熔断终态通知，隔离兜底周期断言

    const callsWith = (root: string) => scanFn.mock.calls.filter(([r]) => r === root).length
    const globalAtBreak = callsWith('')
    const projectAtBreak = callsWith(cwd)

    // 3 个兜底周期：第 2 周期磁盘出现新 skill，1/3 周期无变化
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (cycle === 2) projectValue.push(makeSkill('cycle-skill'))
      await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      // 每周期每 scope 恰重扫一次——线性增长，不随周期堆叠（发散防护）
      expect(callsWith('')).toBe(globalAtBreak + cycle)
      expect(callsWith(cwd)).toBe(projectAtBreak + cycle)
      // 兜底定时器恒为 1，不累积
      expect(vi.getTimerCount()).toBe(1)
    }

    // 通知只随值变化：3 周期中仅第 2 周期的 project 变化触发一次广播；global 全程未变零广播
    expect(events.filter(e => e.scope === 'project' && e.cwd === cwd)).toHaveLength(1)
    expect(events.filter(e => e.scope === 'global')).toHaveLength(0)

    // 循环收敛结果可读
    expect((await reg.getProjectSkills(cwd)).some(s => s.id === 'cycle-skill')).toBe(true)

    // dispose 后兜底定时器清零，不再扫描
    reg.dispose()
    expect(vi.getTimerCount()).toBe(0)
    const globalAfterDispose = callsWith('')
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(callsWith('')).toBe(globalAfterDispose)
  })

  it('F4: LRU 驱逐窗口失明 → 兜底重扫收敛（被驱逐 cwd 无 watcher 无访问也更新缓存并广播）', async () => {
    vi.useFakeTimers()
    const values = new Map<string, SkillInfo[]>()
    // 同 F2：scanFn 返回拷贝，防缓存与 mock 数据源同引用致值变化判定失真
    const scanFn = vi.fn((root: string): Promise<SkillInfo[]> =>
      Promise.resolve(root === '' ? [] : [...(values.get(root) ?? [])]))
    const reg = makeRegistry(scanFn)
    const events: Array<{ scope: string; cwd?: string }> = []
    reg.onChange(e => events.push({ scope: e.scope, cwd: e.cwd }))

    // 兜底定时器锚定 initGlobal 武装点（生产组合根唯一激活入口），先激活再建项目缓存
    await reg.initGlobal()

    const cwds: string[] = []
    for (let i = 0; i < MAX_PROJECT_WATCHERS + 1; i++) {
      const c = mkCwd(`f4-${i}`)
      cwds.push(c)
      values.set(c, [])
      await reg.getProjectSkills(c)
    }
    expect(createdWatchers).toHaveLength(MAX_PROJECT_WATCHERS + 1)
    expect(createdWatchers[0].close).toHaveBeenCalledTimes(1) // cwds[0] 已被 LRU 驱逐

    // 失明窗口内磁盘变化：被驱逐 cwd（无 watcher、期间无任何访问）新建 skill
    values.set(cwds[0], [makeSkill('lru-skill')])

    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)

    // 全部活跃 projectCache cwd 均被重扫（含被驱逐者）：缓存收敛 + 广播
    expect(scanFn.mock.calls.filter(([r]) => r === cwds[0]).length).toBe(2)
    expect((await reg.getProjectSkills(cwds[0])).some(s => s.id === 'lru-skill')).toBe(true)
    expect(events.some(e => e.scope === 'project' && e.cwd === cwds[0])).toBe(true)
  })

  it('F5: 启动扫描失败（initGlobal reject）兜底定时器仍武装——下个周期自愈补上 globalCache', async () => {
    vi.useFakeTimers()
    let globalFail = true
    const scanFn = vi.fn((root: string): Promise<SkillInfo[]> =>
      root === ''
        ? (globalFail ? Promise.reject(new Error('scan boom')) : Promise.resolve([makeSkill('late-skill')]))
        : Promise.resolve([]))
    const reg = makeRegistry(scanFn)
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)

    // 启动扫描失败（组合根对该失败降级不阻塞 runtime）——watcher 未挂、缓存空
    await expect(reg.initGlobal()).rejects.toThrow('scan boom')
    expect(reg.getGlobalSkills()).toEqual([])

    globalFail = false
    await vi.advanceTimersByTimeAsync(FALLBACK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)

    // 兜底重扫自愈：下个周期补上 globalCache 并广播
    expect(reg.getGlobalSkills()).toEqual([makeSkill('late-skill')])
    expect(onChangeSpy).toHaveBeenCalledWith({ scope: 'global', affectedSessionIds: [] })
  })
})
