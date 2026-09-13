/**
 * 对话流 block 渲染重构组件级回归护栏（§8.3，M1）。
 *
 * 背景：M0 重构（text 全 inline 就地渲染 + v-if 下沉 Block 级 + streaming-tail 光标迁移）
 * 已合并，本文件补三组 §8.3 验收语义的 DOM 断言，防未来重构（key 变化 / Vue 升级 /
 * 样式 token 调整 / 折叠语义回退）静默回归：
 *
 * - TC-REG-1 零跳变：message_start 序列（T1=[a1 text streaming] → T2=[a1 text+tool running]
 *   → T3=[a1 text+tool, a2 text streaming]）下，a1 text 的 DOM element 引用全程同一节点
 *   （引用比较 + exists）、相对顺序不变（text 在 tool 前、a2 text 在 a1 块后）、textContent 无丢失。
 *   依赖 Vue keyed v-for 节点复用（key=`${assistant.id}-${blk.kind}-${bIdx}`，a1-text-0 全程稳定）。
 * - TC-REG-2 折叠态多 assistant 文字可见：complete 态 + 不传 isSessionActive（showTrace=false）
 *   时，所有 text 块 DOM 均存在（含非末位 a1 的 text——防「非末位 text 被折叠隐藏」历史回归），
 *   thinking/tool 节点不存在，.trace 容器恒渲染。
 * - TC-REG-3 样式统一：展开态下所有 text block class 含正文 token 锚点
 *   （text-[length:var(--text-base)] + leading-7），不含过程样式（text-[length:var(--text-sm)] /
 *   leading-relaxed）。Block.vue 用 arbitrary value，禁止字面 'text-base' 子串匹配（TC-M0-4 模式）。
 *
 * fixture 自包含复制自 turn-working.test.ts（msg/makeTurn/mountTurnWithRealBlock），
 * 仅 MarkdownRenderer stub 改为渲染 content 的自定义 stub（TC-REG-1 需要 textContent 可见）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/block-rendering-regression.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
// ui 包 Turn 经 ChatViewDeps inject 消费依赖，mount 时 provide mock deps
import { Turn } from '@xyz-agent/ui'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

function msg(over: Partial<Message> = {}): Message {
  return { id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: Date.now(), ...over }
}

/** 构造 MessageTurn：默认 streaming 态（最后 assistant streaming），含可折叠块 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() },
    assistants: [msg()],
    isStreaming: true,
    hasFoldable: true,
    ...over,
  }
}

/**
 * mount Turn 但用真实 Block（仅 stub 重依赖 ChangeSetCard + 自定义 MarkdownRenderer）。
 * MarkdownRenderer stub 渲染 content 到 .md-stub（区别于 turn-working 的 stub=true：
 * 本文件需要 textContent 可见来断言零跳变无丢失）。
 * 展开/折叠经 deps 注入（isExpanded/toggleExpand 必须用 reactive Set——普通 Set 非响应式，
 * computed 不重算）。
 */
const expandedTurns = reactive(new Set<string>())
// isLastTurn 默认 true：单 turn 隔离挂载即末位 turn（D1 折叠作用域，streaming-trace-window design §3.3），
// session 进行中（streaming）时工作 trace 才展开——TC-REG-1 的 streaming 序列需要末位 turn 展开 trace。
function mountTurnWithRealBlock(props: { turn: MessageTurn; sessionId?: string; isLastTurn?: boolean }) {
  return mount(Turn, {
    props: { turn: props.turn, sessionId: props.sessionId ?? 's1', isLastTurn: props.isLastTurn ?? true },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide({
        isExpanded: (key: string) => expandedTurns.has(key),
        toggleExpand: (key: string) => {
          if (expandedTurns.has(key)) expandedTurns.delete(key)
          else expandedTurns.add(key)
        },
      }),
      stubs: {
        ChangeSetCard: true,
        MarkdownRenderer: {
          props: ['content'],
          template: '<div class="md-stub">{{ content }}</div>',
        },
      },
    },
  })
}

describe('block-rendering 回归护栏（§8.3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    expandedTurns.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // TC-REG-1：零跳变回归——message_start 序列下窗口内块节点全程同一 DOM 引用。
  // T1=[a1 text streaming] → T2=[a1 text+tool running] → T3=[a1 text+tool, a2 text streaming]。
  // [8be96c5dc 适配] 窗口语义：末位 text 全 turn 单个（不按 assistant 分组）——T3 时 a1 text
  // （非末位）被收编出 visible，visible=[a1 tool, a2 text]；零跳变断言改为「T1→T2 a1 text 引用
  // 稳定 + T2→T3 窗口内 a1 tool 引用稳定」（key=flatIndex keyed v-for 复用）。
  it('TC-REG-1: 零跳变 — 窗口内块 DOM 引用在 T1→T3 全程同一节点，顺序不变，末位 text 无丢失', async () => {
    const a1Text = (over: Partial<Message> = {}): Message =>
      msg({
        id: 'a1',
        status: 'streaming',
        content: '我先读文件',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        ...over,
      })
    const runningTool = { id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'running', startTime: 0 }

    // T1：a1 text streaming（记录 a1 text 的 DOM element 引用）
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({ isStreaming: true, hasFoldable: false, assistants: [a1Text()] }),
    })
    const a1TextEl = wrapper.find('.trace .trace-blk > div').element as HTMLElement
    expect(a1TextEl).toBeInstanceOf(HTMLElement)
    expect(wrapper.find('.trace .trace-blk > div').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk .md-stub').text()).toBe('我先读文件')
    expect(wrapper.find('.trace').text()).toContain('我先读文件')

    // T2：message_start 后 tool 插入——a1 同 text + toolCall running
    await wrapper.setProps({
      turn: makeTurn({
        isStreaming: true,
        hasFoldable: true,
        assistants: [
          a1Text({
            contentBlocks: [
              { type: 'text', refId: 'text' },
              { type: 'toolCall', refId: 'tc1' },
            ],
            toolCalls: [runningTool],
          }),
        ],
      }),
    })
    // a1 text 引用同一节点（keyed v-for 按 flatIndex=0 复用），textContent 无丢失
    expect(wrapper.find('.trace .trace-blk > div').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk > div').element).toBe(a1TextEl)
    // U2 起 text 块行尾含时刻槽（text-time-slot），textContent 含时刻文本——断言「正文无丢失」用 toContain
    expect(a1TextEl.textContent).toContain('我先读文件')
    // 相对顺序不变：a1 text 在 tool 前
    const blocksT2 = wrapper.findAll('.trace .trace-blk')
    expect(blocksT2.length).toBe(2)
    expect(blocksT2[0].find('.md-stub').exists()).toBe(true)
    expect(blocksT2[0].find('.md-stub').text()).toBe('我先读文件')
    expect(blocksT2[1].find('.trace-tool').exists()).toBe(true)
    // 记录 T2 的 a1 tool DOM 引用（T3 窗口收编 a1 text 后 tool 仍在窗口内）
    const a1ToolEl = blocksT2[1].element as HTMLElement

    // T3：message_start(a2)——a1 text 收编（非末位），visible=[a1 tool, a2 text]
    await wrapper.setProps({
      turn: makeTurn({
        isStreaming: true,
        hasFoldable: true,
        assistants: [
          a1Text({
            contentBlocks: [
              { type: 'text', refId: 'text' },
              { type: 'toolCall', refId: 'tc1' },
            ],
            toolCalls: [runningTool],
          }),
          msg({ id: 'a2', status: 'streaming', content: '内容是...' }),
        ],
      }),
    })
    // a1 tool 引用仍同一节点（flatIndex=1 不变，窗口内块零跳变）
    const blocksT3 = wrapper.findAll('.trace .trace-blk')
    expect(blocksT3.length).toBe(2)
    expect(blocksT3[0].find('.trace-tool').exists()).toBe(true)
    expect(blocksT3[0].element).toBe(a1ToolEl)
    // 相对顺序不变：a1 tool 在 a2 text（末位 text = 流式正文）前
    expect(blocksT3[1].find('.md-stub').exists()).toBe(true)
    expect(blocksT3[1].find('.md-stub').text()).toBe('内容是...')
    // 末位 text 无丢失（a1 非末位 text 已收编，经 takeover/展开查看——8be96c5dc）
    expect(wrapper.find('.trace').text()).toContain('内容是...')
  })

  // TC-REG-2：折叠态多 assistant 文字可见——showTrace=false 时仅全 turn 末位 text 可见
  // （8be96c5dc：不按 assistant 分组，防 tool-loop 多 assistant visible 爆炸），thinking/tool
  // 不存在，.trace 容器恒渲染；非末位 text 经展开（完成态全量 flatBlocks「回看就是全量」）恢复。
  it('TC-REG-2: 折叠态多 assistant — 仅末位 text 可见，thinking/tool 隐藏；展开后全量恢复', async () => {
    const a1 = msg({
      id: 'a1',
      status: 'complete',
      content: '正文A',
      thinking: [{ id: 'th1', content: 'thinking', collapsed: true }],
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'completed', startTime: 0 }],
      contentBlocks: [
        { type: 'thinking', refId: 'th1' },
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'tc1' },
      ],
    })
    const a2 = msg({ id: 'a2', status: 'complete', content: '正文B' })
    // complete 态 + 不传 isSessionActive → sessionActive 回退 turn.isStreaming=false → showTrace=false
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({ isStreaming: false, hasFoldable: true, assistants: [a1, a2] }),
    })
    // .trace 容器恒渲染（v-if 下沉 Block 级）
    expect(wrapper.find('.trace').exists()).toBe(true)
    // 折叠态仅全 turn 末位 text（a2「正文B」）可见；a1 非末位 text 收编
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(1)
    expect(blocks[0].find('.md-stub').exists()).toBe(true)
    expect(blocks[0].find('.md-stub').text()).toBe('正文B')
    // thinking/tool 节点不存在（showTrace=false 隐藏）
    expect(wrapper.find('.trace-think').exists()).toBe(false)
    expect(wrapper.find('.trace-tool').exists()).toBe(false)
    expect(wrapper.find('.trace').text()).toContain('正文B')

    // 展开后（showTrace && !isWorkingTurn → 全量 flatBlocks）：a1 thinking/text/tool + a2 text 全恢复
    expandedTurns.add('u1')
    await nextTick()
    const expanded = wrapper.findAll('.trace .trace-blk')
    expect(expanded.length).toBe(4)
    expect(wrapper.find('.trace').text()).toContain('正文A')
    expect(wrapper.find('.trace').text()).toContain('正文B')
    expect(wrapper.find('.trace-think').exists()).toBe(true)
    expect(wrapper.find('.trace-tool').exists()).toBe(true)
  })

  // TC-REG-3：样式统一——展开态多 assistant，所有 text block 含正文 token 锚点
  // （text-[length:var(--text-base)] + leading-7），不含过程样式（text-sm / leading-relaxed）。
  it('TC-REG-3: 展开态多 assistant — 所有 text block 统一正文样式（token 锚点）', async () => {
    const a1 = msg({
      id: 'a1',
      status: 'complete',
      content: '正文A',
      toolCalls: [{ id: 'tc1', toolName: 'grep', input: { command: 'foo' }, status: 'completed', startTime: 0 }],
      contentBlocks: [
        { type: 'text', refId: 'text' },
        { type: 'toolCall', refId: 'tc1' },
      ],
    })
    const a2 = msg({ id: 'a2', status: 'complete', content: '正文B' })
    const wrapper = mountTurnWithRealBlock({
      turn: makeTurn({ isStreaming: false, hasFoldable: true, assistants: [a1, a2] }),
    })
    // 手动展开 trace（reactive Set 驱动 isExpanded → showTrace）
    expandedTurns.add('u1')
    await nextTick()
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(3) // a1 text + a1 tool + a2 text
    // 每个 text block 的 class 断言（token 锚点，禁止字面 'text-base' 子串匹配）
    const textEls = wrapper
      .findAll('.trace .trace-blk > div')
      .filter((d) => d.find('.md-stub').exists())
    expect(textEls.length).toBe(2)
    expect(textEls[0].find('.md-stub').text()).toBe('正文A')
    expect(textEls[1].find('.md-stub').text()).toBe('正文B')
    for (const el of textEls) {
      expect(el.classes()).toContain('text-[length:var(--text-base)]')
      expect(el.classes()).toContain('leading-7')
      expect(el.classes()).not.toContain('text-[length:var(--text-sm)]')
      expect(el.classes()).not.toContain('leading-relaxed')
    }
  })
})
