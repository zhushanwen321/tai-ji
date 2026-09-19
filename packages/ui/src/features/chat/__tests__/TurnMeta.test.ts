/**
 * TurnMeta.vue 组件测试（W4TC1/W4TC2）。
 *
 * 覆盖：
 * - W4TC1: badge 灰阶化（thinkCount/toolCount badge 从彩色改为中性灰 bg-surface-2 text-neutral-mid）
 * - W4TC2: sticky + streaming 状态（isWorkingTurn 时 turn-meta sticky，streaming 态文字染 accent）
 *
 * W1 main-fusion 后：TurnMeta 直接调 useTurnExpansion（共享 store），不再走 expanded prop / update:expanded emit。
 * 测试需 setActivePinia + 传 turnIndex/sessionId，chevron 展开态通过 store 预置 isExpanded(sid, idx) 驱动。
 *
 * [chat-flow-timestamp U2] TurnMeta 区间（设计 §3 A1/A2）：
 * - A1 完成/历史态：`.tm-range` 渲染 `· HH:MM:SS → HH:MM:SS`（起止 = 整个 agent-turn 的
 *   startedAt/endedAt，core deriveTurnAggregates 聚合值）
 * - A2 live 态：结束侧不定格 endedAt，以 `→` + panel.message.inProgress 文案结尾
 *
 * 已生成 token 数（口径 = 本 turn 全部 LLM 调用的 output tokens 之和，真实 usage 优先）：
 * - 三态渲染：工作中显示 / 完成态定格常驻（B1）/ tokens=0 不渲染
 * - 数字 toLocaleString() 千分位（用户可见 DOM 断言，锚定 turn-meta-tokens testid）；全程无 `≈`
 *   （只显示已上报的真实 usage，不做估算——用户裁决 A）
 *
 * 长时生成分级配色已删（2026-09，回归锚点见文件尾）：超长时长仍中性，不染 warn/danger。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/TurnMeta.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { TurnMeta } from '@taiji/ui'
import type { MessageTurn } from '@taiji/core/domain/chat'
import { turnStableId } from '@taiji/core/domain/chat'
import { mockChatProvide } from './helpers'

const NOW = Date.now()
const SID = 'sess-turnmeta-test'

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: NOW },
    assistants: [{ id: 'a1', role: 'assistant', content: 'done', status: 'complete', timestamp: NOW, thinking: [{ id: 'th1', content: 'reasoning', collapsed: true }], toolCalls: [{ id: 'tc1', toolName: 'read', input: {}, status: 'completed', startTime: NOW }] }],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  }
}

function mountMeta(props: {
  turn?: MessageTurn
  isWorkingTurn?: boolean
  isStreaming?: boolean
  thinkCount?: number
  toolCount?: number
  /** 是否在挂载前预置该 turn 为展开（store 写入），驱动 chevron rotate-90 */
  expanded?: boolean
  elapsed?: string
  /** turn 起点时刻（整个 agent-turn 聚合） */
  startedAt?: number
  /** turn 终点时刻（最后一次产出结束） */
  endedAt?: number
  /** 本 turn 是否仍在产出（未定格） */
  isLive?: boolean
  /** 本 turn 已上报的真实生成 token 总量（默认 0 不渲染） */
  generatedTokens?: number
}) {
  const turn = props.turn ?? makeTurn()
  return mount(TurnMeta, {
    props: {
      turn,
      isWorkingTurn: props.isWorkingTurn ?? false,
      isStreaming: props.isStreaming ?? false,
      thinkCount: props.thinkCount ?? 1,
      toolCount: props.toolCount ?? 1,
      elapsed: props.elapsed ?? '5s',
      startedAt: props.startedAt ?? NOW,
      endedAt: props.endedAt ?? NOW + 5000,
      isLive: props.isLive ?? false,
      generatedTokens: props.generatedTokens ?? 0,
      turnIndex: turn.index,
      turnKey: turnStableId(turn),
      sessionId: SID,
    },
    global: {
      provide: mockChatProvide({ isExpanded: () => !!props.expanded }),
    },
  })
}

describe('W4TC1: TurnMeta badge 灰阶化', () => {
  it('i18n panel.message.working 在 zh/en 语言文件均定义（zh 工作中 / en Working…）', () => {
    const zh = readFileSync(resolve(__dirname, '../../../../../renderer/src/i18n/locales/zh-CN/panel.ts'), 'utf8')
    const en = readFileSync(resolve(__dirname, '../../../../../renderer/src/i18n/locales/en-US/panel.ts'), 'utf8')
    expect(zh).toContain("working: '工作中'")
    expect(en).toContain("working: 'Working…'")
  })

  it('thinkCount badge 使用 bg-surface-2 text-neutral-mid（不再是 bg-reasoning-soft text-reasoning）', () => {
    const wrapper = mountMeta({ thinkCount: 3, toolCount: 0 })
    const badge = wrapper.find('.badge-think')
    expect(badge.exists()).toBe(true)
    // 灰阶化：bg-surface-2 + text-neutral-mid
    expect(badge.classes()).toContain('bg-surface-2')
    expect(badge.classes()).toContain('text-neutral-mid')
    // 旧彩色不应存在
    expect(badge.classes()).not.toContain('bg-reasoning-soft')
    expect(badge.classes()).not.toContain('text-reasoning')
    // badge 内容
    expect(badge.text()).toContain('3')
  })

  it('toolCount badge 使用 bg-surface-2 text-neutral-mid（不再是 bg-info-soft text-info）', () => {
    const wrapper = mountMeta({ thinkCount: 0, toolCount: 5 })
    const badge = wrapper.find('.badge-tool')
    expect(badge.exists()).toBe(true)
    // 灰阶化：bg-surface-2 + text-neutral-mid
    expect(badge.classes()).toContain('bg-surface-2')
    expect(badge.classes()).toContain('text-neutral-mid')
    // 旧彩色不应存在
    expect(badge.classes()).not.toContain('bg-info-soft')
    expect(badge.classes()).not.toContain('text-info')
    expect(badge.text()).toContain('5')
  })

  it('turn-meta 按钮文字：完成态显示「已工作」+ elapsed', () => {
    const wrapper = mountMeta({ isWorkingTurn: false, elapsed: '12s' })
    expect(wrapper.find('.lbl').text()).toBe('panel.message.worked')
    expect(wrapper.find('.elapsed').text()).toBe('12s')
  })

  it('turn-meta 按钮文字：working 态显示「工作中」（panel.message.working）+ elapsed', () => {
    const wrapper = mountMeta({ isWorkingTurn: true, isStreaming: true, elapsed: '3s' })
    expect(wrapper.find('.lbl').text()).toBe('panel.message.working')
    expect(wrapper.find('.elapsed').text()).toBe('3s')
  })

  it('[u6a] dispatching 占位迁出：空 assistants 不再渲染 TurnMeta（「思考中」迁 ActivityStrip thinking 行）', () => {
    const wrapper = mountMeta({
      turn: makeTurn({ assistants: [] }),
      isWorkingTurn: true,
      isStreaming: false,
      elapsed: '',
    })
    // 占位迁出后 v-if 收窄回 assistants.length > 0：空 turn 整个 TurnMeta（含 wrapper div）不渲染
    expect(wrapper.find('[data-testid="turn-meta-1"]').exists()).toBe(false)
    expect(wrapper.find('.turn-meta').exists()).toBe(false)
  })

  it('thinkCount=0 时不渲染 think badge', () => {
    const wrapper = mountMeta({ thinkCount: 0, toolCount: 1 })
    expect(wrapper.find('.badge-think').exists()).toBe(false)
    expect(wrapper.find('.badge-tool').exists()).toBe(true)
  })

  it('toolCount=0 时不渲染 tool badge', () => {
    const wrapper = mountMeta({ thinkCount: 1, toolCount: 0 })
    expect(wrapper.find('.badge-think').exists()).toBe(true)
    expect(wrapper.find('.badge-tool').exists()).toBe(false)
  })
})

describe('W4TC2: TurnMeta sticky + streaming 状态', () => {
  it('isWorkingTurn 时 turn-meta 父 div 无 sticky（已移除，正常文档流）', () => {
    // sticky 已移除：负 margin 覆盖 scrollEl padding-top 的技巧不可靠（贴顶时与顶部有间隔漏出滚动内容）
    const wrapper = mountMeta({ isWorkingTurn: true })
    expect(wrapper.find('.sticky').exists()).toBe(false)
  })

  it('非 isWorkingTurn 时无 sticky class', () => {
    const wrapper = mountMeta({ isWorkingTurn: false })
    expect(wrapper.find('.sticky').exists()).toBe(false)
  })

  it('streaming 态 + isWorkingTurn → Loader2 spinner 存在 + 文字染 text-accent', () => {
    const wrapper = mountMeta({ isWorkingTurn: true, isStreaming: true })
    // spinner 存在
    expect(wrapper.find('.animate-spin').exists()).toBe(true)
    // thinking 文案染 text-accent
    expect(wrapper.find('.lbl').classes()).toContain('text-accent')
  })

  it('完成态 → 无 spinner + 文字染 text-neutral-mid', () => {
    const wrapper = mountMeta({ isWorkingTurn: false, isStreaming: false })
    expect(wrapper.find('.animate-spin').exists()).toBe(false)
    expect(wrapper.find('.lbl').classes()).toContain('text-neutral-mid')
  })

  it('isWorkingTurn 时 turn-meta disabled（禁止折叠 trace）', () => {
    const wrapper = mountMeta({ isWorkingTurn: true })
    expect(wrapper.find('.turn-meta').attributes('disabled')).toBeDefined()
  })

  it('非 isWorkingTurn + hasFoldable → 点击 turn-meta 触发 toggleExpand(turnKey)', async () => {
    const turn = makeTurn()
    const toggleExpand = vi.fn()
    const wrapper = mount(TurnMeta, {
      props: { turn, isWorkingTurn: false, isStreaming: false, thinkCount: 1, toolCount: 1, elapsed: '5s', startedAt: NOW, endedAt: NOW + 5000, isLive: false, turnIndex: turn.index, turnKey: turnStableId(turn), sessionId: SID },
      global: { provide: mockChatProvide({ toggleExpand }) },
    })
    await wrapper.find('.turn-meta').trigger('click')
    expect(toggleExpand).toHaveBeenCalledWith(turnStableId(turn))
  })

  it('hasFoldable=false + 非 isWorkingTurn → 无 chevron', () => {
    const wrapper = mountMeta({
      turn: makeTurn({ hasFoldable: false }),
      isWorkingTurn: false,
    })
    expect(wrapper.find('.chev').exists()).toBe(false)
  })

  it('hasFoldable=true + 非 isWorkingTurn → 有 chevron + expanded 时 rotate-90', async () => {
    // 非 expanded → 无 rotate-90
    const wrapper = mountMeta({ isWorkingTurn: false, expanded: false })
    expect(wrapper.find('.chev').exists()).toBe(true)
    expect(wrapper.find('.chev').classes()).not.toContain('rotate-90')
    // expanded → 有 rotate-90（store 预置展开态驱动）
    const wrapper2 = mountMeta({ isWorkingTurn: false, expanded: true })
    expect(wrapper2.find('.chev').classes()).toContain('rotate-90')
  })
})

/* ── [chat-flow-timestamp U2] TurnMeta 区间（设计 §3 A1/A2）──
 * 期望时刻用本地 Date getter 构造（clockOf，与 formatClock 同口径 HH:MM:SS；
 * 禁硬编码 '14:00:00' 类时区串——formatClock 禁切 ISO，跨时区跑 CI 才稳定）。 */
function clockOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

describe('chat-flow-timestamp U2: TurnMeta 区间（A1/A2）', () => {
  // 固定 epoch（非 Date.now()）：失败时可复现的确定值
  const FIRST_TS = 1700000000000
  const LAST_TS = 1700000005000

  it('A1 完成态（isLive=false）：.tm-range 文本 `· HH:MM:SS → HH:MM:SS`（起止 = turn 聚合起止时刻）', () => {
    const wrapper = mountMeta({ startedAt: FIRST_TS, endedAt: LAST_TS, isLive: false })
    const range = wrapper.find('.tm-range')
    expect(range.exists()).toBe(true)
    // 归一化空白后整串比对（模板换行在 condense 模式下空白处理不进断言语义）
    expect(range.text().replace(/\s+/g, ' ').trim()).toBe(`· ${clockOf(FIRST_TS)} → ${clockOf(LAST_TS)}`)
  })

  it('A2 live 态（isLive=true）：.tm-range 以 → + panel.message.inProgress 文案结尾（结束侧不定格 endedAt）', () => {
    const wrapper = mountMeta({ startedAt: FIRST_TS, endedAt: LAST_TS, isLive: true })
    const range = wrapper.find('.tm-range')
    expect(range.exists()).toBe(true)
    const normalized = range.text().replace(/\s+/g, ' ').trim()
    // 测试环境 vue-i18n mock 的 t() 返回 key（vitest.setup.ts），断言口径同 W4TC1 'panel.message.worked'
    expect(normalized).toBe(`· ${clockOf(FIRST_TS)} → panel.message.inProgress`)
    // live 态结束侧不定格：endedAt 本地时刻不应出现
    expect(normalized).not.toContain(clockOf(LAST_TS))
  })
})

// ═════════════════════════════════════════════════════════
// [u3 remove-turn-progress-bar → 2026-09 token 口径] TurnMeta 已生成 token 数（设计 §2.1，验收 A2/A3）
//
// 渲染契约：elapsed/时刻区间之后渲染 `· 已生成 X tokens`（v-if tokens>0，B1 完成态定格
// 常驻——完成态与工作态同构可见）；数字 toLocaleString()；含估算时前缀 `≈`；样式跟随
// tm-range 档。测试环境 vue-i18n mock 的 t() 返回 key + 命名参数替换/append
// （vitest.setup.ts），文案断言锚定格式化后的数字（用户可见 DOM 断言）。
// ═════════════════════════════════════════════════════════
describe('u3 remove-turn-progress-bar: TurnMeta 已生成 token 数', () => {
  it('工作中显示：tokens>0 渲染 [data-testid=turn-meta-tokens]，数字经 toLocaleString 格式化', () => {
    const wrapper = mountMeta({ isWorkingTurn: true, isStreaming: true, generatedTokens: 1234 })
    const tokens = wrapper.find('[data-testid="turn-meta-tokens"]')
    expect(tokens.exists()).toBe(true)
    // 数字千分位（用户可见断言，预期用同口径 toLocaleString 求得，不依赖测试环境 locale 假设）
    expect(tokens.text()).toContain((1234).toLocaleString())
    // 样式跟随 tm-range 档：text-2xs + neutral-dim + mono
    expect(tokens.classes()).toContain('text-neutral-dim')
    expect(tokens.classes()).toContain('font-mono')
  })

  it('完成态定格显示（B1 常驻）：非 working/非 streaming 态 tokens>0 仍渲染', () => {
    const wrapper = mountMeta({ isWorkingTurn: false, isStreaming: false, generatedTokens: 207 })
    const tokens = wrapper.find('[data-testid="turn-meta-tokens"]')
    expect(tokens.exists()).toBe(true)
    expect(tokens.text()).toContain('207')
  })

  it('不显示近似值：数字不加 `≈`（只显示模型上报的真实值）', () => {
    const wrapper = mountMeta({ isWorkingTurn: true, isStreaming: true, generatedTokens: 122 })
    const tokensText = wrapper.find('[data-testid="turn-meta-tokens"]').text()
    expect(tokensText).toContain('122')
    expect(tokensText).not.toContain('≈')
  })

  it('tokens=0 不渲染（零内容 turn 不占行宽）', () => {
    const wrapper = mountMeta({ generatedTokens: 0 })
    expect(wrapper.find('[data-testid="turn-meta-tokens"]').exists()).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════
// 长时生成分级配色已删除（2026-09）
//
// 曾按 elapsedSecs ≥5min/≥30min 把 spinner + elapsed 染 warn/danger。时长改整 turn 墙钟
// （含工具执行/等待）后该配色把「等构建 / 等子代理 / 等用户回答」都判成异常，已删——
// 回归断言锚定「长时仍中性」，防重新引入。
// ═════════════════════════════════════════════════════════
describe('长时生成分级配色已删除（回归锚点）', () => {
  const LONG_RUNS = ['6m 12s', '34m 50s']

  it.each(LONG_RUNS)('超长时长 %s 仍用中性配色（无 text-warn / text-danger）', (elapsed) => {
    const wrapper = mountMeta({ isWorkingTurn: true, isStreaming: true, elapsed })
    const elapsedEl = wrapper.find('.elapsed')
    expect(elapsedEl.text()).toBe(elapsed)
    expect(elapsedEl.classes()).toContain('text-neutral-fg')
    expect(elapsedEl.classes().some((c) => c.includes('warn') || c.includes('danger'))).toBe(false)
    const spinner = wrapper.find('.animate-spin')
    expect(spinner.exists()).toBe(true)
    expect(spinner.classes()).toContain('text-accent')
    expect(spinner.classes().some((c) => c.includes('warn') || c.includes('danger'))).toBe(false)
  })
})
