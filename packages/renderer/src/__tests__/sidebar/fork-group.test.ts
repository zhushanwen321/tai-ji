/**
 * W4 后台分支管理（ForkGroup）红灯测试（TDD）。
 *
 * 覆盖 U17-U20：
 * - U17：当前 session 有子分支时渲染 ForkGroup，无子分支不渲染
 * - U18：分支 session SessionItem sub 行显示「fork 自 <父名>」血缘
 * - U19：ForkGroup 分支项停止 action 调 abort（两段式确认）
 * - U20：fresh 高亮 3.2s 后淡出（FRESH_FADE_MS）
 *
 * 红灯预期：
 * - ForkGroup.vue 在 W4 才创建，当前不存在 → U19/U20 import 即失败
 * - SessionSummary 当前无 parentSession 字段（W1 才加）→ U17/U18 构造数据类型不支持
 * - SessionList 当前无 ForkGroup 渲染分支 → U17 断言失败
 * - SessionItem 当前无血缘展示 → U18 断言失败
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/fork-group.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@taiji/shared'

import SessionList from '@/components/sidebar/SessionList.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'

/**
 * 延迟加载 ForkGroup（W4 才创建，当前不存在）。
 * 用变量 specifier 动态 import——vite 的 import-analysis 只静态解析字面量 specifier，
 * 变量 specifier 推迟到运行时解析，避免模块级 transform 阶段就失败（0 test 跑不起来）。
 * 每个测试独立报告失败原因：U19/U20 在此 await 处 fail（运行时 resolve 失败），
 * U17/U18 不依赖 ForkGroup 文件、可独立跑出断言失败。
 */
async function loadForkGroup(): Promise<any> {
  const specifier = '@/components/sidebar/ForkGroup.vue'
  const mod = await import(/* @vite-ignore */ specifier)
  return mod.default
}

// ── 测试夹具 ─────────────────────────────────────────────────
// FRESH_FADE_MS 常量当前不存在（W4 才定义于 ForkGroup 内），此处给出期望值用于断言。
const FRESH_FADE_MS = 3200

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-parent',
    label: '主分支会话',
    cwd: '/Users/test/project',
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'gpt-4',
    tokenCount: 1000,
    ...overrides,
  } as SessionSummary
}

// ── U17：当前 session 有子分支时渲染 ForkGroup ─────────────
describe('U17: SessionList 有子分支时渲染 ForkGroup', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('当前激活 session 有子分支（parentSession 指向当前 session）时渲染 ForkGroup', () => {
    const parent = makeSession({ id: 'sess-active', label: '当前会话' })
    // 分支 session：parentSession 指向当前激活 session（W4 的 ForkGroup 据此聚合）
    const branch = {
      ...makeSession({
        id: 'sess-branch-1',
        label: '探索方案 A',
      }),
      // W1 字段：分支血缘，当前类型不支持，红灯因数据/渲染不支持
      parentSession: 'sess-active',
    } as SessionSummary

    const groups: SessionGroup[] = [
      { cwd: '/Users/test/project', sessions: [parent, branch] },
    ]

    const wrapper = mount(SessionList, {
      props: {
        groups,
        activeId: 'sess-active',
        statusOf: () => 'done' as never,
      },
    })

    // ForkGroup 组件应被渲染（用组件名查找——ForkGroup 是新组件，当前未在 SessionList 中使用）
    const forkGroup = wrapper.findComponent({ name: 'ForkGroup' })
    expect(forkGroup.exists()).toBe(true)
  })

  it('无分支的 sessions 不渲染 ForkGroup', () => {
    const groups: SessionGroup[] = [
      {
        cwd: '/Users/test/project',
        sessions: [makeSession({ id: 'sess-1', label: '会话 1' })],
      },
    ]

    const wrapper = mount(SessionList, {
      props: {
        groups,
        activeId: 'sess-1',
        statusOf: () => 'done' as never,
      },
    })

    const forkGroup = wrapper.findComponent({ name: 'ForkGroup' })
    expect(forkGroup.exists()).toBe(false)
  })
})

// ── U18：分支 session SessionItem sub 行显示 fork 自父名血缘 ──
describe('U18: SessionItem 分支 sub 行显示 fork 自父名', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('分支 session（含 parentSession 字段）sub 行含「fork 自」文案', () => {
    const branch = {
      ...makeSession({
        id: 'sess-branch-1',
        label: '探索方案 A',
      }),
      // W1 字段：fork 血缘，当前 SessionSummary 无此字段 → 红灯因类型不支持
      parentSession: 'sess-parent',
      // 父 session 名（W4 ForkGroup 渲染血缘需要，或 SessionItem 直接展示 parentSession 名）
      parentLabel: '主分支会话',
    } as SessionSummary

    const wrapper = mount(SessionItem, {
      props: {
        session: branch,
        active: false,
        status: 'done' as never,
      },
    })

    // sub 行（dirName 行，font-mono text-neutral-dim）应含「fork 自」血缘文案
    expect(wrapper.text()).toContain('fork 自')
    // 血缘文案含父名
    expect(wrapper.text()).toContain('主分支会话')
  })

  it('普通 session（无 parentSession）sub 行不含 fork 自文案', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: makeSession({ id: 'sess-plain', label: '普通会话' }),
        active: false,
        status: 'done' as never,
      },
    })

    expect(wrapper.text()).not.toContain('fork 自')
  })
})

// ── U19：ForkGroup 分支项停止 action 调 abort ───────────────
describe('U19: ForkGroup 分支项停止 action 调 abort', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('分支项 hover + 点击停止按钮触发两段式 abort（首次确认，再次 emit）', async () => {
    const branches: SessionSummary[] = [
      // running 态分支（status: 'active' 表示生成中，可被 abort）
      makeSession({
        id: 'sess-branch-running',
        label: '运行中分支',
        status: 'active',
      }) as SessionSummary,
    ]

    const ForkGroup = await loadForkGroup()
    const wrapper = mount(ForkGroup, {
      props: {
        branches,
        parentId: 'sess-active',
      },
    })

    // 1. 首次点击停止按钮 → 进入确认态（不 emit）
    const stopBtn = wrapper.find('[data-testid="fork-group-stop"]')
    expect(stopBtn.exists()).toBe(true)
    await stopBtn.trigger('click')
    // 首次点击不 emit（两段式）
    expect(wrapper.emitted('stop')).toBeFalsy()

    // 2. 确认态出现确认按钮
    const confirmBtn = wrapper.find('[data-testid="fork-group-stop-confirm"]')
    expect(confirmBtn.exists()).toBe(true)

    // 3. 再次点击确认 → emit stop（带 sessionId）
    await confirmBtn.trigger('click')
    const emitted = wrapper.emitted('stop')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['sess-branch-running'])
  })
})

// ── U20：fresh 高亮 3.2s 后淡出 ──────────────────────────────
describe('U20: ForkGroup fresh 高亮 3.2s 后淡出', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  it('新 fork 的分支 fresh class 存在，advanceTimersByTime(FRESH_FADE_MS) 后移除', async () => {
    const branches: SessionSummary[] = [
      // 新 fork 的分支：fresh 高亮（isFresh: true / 新创建）
      makeSession({
        id: 'sess-branch-fresh',
        label: '刚 fork 的分支',
      }) as SessionSummary,
    ]

    const ForkGroup = await loadForkGroup()
    const wrapper = mount(ForkGroup, {
      props: {
        branches,
        parentId: 'sess-active',
        // 标记为 fresh（W4 ForkGroup 据此加 fresh class）
        freshIds: ['sess-branch-fresh'],
      },
    })

    // 1. 初始：fresh class 存在（高亮态）
    const freshItem = wrapper.find('[data-testid="fork-group-branch-fresh"]')
    // 或用 class 查找——ForkGroup 给 fresh 分支项加 fresh class
    const branchItem = wrapper.find('[data-testid="fork-group-branch"]')
    expect(branchItem.exists()).toBe(true)
    expect(branchItem.classes()).toContain('fresh')

    // 2. 推进 FRESH_FADE_MS（3.2s）→ fresh class 移除（淡出）
    // [S2] ForkGroup fresh 淡出改为纯响应式驱动（timer 回调只更新 activeFresh Set，
    // DOM patch 走 Vue 响应式异步更新）。fake timer 推进后必须 await nextTick 让 DOM patch 落地。
    vi.advanceTimersByTime(FRESH_FADE_MS)
    await nextTick()

    // 3. fresh class 应已移除
    const branchItemAfter = wrapper.find('[data-testid="fork-group-branch"]')
    expect(branchItemAfter.exists()).toBe(true)
    expect(branchItemAfter.classes()).not.toContain('fresh')
  })

  it('mount 后 freshIds 数组引用更新：新增 id 启动计时出现 fresh class（浅 watch 增量触发，W05 review）', async () => {
    const branches: SessionSummary[] = [
      makeSession({ id: 'sess-branch-a', label: '分支 A' }),
      makeSession({ id: 'sess-branch-b', label: '分支 B' }),
    ] as SessionSummary[]

    const ForkGroup = await loadForkGroup()
    const wrapper = mount(ForkGroup, {
      props: {
        branches,
        parentId: 'sess-active',
        freshIds: [], // mount 时无 fresh
      },
    })

    // 初始：两个分支项均无 fresh class
    let items = wrapper.findAll('[data-testid="fork-group-branch"]')
    expect(items).toHaveLength(2)
    expect(items[0].classes()).not.toContain('fresh')
    expect(items[1].classes()).not.toContain('fresh')

    // 父组件替换 freshIds 数组引用（浅 watch 约定：更新经引用替换表达，原地 mutate 不触发）
    // → 新增 id（sess-branch-b）启动计时，出现 fresh class
    await wrapper.setProps({ freshIds: ['sess-branch-b'] })
    items = wrapper.findAll('[data-testid="fork-group-branch"]')
    expect(items[1].classes()).toContain('fresh')
    // 不在 freshIds 中的 a 不受影响
    expect(items[0].classes()).not.toContain('fresh')

    // 增量触发的计时同样受 FRESH_FADE_MS 管辖：3.2s 后淡出
    vi.advanceTimersByTime(FRESH_FADE_MS)
    await nextTick()
    items = wrapper.findAll('[data-testid="fork-group-branch"]')
    expect(items[1].classes()).not.toContain('fresh')
  })
})
