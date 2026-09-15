/**
 * Turn.vue trace 窗口单测（streaming-trace-window design §3.3）。
 *
 * 覆盖三个 describe：
 * 1. D1 折叠作用域（scope wave，回归保护）：showTrace = isWorkingTurn || isExpanded
 * 2. 窗口切片（window wave）：computeTraceWindow 的 visible 渲染 + TraceCompactorRow v-if + takeover 切换
 * 3. TraceCompactorRow 组件：双态文案 + failed danger + 零 chrome（D5）
 *
 * 用真实 flattenTurnBlocks/computeTraceWindow（RC-1，不 mock core）。
 * TraceCompactorRow 真实组件经内联 i18n plugin mount（RC-2）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/Turn.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

// mock vue-i18n 的 useI18n：自包含 t（vue-i18n v10 的 createI18n 返回对象作 test-utils plugin 时报
// 「must be a function or object with install」，直接 mock useI18n 最可靠）。
// TraceCompactorRow 真实渲染时 useI18n() 拿到此 mock，文案 + count 插值均可断言（RC-2 i18n provide）。
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const msgs: Record<string, string> = {
        'panel.message.traceExpandAll': '展开全部（{count} 步）',
        'panel.message.traceCollapse': '恢复精简',
        'panel.message.traceFailed': '含 {count} 次失败',
        'panel.message.turnTriggerBgNotify': '后台任务完成 · 已继续处理',
        'panel.message.prematureTimeoutNotice': '响应已超时收口。若任务仍在后台进行，完成后将自动恢复显示；确认已停止可重新发送。',
      }
      let s = msgs[key] ?? key
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
      return s
    },
  }),
}))

import { mount } from '@vue/test-utils'
import { Turn } from '@taiji/ui'
import TraceCompactorRow from '../TraceCompactorRow.vue'
import UserBubble from '../UserBubble.vue'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { ContentBlock, Message, ToolCall } from '@taiji/shared'
import { mockChatProvide } from './helpers'

const NOW = 1_700_000_000_000
const SID = 'sess-trace-window-test'

// ─── fixture 构造 ───────────────────────────────────────────────

/** scope wave 用：带 thinking + tool + text 三块的完成态 turn（fallback 路径产出 [text, thinking, tool]）。 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: '最终回复',
    status: 'complete',
    timestamp: NOW,
    thinking: [{ id: 'th1', content: '推理过程', collapsed: true }],
    toolCalls: [{ id: 'tc1', toolName: 'read', input: { path: '/tmp/x' }, status: 'completed', startTime: NOW }],
  }
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  }
}

/**
 * window wave 用：构造指定数量过程块（toolCall）+ 末位 text 的 turn。
 * 走 contentBlocks 显式时序（expandAssistantBlocks 走 contentBlocks 路径，非 fallback），
 * 前 `failedCount` 个 tool 标 status='error'（测 failed 子计数 danger）。
 */
function makeWindowTurn(opts: {
  toolCount?: number
  failedCount?: number
  assistantStatus?: Message['status']
} = {}): MessageTurn {
  const toolCount = opts.toolCount ?? 12
  const failedCount = opts.failedCount ?? 0
  const status = opts.assistantStatus ?? 'complete'
  const toolCalls: ToolCall[] = []
  const contentBlocks: ContentBlock[] = []
  for (let i = 0; i < toolCount; i++) {
    const id = `tc-${i}`
    const isFail = i < failedCount
    toolCalls.push({
      id,
      toolName: 'read',
      input: { path: `/tmp/f${i}` },
      status: isFail ? 'error' : 'completed',
      startTime: NOW + i,
    })
    contentBlocks.push({ type: 'toolCall', refId: id })
  }
  contentBlocks.push({ type: 'text', refId: 'text' })
  const assistant: Message = {
    id: 'a1',
    role: 'assistant',
    content: '最终回复',
    status,
    timestamp: NOW,
    toolCalls,
    contentBlocks,
  }
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isStreaming: status === 'streaming',
    hasFoldable: toolCount > 0,
  }
}

// ─── mount helper ───────────────────────────────────────────────

/** Block stub：根节点带 .trace-blk + data-type/data-status/data-streaming，供断言 trace 块渲染与 props 透传。
 *  data-content 透传 text 正文（premature-timeout 恢复用例的「内容完整」DOM 断言锚点）。 */
const BlockStub = {
  name: 'Block',
  props: {
    type: { type: String, required: true },
    content: { type: String, default: '' },
    status: { type: String, default: '' },
    streaming: { type: Boolean, default: false },
    working: { type: Boolean, default: false },
    tool: { type: Object, default: undefined },
  },
  template: `<div class="trace-blk" :data-type="type" :data-content="content ?? ''" :data-status="status" :data-streaming="streaming ? 'true' : 'false'" :data-working="working ? 'true' : 'false'" />`,
}

function mountTurn(opts: {
  turn?: MessageTurn
  isSessionActive?: boolean
  isLastTurn?: boolean
  isExpanded?: (key: string) => boolean
  isTakeover?: (key: string) => boolean
  /** TraceCompactorRow 真实渲染（默认 stub，隔离 i18n）；true 时 provide i18n + 真实组件 */
  realCompactor?: boolean
} = {}) {
  const useRealCompactor = opts.realCompactor ?? false
  return mount(Turn, {
    props: {
      turn: opts.turn ?? makeTurn(),
      sessionId: SID,
      ...(opts.isSessionActive !== undefined ? { isSessionActive: opts.isSessionActive } : {}),
      ...(opts.isLastTurn !== undefined ? { isLastTurn: opts.isLastTurn } : {}),
    },
    global: {
      provide: mockChatProvide({
        isExpanded: opts.isExpanded ?? (() => false),
        isTakeover: opts.isTakeover ?? (() => false),
      }),
      stubs: {
        UserBubble: true,
        TurnMeta: true,
        TurnSummary: true,
        ChangeSetCard: true,
        Block: BlockStub,
        ...(useRealCompactor ? {} : { TraceCompactorRow: true }),
      },
    },
  })
}

// (i18n 由顶部 vi.mock('vue-i18n') 注入 useI18n，无需 createI18n plugin)

// ═════════════════════════════════════════════════════════════════
// describe 1：scope wave D1 折叠作用域（回归保护）
// ═════════════════════════════════════════════════════════════════
describe('streaming-trace-window D1: Turn 折叠作用域降到 turn 级', () => {
  it('非末位 turn（isLastTurn=false）→ trace 折叠（仅 text 末位正文，thinking/tool 隐藏）', () => {
    const wrapper = mountTurn({ isSessionActive: true, isLastTurn: false })
    expect(wrapper.find('.trace .trace-blk[data-type="text"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(false)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(false)
  })

  it('末位工作 turn（isLastTurn=true, sessionActive）→ trace 展开', () => {
    const wrapper = mountTurn({ isSessionActive: true, isLastTurn: true })
    expect(wrapper.find('.trace .trace-blk[data-type="text"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(true)
  })

  it('手动展开（isExpanded=true）优先于作用域——非末位 turn 也展开', () => {
    const wrapper = mountTurn({
      isSessionActive: true,
      isLastTurn: false,
      isExpanded: () => true,
    })
    expect(wrapper.find('.trace .trace-blk[data-type="thinking"]').exists()).toBe(true)
    expect(wrapper.find('.trace .trace-blk[data-type="tool"]').exists()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 2：window wave 窗口切片
// ═════════════════════════════════════════════════════════════════
describe('streaming-trace-window window: Turn 窗口切片渲染', () => {
  it('TC1: 12 块 turn（W=6）折叠窗口 → 仅渲染 visible（末 W=6 过程块 + 末位 text），前 6 块收编不在 DOM', () => {
    // showTrace=true（末位工作 turn），takeover=false
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12 }),
      isSessionActive: true,
      isLastTurn: true,
    })
    // visible = 6 个 completed tool（tc-6..tc-11）+ 1 text = 7 块
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(7)
    // 收编区前 6 个 tool（tc-0..tc-5）不在 DOM
    expect(wrapper.find('.trace-blk[data-type="tool"]').exists()).toBe(true)
    // 收编行存在（compactedCount=6）
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(true)
  })

  it('TC2: takeover=true 全展开 → 渲染全部块（12 tool + text = 13），收编行保留显示「恢复精简」回退入口', () => {
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12 }),
      isSessionActive: true,
      isLastTurn: true,
      isTakeover: () => true,
    })
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBe(13)
    // takeover=true → compactedCount=0, failedCount=0，但收编行 v-if 含 takeover 维度仍保留
    // （design 交互1：接管态原地变为「恢复精简」，提供回退入口，否则用户卡死在全展态）
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(true)
  })

  it('TC14: 块数 ≤ W（3 块）→ 无收编，收编行不渲染', () => {
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 3 }),
      isSessionActive: true,
      isLastTurn: true,
    })
    // visible = 3 tool + text = 4 块，compactedCount=0
    expect(wrapper.findAll('.trace .trace-blk').length).toBe(4)
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
  })

  it('TC14: 折叠态（!showTrace）→ 收编行不渲染（连 trace 都没展开，谈不上收编）', () => {
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12 }),
      isSessionActive: true,
      isLastTurn: false, // 非末位 → showTrace=false
    })
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
    // 折叠态仅末位 text
    expect(wrapper.findAll('.trace .trace-blk').length).toBe(1)
  })

  it('TC4: 含 failed tool（3 failed）→ 收编行 danger 子计数存在且高亮 text-danger', () => {
    // realCompactor=true 用真实 TraceCompactorRow + i18n，验 danger 文案/class
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12, failedCount: 3 }),
      isSessionActive: true,
      isLastTurn: true,
      realCompactor: true,
    })
    const failed = wrapper.find('[data-testid="trace-compactor-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.classes()).toContain('text-danger')
    expect(failed.text()).toContain('3')
  })

  it('TC9: Block props 透传——streaming assistant 的块收到 streaming=true / status=streaming / working=true', () => {
    // assistantStatus='streaming' + 末位 running tool
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 1, assistantStatus: 'streaming' }),
      isSessionActive: true,
      isLastTurn: true,
    })
    const tool = wrapper.find('.trace-blk[data-type="tool"]')
    expect(tool.exists()).toBe(true)
    expect(tool.attributes('data-streaming')).toBe('true')
    expect(tool.attributes('data-status')).toBe('streaming')
    // :working 随所属 assistant 的 streaming 态（MF-2：从 FlatBlock 所属 assistant 解出）
    expect(tool.attributes('data-working')).toBe('true')
  })

  it('TC2-toggle: 点击收编行 emit toggle → 调用 setTakeover（takeover false→true）', async () => {
    // TraceCompactorRow 真实渲染（需 i18n plugin），点击根 div 触发 emit toggle → onToggleTakeover
    const setTakeover = vi.fn()
    const wrapper = mount(Turn, {
      props: { turn: makeWindowTurn({ toolCount: 12 }), sessionId: SID, isSessionActive: true, isLastTurn: true },
      global: {
        provide: mockChatProvide({ isTakeover: () => false, setTakeover }),
        stubs: { UserBubble: true, TurnMeta: true, TurnSummary: true, ChangeSetCard: true, Block: BlockStub },
      },
    })
    await wrapper.find('[data-testid="trace-compactor"]').trigger('click')
    expect(setTakeover).toHaveBeenCalledTimes(1)
    // isTakeover mock 返回 false，onToggleTakeover 取反 → setTakeover(key, true)
    expect(setTakeover).toHaveBeenCalledWith(expect.any(String), true)
  })

  it('TC-MF2: Block :working 从所属 assistant 解出（非 session 级）——完成 assistant 的块 working=false（session 活跃期可查看 thinking 全文）', () => {
    // 完成 assistant（status='complete'）+ 末位工作 turn（sessionActive=true）：
    // design 要求 Block props 从 FlatBlock 所属 assistant 解出。:working 应随 assistantStatus，
    // 而非 session 级 sessionActive——否则完成助手 thinking 全文在 session 活跃期不可查看。
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 2, assistantStatus: 'complete' }),
      isSessionActive: true,
      isLastTurn: true,
    })
    const blocks = wrapper.findAll('.trace .trace-blk')
    expect(blocks.length).toBeGreaterThan(0)
    // session 虽活跃，但该 assistant 已 complete → 所有块 working=false（旧 sessionActive 绑定会为 true）
    expect(blocks.every((b) => b.attributes('data-working') === 'false')).toBe(true)
  })

  it('TC-MF3: 完成态/历史 turn 手动展开 → 全量 flatBlocks（不走窗口），收编行不渲染（窗口只作用于工作 turn）', () => {
    // 非工作 turn（isLastTurn=false）但 isExpanded=true（手动展开回看）：
    // design §3.1 交互6「回看就是全量」、G5「完成态与历史呈现不变」→ 不截断、无收编行。
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12 }),
      isSessionActive: true,
      isLastTurn: false, // 非末位 → isWorkingTurn=false
      isExpanded: () => true, // 手动展开 → showTrace=true
    })
    // 全量：12 tool + 1 text = 13 块（非窗口的 9 块）
    expect(wrapper.findAll('.trace .trace-blk').length).toBe(13)
    // 非工作 turn → 收编行不渲染（窗口专属 chrome 不出现在回看态）
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 3：TraceCompactorRow 组件（双态 + danger + 零 chrome）
// ═════════════════════════════════════════════════════════════════
describe('streaming-trace-window TraceCompactorRow', () => {
  function mountRow(props: { compactedCount: number; failedCount: number; takeover: boolean }) {
    return mount(TraceCompactorRow, { props })
  }

  it('TC3: 折叠态（takeover=false）显示「展开全部」+ compactedCount', () => {
    const w = mountRow({ compactedCount: 4, failedCount: 0, takeover: false })
    expect(w.text()).toContain('展开全部')
    expect(w.text()).toContain('4')
    // 无 failed 时不渲染 danger 子计数
    expect(w.find('[data-testid="trace-compactor-failed"]').exists()).toBe(false)
  })

  it('TC3: 全展态（takeover=true）显示「恢复精简」', () => {
    const w = mountRow({ compactedCount: 0, failedCount: 0, takeover: true })
    expect(w.text()).toContain('恢复精简')
  })

  it('TC4: failedCount>0 渲染 danger 子计数（含 count + text-danger class）', () => {
    const w = mountRow({ compactedCount: 4, failedCount: 3, takeover: false })
    const failed = w.find('[data-testid="trace-compactor-failed"]')
    expect(failed.exists()).toBe(true)
    expect(failed.classes()).toContain('text-danger')
    expect(failed.text()).toContain('3')
  })

  it('TC12: 零 chrome——根元素 class 不含 border/bg-/divider/gradient/mask', () => {
    const w = mountRow({ compactedCount: 4, failedCount: 0, takeover: false })
    const cls = w.find('[data-testid="trace-compactor-row"]').classes().join(' ')
    expect(cls).not.toMatch(/\bborder\b|bg-|divider|gradient|mask/)
  })

  it('emit toggle on click', async () => {
    const w = mountRow({ compactedCount: 4, failedCount: 0, takeover: false })
    await w.find('[data-testid="trace-compactor-row"]').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 4：edges wave D9 边界态窗口冻结（组件层）
//
// 固化 CL1/CL2 裁决：ask-user/compacting/dispatching/forceWorking 等边界态下
// Turn.vue trace 区 + TraceCompactorRow 渲染正确（窗口冻结，无抖动、无空指针崩溃）。
// 与 TC-edge-core（core 纯函数）分层守护同一核心断言：0 streaming assistant → 窗口稳定。
// ═════════════════════════════════════════════════════════════════
describe('streaming-trace-window edges: D9 边界态窗口冻结（组件层）', () => {
  it('case1 ask-user/compacting 态（sessionActive + assistantStatus=complete）→ trace 区渲染 visible 窗口 + compactor 存在', () => {
    // ask-user/compacting 期间：对话进行中（isSessionActive=true）但 assistant 已 complete（无 streaming 块）。
    // 12 completed tool + text：②进行中集合空 → visible=last 6 tool + text = 7 块，compactedCount=6。
    const wrapper = mountTurn({
      turn: makeWindowTurn({ toolCount: 12, assistantStatus: 'complete' }),
      isSessionActive: true,
      isLastTurn: true,
    })
    // showTrace = sessionActive(true) && isLastTurn(true) = true → trace 展开
    expect(wrapper.find('.trace').exists()).toBe(true)
    // visible = 6 tool（tc-6..tc-11）+ 1 text = 7 块
    expect(wrapper.findAll('.trace .trace-blk').length).toBe(7)
    // compactedCount=6 > 0 → compactor 渲染
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(true)
  })

  it('case2 dispatching 占位（assistants=[]）→ trace 区空 + compactor 不渲染 + 无 console error', () => {
    // dispatching 空窗期：user 已发、message_start 未到 → assistants=[]。
    // flatten([]) → [] → traceWindow 计数全 0 → compactor v-if(showTrace && (0>0||0>0))=false。
    // R3 防护：实测确认 Turn.vue 无空指针崩溃（lastAssistant/assistantById 均 ??/Map 容错）。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const wrapper = mountTurn({
        turn: { ...makeTurn(), assistants: [] },
        isSessionActive: true,
        isLastTurn: true,
      })
      // trace 容器恒渲染，但无任何块（visible=[]）
      expect(wrapper.find('.trace').exists()).toBe(true)
      expect(wrapper.findAll('.trace .trace-blk').length).toBe(0)
      // compactedCount=0 && failedCount=0 → compactor v-if=false
      expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="trace-compactor-failed"]').exists()).toBe(false)
      // 无运行时错误（防空指针）
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('case3 forceWorking 路径（turn.isStreaming=true + assistant.status=complete）→ streaming-tail 显示但 trace 无进行中块', () => {
    // CL1 裁决固化（组件层）：forceWorking 是 renderer 为 keepMounted 设的 turn.isStreaming 标记，
    // 不代表 assistant 真在 streaming。computeTraceWindow 按 assistant.status==='streaming' 判定进行中块
    // → 全 complete 时②空、全部进③已完成池。Turn.vue streaming-tail 跟随 turn.isStreaming（显示），
    // 但 Block 的 streaming prop = assistantStatus==='streaming'（全 false，无进行中块视觉）。
    const wrapper = mountTurn({
      turn: { ...makeWindowTurn({ toolCount: 12, assistantStatus: 'complete' }), isStreaming: true },
      isLastTurn: true,
      // isSessionActive 不传 → 回退 turn.isStreaming=true → sessionActive=true
    })
    // showTrace=true（sessionActive && isLastTurn）→ trace 展开
    expect(wrapper.findAll('.trace .trace-blk').length).toBe(7) // 6 tool + text
    expect(wrapper.find('[data-testid="trace-compactor"]').exists()).toBe(true) // compactedCount=6
    // streaming-tail 显示（isStreaming=true，末位 text 非 running tool）
    expect(wrapper.find('.streaming-tail').exists()).toBe(true)
    // 关键：trace 区所有块的 streaming prop=false（assistantStatus 全 complete，无进行中块）
    const streamingFlags = wrapper.findAll('.trace .trace-blk').map((b) => b.attributes('data-streaming'))
    expect(streamingFlags.every((f) => f === 'false')).toBe(true)
  })

  it('case4 takeover 边界态切换 smoke：false→窗口策略 / true→全展', () => {
    // 同一 forceWorking 边界态 turn，takeover false vs true 渲染差异
    const turn = { ...makeWindowTurn({ toolCount: 12, assistantStatus: 'complete' }), isStreaming: true }
    // takeover=false：窗口策略，visible=7（6 tool + text），compactor 渲染
    const w1 = mountTurn({ turn, isLastTurn: true, isTakeover: () => false })
    expect(w1.findAll('.trace .trace-blk').length).toBe(7)
    expect(w1.find('[data-testid="trace-compactor"]').exists()).toBe(true)
    // takeover=true：全展，visible=13（12 tool + text）；计数归零但收编行保留（恢复精简回退入口，design 交互1）
    const w2 = mountTurn({ turn, isLastTurn: true, isTakeover: () => true })
    expect(w2.findAll('.trace .trace-blk').length).toBe(13)
    expect(w2.find('[data-testid="trace-compactor"]').exists()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 5：turn-attribution W4 —— trigger 起点行 + turn 内 notice 渲染
//
// 固化 D3/D4 渲染契约（conversation-turn-attribution §3.1 / §3.3）：
// - trigger==='bg-notify' && user===null 的 turn 渲染轻量起点行（非 user 气泡）；
// - turn.notices 在 turn 内部末尾渲染：bashExecution → BashOutputBlock（复用既有消费点）、
//   liveOnly → SystemNotice 弱化行；wrapper testid = turn-inline-bash / turn-inline-notice。
// ═════════════════════════════════════════════════════════════════
describe('turn-attribution W4: trigger 起点行 + turn 内 notice', () => {
  /** bg-notify 续跑 turn：user:null + trigger + assistant 结果（无 notice 的基础形态） */
  function makeTriggerTurn(over: Partial<MessageTurn> = {}): MessageTurn {
    return {
      index: 1,
      user: null,
      trigger: 'bg-notify',
      assistants: [
        { id: 'a-bg1', role: 'assistant', content: '后台任务结果已处理', status: 'complete', timestamp: NOW },
      ],
      isStreaming: false,
      hasFoldable: false,
      ...over,
    }
  }

  /** turn 内 bash notice（role:'system' + bashExecution，分组规则 4 inline 归 turn） */
  function bashNotice(id: string): Message {
    return {
      id,
      role: 'system',
      content: '',
      status: 'complete',
      bashExecution: {
        command: 'npm test',
        output: 'all passed',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: NOW,
      },
      timestamp: NOW,
    } as Message
  }

  /** turn 内 liveOnly 健康警告（stream_warn，无 entry 无 replay 对应物） */
  function liveOnlyNotice(id: string): Message {
    return {
      id,
      role: 'system',
      content: '上下文长度接近上限，请注意',
      status: 'complete',
      liveOnly: true,
      timestamp: NOW,
    } as Message
  }

  it('W4-T1: trigger turn（user:null + trigger:bg-notify）→ 起点行渲染且含文案，UserBubble 不渲染', () => {
    const wrapper = mountTurn({ turn: makeTriggerTurn() })
    const row = wrapper.find('[data-testid="turn-trigger-bgnotify"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('后台任务完成')
    // 非 user 气泡：起点行是弱化元信息行，不冒充用户发言
    expect(wrapper.findComponent(UserBubble).exists()).toBe(false)
  })

  it('W4-T2: 普通 user turn → 无 trigger 起点行（UserBubble 正常渲染）', () => {
    const wrapper = mountTurn({ turn: makeTurn() })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(false)
    expect(wrapper.findComponent(UserBubble).exists()).toBe(true)
  })

  it('W4-T3: assistant 自启 turn（user:null 无 trigger）→ 起点行与 UserBubble 都不渲染（首条 assistant 边缘形态不变）', () => {
    const wrapper = mountTurn({ turn: makeTriggerTurn({ trigger: undefined }) })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(false)
    expect(wrapper.findComponent(UserBubble).exists()).toBe(false)
  })

  it('W4-N1: turn.notices 渲染在 turn 内部末尾——bash 复用 BashOutputBlock、liveOnly 走 SystemNotice 弱化行', () => {
    const wrapper = mountTurn({
      turn: makeTurn({ notices: [bashNotice('bash-n1'), liveOnlyNotice('warn-n1')] }),
    })
    // bash notice：wrapper testid + 内部复用 BashOutputBlock（真组件，含 bash-output-block 根 testid）
    const bashWrap = wrapper.find('[data-testid="turn-inline-bash"]')
    expect(bashWrap.exists()).toBe(true)
    expect(bashWrap.find('[data-testid="bash-output-block"]').exists()).toBe(true)
    expect(bashWrap.text()).toContain('npm test')
    // liveOnly notice：wrapper testid + SystemNotice 弱化行（兜底分支渲染 content 文本）
    const noticeWrap = wrapper.find('[data-testid="turn-inline-notice"]')
    expect(noticeWrap.exists()).toBe(true)
    expect(noticeWrap.text()).toContain('上下文长度接近上限')
    // 到达序忠实：bash（先到）在 notice（后到）之前（DOM 顺序）
    const bashEl = bashWrap.element as HTMLElement
    const warnEl = noticeWrap.element as HTMLElement
    expect(bashEl.compareDocumentPosition(warnEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('W4-N2: turn.notices 为空/undefined → 不渲染任何 inline notice wrapper（历史 turn 形态不变）', () => {
    const wrapper = mountTurn({ turn: makeTurn() })
    expect(wrapper.find('[data-testid="turn-inline-bash"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-inline-notice"]').exists()).toBe(false)
  })

  it('W4-N3: trigger turn 也可携带 notices（后台续跑期间跑过 `!` 命令）——起点行与 notice 共存', () => {
    const wrapper = mountTurn({
      turn: makeTriggerTurn({ notices: [bashNotice('bash-t1')] }),
    })
    expect(wrapper.find('[data-testid="turn-trigger-bgnotify"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turn-inline-bash"]').exists()).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// describe 6：premature-timeout 恢复指引渲染（timeout-streaming-ui-idle §4.2 / §5.2 D2）
//
// 打标气泡（timeout 收口误判）显示超时 + 自动恢复指引；complete 自愈清标后指引消失。
// core 侧恢复链见 core chat-premature-timeout-recovery.test.ts（本套只锁渲染契约）。
// ═════════════════════════════════════════════════════════════════
describe('premature-timeout: 超时收口恢复指引渲染', () => {
  /** timeout 误判收口的 assistant（error + prematureTimeout 标） */
  function makeMarkedTurn(): MessageTurn {
    return {
      index: 1,
      user: { id: 'u1', role: 'user', content: '跑长任务', status: 'complete', timestamp: NOW },
      assistants: [
        {
          id: 'a1',
          role: 'assistant',
          content: '截断正文',
          status: 'error',
          prematureTimeout: true,
          timestamp: NOW,
        },
      ],
      isStreaming: false,
      hasFoldable: false,
    }
  }

  it('打标气泡（error + prematureTimeout）→ 恢复指引行渲染且含「自动恢复」语义文案（用户可见 DOM 断言）', () => {
    const wrapper = mountTurn({ turn: makeMarkedTurn() })
    const notice = wrapper.find('[data-testid="turn-premature-timeout"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('超时收口')
    expect(notice.text()).toContain('自动恢复')
  })

  it('普通 error 气泡（无标）→ 指引不渲染（不把真实错误误标为可恢复）', () => {
    const turn = makeMarkedTurn()
    delete (turn.assistants[0] as Partial<Message>).prematureTimeout
    const wrapper = mountTurn({ turn })
    expect(wrapper.find('[data-testid="turn-premature-timeout"]').exists()).toBe(false)
  })

  it('complete 自愈恢复后（status 翻 complete + 清标）→ 指引消失、正文完整可见', async () => {
    const turn = makeMarkedTurn()
    const wrapper = mountTurn({ turn })
    expect(wrapper.find('[data-testid="turn-premature-timeout"]').exists()).toBe(true)
    // 模拟 core 恢复分支产物：status 翻 complete + prematureTimeout 清除 + 权威 content 覆盖
    turn.assistants[0] = { ...turn.assistants[0], status: 'complete', content: '权威完整正文', prematureTimeout: undefined }
    await wrapper.setProps({ turn: { ...turn } })
    expect(wrapper.find('[data-testid="turn-premature-timeout"]').exists()).toBe(false)
    // 内容完整：恢复后的权威正文透传到 text 块（Block stub data-content 锚点）
    expect(wrapper.find('.trace-blk[data-type="text"]').attributes('data-content')).toBe('权威完整正文')
  })
})
