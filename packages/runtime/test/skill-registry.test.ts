/**
 * W1 skillRegistry 单测。
 *
 * U1-U3：原始能力（全局扫描 / 项目懒加载缓存 / onChange 通知）。
 * U4-U5：EMFILE 事故修复（2026-07-22）回归防护——
 *   U4 验证 watcher 范围收窄（只 watch skill 子目录，不 watch 整个 cwd），
 *   U5 验证连续同类错误熔断（防 chokidar EMFILE 死循环刷屏）。
 *
 * vi.mock('chokidar')：U1-U3 因 mock 的 configStore 路径不存在 → dirs 为空 → 不调 watch，不受影响；
 * U4/U5 依赖 mock 捕获 watch 参数 + 控制 watcher error 事件（ESM 下 spyOn 模块 namespace 不可用）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { SkillInfo } from '@taiji/shared'

vi.mock('chokidar', () => ({
  // 默认实现：返回带 close 的 EventEmitter；U5 用 mockReturnValueOnce 覆盖为测试持有的实例
  watch: vi.fn(() => {
    const ee = new EventEmitter()
    ;(ee as unknown as { close: () => Promise<void> }).close = () => Promise.resolve()
    return ee
  }),
}))

// 捕获 ConfigService 构造时传入的 root（S5 验证全局扫描不传 process.cwd()）。
// vi.hoisted 保证 hoisted 的 mock factory 能引用到此数组。
const { configRoots } = vi.hoisted(() => ({ configRoots: [] as string[] }))

// mock config-service：defaultScanFn 经此 mock 返回空数组（U1 不依赖真实磁盘扫描），
// 同时捕获构造 root 供 S5 断言「全局扫描 root !== process.cwd()」。
// 用 class 而非 vi.fn：ConfigService 以 `new` 调用，箭头函数不能作构造函数。
vi.mock('../src/services/config-service.js', () => ({
  ConfigService: class {
    constructor(root: string) {
      configRoots.push(root)
    }
    loadSkills() {
      return []
    }
  },
}))

describe('skillRegistry (W1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configRoots.length = 0
  })

  it('U1: getGlobalSkills 返回启动扫描的 skill', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
    })
    await reg.initGlobal()
    const skills = reg.getGlobalSkills()
    expect(Array.isArray(skills)).toBe(true)
    // config-service 已 mock（返回 []），此处只验证 initGlobal 不抛错 + 返回数组
  })

  it('U2: projectCache 懒加载 + cwd 隔离（同 cwd 二次命中缓存）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const scanSpy = vi.fn().mockResolvedValue([])
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanSpy,
    } as never)
    await reg.getProjectSkills('/proj-a')
    await reg.getProjectSkills('/proj-a') // 命中缓存
    await reg.getProjectSkills('/proj-b')
    expect(scanSpy).toHaveBeenCalledTimes(2) // proj-a 一次，proj-b 一次（proj-a 二次命中缓存）
  })

  it('U3: onChange 回调注册 + 触发通知 affectedSessions', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => ['sid-a', 'sid-b'] } as never,
    } as never)
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)
    // 模拟全局目录变动
    await reg._notifyGlobalChange()
    expect(onChangeSpy).toHaveBeenCalledWith({ scope: 'global', affectedSessionIds: ['sid-a', 'sid-b'] })
  })

  it('U4: getProjectSkills 只 watch 项目 skill 子目录，不递归 watch 整个 cwd（EMFILE 根因防护）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    // 创建临时 cwd：含 .taiji/skills（应被 watch）和 node_modules（绝不该被 watch，fd 爆炸源）
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-u4-'))
    mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
    mkdirSync(join(cwd, 'node_modules', 'some-pkg'), { recursive: true })
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    try {
      await reg.getProjectSkills(cwd)
      expect(chokidar.watch).toHaveBeenCalledTimes(1)
      const watchArgs = vi.mocked(chokidar.watch).mock.calls[0]
      const watchedPaths = watchArgs[0] as string[]
      // 核心断言：watch 的是 skill 子目录，不是整个 cwd（原 bug）
      expect(watchedPaths).toContain(join(cwd, '.taiji', 'skills'))
      expect(watchedPaths).not.toContain(cwd)
      // options 断言：ignored 正则 + ignoreInitial:true（防几余重扫 + node_modules 排除被删）+
      // usePolling:false（2026-08-28 起默认原生事件：nodejs/node#52601 在当前 Node 实测不再复现，
      // polling 降级为 TAIJI_AGENT_SKILL_WATCH_POLLING=1 显式开关；测试环境未设该变量）
      expect(watchArgs[1]).toMatchObject({
        ignored: expect.any(RegExp),
        ignoreInitial: true,
        usePolling: false,
      })
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('U5: watcher 连续同类错误达 MAX_WATCHER_ERRORS 后熔断 close（防 EMFILE 死循环刷屏）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-u5-'))
    mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
    // 持有 fakeWatcher 引用以便手动 emit error
    const fakeWatcher = new EventEmitter()
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    ;(fakeWatcher as unknown as { close: ReturnType<typeof vi.fn> }).close = closeSpy
    vi.mocked(chokidar.watch).mockReturnValueOnce(fakeWatcher as never)
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const emfile = () => Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    try {
      await reg.getProjectSkills(cwd)
      // 连续 4 次同类错误：未达阈值（MAX_WATCHER_ERRORS=5），不熔断
      for (let i = 0; i < 4; i++) fakeWatcher.emit('error', emfile())
      expect(closeSpy).not.toHaveBeenCalled()
      // 第 5 次达阈值 → 熔断 close
      fakeWatcher.emit('error', emfile())
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('U6: getProjectSkills 并发同 cwd 去重——只 scan 一次 + 只 watch 一次（防 TOCTOU watcher 泄漏）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-u6-'))
    mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
    // scanFn 加人为延迟，让多个 getProjectSkills 调用同时处于 in-flight 窗口
    let resolveScan!: (v: []) => void
    const scanSpy = vi.fn(
      () => new Promise<[]>(resolve => { resolveScan = resolve as (v: []) => void }),
    )
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanSpy,
    } as never)
    try {
      // 三个并发调用，全部在 scanFn resolve 前发出
      const p1 = reg.getProjectSkills(cwd)
      const p2 = reg.getProjectSkills(cwd)
      const p3 = reg.getProjectSkills(cwd)
      resolveScan([])
      await Promise.all([p1, p2, p3])
      // in-flight 去重：三个调用共享同一次 scan + 同一次 watch
      expect(scanSpy).toHaveBeenCalledTimes(1)
      expect(chokidar.watch).toHaveBeenCalledTimes(1)
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('W3: 缓存命中时补查新建的 skill 目录——补挂 watcher + 重扫缓存', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-w3-'))
    // scanFn 返回空——本用例只验证「补挂 watcher + 重扫触发」，不关心扫到的 skill 内容
    const scanSpy = vi.fn().mockResolvedValue([])
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanSpy,
    } as never)
    try {
      // 首次扫描：无 skill 目录 → dirs 为空 → 不挂 watcher，缓存空数组
      await reg.getProjectSkills(cwd)
      expect(chokidar.watch).not.toHaveBeenCalled()
      expect(scanSpy).toHaveBeenCalledTimes(1)
      // 用户后续创建 skill 目录（首次扫描时不存在，现在出现）
      mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
      // 再次调用：命中缓存，但检测到「应 watch 但无 watcher」→ 异步补挂 watcher + 重扫
      // setupProjectWatcher 同步注册 watcher 后 scanFn 被同步调用（await 前），放此处的断言可立即生效
      await reg.getProjectSkills(cwd)
      expect(chokidar.watch).toHaveBeenCalledTimes(1)
      expect(scanSpy).toHaveBeenCalledTimes(2)
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('W4: watcher 熔断后推终态通知（上游感知 skill 列表已停更）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-w4-'))
    mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
    const fakeWatcher = new EventEmitter()
    ;(fakeWatcher as unknown as { close: () => Promise<void> }).close = () => Promise.resolve()
    vi.mocked(chokidar.watch).mockReturnValueOnce(fakeWatcher as never)
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: {
        getActiveSessionIds: () => ['sid-x'],
        getSessionCwd: (sid: string) => (sid === 'sid-x' ? cwd : undefined),
      } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)
    const emfile = () => Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    try {
      await reg.getProjectSkills(cwd)
      // 5 次同类错误 → 熔断 → notifyProjectChange(cwd) → affected = cwd 匹配的 ['sid-x']
      for (let i = 0; i < 5; i++) fakeWatcher.emit('error', emfile())
      expect(onChangeSpy).toHaveBeenCalledWith({ scope: 'project', cwd, affectedSessionIds: ['sid-x'] })
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('S5: 全局扫描（projectRoot 空串）不传 process.cwd()，避免项目 skill 混入 globalCache', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
    })
    await reg.initGlobal()
    // defaultScanFn 经 mock ConfigService 捕获构造 root
    expect(configRoots).toHaveLength(1)
    // 核心断言：全局扫描的 root 绝不能是 process.cwd()（否则 cwd 下项目 skill 混入 globalCache，
    // 且这些条目不被全局 watcher 监听 → 缓存与磁盘发散）
    expect(configRoots[0]).not.toBe(process.cwd())
    // S5 用 os.tmpdir() 下不存在的子路径作为 root
    expect(configRoots[0]).toContain(tmpdir())
  })
})

// ── W2：runtime 侧重建 watcher + onChange 携带变更详情 + 广播失效信号 ──
// TC1: rebuildGlobal 重挂 watcher 含新路径（settings 改 skill 扫描路径后调用）
// TC2: rebuildGlobal close 旧 watcher（避免 fd 泄漏）
// TC3: invalidateAllProjects 清空 projectCache + projectWatchers
// TC4: onChange 收到 SkillChangeEvent 对象（global/project 两种 scope）
describe('skillRegistry (W2 rebuild)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TC1: rebuildGlobal 重挂 watcher 含新路径（新 skillDir 纳入 watch 视野）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    // 准备两个全局 skill 目录（模拟 settings 改路径后新增的目录）
    const dirA = mkdtempSync(join(tmpdir(), 'skill-w2-tc1-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'skill-w2-tc1-b-'))
    // 动态切 configStore：initGlobal 时只 watch [dirA]；rebuildGlobal 后 watch [dirA, dirB]
    const currentDirs = { value: [dirA] }
    const reg = new SkillRegistry({
      configStore: {
        getSkillPaths: () => currentDirs.value,
        getPiAgentDir: () => '/pi',
        getSkillPathScopes: () => ({ projectPaths: [], globalPaths: currentDirs.value }),
      } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    try {
      await reg.initGlobal()
      // initGlobal 后清空 watch 调用计数，便于隔离 rebuildGlobal 的调用
      vi.mocked(chokidar.watch).mockClear()
      // 模拟 settings 改路径：新增 dirB
      currentDirs.value = [dirA, dirB]
      await reg.rebuildGlobal()
      // rebuildGlobal 应重新挂一次 watcher
      expect(chokidar.watch).toHaveBeenCalledTimes(1)
      const watchArgs = vi.mocked(chokidar.watch).mock.calls[0]
      const watchedPaths = watchArgs[0] as string[]
      // 核心：新路径 dirB 纳入 watch 视野（rebuild 读最新 configStore）
      expect(watchedPaths).toContain(dirA)
      expect(watchedPaths).toContain(dirB)
    } finally {
      reg.dispose()
      rmSync(dirA, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(dirB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('TC2: rebuildGlobal close 旧 watcher（避免 fd 泄漏）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const dir = mkdtempSync(join(tmpdir(), 'skill-w2-tc2-'))
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [dir], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [dir] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    // 用自定义 watcher 覆盖默认 mock：close 为 spy，便于断言 rebuildGlobal 是否 close 了旧 watcher
    const oldWatcher = new EventEmitter()
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    ;(oldWatcher as unknown as { close: ReturnType<typeof vi.fn> }).close = closeSpy
    vi.mocked(chokidar.watch).mockReturnValueOnce(oldWatcher as never)
    try {
      await reg.initGlobal()
      // 重建：应 close 旧 watcher
      await reg.rebuildGlobal()
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      reg.dispose()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('TC2b: rebuildGlobal scanFn 失败时 watcher 仍挂上 + globalCache 保留旧值（兜底防断链）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    // 准备一个真实存在的全局 skill 目录（让 setupGlobalWatcher 真正挂 watcher）
    const dir = mkdtempSync(join(tmpdir(), 'skill-w2-tc2b-'))
    const skill1 = { id: 'skill-1', name: 'Skill One' }
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [dir], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [dir] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => ['sid-tc2b'] } as never,
      // initGlobal 返回 [skill1]；rebuildGlobal 第二次调用（index=1）抛错
      _scanFn: vi.fn()
        .mockResolvedValueOnce([skill1])
        .mockRejectedValueOnce(new Error('scan boom')),
    } as never)
    const onChangeSpy = vi.fn()
    reg.onChange(onChangeSpy)
    try {
      // initGlobal 成功，globalCache = [skill1]
      await reg.initGlobal()
      expect(reg.getGlobalSkills()).toEqual([skill1])
      const watchCountAfterInit = vi.mocked(chokidar.watch).mock.calls.length

      // rebuildGlobal 时 scanFn 抛错
      await reg.rebuildGlobal()

      // 核心 1：watcher 仍挂上（setupGlobalWatcher 在 finally 执行）——
      // 新 watch 调用产生，证明监听链未断
      expect(vi.mocked(chokidar.watch).mock.calls.length).toBeGreaterThan(watchCountAfterInit)
      // 核心 2：globalCache 仍为旧值 [skill1]（未被空值覆盖，scanFn 失败保留旧值）
      expect(reg.getGlobalSkills()).toEqual([skill1])
      // 核心 3：notifyGlobalChange 仍被调用（上游仍收到变更事件）
      expect(onChangeSpy).toHaveBeenCalledWith({
        scope: 'global',
        affectedSessionIds: ['sid-tc2b'],
      })
    } finally {
      reg.dispose()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('TC3: invalidateAllProjects 清空 projectCache + close 所有 project watcher', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwdA = mkdtempSync(join(tmpdir(), 'skill-w2-tc3-a-'))
    const cwdB = mkdtempSync(join(tmpdir(), 'skill-w2-tc3-b-'))
    mkdirSync(join(cwdA, '.taiji', 'skills'), { recursive: true })
    mkdirSync(join(cwdB, '.taiji', 'skills'), { recursive: true })
    const scanSpy = vi.fn().mockResolvedValue([])
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanSpy,
    } as never)
    // 自定义 watcher（带 close spy）覆盖默认 mock，断言 invalidateAllProjects close 了所有 watcher
    const watcherA = new EventEmitter()
    const closeSpyA = vi.fn().mockResolvedValue(undefined)
    ;(watcherA as unknown as { close: ReturnType<typeof vi.fn> }).close = closeSpyA
    const watcherB = new EventEmitter()
    const closeSpyB = vi.fn().mockResolvedValue(undefined)
    ;(watcherB as unknown as { close: ReturnType<typeof vi.fn> }).close = closeSpyB
    const chokidar = await import('chokidar')
    vi.mocked(chokidar.watch)
      .mockReturnValueOnce(watcherA as never)
      .mockReturnValueOnce(watcherB as never)
    try {
      // 首次扫描两个项目，各自挂 watcher + 缓存
      await reg.getProjectSkills(cwdA)
      await reg.getProjectSkills(cwdB)
      // invalidateAllProjects：close 所有 watcher + 清缓存
      reg.invalidateAllProjects()
      expect(closeSpyA).toHaveBeenCalledTimes(1)
      expect(closeSpyB).toHaveBeenCalledTimes(1)
      // 清空后再次 getProjectSkills：scanFn 应被重新调用（缓存已清，重新扫描）
      const scanBefore = scanSpy.mock.calls.length
      await reg.getProjectSkills(cwdA)
      expect(scanSpy.mock.calls.length).toBeGreaterThan(scanBefore)
    } finally {
      reg.dispose()
      rmSync(cwdA, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(cwdB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('TC3b: invalidateAllProjects 清空 projectInFlight + project debounce timers（防竞态写回陈旧缓存）', async () => {
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    // 用「分阶段 scanFn」模拟竞态：第一次调用挂起（in-flight），第二次（invalidate 后重扫）立即返回 []。
    let resolveFirstScan!: (v: SkillInfo[]) => void
    const firstScan = new Promise<SkillInfo[]>((r) => { resolveFirstScan = r })
    const staleSkills: SkillInfo[] = [{ id: 'stale', name: 'Stale' } as SkillInfo]
    let scanCallCount = 0
    const scanFn = vi.fn((_root: string): Promise<SkillInfo[]> => {
      scanCallCount++
      return scanCallCount === 1 ? firstScan : Promise.resolve([])
    })
    const cwd = mkdtempSync(join(tmpdir(), 'skill-w2-tc3b-'))
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: scanFn,
    } as never)
    try {
      // 1. 发起 getProjectSkills（in-flight，scanFn 未 resolve）
      const p = reg.getProjectSkills(cwd)
      // 让 (async)() 进入 await scanFn
      await Promise.resolve()
      // 2. 调 invalidateAllProjects：清 projectCache + projectWatchers + projectInFlight + project debounce
      reg.invalidateAllProjects()
      // 3. resolveScan 传「陈旧 skill 列表」——模拟旧配置扫描结果
      resolveFirstScan(staleSkills)
      await p

      // 核心 1：in-flight 完成后旧结果（staleSkills）写不回缓存——
      // invalidateAllProjects 清了 projectInFlight，getProjectSkills 的守卫检测到 key 已不存在，跳过 set。
      // 重新 getProjectSkills 触发新一次 scanFn（返回 []），缓存值应为空而非 staleSkills。
      const skillsAfter = await reg.getProjectSkills(cwd)
      expect(skillsAfter).toEqual([])
      // scanFn 被调用两次（首次 in-flight + invalidate 后重扫），证明缓存被清后确实重扫了
      expect(scanFn).toHaveBeenCalledTimes(2)

      // 核心 2：in-flight 期间不应再挂 watcher（守卫跳过 setupProjectWatcher）——
      // invalidateAllProjects 后 watch 调用次数应为 0（首次 in-flight 守卫跳过 + 重扫时项目无 skill 目录 dirs 为空）
      expect(chokidar.watch).not.toHaveBeenCalled()
    } finally {
      reg.dispose()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('TC4: onChange 收到 SkillChangeEvent 对象（global scope 带 affectedSessionIds / project scope 带 cwd）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = '/proj-tc4'
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: {
        getActiveSessionIds: () => ['sid-1', 'sid-2'],
        getSessionCwd: (sid: string) => (sid === 'sid-1' ? cwd : '/other'),
      } as never,
    } as never)
    const events: Array<{ scope: string; cwd?: string; affectedSessionIds: string[] }> = []
    reg.onChange((event) => events.push(event))

    // 全局变动：scope='global'，cwd 缺省，affectedSessionIds=全部活跃
    await reg.notifyGlobalChange()
    expect(events[0]).toMatchObject({ scope: 'global', affectedSessionIds: ['sid-1', 'sid-2'] })
    expect(events[0].cwd).toBeUndefined()

    // 项目变动：scope='project'，cwd 携带，affectedSessionIds=cwd 匹配的活跃 session
    await reg.notifyProjectChange(cwd)
    expect(events[1]).toMatchObject({ scope: 'project', cwd, affectedSessionIds: ['sid-1'] })
  })

  it('TC4b: rebuildGlobal 触发 onChange 广播 global scope（index.ts onChange 连线的等效验证）', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const dir = mkdtempSync(join(tmpdir(), 'skill-w2-tc4b-'))
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [dir], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      // 真实 sessionService：返回活跃 session 列表（rebuildGlobal → notifyGlobalChange 会读它）
      sessionService: { getActiveSessionIds: () => ['sid-g1', 'sid-g2'] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const events: Array<{ scope: string; cwd?: string; affectedSessionIds: string[] }> = []
    reg.onChange((event) => events.push(event))
    try {
      await reg.initGlobal()
      events.length = 0 // 清掉 initGlobal 的副作用事件（initGlobal 不调 notifyGlobalChange，防御性清空）

      // 调 rebuildGlobal：内部 notifyGlobalChange → onChange 回调收到 { scope:'global', affectedSessionIds:[...] }
      await reg.rebuildGlobal()

      // 核心断言：global scope 广播链路通畅——rebuildGlobal 触发 onChange({scope:'global', ...})
      // （index.ts 用此回调调 server.broadcastSkillCacheInvalidated('global')；本 TC 用真 SkillRegistry
      // 验证 onChange 回调能被 rebuildGlobal 触发并携带 global scope，填补 TC5 只覆盖 project scope 的缺口）
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        scope: 'global',
        affectedSessionIds: ['sid-g1', 'sid-g2'],
      })
      expect(events[0].cwd).toBeUndefined()
    } finally {
      reg.dispose()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('skill-registry D8-a watcher 归因日志（[skill-reload] 行）', () => {
  // G4/S4：watcher 命中必须在 debounce 批边界落一行 `dir= event= affectedSessions=[...]`，
  // 与 reload-orchestrator 的 decision= 行串因果。fake timers 推进 DEBOUNCE_MS(300)
  // 断言批合并（高频编辑不逐事件刷屏）与字段形态。

  /** 造一个测试持有的 fake watcher（同 U5 形态：EventEmitter + close stub）。 */
  const makeFakeWatcher = () => {
    const fakeWatcher = new EventEmitter()
    ;(fakeWatcher as unknown as { close: () => Promise<void> }).close = () => Promise.resolve()
    return fakeWatcher
  }

  it('project watcher：批内多事件合并为一行，affectedSessions 按 cwd 过滤，窗口内不落日志', async () => {
    vi.useFakeTimers()
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-d8a-p-'))
    mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
    const fakeWatcher = makeFakeWatcher()
    vi.mocked(chokidar.watch).mockReturnValueOnce(fakeWatcher as never)
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: {
        getActiveSessionIds: () => ['sid-1', 'sid-2'],
        getSessionCwd: (sid: string) => (sid === 'sid-1' ? cwd : undefined),
      } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await reg.getProjectSkills(cwd)
      // 同一 debounce 窗口内 3 次事件（change×2 去重 + add×1）
      fakeWatcher.emit('all', 'change', join(cwd, '.taiji', 'skills', 'a', 'SKILL.md'))
      fakeWatcher.emit('all', 'add', join(cwd, '.taiji', 'skills', 'b', 'SKILL.md'))
      fakeWatcher.emit('all', 'change', join(cwd, '.taiji', 'skills', 'c', 'SKILL.md'))
      // 窗口内不逐事件落日志（D8 设计：高频编辑不刷屏）
      expect(logSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(310) // DEBOUNCE_MS=300 + 余量
      const reloadLines = logSpy.mock.calls.map(c => c.join(' ')).filter(l => l.includes('[skill-reload]'))
      // 批合并：3 事件 → 1 行；事件类型 Set 插入序去重（change,add）；affectedSessions 走
      // getSessionCwd 过滤（sid-1 匹配 cwd，sid-2 不匹配）
      expect(reloadLines).toEqual([
        `[skill-reload] dir=project:${cwd} event=change,add affectedSessions=[sid-1]`,
      ])
    } finally {
      logSpy.mockRestore()
      reg.dispose()
      vi.useRealTimers()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('F1 类级兜底：定时器同步段（归因日志/受影响 session 计算）抛错 → 降级不崩，rescan 主链照常', async () => {
    // 44beb27cf 事故的类级防线：实例级修复（经宿主对象调用）只保住 getSessionCwd 一处
    // 解绑形态；任何后续往 logWatcherBatch / getAffectedSessionIds 同步段加的 throw 都会
    // 变成 uncaughtException 整机崩（TypeError 无 code，uncaught-policy 不容错）。
    // 本用例锁定：定时器回调同步段抛错时 console.error 降级 + notifyProjectChange 照常。
    vi.useFakeTimers()
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const cwd = mkdtempSync(join(tmpdir(), 'skill-reg-f1-'))
    mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
    const fakeWatcher = makeFakeWatcher()
    vi.mocked(chokidar.watch).mockReturnValueOnce(fakeWatcher as never)
    // 单次抛错：logWatcherBatch 的 getAffectedSessionIds 调用抛（同步段），随后
    // notifyProjectChange 的同函数调用恢复正常（隔离「归因段 throw」与「通知段正常」）。
    let failNext = true
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: {
        getActiveSessionIds: () => {
          if (failNext) {
            failNext = false
            throw new TypeError('simulated sync throw in timer callback')
          }
          return ['sid-1']
        },
        getSessionCwd: () => cwd,
      } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: string[] = []
    reg.onChange((e) => events.push(e.scope))
    try {
      await reg.getProjectSkills(cwd)
      fakeWatcher.emit('all', 'change', join(cwd, '.taiji', 'skills', 'a', 'SKILL.md'))
      await vi.advanceTimersByTimeAsync(310) // 若无兜底：uncaughtException 直接 fail 本测试
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(errSpy.mock.calls[0]!.join(' ')).toContain('watcher batch attribution failed')
      expect(events).toEqual(['project']) // rescan 主链（notifyProjectChange）不被归因失败吞掉
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
      reg.dispose()
      vi.useRealTimers()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('global watcher：dir=global，affectedSessions=全部活跃 session', async () => {
    vi.useFakeTimers()
    const chokidar = await import('chokidar')
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const skillDir = mkdtempSync(join(tmpdir(), 'skill-reg-d8a-g-'))
    const fakeWatcher = makeFakeWatcher()
    vi.mocked(chokidar.watch).mockReturnValueOnce(fakeWatcher as never)
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [skillDir] }) } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => ['sid-g1', 'sid-g2'] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await reg.initGlobal()
      fakeWatcher.emit('all', 'unlink', join(skillDir, 'gone', 'SKILL.md'))
      await vi.advanceTimersByTimeAsync(310)
      const reloadLines = logSpy.mock.calls.map(c => c.join(' ')).filter(l => l.includes('[skill-reload]'))
      // global 变动影响所有活跃 session（无 cwd 过滤）
      expect(reloadLines).toEqual([
        `[skill-reload] dir=global event=unlink affectedSessions=[sid-g1,sid-g2]`,
      ])
    } finally {
      logSpy.mockRestore()
      reg.dispose()
      vi.useRealTimers()
      rmSync(skillDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
