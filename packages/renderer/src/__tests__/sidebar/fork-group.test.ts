/**
 * u11 侧栏测试：ForkGroup 退役 + 两项能力迁移 + 父条目计数徽标（设计 §6.9 决策 D9）。
 *
 * [HISTORICAL] 本文件原为 W4「后台分支管理（ForkGroup）」红灯 TDD 测试（U17-U20：聚合渲染 /
 * fresh 淡出 / ForkGroup 内两段式停止）。D9 裁决「侧栏不聚合（子会话与 fork 分支都按一般
 * session 各占一行）」后 ForkGroup 组件退役，原断言随之失效，本文件重写为退役面的回归测试
 * （保留同文件名，git 可追溯原测试）。
 *
 * 覆盖 D9「退役的爆炸半径与能力处置」：
 *  - R1 组件退役：ForkGroup.vue 不存在 + 生产代码零 import/调用引用
 *  - R2 不丢行：分支会话仍在扁平列表各占一行，血缘不再聚合于容器
 *  - R3 未读合流：unreadByBranch 并入既有 session-unread-dot（后台完成 / 分支停止两源都点亮）
 *  - R4 软停止迁入通用行：运行中行右键「停止」两段确认 → SessionItem / SessionList emit abort
 *  - R5 两源同点清除：clearSessionUnread 一次清 session 标记 + fork 分支角标（core select 链 step 4）
 *  - R6 父条目未完成子会话数徽标（D9 元素，U-B 口径：非绿点子会话数）
 *
 * 三视角（TEST-STRATEGY §3）：每条用例至少 1 个用户可见 DOM 断言；清除点（编排层）用纯函数锁语义。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/fork-group.test.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

import SessionList from '@/components/sidebar/SessionList.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import { walkFiles } from '@/__tests__/helpers/walk-files'
import {
  registerFork,
  resetForkBranchState,
  syncForkBranches,
  unreadByBranch,
} from '@/composables/features/fork-handoff/useForkBranchNotify'
import {
  isUnread,
  markUnread,
  __resetCacheForTest,
} from '@/composables/useSessionMarkers'
import { clearSessionUnread } from '@/composables/features/sidebar/useSidebar'

const CWD = '/p'
const PARENT_FILE = '/p/src.jsonl'

// ── 测试夹具 ─────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-parent',
    label: '主分支会话',
    cwd: CWD,
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'gpt-4',
    tokenCount: 1000,
    ...overrides,
  } as SessionSummary
}

function mountList(sessions: SessionSummary[], activeId: string | null = null) {
  return mount(SessionList, {
    attachTo: document.body,
    props: {
      groups: [{ cwd: CWD, sessions }] as SessionGroup[],
      activeId,
      statusOf: () => 'done' as never,
    },
  })
}

function mountItem(session: SessionSummary) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: { session, active: false, status: 'done' as never },
  })
}

/** 打开右键菜单（reka ContextMenuPortal teleport 到 body，同 session-item-force-quit 范式） */
async function openContextMenu(wrapper: { find: (sel: string) => { trigger: (ev: string) => Promise<void> } }) {
  await wrapper.find('.session-item').trigger('contextmenu')
  await nextTick()
  await nextTick()
}

function findStopItem(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-stop-item"]')
}

/** 生产源码 = src 下非 __tests__ 的 .ts/.vue（组件退役扫描面） */
function productionSources(): string[] {
  return walkFiles('src', { extensions: ['.ts', '.vue'], skipDirs: ['__tests__'] })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
  __resetCacheForTest()
  resetForkBranchState()
})

afterEach(() => {
  document.body.innerHTML = ''
})

// ── R1：ForkGroup 组件退役（D9） ─────────────────────────────
describe('R1: ForkGroup 组件退役', () => {
  it('ForkGroup.vue 文件已删除', () => {
    expect(existsSync(join(process.cwd(), 'src/components/sidebar/ForkGroup.vue'))).toBe(false)
  })

  it('生产代码零引用：无 import / 动态 import / 模板使用 ForkGroup，无 useForkBranchBadges 调用', () => {
    const codeRefPatterns = [
      /from\s+['"][^'"]*ForkGroup\.vue['"]/,
      /import\(\s*['"][^'"]*ForkGroup\.vue['"]\s*\)/,
      /<ForkGroup[\s/>]/,
      /useForkBranchBadges\s*\(/,
    ]
    const offenders = productionSources().filter((rel) => {
      const src = readFileSync(rel, 'utf8')
      return codeRefPatterns.some((re) => re.test(src))
    })
    expect(offenders).toEqual([])
  })

  it('SessionList 不再渲染聚合容器（ForkGroup 组件 + fork-group-* testid 均不存在）', () => {
    const parent = makeSession({ id: 'sess-parent', label: '主线会话', sessionFile: PARENT_FILE })
    const branch = makeSession({ id: 'sess-branch', label: '探索方案 A', parentSession: PARENT_FILE })
    const wrapper = mountList([parent, branch], 'sess-parent')

    expect(wrapper.findComponent({ name: 'ForkGroup' }).exists()).toBe(false)
    expect(wrapper.find('[data-testid^="fork-group"]').exists()).toBe(false)
  })
})

// ── R2：扁平列表不丢行 ───────────────────────────────────────
describe('R2: 分支会话仍在扁平列表各占一行', () => {
  it('父 + 分支 = 两行；分支行标题与「fork 自 <父名>」血缘均可见', () => {
    const parent = makeSession({ id: 'sess-parent', label: '主线会话', sessionFile: PARENT_FILE })
    const branch = makeSession({ id: 'sess-branch', label: '探索方案 A', parentSession: PARENT_FILE })
    const wrapper = mountList([parent, branch], 'sess-parent')

    // 退役不丢行：两条 session 各占一行（此前分支被折进 ForkGroup）
    expect(wrapper.findAll('.session-item')).toHaveLength(2)
    expect(wrapper.text()).toContain('主线会话')
    expect(wrapper.text()).toContain('探索方案 A')
    // 血缘展示保留（SessionItem sub 行，D9 未迁移该能力——它原本就在通用行）
    expect(wrapper.text()).toContain('fork 自 主线会话')
  })
})

// ── R3：未读合流进既有 dot ───────────────────────────────────
describe('R3: unreadByBranch 合流进既有 session-unread-dot', () => {
  /** 走真实分支追踪状态机：registerFork 建基线 → syncForkBranches diff 到终态 → 置角标 */
  function markBranchUnread(branchId: string, to: 'done' | 'stopped'): void {
    registerFork('sess-parent', branchId, '分支')
    syncForkBranches(
      [{ cwd: CWD, sessions: [makeSession({ id: branchId, parentSession: PARENT_FILE, status: to })] } as SessionGroup],
      () => {},
    )
  }

  it('后台分支完成（done）→ 该行未读点（session-unread-dot）亮起', () => {
    const branch = makeSession({ id: 'b-done', label: '后台分支', parentSession: PARENT_FILE })
    markBranchUnread('b-done', 'done')

    const wrapper = mountList([branch], 'sess-parent')
    expect(unreadByBranch.value.get('b-done')).toBe(true)
    expect(wrapper.find('[data-testid="session-unread-dot"]').exists()).toBe(true)
  })

  it('后台分支被停止（stopped）→ 该行未读点亮起（软停止路径同源）', () => {
    const branch = makeSession({ id: 'b-stopped', label: '被停止分支', parentSession: PARENT_FILE })
    markBranchUnread('b-stopped', 'stopped')

    const wrapper = mountList([branch], 'sess-parent')
    expect(wrapper.find('[data-testid="session-unread-dot"]').exists()).toBe(true)
  })

  it('既有源（后台完成 markUnread）仍点亮同一枚 dot——合流未破坏原通路', () => {
    markUnread('sess-bg')
    const wrapper = mountList([makeSession({ id: 'sess-bg', label: '后台完成会话' })])

    expect(isUnread('sess-bg')).toBe(true)
    expect(wrapper.find('[data-testid="session-unread-dot"]').exists()).toBe(true)
  })
})

// ── R4：软停止迁入通用行 ─────────────────────────────────────
describe('R4: 软停止（abort）迁入通用行右键菜单', () => {
  it('运行中 session（status=active）→ 菜单出现「停止」项，初始非确认态', async () => {
    const wrapper = mountItem(makeSession({ id: 's-running', status: 'active' }) as SessionSummary)
    await openContextMenu(wrapper)

    const stopItem = findStopItem()
    expect(stopItem).not.toBeNull()
    expect(stopItem!.textContent).toContain('停止')
    expect(stopItem!.textContent).not.toContain('确认停止')
  })

  it('非运行中 session（idle）→ 不出现「停止」项（只有强制退出）', async () => {
    const wrapper = mountItem(makeSession({ id: 's-idle', status: 'idle' }))
    await openContextMenu(wrapper)

    expect(findStopItem()).toBeNull()
    expect(document.body.querySelector('[data-testid="session-force-quit-item"]')).not.toBeNull()
  })

  it('两段确认：首击进确认态（文案「确认停止？」+ danger 底）不 emit；再击才 emit abort', async () => {
    const wrapper = mountItem(makeSession({ id: 's-running', status: 'active' }) as SessionSummary)
    await openContextMenu(wrapper)

    findStopItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    const confirming = findStopItem()
    expect(confirming).not.toBeNull() // 首击 preventDefault 保持菜单打开
    expect(confirming!.textContent).toContain('确认停止？')
    expect(confirming!.className).toContain('bg-danger')
    expect(wrapper.emitted('abort')).toBeUndefined()

    confirming!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('abort')).toEqual([['s-running']])
  })

  it('SessionList 层透传：运行中行两段确认 → emit abort（带 sessionId）', async () => {
    const wrapper = mountList([makeSession({ id: 'b-running', label: '运行中分支', status: 'active' })], null)
    await openContextMenu(wrapper)

    findStopItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('abort')).toBeUndefined()

    findStopItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('abort')).toEqual([['b-running']])
  })
})

// ── R5：两源同点清除 ─────────────────────────────────────────
describe('R5: 未读两源在同一清除点被清（core select 链 step 4）', () => {
  it('clearSessionUnread 同时清 fork 分支角标与 session 标记，DOM 未读点随之消失', async () => {
    const sid = 'b-clear'
    // 两源都置位
    markUnread(sid)
    registerFork('sess-parent', sid, '分支')
    syncForkBranches(
      [{ cwd: CWD, sessions: [makeSession({ id: sid, parentSession: PARENT_FILE, status: 'stopped' })] } as SessionGroup],
      () => {},
    )
    expect(isUnread(sid)).toBe(true)
    expect(unreadByBranch.value.get(sid)).toBe(true)

    const wrapper = mountList([makeSession({ id: sid, label: '待清除分支', parentSession: PARENT_FILE })])
    expect(wrapper.find('[data-testid="session-unread-dot"]').exists()).toBe(true)

    // 单一清除点 = useSidebar 注入 core select 链 step 4 的 sessionEntry.clearUnread
    clearSessionUnread(sid)
    await nextTick()

    expect(isUnread(sid)).toBe(false)
    expect(unreadByBranch.value.has(sid)).toBe(false)
    expect(wrapper.find('[data-testid="session-unread-dot"]').exists()).toBe(false)
  })
})

// ── R6：父条目未完成子会话数徽标（D9 + U-B 口径改未完成数） ────
describe('R6: 父条目子会话计数徽标', () => {
  it('混合态（2 已完成 + 1 active）→ 徽标只数未完成 = 1；无子会话行不渲染', () => {
    const parent = makeSession({ id: 'p-1', label: '父会话' })
    const doneA = makeSession({ id: 'c-1', label: '子会话 A', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'idle' })
    const doneB = makeSession({ id: 'c-2', label: '子会话 B', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'done' })
    const running = makeSession({ id: 'c-3', label: '子会话 C', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'active' })
    const plain = makeSession({ id: 'plain', label: '普通会话' })
    const wrapper = mountList([parent, doneA, doneB, running, plain])

    const badges = wrapper.findAll('[data-testid="session-child-count"]')
    // 仅父行有徽标（子行 / 普通行无）；数字 = 未完成数（2 个绿点子会话不计入）
    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('1')
    // 中性色（不用 accent——accent 已被 [AI] 来源徽标占用）
    expect(badges[0].classes()).toContain('text-neutral-dim')
    expect(badges[0].classes()).not.toContain('text-accent')
  })

  it('全部子会话已完成（idle / done = 绿点）→ 未完成数 0，徽标不渲染', () => {
    const parent = makeSession({ id: 'p-1', label: '父会话' })
    const doneA = makeSession({ id: 'c-1', label: '子会话 A', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'idle' })
    const doneB = makeSession({ id: 'c-2', label: '子会话 B', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'done' })
    const wrapper = mountList([parent, doneA, doneB])

    expect(wrapper.findAll('[data-testid="session-child-count"]')).toHaveLength(0)
  })

  it('error / stopped 子会话计入未完成数（判据 = 非绿点，非仅 active）', () => {
    const parent = makeSession({ id: 'p-1', label: '父会话' })
    const failed = makeSession({ id: 'c-1', label: '失败子会话', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'error' })
    const stopped = makeSession({ id: 'c-2', label: '停止子会话', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'stopped' })
    const doneChild = makeSession({ id: 'c-3', label: '已完子会话', parentAgentSessionId: 'p-1', spawnSource: 'agent', status: 'done' })
    const wrapper = mountList([parent, failed, stopped, doneChild])

    const badges = wrapper.findAll('[data-testid="session-child-count"]')
    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('2')
  })
})
