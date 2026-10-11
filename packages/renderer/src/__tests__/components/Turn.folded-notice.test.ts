/**
 * Turn.vue 收纳完成通知编排测试（specs/chat/system-notices.md §3，bg-notice-fold-into-meta）。
 *
 * 覆盖（renderer i18n setup 回真实 zh 文案——vitest-i18n-setup.ts）：
 * - 落成态 + foldedNotices → 展开区首行起渲染收纳明细行（类型词 / 摘要 / 状态 / 任务 id，
 *   成功 dim / 失败 warn 的用户可见 DOM）
 * - 工作态 + foldedNotices → bash 结构化行以临时外部行渲染（inline），明细行不渲染
 * - trigger 起点聚合行仅工作态渲染（settle 后数据收进轮头行，独立行退役）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/Turn.folded-notice.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { shallowMount } from '@vue/test-utils'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { Message } from '@taiji/shared'
import { Turn } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

function assistantMsg(id: string): Message {
  return { id, role: 'assistant', content: 'done', segments: [], status: 'complete', createdAt: Date.now() } as unknown as Message
}

/** background-bash 结构化完成通知（details 经 shared 解析器命中） */
function bashDoneMsg(id: string, exitCode = 0): Message {
  return {
    id,
    role: 'system',
    content: `后台命令已完成（exit ${exitCode}）`,
    status: 'complete',
    timestamp: 0,
    details: { taskId: `task-${id}`, command: `cmd-${id}`, durationMs: 1500, endReason: 'natural', exitCode },
  } as unknown as Message
}

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: null,
    assistants: [assistantMsg('a-1')],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  }
}

function mountTurn(turn: MessageTurn, opts: { expanded?: boolean; isSessionActive?: boolean; isLastTurn?: boolean } = {}) {
  return shallowMount(Turn, {
    props: {
      turn,
      sessionId: 'test-session',
      isSessionActive: opts.isSessionActive ?? false,
      isLastTurn: opts.isLastTurn ?? true,
    },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide({ isExpanded: () => opts.expanded ?? true }),
    },
  })
}

describe('Turn 收纳完成通知（specs/chat/system-notices.md §3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('落成态展开：明细行首行起逐条渲染（类型词 / 摘要 / exit 状态 / 任务 id），到达序保持', () => {
    const wrapper = mountTurn(makeTurn({
      foldedNotices: [bashDoneMsg('b1', 0), bashDoneMsg('b2', 2)],
    }))
    const detail = wrapper.find('[data-testid="turn-folded-notices"]')
    expect(detail.exists()).toBe(true)
    const rows = wrapper.findAll('[data-testid="turn-folded-notice-bash"]')
    expect(rows).toHaveLength(2)
    // 类型词（真实 zh 文案）+ 命令摘要 + 任务 id（用户可见 DOM 断言）
    expect(rows[0].text()).toContain('后台任务')
    expect(rows[0].text()).toContain('cmd-b1')
    expect(rows[0].text()).toContain('task-b1')
    expect(rows[1].text()).toContain('cmd-b2')
    // 状态列：exit 0（成功 dim）/ exit 2（失败 warn，不依赖 hover）
    const statuses = wrapper.findAll('[data-testid="turn-folded-notice-status"]')
    expect(statuses[0].text()).toBe('exit 0')
    expect(statuses[0].classes()).not.toContain('text-warn')
    expect(statuses[1].text()).toBe('exit 2')
    expect(statuses[1].classes()).toContain('text-warn')
  })

  it('落成态 + 明细行之后才是本轮 trace 块（明细行先行的展开区次序）', () => {
    const wrapper = mountTurn(makeTurn({ foldedNotices: [bashDoneMsg('b1')] }))
    const trace = wrapper.find('.trace')
    expect(trace.exists()).toBe(true)
    const children = trace.element.children
    expect(children.length).toBeGreaterThan(1)
    // 明细行容器是 trace 首个子元素（其后才是 TraceCompactorRow / Block）
    expect(children[0].getAttribute('data-testid')).toBe('turn-folded-notices')
  })

  it('工作态：bash 行以临时外部行渲染（inline），明细行不渲染', () => {
    const wrapper = mountTurn(makeTurn({ foldedNotices: [bashDoneMsg('b1')] }), {
      isSessionActive: true,
      isLastTurn: true,
    })
    // 临时外部行（工作态现状外部形态）
    expect(wrapper.find('[data-testid="turn-folded-notice-external"]').exists()).toBe(true)
    // 明细行只在落成态展开时渲染
    expect(wrapper.find('[data-testid="turn-folded-notices"]').exists()).toBe(false)
  })

  it('trigger 起点聚合行：工作态渲染，落成态退役（数据已收进轮头行）', () => {
    const working = mountTurn(makeTurn({ trigger: 'bg-notify' }), {
      isSessionActive: true,
      isLastTurn: true,
    })
    expect(working.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(true)

    const settled = mountTurn(makeTurn({ trigger: 'bg-notify' }), {
      isSessionActive: false,
      isLastTurn: true,
    })
    expect(settled.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(false)
  })
})
