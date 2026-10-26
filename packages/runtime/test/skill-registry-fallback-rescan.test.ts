/**
 * skill-registry-fallback-rescan：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - skill-registry-fallback-rescan.test.ts
 *   - skill-registry-watcher-lru.test.ts
 *   - skill-cache-invalidation-integration.test.ts
 *   - skill-registry-affected-sessions.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/skill-registry-fallback-rescan.test.ts
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage, SkillInfo } from '@taiji/shared'
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'
import { SkillRegistry, type SkillRegistrySessionService, type SkillScanFn } from '../src/services/skill-registry.js'
import type { BrokerServices, ClientPool } from '../src/transport/message-broker.js'

// ── chokidar 桩（两个 watcher 节共用；声明提升到文件层以匹配 vi.mock 工厂提升后的作用域）──
interface FakeWatcher extends EventEmitter {
  close: ReturnType<typeof vi.fn>
}

/** 每次 chokidar.watch() 产物按序记录（熔断/LRU 驱逐断言按位取 watcher；各节 beforeEach 清空） */
const createdWatchers: FakeWatcher[] = []

vi.mock('chokidar', () => ({
  watch: vi.fn((): FakeWatcher => {
    const ee = new EventEmitter() as FakeWatcher
    ee.close = vi.fn(() => Promise.resolve())
    createdWatchers.push(ee)
    return ee
  }),
}))


// ════════════════ 来源: skill-registry-fallback-rescan.test.ts ════════════════
describe('skill-registry-fallback-rescan', () => {
  /**
   * [U2 / cache-governance 1-4] SkillRegistry 周期兜底重扫单测（fake timers）。
   *
   * G5「失效机制故障可自愈」：watcher 熔断后现状「冻结到重启」——兜底定时器按固定周期
   * （FALLBACK_RESCAN_INTERVAL_MS = 5min）无条件重扫 globalCache + 全部活跃 projectCache cwd：
   *  - F1: watcher 正常 → 兜底周期到也重扫（无条件重扫语义）；值未变不广播（广播链下游 =
   *        reloadOrchestrator 全量 idle session pi reload + renderer 重新拉取，无差别周期广播违背
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
      // + renderer 失效重新拉取，无差别周期广播违背「watcher 正常时兜底成本可忽略」
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
});

// ════════════════ 来源: skill-registry-watcher-lru.test.ts ════════════════
describe('skill-registry-watcher-lru', () => {
  /**
   * [G4 / u10] SkillRegistry projectWatcher LRU 驱逐单测（2026-09-14 内存审计）。
   *
   * 锁定（内存审计 ADR-0069 G4；原文档已删除 git 可追溯）：
   *  - L1 容量：distinct cwd 超过 MAX_PROJECT_WATCHERS（8）时驱逐最久未访问 cwd 的 watcher
   *    （close 释放 OS fd——worktree 工作方式下 distinct cwd 持续增长，无界即 EMFILE 同族风险）
   *  - L2 recency：getProjectSkills 缓存命中刷新 recency——活跃 cwd 不被挤出，驱逐落到次旧
   *  - L3 自愈：被驱逐 cwd 再次访问经缓存命中路径的「应 watch 无 watcher」补挂（W3）重挂
   *    watcher，不因驱逐永久失明；重挂本身也 touch（挤出的驱逐链继续滚动）
   *
   * mock 策略对齐 test/skill-registry.test.ts：vi.mock('chokidar') 捕获每次 watch() 产物
   * （close 用 per-instance spy 断言驱逐）；扫描走 _scanFn mock；真实 mkdtemp 目录提供
   * .taiji/skills（resolveProjectSkillDirs 解析出非空 dirs → 挂 watcher）。
   *
   * 运行：cd packages/runtime && npx vitest run test/skill-registry-watcher-lru.test.ts
   */

  /** LRU 容量常量镜像断言用（与 skill-registry.ts MAX_PROJECT_WATCHERS 同值） */
  const MAX_PROJECT_WATCHERS = 8

  function makeRegistry(): SkillRegistry {
    return new SkillRegistry({
      configStore:
        {
          getSkillPaths: () => [],
          getPiAgentDir: () => '/pi',
          getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }),
        } as never,
      configDir: '/cfg',
      sessionService: { getActiveSessionIds: () => [] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)
  }

  /** mkdtemp 一个含 .taiji/skills 的 cwd（挂 watcher 的最小形态） */
  function makeCwd(tag: string): string {
    const cwd = mkdtempSync(join(tmpdir(), `skill-lru-${tag}-`))
    mkdirSync(join(cwd, '.taiji', 'skills'), { recursive: true })
    return cwd
  }

  describe('skillRegistry projectWatcher LRU（G4/u10）', () => {
    let cwds: string[]

    beforeEach(() => {
      createdWatchers.length = 0
      cwds = []
    })
    afterEach(() => {
      for (const cwd of cwds) rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it(`L1: 第 ${MAX_PROJECT_WATCHERS + 1} 个 distinct cwd 挂载驱逐最旧 watcher（close 释放），最新 ${MAX_PROJECT_WATCHERS} 个存活`, async () => {
      const reg = makeRegistry()
      for (let i = 0; i < MAX_PROJECT_WATCHERS + 1; i++) {
        const cwd = makeCwd(`a${i}`)
        cwds.push(cwd)
        await reg.getProjectSkills(cwd)
      }

      expect(createdWatchers).toHaveLength(MAX_PROJECT_WATCHERS + 1)
      // 最旧（第 1 个 cwd）被驱逐：close 恰一次
      expect(createdWatchers[0].close).toHaveBeenCalledTimes(1)
      // 其余 watcher 存活（close 未被调）
      for (let i = 1; i <= MAX_PROJECT_WATCHERS; i++) {
        expect(createdWatchers[i].close).not.toHaveBeenCalled()
      }
      reg.dispose()
    })

    it('L2: 缓存命中刷新 recency——被 touch 的最旧 cwd 存活，驱逐落到次旧', async () => {
      const reg = makeRegistry()
      for (let i = 0; i < MAX_PROJECT_WATCHERS; i++) {
        const cwd = makeCwd(`b${i}`)
        cwds.push(cwd)
        await reg.getProjectSkills(cwd)
      }
      // touch 最旧（缓存命中路径，不新建 watcher）
      await reg.getProjectSkills(cwds[0])
      expect(createdWatchers).toHaveLength(MAX_PROJECT_WATCHERS)

      const ninth = makeCwd('b-new')
      cwds.push(ninth)
      await reg.getProjectSkills(ninth)

      expect(createdWatchers).toHaveLength(MAX_PROJECT_WATCHERS + 1)
      // 被 touch 的 cwd[0] 存活；驱逐落到次旧 cwd[1]
      expect(createdWatchers[0].close).not.toHaveBeenCalled()
      expect(createdWatchers[1].close).toHaveBeenCalledTimes(1)
      reg.dispose()
    })

    it('L3: 被驱逐 cwd 再次访问经 W3 补挂路径重挂 watcher（自愈；重挂 touch 继续滚动驱逐）', async () => {
      const reg = makeRegistry()
      for (let i = 0; i < MAX_PROJECT_WATCHERS + 1; i++) {
        const cwd = makeCwd(`c${i}`)
        cwds.push(cwd)
        await reg.getProjectSkills(cwd)
      }
      expect(createdWatchers[0].close).toHaveBeenCalledTimes(1) // cwd[0] 已被驱逐

      // 缓存命中 + 无 watcher → refreshProjectWatcher 补挂（setupProjectWatcher 同步先行）
      const before = createdWatchers.length
      await reg.getProjectSkills(cwds[0])
      expect(createdWatchers).toHaveLength(before + 1) // 重挂新 watcher

      // 重挂 touch 使 LRU 超容 → 滚动驱逐次旧（cwd[1] 的 watcher）
      expect(createdWatchers[1].close).toHaveBeenCalledTimes(1)
      reg.dispose()
    })
  })
});

// ════════════════ 来源: skill-cache-invalidation-integration.test.ts ════════════════
describe('skill-cache-invalidation-integration', () => {
  /**
   * 契约 4 端到端集成测试：config.skillCacheInvalidated 广播链路（reviewer-D WARNING-1）。
   *
   * 背景：契约 4 此前被切成三段分别测，**中间真实 broker 广播从未被串联执行**：
   *   - skill-registry.test.ts TC4b：止于 registry 层（验 rebuildGlobal → onChange({scope:'global'})，不触达 broker）
   *   - settings-message-handler.test.ts TC5：mock 掉 registry，handler → ctx.broadcastSkillCacheInvalidated('project')
   *     （onChange 路径未走，只是 handler 直调 ctx）
   *   - command-popover-landing.test.ts TC5（renderer 侧）：人造 dispatchGlobal 验 DOM，非真实 broker 广播
   *
   * 本文件补的 gap：真实 SkillRegistry + 真实 ServerMessageBroker，手动复刻 index.ts:326-331 的组合根连线
   * （registry.onChange → broker.broadcastSkillCacheInvalidated），驱动 rebuildGlobal / notifyProjectChange，
   * 断言 broker.broadcast 收到 { type:'config.skillCacheInvalidated', payload:{ scope, cwd } } 消息。
   *
   * 这是「registry 层 onChange 测了、renderer 层 dispatchGlobal 测了、但中间 broker 广播没串」的典型
   * 「测试绿但集成断」gap——本测试把三段连成一条线，确保 payload 字段（scope/cwd）从 registry 一路透传到 WS 消息体。
   *
   * 不验真实 WS 发送（broker.broadcast 内部遍历 pool.clients 调 ws.send 是 message-broker.test.ts 的 U9 职责），
   * 这里只 spy broker.broadcast 验消息构造正确。
   */

  /** 构造真实 ServerMessageBroker，返回 broker + 捕获 broadcast 消息的 spy。 */
  async function makeRealBroker() {
    const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
    // 空连接池：broadcast 仍会序列化 msg 并遍历 clients（空集 → 无 ws.send），构造路径完整执行。
    // 我们 spy broadcast 入口验消息，不依赖真实 ws。
    const pool: ClientPool = { clients: new Set() }
    const services = {
      sessionService: { listPersistedSessions: () => [] },
      configService: {
        listProviders: () => [],
        getDefaultModel: () => null,
        loadSkills: () => [],
        loadAgents: () => [],
        getSkillDirs: () => [],
        getAgentDirs: () => [],
        getExtensionDirs: () => [],
      },
      modelService: { aggregateModels: () => [] },
      pluginService: undefined,
      extensionService: undefined,
      projectRoot: '/proj',
      appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
    } as unknown as BrokerServices
    const broker = new ServerMessageBroker(pool, services)
    const broadcastSpy = vi.spyOn(broker, 'broadcast')
    return { broker, broadcastSpy }
  }

  /**
   * 从 broadcastSpy 调用记录里捞出所有 config.skillCacheInvalidated 消息。
   * （broker 其他广播 helper 不在本测试链路触发，这里防御性过滤 type。）
   */
  function skillCacheInvalidatedCalls(spy: ReturnType<typeof vi.spyOn>): ServerMessage[] {
    return spy.mock.calls
      .map(([msg]: [ServerMessage]) => msg)
      .filter((msg: ServerMessage) => msg.type === 'config.skillCacheInvalidated')
  }

  describe('skill cache invalidation 端到端广播（契约 4 集成）', () => {
    it('rebuildGlobal → onChange → broker 广播 config.skillCacheInvalidated scope=global', async () => {
      const { SkillRegistry } = await import('../src/services/skill-registry.js')
      const { broker, broadcastSpy } = await makeRealBroker()

      const reg = new SkillRegistry({
        configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
        configDir: '/cfg',
        // 真实 sessionService：返回活跃 session（notifyGlobalChange 会读它填 affectedSessionIds）
        sessionService: { getActiveSessionIds: () => ['s1'] } as never,
        _scanFn: vi.fn().mockResolvedValue([]),
      } as never)

      try {
        // 复刻 index.ts:326-331 的组合根连线：registry.onChange → broker.broadcastSkillCacheInvalidated
        // 这条线是契约 4 的真实集成点——此前三段单测各自 mock，从未串联执行过。
        reg.onChange((event) => {
          broker.broadcastSkillCacheInvalidated(event.scope, event.cwd)
        })

        // 触发 rebuildGlobal：内部 scanFn 重扫 → notifyGlobalChange → 上面注册的 onChange handler
        // → broker.broadcastSkillCacheInvalidated('global') → broker.broadcast(msg)
        await reg.rebuildGlobal()

        const calls = skillCacheInvalidatedCalls(broadcastSpy)
        // 核心断言：真实 broker.broadcast 被以正确的 config.skillCacheInvalidated 消息调用
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({
          type: 'config.skillCacheInvalidated',
          payload: { scope: 'global' },
        })
        // scope=global 时 cwd 缺省（不应误带 cwd 字段污染前端路由判断）
        expect((calls[0].payload as { cwd?: string }).cwd).toBeUndefined()
        // id 是 broker.nextPushId 生成的 push_<n>（验消息体结构完整，非裸 payload）
        expect(typeof calls[0].id).toBe('string')
        expect(calls[0].id).toMatch(/^push_\d+$/)
      } finally {
        reg.dispose()
      }
    })

    it('notifyProjectChange(cwd) → onChange → broker 广播 scope=project + cwd', async () => {
      const { SkillRegistry } = await import('../src/services/skill-registry.js')
      const { broker, broadcastSpy } = await makeRealBroker()

      const cwd = '/proj'
      const reg = new SkillRegistry({
        configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
        configDir: '/cfg',
        sessionService: {
          getActiveSessionIds: () => ['s1', 's2'],
          // s1 绑定 cwd，s2 绑定别的（验 affectedSessionIds 按 cwd 过滤，但广播 payload 只关心 scope/cwd）
          getSessionCwd: (sid: string) => (sid === 's1' ? cwd : '/other'),
        } as never,
        _scanFn: vi.fn().mockResolvedValue([]),
      } as never)

      try {
        // 同样复刻 index.ts:326-331 连线
        reg.onChange((event) => {
          broker.broadcastSkillCacheInvalidated(event.scope, event.cwd)
        })

        // 触发 notifyProjectChange：project scope + cwd 透传到 broker 广播
        await reg.notifyProjectChange(cwd)

        const calls = skillCacheInvalidatedCalls(broadcastSpy)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({
          type: 'config.skillCacheInvalidated',
          payload: { scope: 'project', cwd },
        })
        expect(calls[0].id).toMatch(/^push_\d+$/)
      } finally {
        reg.dispose()
      }
    })

    it('rebuildGlobal + notifyProjectChange 连续触发 → broker 广播两条消息（global 后 project），payload 互不串扰', async () => {
      // 防御性：连续广播下 broker 内部 pushId 自增 + payload 字段不交叉污染
      const { SkillRegistry } = await import('../src/services/skill-registry.js')
      const { broker, broadcastSpy } = await makeRealBroker()

      const cwd = '/proj-2'
      const reg = new SkillRegistry({
        configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
        configDir: '/cfg',
        sessionService: {
          getActiveSessionIds: () => ['s1'],
          getSessionCwd: (sid: string) => (sid === 's1' ? cwd : undefined),
        } as never,
        _scanFn: vi.fn().mockResolvedValue([]),
      } as never)

      try {
        reg.onChange((event) => {
          broker.broadcastSkillCacheInvalidated(event.scope, event.cwd)
        })

        await reg.rebuildGlobal()
        await reg.notifyProjectChange(cwd)

        const calls = skillCacheInvalidatedCalls(broadcastSpy)
        expect(calls).toHaveLength(2)
        // 第一条 global（rebuildGlobal 触发），第二条 project（notifyProjectChange 触发）
        expect(calls[0]).toMatchObject({ type: 'config.skillCacheInvalidated', payload: { scope: 'global' } })
        expect(calls[1]).toMatchObject({ type: 'config.skillCacheInvalidated', payload: { scope: 'project', cwd } })
        // 两条 id 各自独立自增（非复用同一 id）
        expect(calls[0].id).not.toBe(calls[1].id)
      } finally {
        reg.dispose()
      }
    })

    it('RT-1#9: partial=true 透传进广播 payload（rebuildGlobal 失败分支的降级补发标注）', async () => {
      const { broker, broadcastSpy } = await makeRealBroker()

      broker.broadcastSkillCacheInvalidated('global', undefined, true)
      broker.broadcastSkillCacheInvalidated('project')

      const calls = skillCacheInvalidatedCalls(broadcastSpy)
      expect(calls).toHaveLength(2)
      // partial 降级标注随 payload 下发；正常失效广播不携带该字段
      expect(calls[0]).toMatchObject({ payload: { scope: 'global', partial: true } })
      expect((calls[1].payload as { partial?: boolean }).partial).toBeUndefined()
    })
  })
});

// ════════════════ 来源: skill-registry-affected-sessions.test.ts ════════════════
describe('skill-registry-affected-sessions', () => {
  /**
   * getAffectedSessionIds 的 this 绑定锁定（skill-reload B4 真机事故回归）。
   *
   * 事故：skill-registry 曾以「解绑提取」消费 sessionService.getSessionCwd
   * （const fn = svc.getSessionCwd 后裸调用），真实 SessionService 是 class 原型方法，
   * 裸调用 this=undefined → watcher debounce 定时器内 TypeError → uncaughtException
   * 整机崩（supervisor 重启 → 全部 session 执行树被 destroyAll 带走）。
   * 单测未拦住的原因：彼时 stub 全部用箭头函数属性形态（不受解绑影响）。
   * 本文件以 class 原型方法形态的 stub 锁定：通知 payload 与 D8-a 归因日志共用的
   * affected 计算口径必须经宿主对象调用。
   */


  /** 真实 SessionService 同构：方法在 prototype 上（非箭头函数实例属性）——解绑即炸的形态。 */
  class ClassMethodSessionService {
    private readonly cwds = new Map<string, string | undefined>([
      ['s-proj', '/proj'],
      ['s-other', '/elsewhere'],
    ])
    getActiveSessionIds(): string[] {
      return [...this.cwds.keys()]
    }
    getSessionCwd(sessionId: string): string | undefined {
      return this.cwds.get(sessionId)
    }
  }

  function makeRegistry(sessionService: unknown): {
    registry: SkillRegistry
    seen: Array<{ scope: string; cwd?: string; affectedSessionIds: string[] }>
  } {
    const seen: Array<{ scope: string; cwd?: string; affectedSessionIds: string[] }> = []
    const registry = new SkillRegistry({
      configStore: { getPiAgentDir: () => '/tmp/agent', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) },
      configDir: '/tmp',
      sessionService: sessionService as never,
    })
    registry.onChange((e) => seen.push(e))
    return { registry, seen }
  }

  describe('SkillRegistry.getAffectedSessionIds（this 绑定锁定）', () => {
    test('class 原型方法形态的 sessionService：project 变更按 cwd 过滤且不炸（解绑提取回归测试）', async () => {
      const { registry, seen } = makeRegistry(new ClassMethodSessionService())

      await registry.notifyProjectChange('/proj')

      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ scope: 'project', cwd: '/proj', affectedSessionIds: ['s-proj'] })
    })

    test('getSessionCwd 未注入时降级为全部活跃 session（契约不变）', async () => {
      const { registry, seen } = makeRegistry({ getActiveSessionIds: () => ['s-proj', 's-other'] })

      await registry.notifyProjectChange('/proj')

      expect(seen).toHaveLength(1)
      expect(seen[0].affectedSessionIds).toEqual(['s-proj', 's-other'])
    })

    test('global 变更 = 全部活跃 session', async () => {
      const { registry, seen } = makeRegistry(new ClassMethodSessionService())

      await registry.notifyGlobalChange()

      expect(seen).toHaveLength(1)
      expect(seen[0].affectedSessionIds).toEqual(['s-proj', 's-other'])
    })

    test('未订阅 handler 时通知不炸（空 handlers）', async () => {
      const registry = new SkillRegistry({
        configStore: { getPiAgentDir: () => '/tmp/agent', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) },
        configDir: '/tmp',
        sessionService: new ClassMethodSessionService() as never,
      })

      await expect(registry.notifyProjectChange('/proj')).resolves.toBeUndefined()
    })
  })
});
