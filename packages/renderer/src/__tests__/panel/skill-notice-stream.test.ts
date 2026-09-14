/**
 * skill 注入提示呈现测试（composer-multi-skill-injection u5，场景 2③/2b②/3② + u5 验收条款）。
 *
 * 覆盖五组验收：
 * ① 降级两文案可区分渲染：budget_exceeded（「预算超限」）vs context_window_unavailable
 *    （「窗口信息获取失败」），同锚点 turn 各出一条内联行，文案互斥（场景 2③/2b②）。
 * ② 失效 toast + 内联提示：skill_missing → toast 含失效 skill 名 + 内联行含名字（场景 3②）；
 *    marker_malformed（skills 可空）→ 通用失效文案。
 * ③ 纯文本消息无提示（负面）：无 notice 时对话流不渲染任何 skill-notice-inline。
 * ④ 无 clientUuid 的 notice（steer/followUp）：不内联、不静默——降级类与失效类都降级为仅 toast。
 * ⑤ 多 session 隔离：session A 的提示不出现在 session B（Map 分区）；切回 A 仍在（ADR-0049 分区保留）。
 *
 * 挂载模式对齐 MessageStream-kind.test.ts：mock virtua（happy-dom 无布局）为全量渲染
 * scoped slot 的 stub，让模板 v-if 链对每项真实执行；chat deps mock 壳装配。
 * notice 触发走生产同一路径：api/events.dispatchSession（session 通道）——MessageStream 内
 * useSkillNoticeStream → useSessionEvents(events.on) 的真实订阅分发链路。
 *
 * 运行：cd packages/renderer && pnpm vitest run src/__tests__/panel/skill-notice-stream.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useToast } from '@/composables/useToast'
import { dispatchSession } from '@xyz-agent/core/transport/api'
import type { ServerMessage } from '@xyz-agent/shared'
import type { SkillNoticeEntry } from '@/composables/panel/useSkillNoticeStream'
import { interleaveSkillNoticeItems } from '@/composables/panel/useSkillNoticeStream'

// ── virtua mock：全量渲染 scoped slot 的 stub（同 MessageStream-kind.test.ts）──────────
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        keepMounted: { type: Array, default: () => [] },
      },
      setup() {
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vitest.fn(),
          getItemOffset: vitest.fn(() => 0),
          getItemSize: vitest.fn(() => 200),
          findItemIndex: vitest.fn(() => 0),
          scrollTo: vitest.fn(),
          scrollBy: vitest.fn(),
        }
      },
      render(ctx) {
        const data = ctx.data as unknown[]
        const indexes = new Set<number>((ctx.keepMounted as number[]) ?? [])
        for (let i = 0; i < data.length; i += 1) indexes.add(i)
        return h(
          'div',
          { class: 'mock-virtualizer' },
          [...indexes].flatMap((idx) => ctx.$slots.default?.({ item: data[idx], index: idx }) ?? []),
        )
      },
    }),
  }
})

// 壳 deps mock（同 MessageStream-kind.test.ts：装配 useChatViewDeps，本测聚焦 notice 呈现）
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(),
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const globalStubs = {
  Turn: {
    name: 'Turn',
    props: { turn: { type: Object, required: true }, canEdit: { type: Boolean, default: false } },
    template: `<div :data-testid="'turn-stub-' + turn.user?.id"><slot name="user" /></div>`,
  },
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div data-testid="bash-output-stub" />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

function userMsg(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    status: 'complete' as const,
    timestamp: Date.now(),
  }
}

/** 构造生产 wire 形态的 session.skillNotice 帧（payload 契约见 shared protocol.ts）。 */
function skillNoticeMsg(payload: {
  sessionId: string
  clientUuid?: string
  reason: SkillNoticeEntry['reason']
  skills: string[]
}): ServerMessage<'session.skillNotice'> {
  return { type: 'session.skillNotice', seq: 1, payload }
}

/** 经生产分发路径注入一条 notice（session 通道 dispatchSession → events.on 订阅者）。 */
function injectNotice(payload: Parameters<typeof skillNoticeMsg>[0]): void {
  dispatchSession(payload.sessionId, skillNoticeMsg(payload))
}

describe('skill 注入提示呈现（u5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    // toast 是模块级单例：用例间清空，防跨用例串扰（自动移除 timer 为 4s/8s，测试同步断言无竞争）
    useToast().toasts.value = []
  })

  it('① 降级两文案可区分：预算超限 vs 窗口信息获取失败（场景 2③/2b②）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-degrade', [userMsg('u-aaaa', '帮我 review 这段代码')])
    const wrapper = mountStream('sess-degrade')
    await wrapper.vm.$nextTick()

    injectNotice({ sessionId: 'sess-degrade', clientUuid: 'u-aaaa', reason: 'budget_exceeded', skills: ['a'] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    const degradeLine = wrapper.find('[data-testid="skill-notice-inline"][data-variant="degrade"]')
    expect(degradeLine.exists()).toBe(true)
    expect(degradeLine.text()).toContain('预算超限')
    expect(degradeLine.text()).toContain('标记模式')
    // 此处不得出现另一降级原因的文案（可区分性正断言）
    expect(degradeLine.text()).not.toContain('窗口信息获取失败')

    // 另一 session 的消息：窗口信息获取失败（fail-safe 降级，场景 2b）——两文案互斥可区分
    chat.hydrate('sess-degrade-2', [userMsg('u-bbbb', '第二条消息')])
    const wrapper2 = mountStream('sess-degrade-2')
    await wrapper2.vm.$nextTick()
    injectNotice({
      sessionId: 'sess-degrade-2',
      clientUuid: 'u-bbbb',
      reason: 'context_window_unavailable',
      skills: ['a'],
    })
    await wrapper2.vm.$nextTick()
    await wrapper2.vm.$nextTick()
    const windowLine = wrapper2.find('[data-testid="skill-notice-inline"][data-variant="degrade"]')
    expect(windowLine.exists()).toBe(true)
    expect(windowLine.text()).toContain('窗口信息获取失败')
    expect(windowLine.text()).not.toContain('预算超限')

    wrapper.unmount()
    wrapper2.unmount()
  })

  it('② 失效 toast + 消息内联提示，文案含失效 skill 名（场景 3②）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-invalid', [userMsg('u-cccc', '带 chip 的消息')])
    const wrapper = mountStream('sess-invalid')
    await wrapper.vm.$nextTick()

    injectNotice({
      sessionId: 'sess-invalid',
      clientUuid: 'u-cccc',
      reason: 'skill_missing',
      skills: ['ghost-skill'],
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 内联行：invalid 形态 + 含失效 skill 名
    const inline = wrapper.find('[data-testid="skill-notice-inline"][data-variant="invalid"]')
    expect(inline.exists()).toBe(true)
    expect(inline.text()).toContain('ghost-skill')
    expect(inline.text()).toContain('不存在')

    // toast 同步可见（D8 禁静默），文案含失效 skill 名
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'warning' && t.message.includes('ghost-skill'))).toBe(true)

    wrapper.unmount()
  })

  it('②b marker_malformed（skills 可空）→ 通用失效文案 + toast', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-malformed', [userMsg('u-dddd', '被 hook 破坏的消息')])
    const wrapper = mountStream('sess-malformed')
    await wrapper.vm.$nextTick()

    injectNotice({ sessionId: 'sess-malformed', clientUuid: 'u-dddd', reason: 'marker_malformed', skills: [] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    const inline = wrapper.find('[data-testid="skill-notice-inline"][data-variant="invalid"]')
    expect(inline.exists()).toBe(true)
    expect(inline.text()).toContain('标记已损坏')
    expect(useToast().toasts.value.length).toBeGreaterThan(0)

    wrapper.unmount()
  })

  it('③ 纯文本消息无提示（负面）：无 notice 时对话流不渲染提示行', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-plain', [userMsg('u-eeee', '纯文本消息，无 skill chip')])
    const wrapper = mountStream('sess-plain')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 消息本身正常渲染
    expect(wrapper.find('[data-testid="turn-stub-u-eeee"]').exists()).toBe(true)
    // 无任何提示行
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('④ 无 clientUuid 的 notice（steer/followUp）：不内联、仅 toast，不报错不静默', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-anon', [userMsg('u-ffff', 'busy 中 steer 的消息')])
    const wrapper = mountStream('sess-anon')
    await wrapper.vm.$nextTick()

    // 失效类无锚点：toast 呈现（不静默），无内联
    injectNotice({ sessionId: 'sess-anon', reason: 'skill_missing', skills: ['steer-skill'] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)
    expect(useToast().toasts.value.some((t) => t.message.includes('steer-skill'))).toBe(true)

    // 降级类无锚点：同样降级为 toast（有锚点时降级类仅内联不 toast——两种路径都不断言互扰）
    injectNotice({ sessionId: 'sess-anon', reason: 'budget_exceeded', skills: ['steer-skill'] })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)
    expect(useToast().toasts.value.some((t) => t.message.includes('预算超限'))).toBe(true)

    wrapper.unmount()
  })

  it('⑤ 多 session 隔离：session A 的提示不出现在 session B，切回 A 仍在（Map 分区）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-iso-a', [userMsg('u-gggg', 'A 的消息')])
    chat.hydrate('sess-iso-b', [userMsg('u-hhhh', 'B 的消息')])

    const wrapper = mountStream('sess-iso-a')
    await wrapper.vm.$nextTick()

    injectNotice({ sessionId: 'sess-iso-a', clientUuid: 'u-gggg', reason: 'skill_missing', skills: ['a-skill'] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(true)

    // 切到 B（同一 wrapper 复用，props.sessionId 变化 → 订阅重订 + 分区切换）
    await wrapper.setProps({ sessionId: 'sess-iso-b' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-stub-u-hhhh"]').exists()).toBe(true)

    // 切回 A：提示仍在（useSessionScopedState Map 分区保留，不随切换丢失）
    await wrapper.setProps({ sessionId: 'sess-iso-a' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('a-skill')

    wrapper.unmount()
  })

  it('幂等去重：同签名 notice 重复到达（reconcile 回放）不重复入流、不重复 toast', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-dedup', [userMsg('u-iiii', '去重消息')])
    const wrapper = mountStream('sess-dedup')
    await wrapper.vm.$nextTick()

    const payload = { sessionId: 'sess-dedup', clientUuid: 'u-iiii', reason: 'skill_missing' as const, skills: ['dup'] }
    injectNotice(payload)
    injectNotice(payload)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-testid="skill-notice-inline"]')).toHaveLength(1)
    expect(useToast().toasts.value.filter((t) => t.message.includes('dup'))).toHaveLength(1)

    wrapper.unmount()
  })
})

describe('interleaveSkillNoticeItems 纯函数', () => {
  it('无 notice 时原样返回同一引用（增量派生路径零开销）', () => {
    const items: never[] = []
    expect(interleaveSkillNoticeItems(items, [])).toBe(items)
  })

  it('锚点命中插 turn 之后；无锚点/宿主缺失不产出渲染项', () => {
    const turn = {
      index: 0,
      user: { id: 'u-1', role: 'user', content: [], status: 'complete', timestamp: 0 },
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    }
    const items = [{ kind: 'turn' as const, turn }]
    const notices: SkillNoticeEntry[] = [
      { id: 'n-1', clientUuid: 'u-1', reason: 'skill_missing', skills: ['x'] },
      { id: 'n-2', reason: 'skill_missing', skills: ['y'] },
      { id: 'n-3', clientUuid: 'u-404', reason: 'budget_exceeded', skills: ['z'] },
    ]
    const out = interleaveSkillNoticeItems(items, notices)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(items[0])
    expect(out[1]).toEqual({ kind: 'skillNotice', entry: notices[0] })
  })
})
