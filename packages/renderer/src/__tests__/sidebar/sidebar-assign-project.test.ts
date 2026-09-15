/**
 * D14「归入项目」handler 链测试（review MF-1：emit 之后的链零覆盖补测）。
 *
 * 链：SessionItem 菜单 emit setProject → SessionList 透传 → Sidebar.vue @set-project →
 *     useSidebarSessionActions.onAssignProject（失败 toast）→ useSidebar.assignSessionToProject
 *     （await sessionApi.setProject RPC → sessionStore.updateProjectId 乐观更新）。
 *
 * 本文件覆盖链的下游两环（Sidebar 接线 + toast 在 sidebar-assign-project-wiring.test.ts）：
 *  - useSidebar.assignSessionToProject：RPC 参数透传、乐观更新同步（SessionList 聚合数据源
 *    store.groups 实时变化，无需等 config.sessions 广播）、顺序（RPC await resolve 前不做乐观更新，
 *    防 UI/磁盘分叉）、reject 不乐观更新且错误向上传播、projectId 空串 = 归回默认项目
 *  - SessionList 透传接线（L67 @set-project → emit('setProject')，同 payload 原样透传）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-assign-project.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

// ── mock @/api：session.setProject 是受测 RPC，需 hoisted 控制 resolve/reject ──
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

import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionStore } from '@/stores/session'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import SessionList from '@/components/sidebar/SessionList.vue'

function makeSummary(id: string, projectId?: string): SessionSummary {
  return {
    id,
    label: id,
    cwd: '/proj',
    status: 'idle',
    lastActiveAt: 1,
    modelId: 'm1',
    tokenCount: 0,
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
