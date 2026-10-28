import { __testing } from '../../bootstrap';
import { i18n } from '../../i18n';
import { chatStore, composerInjectionStore, createTurnExpansion, deleteSession, restoreSession, selectSession, sessionStore } from '../../shell/app-runtime';
import MobileComposer from '../MobileComposer.vue';
import MobileMessageStream from '../MobileMessageStream.vue';
import MobileSessionList from '../MobileSessionList.vue';
import NewTaskSheet from '../NewTaskSheet.vue';
import QueueStrip from '../QueueStrip.vue';
import SubagentStatusLine, { __testing as subagentStatusTesting, applySubagentRecords } from '../SubagentStatusLine.vue';
import { createLifecycleEffects, getDeliveryProjectionRef, resetChatModuleStateForTest } from '@taiji/core';
import type { DeliveryFrameEntry } from '@taiji/core';
import { registerSessionCleanup, triggerSessionCleanups } from '@taiji/core/foundation/use-session-scoped-state';
import type { Message, SessionGroup, SessionSummary, SubagentRecord } from '@taiji/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← session-list.test.ts
// ======================================================================

const mocks = vi.hoisted(() => ({
  list: vi.fn(async () => [] as never[]),
  switchSession: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  restoreSession: vi.fn(async () => ({}) as SessionSummary),
  getHistory: vi.fn(async () => ({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })),
  streamSubscribe: vi.fn(() => vi.fn()),
}))
// 簇内并集 mock（session-list 管理出口 + new-task 创建流出口 + truncated 历史分页 +
// queue-strip 取消出口同表覆写；spread actual —— 其余 transport 成员保持真实）。
vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return {
    ...actual,
    list: mocks.list,
    switchSession: mocks.switchSession,
    rename: mocks.rename,
    remove: mocks.remove,
    restoreSession: mocks.restoreSession,
    create: mocks_m2.create,
  }
})
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return {
    ...actual,
    getHistory: getHistoryMock,
    submitDelivery: mocks_m2.submitDelivery,
    streamSubscribe: mocks_m2.streamSubscribe,
    cancelDelivery: cancelDeliveryMock,
  }
})

describe('session-list', () => {
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
// 运行：cd packages/mobile-renderer && npx vitest run src/views/__tests__/session-flow.test.ts




function mountList() {
  return mount(MobileSessionList, { global: { plugins: [i18n] } })
}

function makeSummary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'lastActiveAt'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    ...overrides,
  }
}

/** 经 store 唯一写入口 applySnapshot 注入列表（数据源顺序 = runtime 组序派生视图） */
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
  subagentStatusTesting.resetSubagentPartitionsForTest()
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
    // 移动输入子集语义（D9② 白名单）：列表渲染链不传 hasBlockingOverlay——谓词缺省 false，
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

  it('点「重新打开」执行恢复三步编排：restore RPC → 切入链 → revive 收尾', async () => {
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
    // 步 3：revive 收尾——列表条目 dead → idle（dead 态清除）
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

describe('app-runtime 编排出口接线（A3/A4 壳层编排侧）', () => {
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

})

describe('subagent-status', () => {
// subagent 运行状态行（remote-use A9 / U15；D5 去留表 onSubagents 行）。
//
// 锁定两个验收条款：
//   1. onSubagents 消息写分区并渲染运行状态行——bootstrap effects.onSubagents 直挂
//      applySubagentRecords（写 per-session Map 分区，不可变替换）→ 组件按活跃 sessionId
//      读分区 → running 汇总状态行（idle 不计、轮收条已写（stopReason 在场）不计）。
//   2. 接线位在壳扩展层非 factory 内——effects.onSubagents 与组件模块导出 applySubagentRecords
//      同源（直挂）；core lifecycle factory 产物不含 onSubagents（factory 不含 subagent 语义，
//      D5 去留表口径的机器断言）。
//
// 写分区语义 = 桌面 stores/subagent.ts applyRecords 的最小子集（分区范式：不可变整 Map 替换；
// 推送是权威数据，空数组照写——对齐桌面推送路径不经 strike 检查）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/views/__tests__/session-flow.test.ts

const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

function record(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'general-purpose',
    slug: '',
    task: 'demo task',
    status: 'idle',
    ...overrides,
  }
}

function mountStatusLine(sessionId: string): VueWrapper {
  return mount(SubagentStatusLine, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

describe('subagent 运行状态行（A9/U15）', () => {
  beforeEach(() => {
    // 模块级分区单例跨用例残留清零（__testing 先例：仅测试消费）
    subagentStatusTesting.resetSubagentPartitionsForTest()
  })

  it('onSubagents 消息经壳 effects 写分区并渲染运行状态行（全链路：回调 → 分区 → 渲染）', () => {
    __testing.shellEffects.onSubagents?.('sid-live', [
      record({ subagentId: 'bg-1', slug: 'reviewer', status: 'running' }),
    ])

    const wrapper = mountStatusLine('sid-live')
    const line = wrapper.find('[data-testid="mobile-subagent-status-line"]')
    expect(line.exists()).toBe(true)
    expect(line.attributes('role')).toBe('status')
    expect(line.text()).toBe(t('mobile.subagentStatus.running', { slugs: 'reviewer' }))
  })

  it('推送是权威数据：同 sid 二次推送整体替换（跑完翻 idle → 状态行消失）', async () => {
    applySubagentRecords('sid-replace', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'running' }),
    ])
    const wrapper = mountStatusLine('sid-replace')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(true)

    applySubagentRecords('sid-replace', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'idle', stopReason: 'completed' }),
    ])
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)
  })

  it('running 过滤：idle 记录不计入运行汇总（占用判据 = running 且无 stopReason）', () => {
    applySubagentRecords('sid-filter', [
      record({ subagentId: 'bg-1', slug: 'runner', status: 'running' }),
      record({ subagentId: 'bg-2', slug: 'finished', status: 'idle', stopReason: 'completed' }),
    ])

    const wrapper = mountStatusLine('sid-filter')
    const text = wrapper.find('[data-testid="mobile-subagent-status-line"]').text()
    expect(text).toContain('runner')
    expect(text).not.toContain('finished')
  })

  it('轮收条已写（stopReason 在场）不算在跑（[subagent-observability §3.3.3⑦] 占用信号语义；原「死亡纳管态」措辞随 adoptEngineDeath 写点退役）；无 running 记录时状态行不渲染', () => {
    applySubagentRecords('sid-dead-running', [
      record({ subagentId: 'bg-1', slug: 'adopted', status: 'running', stopReason: 'failed' }),
    ])
    const wrapper = mountStatusLine('sid-dead-running')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)

    // 空数组推送（无 subagent 会话）同样不渲染
    applySubagentRecords('sid-empty', [])
    const wrapperEmpty = mountStatusLine('sid-empty')
    expect(wrapperEmpty.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)
  })

  it('分区隔离：不同 session 各读各的分区（props sessionId 切换自动重算）', async () => {
    applySubagentRecords('sid-a', [
      record({ subagentId: 'bg-1', slug: 'alpha', status: 'running' }),
    ])
    const wrapper = mountStatusLine('sid-a')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).toContain('alpha')

    await wrapper.setProps({ sessionId: 'sid-b' })
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').exists()).toBe(false)

    applySubagentRecords('sid-b', [
      record({ subagentId: 'bg-2', slug: 'beta', status: 'running' }),
    ])
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).toContain('beta')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).not.toContain('alpha')
  })

  it('slug 缺省兜底 agent 名（旧 session 数据 slug 空串形态文案不空）', () => {
    applySubagentRecords('sid-noslug', [
      record({ subagentId: 'bg-1', slug: '', agent: 'reviewer', status: 'running' }),
    ])

    const wrapper = mountStatusLine('sid-noslug')
    expect(wrapper.find('[data-testid="mobile-subagent-status-line"]').text()).toBe(
      t('mobile.subagentStatus.running', { slugs: 'reviewer' }),
    )
  })

  it('接线位在壳扩展层非 factory 内：effects.onSubagents 与组件导出同源直挂；factory 产物无 onSubagents', () => {
    // 直挂断言：bootstrap 壳 effects 的 onSubagents 就是组件模块导出的写入口（非包装非转接）
    expect(__testing.shellEffects.onSubagents).toBe(applySubagentRecords)

    // factory 不含 subagent 语义（D5 去留表）：createLifecycleEffects 产物键集无 onSubagents
    const factoryEffects = createLifecycleEffects(
      { chat: chatStore, session: sessionStore },
      { restored: 'r', restoreFailed: 'f' },
    )
    expect(Object.keys(factoryEffects)).not.toContain('onSubagents')
  })
})

})

// ======================================================================
// ← new-task-sheet.test.ts
// ======================================================================

const mocks_m2 = vi.hoisted(() => ({
  create: vi.fn<(...args: unknown[]) => Promise<SessionSummary>>(async () => ({}) as SessionSummary),
  submitDelivery: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  streamSubscribe: vi.fn<(sessionId: string, handler: unknown) => () => void>(() => vi.fn()),
}))

// transport 并集 mock 见簇首（session-list 节顶部）：本节覆盖项已并入同一工厂。

/** RFC 4122 canonical 形态（randomUuid 两条实现路径——crypto.randomUUID 与 fallback 手拼——产出同形） */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function makeSummary_m2(
  overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'lastActiveAt'>,
): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    ...overrides,
  }
}

function mountSheet(): VueWrapper {
  return mount(NewTaskSheet, { props: { open: false }, global: { plugins: [i18n] } })
}

async function openSheet(wrapper: VueWrapper): Promise<void> {
  await wrapper.setProps({ open: true })
  await flushPromises()
}

async function fillAndSubmit(
  wrapper: VueWrapper,
  input = { cwd: '/tmp/project-a', message: 'first message' },
): Promise<void> {
  await wrapper.get('[data-testid="new-task-cwd"]').setValue(input.cwd)
  await wrapper.get('[data-testid="new-task-message"]').setValue(input.message)
  await wrapper.get('[data-testid="new-task-submit"]').trigger('click')
  await flushPromises()
}

/** 幂等键观察边界：session.create RPC 第 7 参（端口适配器逐参透传，位置恒定） */
function submittedClientUuids(): Array<string | undefined> {
  return mocks_m2.create.mock.calls.map((call) => call[6] as string | undefined)
}

beforeEach(() => {
  i18n.global.locale.value = 'zh-CN'
  sessionStore.applySnapshot({ groups: [] })
  sessionStore.setActiveId(null)
  for (const fn of Object.values(mocks_m2)) fn.mockClear()
})

describe('A17 创建流幂等键（per-open 黏滞槽）', () => {
  it('提交失败后重试复用同一 clientUuid（同意图重试不换键，禁 per-call 生成）', async () => {
    const wrapper = mountSheet()
    await openSheet(wrapper)

    mocks_m2.create.mockRejectedValueOnce(new Error('RPC_TIMEOUT'))
    await fillAndSubmit(wrapper)
    expect(wrapper.get('[data-testid="new-task-error"]').text()).toContain('RPC_TIMEOUT')

    // 用户在失败后原样重试（弱网超时场景）：runtime 按 clientUuid 幂等返回已建 session，
    // 键更换即双建——重试路径不得重新生成
    await fillAndSubmit(wrapper)

    const uuids = submittedClientUuids()
    expect(uuids).toHaveLength(2)
    expect(uuids[0]).toMatch(UUID_SHAPE)
    expect(uuids[1]).toBe(uuids[0])
    wrapper.unmount()
  })

  it('提交成功后槽重置：表单未关窗口内的再次提交携带新键', async () => {
    const wrapper = mountSheet()
    await openSheet(wrapper)

    mocks_m2.create.mockResolvedValueOnce(makeSummary_m2({ id: 's-1', lastActiveAt: 1000 }))
    await fillAndSubmit(wrapper)
    expect(wrapper.emitted('created')).toHaveLength(1)

    // 父组件尚未响应 close 的窗口内再次提交 = 新意图，不得复用已消费的键
    mocks_m2.create.mockResolvedValueOnce(makeSummary_m2({ id: 's-2', lastActiveAt: 2000 }))
    await fillAndSubmit(wrapper)

    const uuids = submittedClientUuids()
    expect(uuids).toHaveLength(2)
    expect(uuids[0]).toMatch(UUID_SHAPE)
    expect(uuids[1]).toMatch(UUID_SHAPE)
    expect(uuids[1]).not.toBe(uuids[0])
    wrapper.unmount()
  })

  it('关闭表单后槽重置：跨关闭窗口的重试不复用上一意图的键', async () => {
    const wrapper = mountSheet()
    await openSheet(wrapper)

    mocks_m2.create.mockRejectedValueOnce(new Error('RPC_TIMEOUT'))
    await fillAndSubmit(wrapper)
    const [failedUuid] = submittedClientUuids()
    expect(failedUuid).toMatch(UUID_SHAPE)

    // 关闭（放弃重试）→ 重新打开 = 新意图：失败意图保留的槽不得跨关闭存活
    await wrapper.setProps({ open: false })
    await flushPromises()
    await openSheet(wrapper)

    mocks_m2.create.mockResolvedValueOnce(makeSummary_m2({ id: 's-3', lastActiveAt: 3000 }))
    await fillAndSubmit(wrapper)

    const uuids = submittedClientUuids()
    expect(uuids).toHaveLength(2)
    expect(uuids[1]).toMatch(UUID_SHAPE)
    expect(uuids[1]).not.toBe(failedUuid)
    wrapper.unmount()
  })
})

// ======================================================================
// ← truncated-history.test.ts
// ======================================================================

const { getHistoryMock } = vi.hoisted(() => ({ getHistoryMock: vi.fn() }))

// chat 域并集 mock 见簇首（session-list 节顶部）。

const SID = 'sid-truncated-history'

function userMsg(id: string, text: string, piEntryId?: string): Message {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    status: 'complete',
    timestamp: Date.now(),
    ...(piEntryId ? { piEntryId } : {}),
  }
}

function assistantMsg(id: string, text: string): Message {
  return { id, role: 'assistant', content: text, status: 'complete', timestamp: Date.now() }
}

/** 既有最近一窗（user 带文件侧 piEntryId——游标锚）+ 更早一页（点击后的 RPC 应答） */
const RECENT: Message[] = [
  userMsg('recent-1', 'recent-question', 'entry-recent-1'),
  assistantMsg('recent-2', 'recent-answer'),
]
const EARLIER: Message[] = [
  userMsg('earlier-1', 'earlier-question', 'entry-earlier-1'),
  assistantMsg('earlier-2', 'earlier-answer'),
]
const PAGE_REPLY = { messages: EARLIER, truncated: false, loadedTurns: 3, totalTurnsEstimate: 5 }

function mountStream(): VueWrapper {
  return mount(MobileMessageStream, {
    props: { sessionId: SID },
    global: { plugins: [i18n] },
  })
}

/** 冲净微任务 + 一轮宏任务（loadMoreHistory 内 await RPC + nextTick 的完整链） */
async function settle(): Promise<void> {
  await flushPromises()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function barOf(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="truncated-history-bar"]')
}

function loadMoreBtnOf(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="load-more-history"]')
}

beforeEach(() => {
  resetChatModuleStateForTest()
  chatStore.disposeSession(SID)
  getHistoryMock.mockReset().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
})

describe('MobileMessageStream 加载更早（A2 / U11）', () => {
  it('验收① 点击「加载更早」→ 游标翻页前插更早轮次；truncated=false 页收敛后顶部条消失', async () => {
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    getHistoryMock.mockResolvedValue(PAGE_REPLY)
    const wrapper = mountStream()
    await settle()

    expect(loadMoreBtnOf(wrapper).exists()).toBe(true)
    await loadMoreBtnOf(wrapper).trigger('click')
    await settle()

    // 游标 = 分区最旧消息的文件侧身份（piEntryId ?? id）——core 游标翻页契约
    expect(getHistoryMock).toHaveBeenCalledTimes(1)
    expect(getHistoryMock).toHaveBeenCalledWith(SID, { cursor: 'entry-recent-1' })
    // 分区前插：更早轮次在分区头部（构建者白盒视角）
    const partition = chatStore.getMessages(SID)
    expect(partition[0]?.id).toBe('earlier-1')
    expect(partition[1]?.id).toBe('earlier-2')
    expect(partition[2]?.id).toBe('recent-1')
    // DOM 前插序：更早问题排在既有最近问题之前（使用者视角）
    const text = wrapper.text()
    expect(text).toContain('earlier-question')
    expect(text.indexOf('earlier-question')).toBeLessThan(text.indexOf('recent-question'))
    // 页 truncated=false → 窗口收敛 → 顶部条结构性消失（翻页到头语义）
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('验收② 非贴底阅读态前插后 scrollTop += 高度增量（滚动位置不跳）', async () => {
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    const wrapper = mountStream()
    await settle()

    // happy-dom 无布局：桩定滚动几何，可写变量模拟「前插使 scrollHeight 1000→1800」
    const el = wrapper.find('[data-testid="mobile-message-stream"]').element as HTMLElement
    let scrollHeight = 1000
    let scrollTopValue = 0
    Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => 400, configurable: true })
    Object.defineProperty(el, 'scrollTop', {
      get: () => scrollTopValue,
      set: (v: number) => {
        scrollTopValue = v
      },
      configurable: true,
    })
    scrollTopValue = 100 // 上翻阅读态：距底 500px
    await wrapper.find('[data-testid="mobile-message-stream"]').trigger('scroll')
    expect(chatStore.getHistoryWindow(SID)?.truncated).toBe(true)

    // 前插落 DOM 后 scrollHeight 增高（真实浏览器下 nextTick 后才可读）
    getHistoryMock.mockImplementation(async () => {
      scrollHeight = 1800
      return PAGE_REPLY
    })
    await loadMoreBtnOf(wrapper).trigger('click')
    await settle()

    // 锚定补偿：scrollTop += 增量（800）→ 视口正在读的内容原位不动
    expect(scrollTopValue).toBe(900)
    wrapper.unmount()
  })

  it('验收② 加载中防重入：pending 期按钮禁用 + 重复点击只走一次翻页通路', async () => {
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    let resolveRpc!: (v: typeof PAGE_REPLY) => void
    getHistoryMock.mockImplementation(
      () => new Promise<typeof PAGE_REPLY>((resolve) => (resolveRpc = resolve)),
    )
    const wrapper = mountStream()
    await settle()

    await loadMoreBtnOf(wrapper).trigger('click')
    expect(loadMoreBtnOf(wrapper).attributes('disabled')).toBeDefined()
    await loadMoreBtnOf(wrapper).trigger('click')
    expect(getHistoryMock).toHaveBeenCalledTimes(1)

    resolveRpc(PAGE_REPLY)
    await settle()
    expect(getHistoryMock).toHaveBeenCalledTimes(1)
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('验收③ 截断窗口状态驱动显隐：无记录/false 不渲染，true 渲染，响应式翻转即消失', async () => {
    // 无窗口记录（未 hydrate / 已清理）= 无截断 → 结构性不渲染
    chatStore.hydrate(SID, RECENT)
    let wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()

    // truncated=false（全量窗口）→ 不渲染（A6 回归：普通 session 无截断提示）
    chatStore.disposeSession(SID)
    chatStore.hydrate(SID, RECENT, { truncated: false, loadedTurns: 2, totalTurnsEstimate: 2 })
    wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()

    // truncated=true → 条可见：N = loadedTurns + 「加载更早」入口（文案经 ui locale 单源）
    chatStore.disposeSession(SID)
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(true)
    const expectedInfo = i18n.global.t('panel.message.loadedRecentTurns', { count: 2 })
    expect(wrapper.find('[data-testid="truncated-history-info"]').text()).toBe(expectedInfo)
    expect(loadMoreBtnOf(wrapper).text()).toContain(i18n.global.t('panel.message.loadEarlier'))

    // 响应式翻转：窗口状态置 false → 条即时消失（状态驱动，非仅挂载期快照）
    chatStore.setHistoryWindow(SID, { truncated: false, loadedTurns: 5, totalTurnsEstimate: 5 })
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('验收③ 消息分区为空时不渲染顶部条（无可翻页游标，对齐桌面 renderItems 条件）', async () => {
    chatStore.hydrate(SID, [], { truncated: true, loadedTurns: 0, totalTurnsEstimate: 3 })
    const wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })
})

// ======================================================================
// ← queue-strip.test.ts
// ======================================================================

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { cancelDeliveryMock } = vi.hoisted(() => ({ cancelDeliveryMock: vi.fn() }))

// chat 域并集 mock 见簇首（session-list 节顶部）。

/** ComposerInput stub 的 expose spy（消费 API 断言范围；仅「端到端回填」组消费）。
 *  经 vi.hoisted 创建：合并产物里本段晚于文件头 import 执行，工厂求值时 body 层 const 尚未初始化。 */
const inputCalls = vi.hoisted(() => ({ insertTextAtCursor: vi.fn() }))

vi.mock('@taiji/ui/features/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/ui/features/composer')>()
  // 工厂求值时机早于文件头 `import { defineComponent, h } from 'vue'`（本段在合并产物中晚于
  // 组件 import），故在工厂内动态取 vue 绑定。
  const { defineComponent, h } = await import('vue')
  return {
    ...actual,
    ComposerInput: defineComponent({
      name: 'ComposerInputStub',
      setup(_, { expose }) {
        expose({
          insertTextAtCursor: inputCalls.insertTextAtCursor,
          // 发送键路径的只读口（本测不触发送，给空实现防 undefined 调用）
          getText: () => '',
          getSegments: () => [],
        })
        return () => h('div', { role: 'textbox' })
      },
    }),
  }
})

const SID_m2 = 'sid-queue-strip'

function entry(
  clientUuid: string,
  state: DeliveryFrameEntry['state'],
  lane: DeliveryFrameEntry['lane'],
  preview = clientUuid,
): DeliveryFrameEntry {
  return { clientUuid, preview, state, lane }
}

/** 写 core 派生视图（state topic last-value 语义：每帧整体替换） */
function setProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const ref = getDeliveryProjectionRef()
  const next = new Map(ref.value)
  next.set(sid, entries)
  ref.value = next
}

function mountStrip(sessionId = SID_m2) {
  return mount(QueueStrip, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}

function rowsOf(wrapper: ReturnType<typeof mountStrip>) {
  return wrapper.findAll('[data-testid="mobile-queue-row"]')
}

function tOf(key: string, params?: Record<string, unknown>): string {
  return (i18n.global.t as (key: string, params?: Record<string, unknown>) => string)(key, params)
}

beforeEach(() => {
  resetChatModuleStateForTest()
  cancelDeliveryMock.mockReset()
  inputCalls.insertTextAtCursor.mockClear()
  composerInjectionStore.clearInjection()
})

// ── 验收①：排队条目渲染（消费 core 谓词非本地重写）─────────────────────────

describe('QueueStrip 条目渲染（D7 验收①：core 谓词单源）', () => {
  it('行集合 = core deliveryQueueEntries 谓词输出：非 direct 且未 delivered 三态可见、帧序保持、preview 直显', () => {
    setProjection(SID_m2, [
      entry('d1', 'in-flight', 'direct', 'direct 气泡原位'), // direct 投递路径：乐观气泡原位保留 → 不进队列条
      entry('q1', 'queued', 'queued', '排队消息甲'),
      entry('f1', 'in-flight', 'steer', '投递中消息乙'),
      entry('x1', 'delivered', 'steer', '已入流消息'), // delivered：transcript 权威已入流 → 隐去
      entry('q2', 'failed', 'queued', '失败消息丙'),
    ])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(3)
    // 帧序 = 内核 FIFO 发送序（谓词只过滤不重排）
    expect(rows[0]!.text()).toContain('排队消息甲')
    expect(rows[1]!.text()).toContain('投递中消息乙')
    expect(rows[2]!.text()).toContain('失败消息丙')
    // 三态徽标可见（使用者视角：状态可区分）
    expect(wrapper.find('[data-testid="mobile-queue-state-queued"]').text()).toBe(
      tOf('mobile.queueStrip.stateQueued'),
    )
    expect(wrapper.find('[data-testid="mobile-queue-state-in-flight"]').text()).toBe(
      tOf('mobile.queueStrip.stateInFlight'),
    )
    expect(wrapper.find('[data-testid="mobile-queue-state-failed"]').text()).toBe(
      tOf('mobile.queueStrip.stateFailed'),
    )
    // direct / delivered 条目结构性不在渲染集（text 全域不含）
    expect(wrapper.text()).not.toContain('direct 气泡原位')
    expect(wrapper.text()).not.toContain('已入流消息')
    wrapper.unmount()
  })

  it('空派生视图 / 无分区 → 结构性不渲染（无占位空态，随派生视图帧出现/收敛即时翻转）', async () => {
    const wrapper = mountStrip()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(false)

    // 派生视图帧到达 → 条即时出现（响应式，非仅挂载期快照）
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(true)
    expect(rowsOf(wrapper)).toHaveLength(1)

    // 下一帧全量收敛（delivered → 队列区隐去）→ 条结构性消失
    setProjection(SID_m2, [entry('q1', 'delivered', 'queued', '排队消息')])
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('跨会话分区隔离：只渲染 props.sessionId 的派生视图分区', () => {
    setProjection('sid-other', [entry('q0', 'queued', 'queued', '别的会话排队')])
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '本会话排队')])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('本会话排队')
    expect(wrapper.text()).not.toContain('别的会话排队')
    wrapper.unmount()
  })
})

// ── 验收②：点取消调 delivery.cancel ────────────────────────────────────────

describe('QueueStrip 取消（D7 验收②：delivery.cancel 出口）', () => {
  it('点取消钮 → delivery.cancel(sid, clientUuid)（app-runtime 透传出口命中 transport mock）', async () => {
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(cancelDeliveryMock).toHaveBeenCalledTimes(1)
    expect(cancelDeliveryMock).toHaveBeenCalledWith(SID_m2, 'q1')
    wrapper.unmount()
  })

  it('取消在途防重入：pending 期取消钮禁用，重复点击只走一次 RPC', async () => {
    let resolveRpc!: (v: { clientUuid: string; cancelled: boolean; content: string }) => void
    cancelDeliveryMock.mockImplementation(
      () => new Promise((resolve) => (resolveRpc = resolve)),
    )
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    expect(
      rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').attributes('aria-disabled'),
    ).toBe('true')
    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    expect(cancelDeliveryMock).toHaveBeenCalledTimes(1)

    resolveRpc({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    await flushPromises()
    expect(
      rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').attributes('aria-disabled'),
    ).toBe('false')
    wrapper.unmount()
  })

  it('不可撤（cancelled=false）→ 内联错误行可见（不静默），不写注入槽位', async () => {
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: false, reason: 'already delivered' })
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    const errLine = wrapper.find('[data-testid="mobile-queue-strip-error"]')
    expect(errLine.exists()).toBe(true)
    expect(errLine.attributes('role')).toBe('alert')
    expect(errLine.text()).toBe(
      tOf('mobile.queueStrip.cancelUnavailableWithReason', { reason: 'already delivered' }),
    )
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    wrapper.unmount()
  })
})

// ── 验收③：取消成功后草稿回填 ─────────────────────────────────────────────

describe('QueueStrip 草稿回填（D7 验收③：全文回输入框）', () => {
  it('取消成功 → 注入槽位收到 { target:current, sessionId, text=全文 }（消费端通道写入侧）', async () => {
    const segments = [{ type: 'text' as const, text: '被撤销的文本' }]
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本', segments })
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    const pending = composerInjectionStore.pendingInjection.value
    expect(pending).not.toBeNull()
    expect(pending!.target).toBe('current')
    expect(pending!.sessionId).toBe(SID_m2)
    expect(pending!.text).toBe('被撤销的文本')
    wrapper.unmount()
  })

  it('槽位已有同会话待消费文本 → 追加不覆盖（\\n\\n 累积，桌面 restoreToDraft 同款）', async () => {
    composerInjectionStore.requestInjection({ target: 'current', sessionId: SID_m2, text: '正在输入的内容' })
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(composerInjectionStore.pendingInjection.value!.text).toBe('正在输入的内容\n\n被撤销的文本')
    wrapper.unmount()
  })

  it('槽位残留他分会话文本 → 覆盖不累积（跨会话槽位串文本是错误语义）', async () => {
    composerInjectionStore.requestInjection({ target: 'current', sessionId: 'sid-stale', text: '别的会话残留' })
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(composerInjectionStore.pendingInjection.value!.text).toBe('被撤销的文本')
    expect(composerInjectionStore.pendingInjection.value!.sessionId).toBe(SID_m2)
    wrapper.unmount()
  })

  it('cancelled=true 但 content 缺失/空白（runtime 契约违规）→ 出声不静默，不写槽位', async () => {
    cancelDeliveryMock.mockResolvedValueOnce({ clientUuid: 'q1', cancelled: true })
    cancelDeliveryMock.mockResolvedValueOnce({ clientUuid: 'q2', cancelled: true, content: '   ' })
    setProjection(SID_m2, [
      entry('q1', 'queued', 'queued', '无全文条目'),
      entry('q2', 'queued', 'queued', '空白全文条目'),
    ])
    const wrapper = mountStrip()

    const rows = rowsOf(wrapper)
    await rows[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="mobile-queue-strip-error"]').text()).toBe(
      tOf('mobile.queueStrip.restoreContentMissing'),
    )
    expect(composerInjectionStore.pendingInjection.value).toBeNull()

    await rows[1]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    wrapper.unmount()
  })

  it('RPC 失败 → 内联错误行（含原因，用户可重试），不写槽位', async () => {
    cancelDeliveryMock.mockRejectedValue(new Error('ws disconnected'))
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])
    const wrapper = mountStrip()

    await rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="mobile-queue-strip-error"]').text()).toBe(
      tOf('mobile.queueStrip.cancelFailed', { msg: 'ws disconnected' }),
    )
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    // 失败后取消钮恢复可用（可重试）
    expect(
      rowsOf(wrapper)[0]!.get('[data-testid="mobile-queue-cancel"]').attributes('aria-disabled'),
    ).toBe('false')
    wrapper.unmount()
  })

  it('端到端：取消成功 → MobileComposer 消费端 insertTextAtCursor(text) 落输入框 + 槽位清空（一次性通道封住）', async () => {
    cancelDeliveryMock.mockResolvedValue({ clientUuid: 'q1', cancelled: true, content: '被撤销的文本' })
    setProjection(SID_m2, [entry('q1', 'queued', 'queued', '排队消息')])

    // 消费端先挂载（watch 注册 + onMounted 补检查），写入发生在挂载之后 → watch 时序
    const composer = mount(MobileComposer, {
      props: { sessionId: SID_m2 },
      global: { plugins: [i18n] },
    })
    const strip = mountStrip()
    await flushPromises()
    expect(inputCalls.insertTextAtCursor).not.toHaveBeenCalled()

    await rowsOf(strip)[0]!.get('[data-testid="mobile-queue-cancel"]').trigger('click')
    await flushPromises()

    expect(inputCalls.insertTextAtCursor).toHaveBeenCalledTimes(1)
    expect(inputCalls.insertTextAtCursor).toHaveBeenCalledWith('被撤销的文本')
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    composer.unmount()
    strip.unmount()
  })

  it('端到端：他分会话的注入请求不消费（sessionId 匹配门——取消 A 会话条目不落 B 会话输入框）', async () => {
    setProjection(SID_m2, [])
    const composer = mount(MobileComposer, {
      props: { sessionId: 'sid-b' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    composerInjectionStore.requestInjection({ target: 'current', sessionId: SID_m2, text: 'A 会话的文本' })
    await flushPromises()

    expect(inputCalls.insertTextAtCursor).not.toHaveBeenCalled()
    expect(composerInjectionStore.pendingInjection.value!.text).toBe('A 会话的文本')
    composer.unmount()
  })
})
