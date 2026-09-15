/**
 * [G4 / u10] SkillRegistry projectWatcher LRU 驱逐单测（2026-09-14 内存审计）。
 *
 * 锁定（docs/design/memory-leak-remediation.md §3.4 G4）：
 *  - L1 容量：distinct cwd 超过 MAX_PROJECT_WATCHERS（8）时驱逐最久未访问 cwd 的 watcher
 *    （close 释放 OS fd——worktree 工作方式下 distinct cwd 持续增长，无界即 EMFILE 同族风险）
 *  - L2 recency：getProjectSkills 缓存命中刷新 recency——活跃 cwd 不被挤出，驱逐落到次旧
 *  - L3 自愈：被驱逐 cwd 再次访问经缓存命中路径的「应 watch 无 watcher」补挂（W3）重挂
 *    watcher，不因驱逐永久失明；重挂本身也 touch（挤出的驱逐链继续滚动）
 *
 * mock 策略对齐 test/skill-registry.test.ts：vi.mock('chokidar') 捕获每次 watch() 产物
 * （close 用 per-instance spy 断言驱逐）；扫描走 _scanFn mock；真实 mkdtemp 目录提供
 * .xyz-agent/skills（resolveProjectSkillDirs 解析出非空 dirs → 挂 watcher）。
 *
 * 运行：cd packages/runtime && npx vitest run test/skill-registry-watcher-lru.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

interface FakeWatcher extends EventEmitter {
  close: ReturnType<typeof vi.fn>
}

/** 每次 chokidar.watch() 产物按序记录（close spy 驱逐断言用） */
const createdWatchers: FakeWatcher[] = []

vi.mock('chokidar', () => ({
  watch: vi.fn((): FakeWatcher => {
    const ee = new EventEmitter() as FakeWatcher
    ee.close = vi.fn(() => Promise.resolve())
    createdWatchers.push(ee)
    return ee
  }),
}))

import { SkillRegistry } from '../src/services/skill-registry.js'

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

/** mkdtemp 一个含 .xyz-agent/skills 的 cwd（挂 watcher 的最小形态） */
function makeCwd(tag: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `skill-lru-${tag}-`))
  mkdirSync(join(cwd, '.xyz-agent', 'skills'), { recursive: true })
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
