/**
 * useProjectSkills / useGlobalSkills 单测（W4，cw-2026-07-21-fix-ask-user-ime）。
 *
 * W4 改动：useProjectSkills 改调 configApi.getProjectSkills(cwd)（走 skillRegistry projectCache），
 * 替代原 scanSessionSkills（无缓存直调 configService）。新增 useGlobalSkills（模块级 singleton 缓存）。
 *
 * Wave3 新增 TC1-TC4（订阅 skill 缓存失效信号 + 失败不永久失败）：
 * - TC1：useGlobalSkills RPC 失败不置 globalLoaded（修复永久失败 bug，可重试）
 * - TC2：useGlobalSkills 订阅 global scope 失效信号触发 force 重拉
 * - TC3：useProjectSkills 订阅 project scope 失效信号清缓存重拉（版本号机制）
 * - TC4：多实例共享模块级订阅（onSkillCacheInvalidated 只注册一次）
 *
 * 模块级状态重置：TC1-TC4 用 vi.resetModules() + 动态 import 重新加载 composable 模块，
 * 保证每个 it 拿到全新的 globalLoaded/globalInvalidateSubscribed/projectInvalidateSubscribed。
 * 现有 W4 用例（TC0 组）保持静态 import，不受模块级状态影响（其断言不依赖订阅守卫）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/use-project-skills.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { SkillInfo } from '@taiji/shared'

// mock getProjectSkills RPC（W4：替代 scanSessionSkills）
// onSkillCacheInvalidated 顶层 stub（Wave3 模块级订阅调用；W4 用例不验证订阅，stub 为空实现）。
const getProjectSkillsMock = vi.hoisted(() => vi.fn())
const onSkillCacheInvalidatedMock = vi.hoisted(() => vi.fn().mockReturnValue(() => {}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: {
    getProjectSkills: getProjectSkillsMock,
    onSkillCacheInvalidated: onSkillCacheInvalidatedMock,
  },
}))

import { useProjectSkills } from '@/composables/features/settings/useProjectSkills'

const SKILLS_A: SkillInfo[] = [
  { id: 's-a1', name: 'proj-a-skill', description: 'a', enabled: true, source: 'agents', effective: true },
]
const SKILLS_B: SkillInfo[] = [
  { id: 's-b1', name: 'proj-b-skill', description: 'b', enabled: true, source: 'agents', effective: true },
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useProjectSkills (W4)', () => {
  it('currentCwd 变化触发 getProjectSkills(cwd)，projectSkills 更新', async () => {
    getProjectSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)

    // 初始 cwd=/proj-a → 触发 RPC
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).toHaveBeenCalledWith('/proj-a')
    })
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual(SKILLS_A)
    })
  })

  it('切到新 cwd → 触发新 RPC，projectSkills 更新为新 cwd 的 skill', async () => {
    getProjectSkillsMock.mockResolvedValueOnce(SKILLS_A).mockResolvedValueOnce(SKILLS_B)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))

    cwd.value = '/proj-b'
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).toHaveBeenCalledWith('/proj-b')
    })
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
  })

  it('切回旧 cwd 命中缓存，不重复 RPC', async () => {
    getProjectSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(1)

    cwd.value = '/proj-b'
    getProjectSkillsMock.mockResolvedValue(SKILLS_B)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(2)

    // 切回 /proj-a → 命中缓存，不触发第 3 次 RPC
    cwd.value = '/proj-a'
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(2)
  })

  it('currentCwd 为 null → projectSkills 为空数组，不 RPC', async () => {
    const cwd = ref<string | null>(null)
    const { projectSkills } = useProjectSkills(cwd)

    // 等待一个 tick 确保 watch 不触发
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).not.toHaveBeenCalled()
      expect(projectSkills.value).toEqual([])
    })
  })

  it('getProjectSkills 抛错 → projectSkills 为空数组，不崩（best-effort）', async () => {
    getProjectSkillsMock.mockRejectedValue(new Error('rpc fail'))
    const cwd = ref<string | null>('/proj-x')

    const { projectSkills } = useProjectSkills(cwd)

    await vi.waitFor(() => expect(getProjectSkillsMock).toHaveBeenCalled())
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual([])
    })
  })
})

// ── Wave3 TC1-TC4：订阅 skill 缓存失效信号 + 失败不永久失败 ──────────
// 模块级状态（globalLoaded/globalInvalidateSubscribed/projectInvalidateSubscribed）跨 it 持久，
// 需每个 it 重置：vi.resetModules() 清模块缓存 + 重新 vi.mock + 动态 import 拿全新模块实例。
// onSkillCacheInvalidated 订阅指向的 events 模块也需一起重置（否则旧订阅残留导致守卫计数错误）。

const SKILL_1: SkillInfo[] = [
  { id: 's1', name: 'skill1', description: 'one', enabled: true, source: 'agents', effective: true },
]
const SKILL_1_2: SkillInfo[] = [
  { id: 's1', name: 'skill1', description: 'one', enabled: true, source: 'agents', effective: true },
  { id: 's2', name: 'skill2', description: 'two', enabled: true, source: 'agents', effective: true },
]
const SKILL_A: SkillInfo[] = [
  { id: 'sa', name: 'skillA', description: 'a', enabled: true, source: 'agents', effective: true },
]
const SKILL_A_B: SkillInfo[] = [
  { id: 'sa', name: 'skillA', description: 'a', enabled: true, source: 'agents', effective: true },
  { id: 'sb', name: 'skillB', description: 'b', enabled: true, source: 'agents', effective: true },
]

describe('useGlobalSkills / useProjectSkills (Wave3: 订阅失效信号)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  /**
   * 订阅 mock 工厂：记录所有注册的 handler，并按 scope 暴露「派发」入口。
   * 用途：
   * - 用 vi.fn 断言注册次数（守卫验证）
   * - emit(scope) 直接调对应 handler（绕开 events，隔离 project/global handler 各测各的）
   * 关键：模块加载时顶层 project 订阅先注册（calls[0] scope=project），
   * useGlobalSkills() 内 global 订阅后注册（calls[1] scope=global）。两者各自带 scope 守卫。
   */
  function makeInvalidateMock() {
    const handlers: Array<(p: { scope: 'global' | 'project'; cwd?: string }) => void> = []
    const onSkillCacheInvalidated = vi.fn(
      (handler: (p: { scope: 'global' | 'project'; cwd?: string }) => void) => {
        handlers.push(handler)
        return () => {}
      },
    )
    function emit(payload: { scope: 'global' | 'project'; cwd?: string }): void {
      // 拷贝避免遍历中 handler 改 handlers 数组
      for (const h of [...handlers]) h(payload)
    }
    function emitGlobal(): void {
      emit({ scope: 'global' })
    }
    function emitProject(cwd?: string): void {
      emit({ scope: 'project', cwd })
    }
    return { onSkillCacheInvalidated, emit, emitGlobal, emitProject }
  }

  it('TC1: useGlobalSkills RPC 失败不置 globalLoaded（修复永久失败 bug，可重试）', async () => {
    const getGlobalSkills = vi.fn().mockRejectedValue(new Error('network'))
    const inv = makeInvalidateMock()
    vi.doMock('@/api', () => ({ config: { getGlobalSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated } }))

    const { useGlobalSkills } = await import('@/composables/features/settings/useProjectSkills')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { globalSkills } = useGlobalSkills()
    await vi.waitFor(() => expect(getGlobalSkills).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(globalSkills.value).toEqual([]))

    // 关键断言：失败后可重试（globalLoaded 未被置 true）。mock 改 resolve([skill1]) 后，
    // 模拟 global scope 失效信号 → loadGlobal(true) 强制重拉 → globalSkills 刷新为 [skill1]
    getGlobalSkills.mockResolvedValue(SKILL_1)
    inv.emitGlobal()
    await vi.waitFor(() => expect(globalSkills.value).toEqual(SKILL_1))
    expect(getGlobalSkills).toHaveBeenCalledTimes(2)

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('TC2: useGlobalSkills 订阅 global scope 失效信号触发 force 重拉', async () => {
    const getGlobalSkills = vi.fn().mockResolvedValue(SKILL_1)
    const inv = makeInvalidateMock()
    vi.doMock('@/api', () => ({ config: { getGlobalSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated } }))

    const { useGlobalSkills } = await import('@/composables/features/settings/useProjectSkills')
    const { globalSkills } = useGlobalSkills()
    await vi.waitFor(() => expect(globalSkills.value).toEqual(SKILL_1))
    expect(getGlobalSkills).toHaveBeenCalledTimes(1)

    // mock 改返回 [skill1, skill2]，模拟 runtime 重扫后缓存更新
    getGlobalSkills.mockResolvedValue(SKILL_1_2)
    // 派发 global scope 失效信号 → loadGlobal(true) force 重拉
    inv.emitGlobal()
    await vi.waitFor(() => expect(globalSkills.value).toEqual(SKILL_1_2))
    expect(getGlobalSkills).toHaveBeenCalledTimes(2)

    // 再次调用 useGlobalSkills 不重复挂 global 订阅（globalInvalidateSubscribed 守卫）
    const callsBefore = inv.onSkillCacheInvalidated.mock.calls.length
    useGlobalSkills()
    expect(inv.onSkillCacheInvalidated.mock.calls.length).toBe(callsBefore)
  })

  it('TC2-B1: Composer 重挂后失效信号仍刷新活跃实例（globalSkills 模块级共享 ref）', async () => {
    const getGlobalSkills = vi.fn().mockResolvedValue(SKILL_1)
    const inv = makeInvalidateMock()
    vi.doMock('@/api', () => ({ config: { getGlobalSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated } }))

    const { useGlobalSkills } = await import('@/composables/features/settings/useProjectSkills')
    // 第一次挂载（模拟首个 Composer 实例）
    const first = useGlobalSkills()
    await vi.waitFor(() => expect(first.globalSkills.value).toEqual(SKILL_1))
    expect(getGlobalSkills).toHaveBeenCalledTimes(1)

    // 重挂：再次调用 useGlobalSkills（模拟 Composer unmount→remount，拿到新返回值）
    const second = useGlobalSkills()

    // B1 回归断言：两次返回的 globalSkills 是同一个模块级 ref（共享，非各自独立）
    expect(second.globalSkills).toBe(first.globalSkills)

    // runtime 重扫后缓存更新，派发 global 失效信号 → 活跃实例（second）应刷新
    getGlobalSkills.mockResolvedValue(SKILL_1_2)
    inv.emitGlobal()
    await vi.waitFor(() => expect(second.globalSkills.value).toEqual(SKILL_1_2))
    expect(first.globalSkills.value).toEqual(SKILL_1_2) // 同一 ref，first 也同步
    expect(getGlobalSkills).toHaveBeenCalledTimes(2)
  })

  it('TC3: useProjectSkills 订阅 project scope 失效信号清缓存重拉（版本号机制）', async () => {
    const getProjectSkills = vi.fn().mockResolvedValue(SKILL_A)
    const inv = makeInvalidateMock()
    vi.doMock('@/api', () => ({ config: { getProjectSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated } }))

    const { useProjectSkills } = await import('@/composables/features/settings/useProjectSkills')
    const cwd = ref<string | null>('/proj1')
    const { projectSkills } = useProjectSkills(cwd)

    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILL_A))
    expect(getProjectSkills).toHaveBeenCalledTimes(1)

    // mock 改返回 [skillA, skillB]，模拟项目目录变更后重扫
    getProjectSkills.mockResolvedValue(SKILL_A_B)
    // 派发 project scope 失效信号 → 版本号++ → watch 清 skillsByCwd → 重拉当前 cwd
    inv.emitProject('/proj1')
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILL_A_B))
    expect(getProjectSkills).toHaveBeenCalledTimes(2)
  })

  it('TC4: 多实例 useProjectSkills 共享一份模块级订阅', async () => {
    const getProjectSkills = vi.fn().mockResolvedValue(SKILL_A)
    const inv = makeInvalidateMock()
    vi.doMock('@/api', () => ({ config: { getProjectSkills, onSkillCacheInvalidated: inv.onSkillCacheInvalidated } }))

    const { useProjectSkills } = await import('@/composables/features/settings/useProjectSkills')
    // 两次实例化（模拟多个 Composer 实例）
    useProjectSkills(ref('/a'))
    useProjectSkills(ref('/b'))

    // 关键断言：project 模块级订阅只挂一次（projectInvalidateSubscribed 守卫，模块加载时挂载）。
    // 注意：onSkillCacheInvalidated 总调用次数 = 1（仅 project 顶层订阅）；useGlobalSkills 未调用，无 global 订阅。
    expect(inv.onSkillCacheInvalidated).toHaveBeenCalledTimes(1)

    // 派发 project 信号 → 两实例各自 watch 版本号触发清自己的 skillsByCwd（版本号共享，触发次数=实例数）
    getProjectSkills.mockResolvedValue(SKILL_A_B)
    inv.emitProject()
    // 等待 watch 生效（两实例各重拉一次自己的当前 cwd）
    await vi.waitFor(() => expect(getProjectSkills.mock.calls.filter((c) => c[0] === '/a').length).toBeGreaterThanOrEqual(1))
    await vi.waitFor(() => expect(getProjectSkills.mock.calls.filter((c) => c[0] === '/b').length).toBeGreaterThanOrEqual(1))
  })
})
