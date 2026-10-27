/**
 * 合并产物（round5-f S1，簇 3-1 拆对子集）。
 *
 * 来源五文件（describe/it 原样搬运）：fork-group / session-item-archive-button /
 * session-item-export-jsonl / sidebar-assign-project / session-item-active-style。
 * 环境全默认。唯一 mock：@/api 部分门面（assign-project 节；该 mock 面与
 * assembly-check.test.ts 同款，覆盖 useSidebar 构造期消费成员，SessionItem/
 * SessionList 真实链在其下可挂载——assign-project 节自身 mount SessionList 跑通）。
 * 辅助函数按节改名消歧（mountArchiveItem / mountExportItem / mountActiveItem /
 * mountExportList / openContextMenu）；顶层 hook 幂等并集（pinia 重建 +
 * localStorage 清理 + fork/markers 状态复位）。
 *
 * fork-group 节 [HISTORICAL] 登记保留：本节原为 W4「后台分支管理（ForkGroup）」
 * 红灯 TDD 测试（U17-U20）。D9 裁决「侧栏不聚合（子会话与 fork 分支都按一般
 * session 各占一行）」后 ForkGroup 组件退役，原断言随之失效，重写为退役场景的
 * 回归测试（保留节名，git 可追溯原测试）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, effectScope } from 'vue'
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
import { clearSessionUnread, useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionStore } from '@/stores/session'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'

// ── assign-project 节 mock：@/api 部分门面（session.setProject 是受测 RPC，hoisted 控制）──
const apiMocks = vi.hoisted(() => ({
  setProject: vi.fn(),
}))

vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve({ id: 'mock' })),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    setProject: apiMocks.setProject,
  },
}))
// ═══ 来源：fork-group.test.ts（[HISTORICAL] 登记见产物头）═══
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
    ...overrides,
  }
}

function mountList(sessions: SessionSummary[], activeId: string | null = null) {
  // 装载 loaded + 默认项目（connection-datasync-ssot §6.7 三形态：idle 分组区渲染占位，
  // 会话行不渲染——本 helper 挂载的会话无 projectId，落默认区渲染）
  const store = useProjectStore()
  store.projects = [{ id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }]
  store.activeProjectId = DEFAULT_PROJECT_ID
  store.revision = 1
  store.loadState = 'loaded'
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

/** 生产源码 = src 下非 __tests__ 的 .ts/.vue（组件退役扫描范围） */
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
  it('父 + 分支 = 两行；列表单行（标题+时间），血缘/分支/cwd 不再上列表行', () => {
    const parent = makeSession({ id: 'sess-parent', label: '主线会话', sessionFile: PARENT_FILE })
    const branch = makeSession({ id: 'sess-branch', label: '探索方案 A', parentSession: PARENT_FILE })
    const wrapper = mountList([parent, branch], 'sess-parent')

    // 退役不丢行：两条 session 各占一行（此前分支被折进 ForkGroup）
    expect(wrapper.findAll('.session-item')).toHaveLength(2)
    expect(wrapper.text()).toContain('主线会话')
    expect(wrapper.text()).toContain('探索方案 A')
    // 单行化（demo .si，用户裁决 2026-10-10）：列表行只有标题+时间，
    // 血缘/分支/cwd 副行退役——元信息归 hover 详情卡（下方血缘卡片用例）
    expect(wrapper.text()).not.toContain('fork 自 主线会话')
    expect(wrapper.find('[data-testid="sidebar-session-sub"]').exists()).toBe(false)
  })

  it('hover 详情卡展示「fork 自 <父名>」血缘行（demo .sess-pop：行首图标 + 立即开）', async () => {
    // 生产接线还原：parentLabel 只经 :parent-label prop 注入（SessionList.parentLabelOf 反查），
    // session 对象不持该字段——shared SessionSummary 无 parentLabel，展示期注入不污染实体
    const branch = makeSession({ id: 'sess-branch', label: '探索方案 A', parentSession: PARENT_FILE })
    const wrapper = mount(SessionItem, {
      attachTo: document.body,
      props: { session: branch, parentLabel: '主线会话', active: false, status: 'done' as never },
    })
    // demo @mouseenter=openCard 立即开（无延迟定时），pointerenter 后同步渲染
    await wrapper.find('.session-item').trigger('pointerenter')
    await nextTick()

    const card = document.body.querySelector('[data-testid="session-detail-card"]')
    expect(card).not.toBeNull()
    // 行首图标（demo .pr 形态：GitBranch 13px）+ 值；textContent 拼接去 span 间空白分断言
    expect(card?.querySelector('svg')).not.toBeNull()
    expect(card?.textContent).toContain('fork 自')
    expect(card?.textContent).toContain('主线会话')
    // 离行即关（demo closeCard 同款）
    await wrapper.find('.session-item').trigger('pointerleave')
    await nextTick()
    expect(document.body.querySelector('[data-testid="session-detail-card"]')).toBeNull()
    wrapper.unmount()
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

// ═══ 来源：session-item-archive-button.test.ts ═══
function mountArchiveItem(status: string, id = 's1') {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { id, label: `会话 ${id}`, cwd: '/p', lastActiveAt: 0 },
      active: false,
      status: status as never,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SessionItem 归档钮两段确认（D6 accent 轻确认）', () => {
  it('首击 → 确认态（accent 类 + Check 图标 + title 提示），不 emit archive', async () => {
    const wrapper = mountArchiveItem('done')
    const btn = wrapper.find('[data-testid="session-archive-btn"]')

    await btn.trigger('click')

    expect(btn.classes()).toContain('bg-accent-soft')
    expect(btn.classes()).toContain('text-accent')
    // 确认态非 danger（归档非破坏性——区别于原删除钮红底）
    expect(btn.classes()).not.toContain('bg-danger')
    expect(btn.attributes('title')).toBe('再次点击确认归档')
    expect(btn.find('svg.lucide-check').exists()).toBe(true)
    expect(wrapper.emitted('archive')).toBeUndefined()
    wrapper.unmount()
  })

  it('确认态再击 → emit archive(sessionId) + 确认态复位（Archive 图标回归）', async () => {
    const wrapper = mountArchiveItem('done')
    const btn = wrapper.find('[data-testid="session-archive-btn"]')

    await btn.trigger('click')
    await btn.trigger('click')

    expect(wrapper.emitted('archive')).toEqual([['s1']])
    expect(btn.classes()).not.toContain('bg-accent-soft')
    expect(btn.find('svg.lucide-archive').exists()).toBe(true)
    wrapper.unmount()
  })

  it('默认态：title「归档」+ Archive 图标（与归档域入口/空态同族，区别于标记完成的 CircleCheck）', () => {
    const wrapper = mountArchiveItem('done')
    const btn = wrapper.find('[data-testid="session-archive-btn"]')
    expect(btn.attributes('title')).toBe('归档')
    // done 终态不禁用（生成中六瞬态才禁用）
    expect(btn.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('SessionItem 归档钮生成中禁用（D13 renderer 拦截层）', () => {
  it.each(['streaming', 'pending', 'compacting', 'waiting', 'retrying', 'working'] as const)(
    'status=%s → disabled + title「生成中不可归档」，点击不 emit',
    async (status) => {
      const wrapper = mountArchiveItem(status)
      const btn = wrapper.find('[data-testid="session-archive-btn"]')

      expect(btn.attributes('disabled')).toBeDefined()
      expect(btn.attributes('title')).toBe('生成中不可归档')

      await btn.trigger('click')
      expect(wrapper.emitted('archive')).toBeUndefined()
      expect(wrapper.emitted('update:confirming')).toBeUndefined()
      wrapper.unmount()
    },
  )

  it.each(['done', 'stopped', 'error'] as const)('终态 status=%s → 可点击（非禁用）', (status) => {
    const wrapper = mountArchiveItem(status)
    expect(wrapper.find('[data-testid="session-archive-btn"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

// ═══ 来源：session-item-export-jsonl.test.ts ═══
/** 带 sessionFile 的普通 session fixture */
const SESSION_WITH_FILE = {
  id: 'exp-1',
  label: '我的会话',
  cwd: '/p',
  lastActiveAt: 0,
  sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
}

function mountExportItem(sessionOverrides: Record<string, unknown> = {}) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { ...SESSION_WITH_FILE, ...sessionOverrides },
      active: false,
      status: 'done' as never,
    },
  })
}

/** 挂载含一条 session 的 SessionList（转发链路用） */
function mountExportList(sessions: Array<Record<string, unknown>>) {
  // 装载 loaded + 默认项目（connection-datasync-ssot §6.7 三形态：idle 分组区渲染占位，
  // 会话行不渲染——右键菜单事件链需要行在 DOM）
  const store = useProjectStore()
  store.projects = [{ id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }]
  store.activeProjectId = DEFAULT_PROJECT_ID
  store.revision = 1
  store.loadState = 'loaded'
  return mount(SessionList, {
    attachTo: document.body,
    props: {
      groups: [{ cwd: '/p', sessions }] as unknown as SessionGroup[],
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

function findExportItem(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-export-jsonl-item"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})


/** 断言「导出 JSONL」菜单项渲染 + 文案单源（返回该 item 供可用态差异断言）。 */
function expectExportItemRendered(): HTMLElement | null {
  const item = findExportItem()
  expect(item).not.toBeNull()
  expect(item!.textContent).toContain('导出 JSONL')
  return item
}

describe('导出 JSONL 菜单项渲染（SessionItem）', () => {
  it('右键 session → 「导出 JSONL」菜单项出现且可用（使用者黑盒）', async () => {
    const wrapper = mountExportItem()
    await openContextMenu(wrapper)

    const item = expectExportItemRendered()
    expect(item!.hasAttribute('data-disabled')).toBe(false)
    expect(item!.getAttribute('title')).toBeNull()
  })

  it('sessionFile 缺失（pi 延迟写入窗口）→ 菜单项禁用 + title 提示（构建者白盒 + 观察者形态）', async () => {
    const wrapper = mountExportItem({ sessionFile: undefined })
    await openContextMenu(wrapper)

    const item = expectExportItemRendered()
    expect(item!.hasAttribute('data-disabled')).toBe(true)
    expect(item!.getAttribute('title')).toContain('会话尚未产生记录文件')
  })
})

describe('导出 JSONL 单击 emit（SessionItem）', () => {
  it('单击即 emit exportJsonl，payload = main 侧 IPC 请求体（sessionId + sessionFile + suggestedName=label.jsonl）', async () => {
    const wrapper = mountExportItem()
    await openContextMenu(wrapper)

    findExportItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('exportJsonl')).toEqual([[
      {
        sessionId: 'exp-1',
        sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
        suggestedName: '我的会话.jsonl',
      },
    ]])
  })

  it('禁用态点击不 emit（sessionFile 缺失时入口不可用）', async () => {
    const wrapper = mountExportItem({ sessionFile: undefined })
    await openContextMenu(wrapper)

    findExportItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('exportJsonl')).toBeUndefined()
  })
})

describe('exportJsonl 事件链（SessionItem → SessionList）', () => {
  it('SessionList 层收到 exportJsonl 且 payload 原样透传（全链路）', async () => {
    const wrapper = mountExportList([{ ...SESSION_WITH_FILE }])
    await openContextMenu(wrapper)

    findExportItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('exportJsonl')).toEqual([[
      {
        sessionId: 'exp-1',
        sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
        suggestedName: '我的会话.jsonl',
      },
    ]])
  })
})

// ═══ 来源：session-item-active-style.test.ts ═══
const BASE_SESSION = {
  id: 'active-style-1',
  label: 'Active Session',
  cwd: '/p',
  lastActiveAt: 0,
}

function mountActiveItem(active: boolean) {
  return mount(SessionItem, {
    props: {
      session: { ...BASE_SESSION },
      active,
      status: 'done' as never,
    },
  })
}

beforeEach(() => {
  // SessionItem setup 内 useProjectStore（D14 归入项目菜单），mount 需激活 pinia
  setActivePinia(createPinia())
})

describe('会话条目激活态样式（选中 = 悬停同色实底 + 文字提亮）', () => {
  it('激活条目：根节点挂 bg-surface-hover（与 hover 同色实底），无竖条/elevated 底，保留行文字提亮', () => {
    const wrapper = mountActiveItem(true)
    const root = wrapper.find('.session-item')
    expect(root.classes()).toContain('bg-surface-hover')
    expect(root.classes()).not.toContain('bg-bg-elevated')
    expect(root.classes()).not.toContain('bg-accent-soft')
    expect(root.classes()).not.toContain('shadow-[inset_2px_0_0_var(--accent)]')
    expect(root.classes()).toContain('text-neutral-fg')
  })

  it('激活条目标题文字为提亮中性色 text-neutral-fg（使用者黑盒，用户可见 DOM）', () => {
    const wrapper = mountActiveItem(true)
    const title = wrapper.findAll('span').find((s) => s.text() === 'Active Session')
    expect(title).toBeTruthy()
    const titleRow = title!.element.parentElement as HTMLElement
    expect(titleRow.className).toContain('text-neutral-fg')
    expect(titleRow.className).not.toContain('text-accent')
  })

  it('非激活条目：无选中文字提亮，行根恒挂 hover 底（demo .si:hover 恒有背景）', () => {
    const wrapper = mountActiveItem(false)
    const root = wrapper.find('.session-item')
    expect(root.classes()).toContain('hover:bg-surface-hover')
  })
})

// ═══ 来源：sidebar-assign-project.test.ts ═══
function makeSummary(id: string, projectId?: string): SessionSummary {
  return {
    id,
    label: id,
    cwd: '/proj',
    status: 'idle',
    lastActiveAt: 1,
    ...(projectId !== undefined ? { projectId } : {}),
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
  vi.clearAllMocks()
})

describe('useSidebar.assignSessionToProject（RPC + 乐观更新）', () => {
  it('成功：setProject RPC 调用（sessionId, projectId 透传）+ 乐观更新同步（聚合数据源实时变化）', async () => {
    apiMocks.setProject.mockResolvedValue(undefined)
    const store = useSessionStore()
    store.applySnapshot({ groups: [{ cwd: '/proj', sessions: [makeSummary('s1', 'p0')] }] })

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    await sidebar.assignSessionToProject('s1', 'p1')

    expect(apiMocks.setProject).toHaveBeenCalledWith('s1', 'p1')
    // 乐观更新写 pinia store —— SessionList 的 groups 数据源（props: session.groups）实时变化，
    // 不依赖后续 config.sessions 广播收敛
    expect(store.groups[0]!.sessions[0]!.projectId).toBe('p1')
    scope.stop()
  })

  it('顺序：setProject resolve 前不做乐观更新（先磁盘后 UI，防 UI/磁盘分叉）', async () => {
    let resolveRpc!: () => void
    apiMocks.setProject.mockImplementation(
      () => new Promise<void>((res) => { resolveRpc = res }),
    )
    const store = useSessionStore()
    store.applySnapshot({ groups: [{ cwd: '/proj', sessions: [makeSummary('s1', 'p0')] }] })

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    const pending = sidebar.assignSessionToProject('s1', 'p1')

    // RPC 未 resolve：store 保持原归属（乐观更新被 await 挡在 RPC 之后）
    expect(store.groups[0]!.sessions[0]!.projectId).toBe('p0')
    resolveRpc()
    await pending
    expect(store.groups[0]!.sessions[0]!.projectId).toBe('p1')
    scope.stop()
  })

  it('setProject reject → 不乐观更新（归属保持原值）且错误向上传播（Sidebar 层 toast 分支）', async () => {
    apiMocks.setProject.mockRejectedValue(new Error('rpc-fail'))
    const store = useSessionStore()
    store.applySnapshot({ groups: [{ cwd: '/proj', sessions: [makeSummary('s1', 'p0')] }] })

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    await expect(sidebar.assignSessionToProject('s1', 'p1')).rejects.toThrow('rpc-fail')

    expect(apiMocks.setProject).toHaveBeenCalledWith('s1', 'p1')
    // 乐观更新未执行：磁盘失败时 UI 不提前分叉
    expect(store.groups[0]!.sessions[0]!.projectId).toBe('p0')
    scope.stop()
  })

  it('projectId 空串 = 归回默认项目（RPC 透传空串，store 清为 undefined）', async () => {
    apiMocks.setProject.mockResolvedValue(undefined)
    const store = useSessionStore()
    store.applySnapshot({ groups: [{ cwd: '/proj', sessions: [makeSummary('s1', 'p1')] }] })

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    await sidebar.assignSessionToProject('s1', '')

    expect(apiMocks.setProject).toHaveBeenCalledWith('s1', '')
    // updateProjectId 空串 → undefined：归回默认项目后 SessionList 默认聚合视图可达
    expect(store.groups[0]!.sessions[0]!.projectId).toBeUndefined()
    scope.stop()
  })
})

describe('SessionList: setProject 透传接线（L67 @set-project → emit setProject）', () => {
  it('SessionItem 菜单选项目 → SessionList 原样透传 emit setProject 同 payload', async () => {
    const store = useProjectStore()
    store.projects = [
      { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
      { id: 'p1', name: 'Alpha', lastUsedAt: 0 },
    ]
    store.activeProjectId = DEFAULT_PROJECT_ID
    store.revision = 1 // loaded 态（§6.9）：无有效数据形态下归属入口整体隐藏
    store.loadState = 'loaded'

    const groups: SessionGroup[] = [{ cwd: '/repo', sessions: [makeSummary('s1')] }]
    const wrapper = mount(SessionList, {
      attachTo: document.body,
      props: { groups, activeId: null, statusOf: () => 'done' as never },
    })

    // 真实链路：SessionItem 菜单点击（emit setProject）→ SessionList L67 透传 emit('setProject')
    await wrapper.find('[data-testid="assign-project-btn"]').trigger('click')
    await nextTick()
    const alpha = Array.from(
      document.body.querySelectorAll('[data-testid="assign-project-option"]'),
    ).find((o) => o.textContent === 'Alpha')!
    alpha.dispatchEvent(new MouseEvent('click'))
    await nextTick()

    expect(wrapper.emitted('setProject')).toEqual([[{ sessionId: 's1', projectId: 'p1' }]])
    // 先 unmount 再清 body：reka popover/ScrollArea 的异步 DOM 更新在 attachTo 节点销毁后 flush
    // 会触发 insertBefore(null) 未处理异常（见 Vitest Unhandled Rejection）
    wrapper.unmount()
    await nextTick()
    document.body.innerHTML = ''
  })
})
