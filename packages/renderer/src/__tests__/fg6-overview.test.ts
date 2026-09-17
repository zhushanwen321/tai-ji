/**
 * FG6 自检 —— Overview 进入/退出语义 + sessionDigest 派生 + formatTime 纯函数。
 *
 * 覆盖 spec §8.5 v1 必做项：
 * - Overview 进入（nav.push view:'overview'）
 * - 基本退出（back 回 chat view；canBack 守卫：栈空 no-op）
 * - 点卡片载入 session（selectSession → push chat + activeId）
 * - sessionDigest：末条 assistant 文本 + 回合计数（空 session 摘要为空）
 * - formatRelativeTime 四个分桶（今天/昨天/7 天内/更早）
 *
 * useSidebar 走 @/api 门面，测试用 vi.mock 替换为 mock 实现（避免 transport 挂起）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/fg6-overview.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as mockApi from '@taiji/core/transport/mock'
import { useChatStore } from '@/stores/chat'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useChat } from '@/composables/features/chat/useChat'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import { formatRelativeTime } from '@/composables/logic/formatTime'

/** useSidebar 经 @/api 门面调真实 transport 会挂起；测试统一替成 mock 实现。
 *  selectSession 触发 loadTree（文件树预加载，并行拉 file.tree + git.status），补 file/git domain mock 避免 unhandled rejection。 */
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  session: mockApi.session,
  chat: mockApi.chat,
  file: mockApi.file,
  git: mockApi.git,
}))

const HOUR = 3_600_000
const DAY = 86_400_000

describe('FG6 Overview 进入/退出 + sessionDigest', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('Overview 进入：goOverview push view:overview，current.view 切换', () => {
    const navigation = useNavigationStore()
    const { goOverview } = useSidebar()
    expect(navigation.current.view).toBe('chat')
    goOverview()
    expect(navigation.current.view).toBe('overview')
  })

  it('基本退出：back 回上一个 chat view', () => {
    const navigation = useNavigationStore()
    const { goOverview } = useSidebar()
    navigation.push({ view: 'chat', sessionId: 's1' })
    goOverview()
    expect(navigation.current.view).toBe('overview')
    expect(navigation.canBack).toBe(true)
    navigation.back()
    expect(navigation.current.view).toBe('chat')
    expect(navigation.current.sessionId).toBe('s1')
  })

  it('canBack 守卫：栈空时 back 不越界（仍停在 overview）', () => {
    const navigation = useNavigationStore()
    const { goOverview } = useSidebar()
    goOverview()
    expect(navigation.canBack).toBe(false)
    navigation.back() // 栈空 no-op
    expect(navigation.current.view).toBe('overview')
  })

  it('点卡片载入 session：selectSession push chat + 更新 activeId + focusedSessionId', async () => {
    const navigation = useNavigationStore()
    const session = useSessionStore()
    const { selectSession, focusedSessionId } = useSidebar()
    await selectSession('s1')
    expect(navigation.current.view).toBe('chat')
    expect(navigation.current.sessionId).toBe('s1')
    expect(session.activeId).toBe('s1')
    // Overview.vue 卡片高亮 SSOT = focusedSessionId（从 panel.activePanelId 派生）。
    // selectSession → syncSessionToPanel → loadSession(activePanel, 's1') → focusedSessionId 跟随。
    expect(focusedSessionId.value).toBe('s1')
  }, 10_000)

  it('已 hydrate 二次切入：reconcile 同步刷新 truncated 标记（load-more 可恢复）', async () => {
    // [truncated-refresh] 对齐 core a3b54bc08：已 hydrate 分支的 reconcile（[u6] 窗口响应
    // 仅合并覆盖最近窗口），响应 truncated=true 时标记须重置（按钮重显），false 时清除。
    const historySpy = vi
      .spyOn(mockApi.chat, 'getHistory')
      .mockResolvedValue({ messages: [], truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    const { selectSession } = useSidebar()
    await selectSession('s1') // 首进 hydrate
    await selectSession('s1') // 已 hydrate 切入 → else 分支 reconcile + 标记刷新
    expect(useChat().hasMoreHistory('s1')).toBe(true)

    historySpy.mockResolvedValue({ messages: [], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await selectSession('s1')
    expect(useChat().hasMoreHistory('s1')).toBe(false)

    historySpy.mockRestore()
    // 清截断窗口状态，避免污染后续用例（[u4d] SSOT 在 chat store 截断窗口状态）
    useChatStore().clearHistoryWindow('s1')
  }, 10_000)

  it('sessionDigest：s1 fixture 末条 assistant 摘要 + 回合计数', async () => {
    const { selectSession } = useSidebar()
    const { sessionDigest } = useSessionDerivations()
    await selectSession('s1')
    const digest = sessionDigest('s1').value
    // fixture s1 有 2 个 user 回合，末条 assistant 为「提交时遇到文件锁…」
    expect(digest.turnCount).toBe(2)
    expect(digest.summary).toContain('文件锁')
  }, 10_000)

  it('sessionDigest：空 session（s3）摘要为空、回合 0', () => {
    const chat = useChatStore()
    const { sessionDigest } = useSessionDerivations()
    chat.hydrate('s3', [])
    const digest = sessionDigest('s3').value
    expect(digest.summary).toBe('')
    expect(digest.turnCount).toBe(0)
  })

  it('sessionDigest：error 收尾的 session 摘要取 msg.error 文案（M2 形态 content 恒空）', () => {
    const chat = useChatStore()
    const { sessionDigest } = useSessionDerivations()
    chat.hydrate('s-err', [
      { id: 'u1', role: 'user', content: 'go', timestamp: Date.now() },
      // [M2] 错误收尾形态：content 空、错误文本只住 error 字段
      { id: 'a1', role: 'assistant', content: '', error: 'extension load failed', status: 'error', timestamp: Date.now() },
    ])
    const digest = sessionDigest('s-err').value
    // 摘要语义 = session 怎么收尾：error 收尾必须显示错误文案，空串会丢失关键信息
    expect(digest.summary).toBe('extension load failed')
    expect(digest.turnCount).toBe(1)
    // 有正文的 complete 收尾不受影响（content 优先）
    chat.hydrate('s-ok', [
      { id: 'u2', role: 'user', content: 'go', timestamp: Date.now() },
      { id: 'a2', role: 'assistant', content: 'all done', status: 'complete', timestamp: Date.now() },
    ])
    expect(sessionDigest('s-ok').value.summary).toBe('all done')
  })
})

describe('formatRelativeTime 四分桶', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T14:30:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('今天 → HH:MM', () => {
    const now = Date.now()
    expect(formatRelativeTime(now)).toMatch(/^\d{2}:\d{2}$/)
    expect(formatRelativeTime(now - 2 * HOUR)).toMatch(/^\d{2}:\d{2}$/)
  })

  it('昨天 → 「昨天」', () => {
    expect(formatRelativeTime(Date.now() - DAY - HOUR)).toBe('昨天')
  })

  it('7 天内 → 「N 天前」', () => {
    expect(formatRelativeTime(Date.now() - 3 * DAY)).toBe('3 天前')
  })

  it('更早 → 「M 月 D 日」', () => {
    const ts = new Date('2026-05-01T10:00:00Z').getTime()
    expect(formatRelativeTime(ts)).toMatch(/月.*日$/)
  })
})
