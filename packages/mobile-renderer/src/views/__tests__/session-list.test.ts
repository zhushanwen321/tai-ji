// MobileSessionList 会话管理行为 + app-runtime 删除/恢复/注册编排断言（remote-use U12：
// §2.3 A3 dead 分流 / A4 长按菜单 / A13 runtime 组序 / A15 turnExpansionMap 注册）。
//
// 验收条款 → 用例映射：
//   1. 长按菜单含重命名/删除两动作                → describe A4 用例「长按条目弹出菜单」
//   2. dead 分流走恢复三步编排                    → describe A3 用例「点重新打开执行恢复三步编排」
//   3. 删除编排调 triggerSessionCleanups（销毁语义，与 exited 分通道重置分界）→ describe A4 用例「菜单点删除」
//   4. 列表排序 = runtime 组序（lastActiveAt 客户端重排已删除）→ describe A13 用例
//   5. turnExpansionMap 已注册（删除路径可清）    → describe A15 用例 + A4 删除用例的分区清断言
//
// mock 策略：仅 transport 出口（session/chat 域 RPC）模块级 vi.mock 隔离 WS，app-runtime
// 组装与 core 编排保持全真实（对齐 shell/__tests__/app-runtime.test.ts「mock 组件层会变成
// 断言 mock 自身」的立场——删除编排触达 triggerSessionCleanups 注册表、恢复编排三步顺序
// 必须在真实编排链上断言才有证明力）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/views/__tests__/session-list.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { resetChatModuleStateForTest } from '@taiji/core'
import { registerSessionCleanup, triggerSessionCleanups } from '@taiji/core/foundation/use-session-scoped-state'

const mocks = vi.hoisted(() => ({
  list: vi.fn(async () => [] as never[]),
  switchSession: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  restoreSession: vi.fn(async () => ({}) as SessionSummary),
  getHistory: vi.fn(async () => ({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })),
  streamSubscribe: vi.fn(() => vi.fn()),
}))

vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return { ...actual, list: mocks.list, switchSession: mocks.switchSession, rename: mocks.rename, remove: mocks.remove, restoreSession: mocks.restoreSession }
})
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, getHistory: mocks.getHistory, streamSubscribe: mocks.streamSubscribe }
})

import MobileSessionList from '../MobileSessionList.vue'
import { i18n } from '../../i18n'
import { applySubagentRecords, resetSubagentPartitionsForTest } from '../SubagentStatusLine.vue'
import {
  chatStore,
  createTurnExpansion,
  deleteSession,
  restoreSession,
  selectSession,
  sessionStore,
} from '../../shell/app-runtime'

function mountList() {
  return mount(MobileSessionList, { global: { plugins: [i18n] } })
}

function makeSummary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'lastActiveAt'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    modelId: 'test-model',
    tokenCount: 0,
    ...overrides,
  }
}

/** 经 store 唯一写入口 applySnapshot 注入列表（数据源顺序 = runtime 组序投影） */
function seedList(sessions: SessionSummary[]): void {
  const groups: SessionGroup[] = [{ cwd: '/tmp/project', sessions }]
  sessionStore.applySnapshot({ groups })
}

function itemIdsInOrder(wrapper: ReturnType<typeof mountList>): string[] {
  return wrapper
    .findAll('[data-testid^="mobile-session-item-"]')
    .map((node) => node.attributes('data-testid') ?? '')
}

/** 测试内注册的 cleanup 反注册集中地（afterEach 统一摘除，防跨用例泄漏） */
const registeredCleanups: Array<() => void> = []

function trackCleanup(fn: (sid: string) => void): () => void {
  const unregister = registerSessionCleanup(fn)
  registeredCleanups.push(unregister)
  return unregister
}

/** 长按一条列表行（pointerdown + 长按窗）——调用方需已 useFakeTimers */
async function longPressRow(wrapper: ReturnType<typeof mountList>, sessionId: string): Promise<void> {
  await wrapper.get(`[data-testid="mobile-session-item-${sessionId}"]`).trigger('pointerdown')
  vi.advanceTimersByTime(600)
  await flushPromises()
}

beforeEach(() => {
  i18n.global.locale.value = 'zh-CN'
  sessionStore.applySnapshot({ groups: [] })
  sessionStore.setActiveId(null)
  resetChatModuleStateForTest()
  resetSubagentPartitionsForTest()
  for (const fn of Object.values(mocks)) fn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  for (const unregister of registeredCleanups) unregister()
  registeredCleanups.length = 0
})

describe('A13 列表排序 = runtime 组序（客户端 lastActiveAt 重排已删除）', () => {
  it('行顺序与数据源顺序一致，lastActiveAt 乱序不触发客户端重排', () => {
    // 数据源顺序 a1 → a2 → b1，lastActiveAt 故意乱序（a1 最旧）：
    // 若客户端 lastActiveAt 倒序重排残留，a2/b1 会排到 a1 前 → 本用例红
    seedList([
      makeSummary({ id: 'a1', lastActiveAt: 1000 }),
      makeSummary({ id: 'a2', lastActiveAt: 3000 }),
      makeSummary({ id: 'b1', lastActiveAt: 2000 }),
    ])
    const wrapper = mountList()
    expect(itemIdsInOrder(wrapper)).toEqual([
      'mobile-session-item-a1',
      'mobile-session-item-a2',
      'mobile-session-item-b1',
    ])
    wrapper.unmount()
  })
})

describe('A14 状态点 = 参数化输入派生（core deriveSessionStatus 单点判定）', () => {
  it('真实链输入（core chat store occupancy + A9 subagent 运行态分区）驱动状态点：streaming → 生成中；working → 后台任务', () => {
    seedList([
      makeSummary({ id: 'st-1', status: 'active', lastActiveAt: 1000 }),
      makeSummary({ id: 'st-2', status: 'idle', lastActiveAt: 2000 }),
    ])
    // streaming 输入 = core chat store 分区（真实 store，非 mock）：流式 assistant 消息入分区
    chatStore.hydrate('st-1', [
      { id: 'm1', role: 'assistant', content: '…', status: 'streaming', timestamp: 1 },
    ])
    // working 输入 = SubagentStatusLine 分区读口（真实模块）：running 记录推送
    applySubagentRecords('st-2', [
      { subagentId: 'sa-1', sessionFile: null, agent: 'coder', slug: 'coder', task: 'w', status: 'running' },
    ])
    const wrapper = mountList()
    const streamingItem = wrapper.get('[data-testid="mobile-session-item-st-1"]')
    const workingItem = wrapper.get('[data-testid="mobile-session-item-st-2"]')
    expect(streamingItem.get('.rounded-full').classes()).toContain('bg-accent')
    expect(streamingItem.text()).toContain('生成中')
    expect(workingItem.get('.rounded-full').classes()).toContain('bg-accent')
    expect(workingItem.text()).toContain('后台任务')
    wrapper.unmount()
  })

  it('blockingOverlay 输入缺省（移动壳无 extensionUI store）不产生 waiting 误判：同态与显式空输入一致', () => {
    // 移动输入子集语义（D9③ 白名单）：列表渲染链不传 hasBlockingOverlay——谓词缺省 false，
    // 非 hydrate 会话照常落 meta 兜底（done），不因缺源走 waiting 分支
    seedList([makeSummary({ id: 'st-3', status: 'done', lastActiveAt: 1000 })])
    const wrapper = mountList()
    const item = wrapper.get('[data-testid="mobile-session-item-st-3"]')
    expect(item.get('.rounded-full').classes()).toContain('bg-success')
    expect(item.text()).toContain('已完成')
    wrapper.unmount()
  })
})

describe('A4 长按菜单（重命名/删除）与删除编排', () => {
  it('长按条目弹出菜单，含重命名与删除两动作', async () => {
    vi.useFakeTimers()
    seedList([makeSummary({ id: 's1', lastActiveAt: 1000 })])
    const wrapper = mountList()

    await longPressRow(wrapper, 's1')

    const menu = wrapper.get('[data-testid="mobile-session-menu"]')
    expect(menu.find('[data-testid="mobile-session-menu-rename"]').exists()).toBe(true)
    expect(menu.find('[data-testid="mobile-session-menu-delete"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('菜单点删除：删除编排执行——remove RPC + triggerSessionCleanups 注册项一次全清（销毁语义通路），列表条目消失', async () => {
    vi.useFakeTimers()
    const sid = 'del-1'
    seedList([
      makeSummary({ id: sid, lastActiveAt: 1000 }),
      makeSummary({ id: 'keep-1', lastActiveAt: 2000 }),
    ])
    const cleanupSpy = vi.fn()
    trackCleanup(cleanupSpy)
    // turnExpansion 分区预置展开态——删除后须随注册项清掉（A15/验收条款 5 的删除路径断言）
    const expansion = createTurnExpansion(ref(sid))
    expansion.toggle('turn-k')
    expect(expansion.isExpanded('turn-k')).toBe(true)

    const wrapper = mountList()
    await longPressRow(wrapper, sid)
    await wrapper.get('[data-testid="mobile-session-menu-delete"]').trigger('click')
    await flushPromises()

    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.remove).toHaveBeenCalledWith(sid)
    // 销毁语义分界：删除路径经 triggerSessionCleanups 遍历注册表（exited 分通道重置
    // resetCompanionChannelsForExitedSession 不触注册表——语义分界见设计 D5，由其自身用例锁定）
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
    expect(cleanupSpy).toHaveBeenCalledWith(sid)
    // turnExpansion 注册项被删除路径清掉（验收条款 5「删除路径可清」）
    expect(expansion.isExpanded('turn-k')).toBe(false)
    // 条目随 removeFromList 消失，保留条目不动
    expect(itemIdsInOrder(wrapper)).toEqual(['mobile-session-item-keep-1'])
    wrapper.unmount()
  })

  it('菜单点重命名：rename RPC 后条目标签乐观更新', async () => {
    vi.useFakeTimers()
    seedList([makeSummary({ id: 'rn-1', lastActiveAt: 1000 })])
    const wrapper = mountList()

    await longPressRow(wrapper, 'rn-1')
    await wrapper.get('[data-testid="mobile-session-menu-rename"]').trigger('click')
    const input = wrapper.get('[data-testid="mobile-session-rename-input"]')
    expect((input.element as HTMLInputElement).value).toBe('会话-rn-1')
    await input.setValue('新名字')
    await wrapper.get('[data-testid="mobile-session-rename-confirm"]').trigger('click')
    await flushPromises()

    expect(mocks.rename).toHaveBeenCalledTimes(1)
    expect(mocks.rename).toHaveBeenCalledWith('rn-1', '新名字')
    expect(wrapper.get('[data-testid="mobile-session-item-rn-1"]').text()).toContain('新名字')
    wrapper.unmount()
  })
})

describe('A3 dead 分流与恢复三步编排', () => {
  it('点击 dead 条目出现「重新打开」引导菜单（含重新打开动作），不直接切入', async () => {
    seedList([makeSummary({ id: 'd1', status: 'dead', lastActiveAt: 1000 })])
    const wrapper = mountList()

    await wrapper.get('[data-testid="mobile-session-item-d1"]').trigger('click')
    await flushPromises()

    const menu = wrapper.get('[data-testid="mobile-session-menu"]')
    expect(menu.find('[data-testid="mobile-session-menu-restore"]').exists()).toBe(true)
    // 分流反面：dead 不走常规切入（12 步链 switchSession 零调用）
    expect(mocks.switchSession).not.toHaveBeenCalled()
    expect(wrapper.emitted('open-chat')).toBeUndefined()
    wrapper.unmount()
  })

  it('点「重新打开」执行恢复三步编排：restore RPC → 切入链 → revive 收口', async () => {
    const sid = 'd2'
    seedList([makeSummary({ id: sid, status: 'dead', lastActiveAt: 1000 })])
    const wrapper = mountList()

    await wrapper.get(`[data-testid="mobile-session-item-${sid}"]`).trigger('click')
    await wrapper.get('[data-testid="mobile-session-menu-restore"]').trigger('click')
    await flushPromises()

    // 步 1：显式 restore RPC（重新 spawn pi）
    expect(mocks.restoreSession).toHaveBeenCalledTimes(1)
    expect(mocks.restoreSession).toHaveBeenCalledWith(sid)
    // 步 2：12 步切入链（restore 成功后 selectSession）
    expect(mocks.switchSession).toHaveBeenCalledWith(sid)
    // 三步顺序：restore RPC 先于切入链 switchSession
    expect(mocks.restoreSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.switchSession.mock.invocationCallOrder[0],
    )
    // 步 3：revive 收口——列表条目 dead → idle（dead 态清除）
    expect(sessionStore.getList().find((s) => s.id === sid)?.status).toBe('idle')
    wrapper.unmount()
  })

  it('点击正常条目照常切入（分流反面：非 dead 不弹引导菜单）', async () => {
    seedList([makeSummary({ id: 'ok-1', lastActiveAt: 1000 })])
    const wrapper = mountList()

    await wrapper.get('[data-testid="mobile-session-item-ok-1"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="mobile-session-menu"]').exists()).toBe(false)
    expect(mocks.switchSession).toHaveBeenCalledWith('ok-1')
    expect(wrapper.emitted('open-chat')).toEqual([['ok-1']])
    wrapper.unmount()
  })
})

describe('A15 turnExpansionMap 已注册（删除路径可清）', () => {
  it('分区注册进 session 销毁注册表：triggerSessionCleanups 清分区，重建无残留', () => {
    const sid = 'a15-x'
    const expansion = createTurnExpansion(ref(sid))
    expansion.toggle('k1')
    expect(expansion.isExpanded('k1')).toBe(true)

    triggerSessionCleanups(sid)

    expect(expansion.isExpanded('k1')).toBe(false)
    // 分区重建（删除后同 id 重新使用）：新分区空展开态，无上代残留
    expansion.toggle('k2')
    expect(expansion.isExpanded('k2')).toBe(true)
    expect(expansion.isExpanded('k1')).toBe(false)
  })

  it('其他会话分区隔离：清理只触目标 sid', () => {
    const expansionX = createTurnExpansion(ref('iso-x'))
    const expansionY = createTurnExpansion(ref('iso-y'))
    expansionX.toggle('k')
    expansionY.toggle('k')

    triggerSessionCleanups('iso-x')

    expect(expansionX.isExpanded('k')).toBe(false)
    expect(expansionY.isExpanded('k')).toBe(true)
  })
})

describe('app-runtime 编排出口接线（A3/A4 壳层编排面）', () => {
  it('deleteSession 出口 = core 销毁唯一编排点（api.remove → triggerSessionCleanups）', async () => {
    const cleanupSpy = vi.fn()
    trackCleanup(cleanupSpy)
    await deleteSession('del-export')
    expect(mocks.remove).toHaveBeenCalledWith('del-export')
    expect(cleanupSpy).toHaveBeenCalledWith('del-export')
  })

  it('restoreSession 出口三步序：restore RPC 失败上抛且不切入不 revive', async () => {
    mocks.restoreSession.mockRejectedValueOnce(new Error('RESTORE_FAILED'))
    await expect(restoreSession('rf-1')).rejects.toThrow('RESTORE_FAILED')
    expect(mocks.switchSession).not.toHaveBeenCalled()
  })

  it('selectSession 出口保持 12 步切入链直通', async () => {
    await selectSession('via-export')
    expect(mocks.switchSession).toHaveBeenCalledWith('via-export')
  })
})
