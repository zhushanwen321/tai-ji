/**
 * [session-dead 结构性修复 D3] useSidebarSessionActions.onForceQuitSession 队列回收编排测试。
 *
 * 设计 D3（docs/design/session-dead-structural-fixes.md——已删除，git 可追溯——§3.3）：forceQuit 两段确认（SessionItem
 * 内，不在本测试面）成功后——
 *  - 行为 1（队列清空）：compactQueue.drain 整队回收（含已提交在途条目），count 归零
 *  - 行为 2（草稿回收）：回收文本经 composer injection 一次性通道写回（target='current' +
 *    text 通道——消费端 insertTextAtCursor 光标插入，不覆盖既有草稿；多条按序 '\n\n' 拼接）
 *  - 行为 3（追加/不覆盖）：消费端组件层断言见 __tests__/panel/force-quit-draft-recovery-dom.test.ts
 *  - [F-U2] 累积追加（写入侧）：槽位是单值覆盖通道，回收写入前读槽位现状 '\n\n' 追加，
 *    防「forceQuit 后、restore 前」窗口内其他注入（drawer / 另一 session forceQuit）覆盖
 *    丢失已宣称收回的文本；槽位无 text 时行为不变（FQ-1 锁定）
 *  - 提示：toast「N 条排队消息已收回草稿」（N=0 不提示）
 *  - 配套：core clearDeferFlushRetryTimer 清 1s 重投 timer + 失败计数（timer 行为本体在
 *    core __tests__/force-quit-defer-recovery.test.ts）
 *  - 配套 [session-dead G1]：core clearQueueState 清 pi queue_update 快照（steer 气泡随 pi
 *    死亡作废，restore 后无 queue_update 帧再清——不清则气泡永久残留；store 层行为本体在
 *    core __tests__/store.test.ts clearQueueState describe）
 *  - 挂点分型（设计 D4）：仅用户显式强制退出入口编排回收；forceQuit RPC 失败（error envelope）
 *    不回收不提示（保持既有 toastError）
 *
 * 环境：真 useCompactQueue / composerInjectionStore 单例（断言面），mock useChat（编排接线
 * 断言 clearDeferFlushRetryTimer 调用）+ '@/api'（forceQuit RPC）+ toast（捕获提示）+ 侧栏
 * 外围 store（对齐 sidebar-ondeletefolder.test.ts 范式降级）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/force-quit-queue-recovery.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const apiMock = vi.hoisted(() => ({
  forceQuit: vi.fn().mockResolvedValue(undefined),
}))
const chatComposable = vi.hoisted(() => ({
  clearDeferFlushRetryTimer: vi.fn(),
  clearQueueState: vi.fn(),
}))
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@/api', () => ({
  session: { forceQuit: apiMock.forceQuit },
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    abort: vi.fn(),
    clearDeferFlushRetryTimer: chatComposable.clearDeferFlushRetryTimer,
    clearQueueState: chatComposable.clearQueueState,
  }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastMocks.error, info: toastMocks.info, warning: toastMocks.warning }),
}))
vi.mock('@/composables/features/search/useSearchModalDeps', () => ({
  useSearchModalDeps: () => ({}),
}))
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ list: [], active: undefined, applySnapshot: vi.fn() }),
}))
vi.mock('@/stores/subagent', () => ({
  useSubagentStore: () => ({ loadSubagents: vi.fn() }),
}))
vi.mock('@/stores/workflow', () => ({
  useWorkflowStore: () => ({ loadWorkflows: vi.fn() }),
}))

import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

/** Host 组件：setup 内实例化被测 composable（useI18n/useCompactQueue 需组件上下文） */
function mountActionsHost(): { actions: ReturnType<typeof useSidebarSessionActions>; unmount: () => void } {
  let captured: ReturnType<typeof useSidebarSessionActions> | undefined
  const Host = defineComponent({
    setup() {
      captured = useSidebarSessionActions({
        focusedSessionId: ref(null),
        selectSession: vi.fn().mockResolvedValue(undefined),
        restoreSession: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn().mockResolvedValue(null),
        goOverview: vi.fn(),
        loadSessions: vi.fn(),
        renameSession: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        deleteFolder: vi.fn().mockResolvedValue({ failed: [] }),
        assignSessionToProject: vi.fn().mockResolvedValue(undefined),
        renameOpen: ref(false),
        targetSessionId: ref(''),
      })
      return () => null
    },
  })
  const wrapper = mount(Host)
  return { actions: captured!, unmount: () => wrapper.unmount() }
}

const wrappers: Array<{ unmount: () => void }> = []

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMock.forceQuit.mockResolvedValue(undefined)
  // 队列单例首次创建需 effect scope（useSessionScopedState 的 onScopeDispose 注册），
  // 预热后 scope 不 stop（单例跨用例共享，对齐 use-compact-queue.test.ts beforeEach）
  const queueScope = effectScope()
  queueScope.run(() => {
    useCompactQueue()
  })
  // 队列单例分区跨用例清理 + 注入槽位清空（模块级单例无自动隔离）
  useCompactQueue()._clearAllForTest()
  composerInjectionStore.clearInjection()
})

afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
})

describe('onForceQuitSession 队列回收编排（session-dead D3）', () => {
  it('FQ-1: 成功后清空队列 + 草稿回收（按序拼接）+ 清重投状态 + 提示 N 条', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', '第一条排队消息')
    queue.enqueue('s1', '第二条排队消息')
    const { actions, unmount } = mountActionsHost()
    wrappers.push({ unmount })

    await actions.onForceQuitSession('s1')

    expect(apiMock.forceQuit).toHaveBeenCalledWith('s1')
    // 配套：core 重投 timer + 失败计数清理（1s 重投脉冲随队列回收失效）
    expect(chatComposable.clearDeferFlushRetryTimer).toHaveBeenCalledWith('s1')
    // 配套 [session-dead G1]：清 pi queue_update 快照（steer 气泡随 pi 死亡作废，restore 后无帧再清）
    expect(chatComposable.clearQueueState).toHaveBeenCalledWith('s1')
    // 行为 1：队列清空
    expect(queue.count('s1')).toBe(0)
    // 行为 2：草稿回收——注入槽位按序拼接文本（消费端光标插入 = 追加语义，见 DOM 测试）
    expect(composerInjectionStore.pendingInjection.value).toMatchObject({
      target: 'current',
      sessionId: 's1',
      text: '第一条排队消息\n\n第二条排队消息',
    })
    // 提示：「N 条排队消息已收回草稿」（全局 i18n setup 按 zh-CN 渲染）
    expect(toastMocks.info).toHaveBeenCalledTimes(1)
    expect(toastMocks.info).toHaveBeenCalledWith('2 条排队消息已收回草稿')
  })

  it('FQ-2: forceQuit RPC 失败 → toastError、不回收不清重投状态（挂点分型：失败保持现状语义）', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', 'm1')
    apiMock.forceQuit.mockRejectedValueOnce(new Error('rpc down'))
    const { actions, unmount } = mountActionsHost()
    wrappers.push({ unmount })

    await actions.onForceQuitSession('s1')

    expect(toastMocks.error).toHaveBeenCalledWith('强制退出失败：rpc down')
    expect(queue.count('s1')).toBe(1)
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    expect(toastMocks.info).not.toHaveBeenCalled()
    expect(chatComposable.clearDeferFlushRetryTimer).not.toHaveBeenCalled()
    expect(chatComposable.clearQueueState).not.toHaveBeenCalled()
  })

  it('FQ-3: 空队列成功 → 清重投状态照常执行，无注入无提示（N=0 不提示）', async () => {
    const { actions, unmount } = mountActionsHost()
    wrappers.push({ unmount })

    await actions.onForceQuitSession('s1')

    expect(apiMock.forceQuit).toHaveBeenCalledWith('s1')
    expect(chatComposable.clearDeferFlushRetryTimer).toHaveBeenCalledWith('s1')
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    expect(toastMocks.info).not.toHaveBeenCalled()
  })

  it('FQ-4: 条目全为空白文本 → 队列清空并提示，但不向输入框注入空串', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', '   ')
    const { actions, unmount } = mountActionsHost()
    wrappers.push({ unmount })

    await actions.onForceQuitSession('s1')

    expect(queue.count('s1')).toBe(0)
    expect(composerInjectionStore.pendingInjection.value).toBeNull()
    expect(toastMocks.info).toHaveBeenCalledWith('1 条排队消息已收回草稿')
  })

  it('FQ-5 [F-U2]: 连续两次 forceQuit（不同 session）→ 槽位两批文本 \\n\\n 连接，前一批不丢失', async () => {
    const queue = useCompactQueue()
    queue.enqueue('s1', '第一批回收文本')
    const { actions, unmount } = mountActionsHost()
    wrappers.push({ unmount })

    await actions.onForceQuitSession('s1')
    expect(composerInjectionStore.pendingInjection.value).toMatchObject({
      target: 'current',
      sessionId: 's1',
      text: '第一批回收文本',
    })

    // 第一批尚未被消费（槽位滞留）时，另一 session 也 forceQuit——覆盖语义下第一批会丢失
    queue.enqueue('s2', '第二批回收文本')
    await actions.onForceQuitSession('s2')

    // 累积追加：两批文本 '\n\n' 连接，无丢失（目标路由 sessionId 随最后一批写入）
    expect(composerInjectionStore.pendingInjection.value).toMatchObject({
      target: 'current',
      sessionId: 's2',
      text: '第一批回收文本\n\n第二批回收文本',
    })
    expect(queue.count('s1')).toBe(0)
    expect(queue.count('s2')).toBe(0)
  })

  it('FQ-6 [F-U2]: 槽位已有未消费 text 注入时单次 forceQuit → 追加而非覆盖；槽位为空时行为不变（FQ-1）', async () => {
    // 预置一笔未消费注入（模拟其他来源的纯文本注入滞留槽位）
    composerInjectionStore.requestInjection({ target: 'current', sessionId: 's1', text: '槽位既有文本' })

    const queue = useCompactQueue()
    queue.enqueue('s1', '回收文本')
    const { actions, unmount } = mountActionsHost()
    wrappers.push({ unmount })

    await actions.onForceQuitSession('s1')

    expect(composerInjectionStore.pendingInjection.value).toMatchObject({
      target: 'current',
      sessionId: 's1',
      text: '槽位既有文本\n\n回收文本',
    })
  })
})
