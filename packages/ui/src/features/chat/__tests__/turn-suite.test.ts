import { useTurnElapsed } from '../composables/useTurnElapsed';
import { mockChatProvide } from './helpers';
import { deriveTurnAggregates, turnStableId, type MessageTurn, type TurnAggregates } from '@taiji/core/domain/chat';
import type { Message } from '@taiji/shared';
import { TurnMeta, TurnRail } from '@taiji/ui';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref, type Ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← TurnMeta.test.ts
// ======================================================================

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

describe('W4TC1: TurnMeta 计数段 chipn chip 化（M3a demo 权威）', () => {
  it('i18n panel.message.working 在 zh/en 语言文件均定义（zh 工作中 / en Working…）', () => {
    const zh = readFileSync(resolve(__dirname, '../../../locale/zh-CN/panel.ts'), 'utf8')
    const en = readFileSync(resolve(__dirname, '../../../locale/en-US/panel.ts'), 'utf8')
    expect(zh).toContain("working: '工作中'")
    expect(en).toContain("working: 'Working…'")
  })

  it('thinkCount 段为 chipn chip：mono + text-neutral-mid + hairline 边框（M3a demo .chipn 形态）', () => {
    const wrapper = mountMeta({ thinkCount: 3, toolCount: 0 })
    const seg = wrapper.find('.badge-think')
    expect(seg.exists()).toBe(true)
    // chip 形态：mono + mid 色 + tabular-nums + hairline 边框 + bg-input 底
    expect(seg.classes()).toContain('font-mono')
    expect(seg.classes()).toContain('text-neutral-mid')
    expect(seg.classes()).toContain('tabular-nums')
    expect(seg.classes()).toContain('border-hairline')
    expect(seg.classes()).toContain('bg-bg-input')
    // 非 rounded-full pill、无加粗
    expect(seg.classes()).not.toContain('bg-surface-2')
    expect(seg.classes()).not.toContain('rounded-full')
    expect(seg.classes()).not.toContain('font-medium')
    // 用户可见 DOM：计数值（chipn 无 `·` 前缀——demo chip 为独立边框件）
    expect(seg.text()).toContain('3')
    expect(seg.text()).not.toContain('·')
  })

  it('toolCount 段为 chipn chip：mono + text-neutral-mid + hairline 边框（M3a demo .chipn 形态）', () => {
    const wrapper = mountMeta({ thinkCount: 0, toolCount: 5 })
    const seg = wrapper.find('.badge-tool')
    expect(seg.exists()).toBe(true)
    // chip 形态：mono + mid 色 + tabular-nums + hairline 边框 + bg-input 底
    expect(seg.classes()).toContain('font-mono')
    expect(seg.classes()).toContain('text-neutral-mid')
    expect(seg.classes()).toContain('tabular-nums')
    expect(seg.classes()).toContain('border-hairline')
    expect(seg.classes()).toContain('bg-bg-input')
    // 非 rounded-full pill、无加粗
    expect(seg.classes()).not.toContain('bg-surface-2')
    expect(seg.classes()).not.toContain('rounded-full')
    expect(seg.classes()).not.toContain('font-medium')
    // 用户可见 DOM：计数值（chipn 无 `·` 前缀）
    expect(seg.text()).toContain('5')
    expect(seg.text()).not.toContain('·')
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

  it('streaming 态 + isWorkingTurn → 呼吸弧 loader 存在染 accent；状态字不染 accent（用户裁决 2026-10-06：状态字恒 text-neutral-dim）', () => {
    const wrapper = mountMeta({ isWorkingTurn: true, isStreaming: true })
    // loader 存在（M3a：Loader2 换呼吸弧 RUNNING_LOADER_SVG + animate-loader-spin），交互指示保留 accent
    const spinner = wrapper.find('.animate-loader-spin')
    expect(spinner.exists()).toBe(true)
    expect(spinner.classes()).toContain('text-accent')
    // 状态字恒暗灰 mono，working 态不再 accent
    const lbl = wrapper.find('.lbl')
    expect(lbl.classes()).not.toContain('text-accent')
    const status = wrapper.find('.tm-status')
    expect(status.classes()).toContain('text-neutral-dim')
    expect(status.classes()).toContain('font-mono')
  })

  it('完成态 → 无 loader + 状态字 text-neutral-dim（用户裁决 2026-10-06：状态字去彩色）', () => {
    const wrapper = mountMeta({ isWorkingTurn: false, isStreaming: false })
    expect(wrapper.find('.animate-loader-spin').exists()).toBe(false)
    expect(wrapper.find('.tm-status').classes()).toContain('text-neutral-dim')
    expect(wrapper.find('.tm-status').classes()).not.toContain('bg-surface-2')
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

  it.each(LONG_RUNS)('超长时长 %s 仍用中性配色（无 text-warn / text-danger；状态段统一 text-neutral-dim——用户裁决 2026-10-06）', (elapsed) => {
    const wrapper = mountMeta({ isWorkingTurn: true, isStreaming: true, elapsed })
    const elapsedEl = wrapper.find('.elapsed')
    expect(elapsedEl.text()).toBe(elapsed)
    // 状态段（.tm-status）随 M3a 保持暗灰底色（demo .workmeta dim 标签）；elapsed 强调走 mid
    // 色 + fw-mid（demo .workmeta b），warn/danger 分级配色不回归
    expect(wrapper.find('.tm-status').classes()).toContain('text-neutral-dim')
    expect(elapsedEl.classes().some((c) => c.includes('warn') || c.includes('danger'))).toBe(false)
    const spinner = wrapper.find('.animate-loader-spin')
    expect(spinner.exists()).toBe(true)
    expect(spinner.classes()).toContain('text-accent')
    expect(spinner.classes().some((c) => c.includes('warn') || c.includes('danger'))).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════
// [bg-notice-fold] settle 收纳折叠标签：
// 落成态状态字换为「已处理 …」分段（发生序去重 + · 连接），失败词标跨类型累计；
// 工作态维持「工作中」（临时外部行由 Turn 渲染，两形态不重复出现）。
// ui 包 i18n mock 回 key 本体（vitest.setup.ts），文案断言锚定键名 + 分段结构。
// ═════════════════════════════════════════════════════════
import type { FoldedNoticeRow } from '@taiji/core/domain/chat';
function foldedRow(over: Partial<FoldedNoticeRow> = {}): FoldedNoticeRow {
  return {
    type: 'bash',
    summary: 'pnpm test',
    fullText: 'pnpm test',
    outcome: 'success',
    id: 'task-1',
    ...over,
  }
}

describe('bg-notice-fold: TurnMeta settle 收纳折叠标签', () => {
  it('落成态：分段标签渲染 + 失败词标 + 类型词 testid（ui i18n mock 回 key）', () => {
    const turn = makeTurn()
    const wrapper = mount(TurnMeta, {
      props: {
        turn,
        isWorkingTurn: false,
        isStreaming: false,
        thinkCount: 0,
        toolCount: 0,
        elapsed: '4s',
        startedAt: NOW,
        endedAt: NOW + 4000,
        isLive: false,
        turnIndex: turn.index,
        turnKey: turnStableId(turn),
        sessionId: SID,
        foldedRows: [
          foldedRow({ type: 'bash', outcome: 'success', id: 't1' }),
          foldedRow({ type: 'bash', outcome: 'failed', id: 't2', summary: 'lint' }),
          foldedRow({ type: 'subagent', outcome: 'success', id: 'sa-1', summary: 'reviewer' }),
        ],
      },
      global: { provide: mockChatProvide() },
    })
    const lbl = wrapper.find('.lbl')
    // 分段 = 发生序去重（bash 只一段）+ · 分隔；键名即文案源（ui mock 回 key）
    expect(lbl.text()).toContain('panel.message.noticeFoldedBash')
    expect(lbl.text()).toContain('panel.message.noticeFoldedSubagent')
    expect(lbl.text()).toContain('·')
    // 类型词 testid（bash/subagent 两段；同类型去重后不重复）
    expect(wrapper.findAll('[data-testid="turn-meta-folded-type-bash"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="turn-meta-folded-type-subagent"]').exists()).toBe(true)
    // 失败词标（1 项失败，跨类型累计）+ warn 档
    const failTag = wrapper.find('[data-testid="turn-meta-folded-failed"]')
    expect(failTag.exists()).toBe(true)
    expect(failTag.text()).toContain('panel.message.noticeFoldFailedTag')
    expect(failTag.classes()).toContain('text-warn')
    // elapsed 段保留（收纳标签只替换状态字，时长沿用）
    expect(wrapper.find('.elapsed').text()).toBe('4s')
  })

  it('落成态全成功：无失败词标', () => {
    const turn = makeTurn()
    const wrapper = mount(TurnMeta, {
      props: {
        turn,
        isWorkingTurn: false,
        isStreaming: false,
        thinkCount: 0,
        toolCount: 0,
        elapsed: '2s',
        startedAt: NOW,
        endedAt: NOW + 2000,
        isLive: false,
        turnIndex: turn.index,
        turnKey: turnStableId(turn),
        sessionId: SID,
        foldedRows: [foldedRow({ outcome: 'success' })],
      },
      global: { provide: mockChatProvide() },
    })
    expect(wrapper.find('[data-testid="turn-meta-folded-failed"]').exists()).toBe(false)
  })

  it('工作态：状态字维持「工作中」（key），折叠分段与失败词标都不渲染', () => {
    const turn = makeTurn()
    const wrapper = mount(TurnMeta, {
      props: {
        turn,
        isWorkingTurn: true,
        isStreaming: true,
        thinkCount: 0,
        toolCount: 0,
        elapsed: '2s',
        startedAt: NOW,
        endedAt: NOW + 2000,
        isLive: true,
        turnIndex: turn.index,
        turnKey: turnStableId(turn),
        sessionId: SID,
        foldedRows: [foldedRow({ outcome: 'failed' })],
      },
      global: { provide: mockChatProvide() },
    })
    expect(wrapper.find('.lbl').text()).toBe('panel.message.working')
    expect(wrapper.find('[data-testid="turn-meta-folded-type-bash"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-meta-folded-failed"]').exists()).toBe(false)
  })
})

// ======================================================================
// ← TurnRail.test.ts
// ======================================================================

/**
 * 构造 rail 测试用 turn fixture。
 * 用 as MessageTurn 断言绕开完整 Message 字段需求（测试 fixture 允许，规范豁免）。
 */
function makeRailTurn(
  idx: number,
  opts: {
    userText?: string
    failed?: boolean
    userNull?: boolean
    /** assistant content（默认 '...'，置 '' 测空 content fallback 计数） */
    assistantContent?: string
    /** thinking 块数量（测 fallback 计数 N thoughts） */
    thinkingCount?: number
    /** toolCall 数量（测 fallback 计数 M tools；failed=true 时叠加 1 个失败 tool） */
    toolCount?: number
    /** user-only turn（assistants=[]，命令取消 / 纯 notify 命令残留形态，测占位门 D1） */
    userOnly?: boolean
    /** [chat-flow-consistency C5] streaming 态 turn（loader 判据 = sessionActive ∧ isStreaming） */
    isStreaming?: boolean
  } = {},
): MessageTurn {
  // thinking 块数组（每块 content 非空）
  const thinking = opts.thinkingCount
    ? Array.from({ length: opts.thinkingCount }, (_, i) => ({
        id: `th${idx}-${i}`,
        content: `thinking ${i}`,
        collapsed: true,
      }))
    : undefined
  // toolCalls 数组（含 failed flag 时追加一个 error tool）
  const baseTools = opts.toolCount
    ? Array.from({ length: opts.toolCount }, (_, i) => ({
        id: `tc${idx}-${i}`,
        toolName: 'read',
        input: { path: `f${i}.ts` },
        status: 'done' as const,
        startTime: 0,
      }))
    : []
  const failTool = opts.failed
    ? [{
        id: `tc${idx}-fail`,
        toolName: 'fail',
        input: {},
        status: 'error' as const,
        startTime: 0,
      }]
    : []
  const toolCalls = [...baseTools, ...failTool]
  return {
    index: idx,
    user: opts.userNull
      ? null
      : ({
          id: `u${idx}`,
          role: 'user',
          content: opts.userText ?? `turn ${idx}`,
          status: 'done',
        } as unknown as Message),
    assistants: opts.userOnly
      ? []
      : [
          {
            id: `a${idx}`,
            role: 'assistant',
            content: opts.assistantContent ?? '...',
            status: opts.isStreaming ? 'streaming' : 'done',
            thinking,
            toolCalls,
          } as unknown as Message,
        ],
    isStreaming: opts.isStreaming ?? false,
    hasFoldable: opts.failed ?? ((toolCalls.length > 0) || (thinking !== undefined)),
  } as MessageTurn
}

/** 默认 mount props（3 turn 场景），测试用例可 override。 */
function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    turns: [makeRailTurn(0), makeRailTurn(1), makeRailTurn(2)],
    activeTurnIndex: 0,
    sessionActive: false,
    ...overrides,
  }
}

describe('TurnRail (IF4)', () => {
  it('TC-w3-1: turns 为空时不渲染 rail', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ turns: [] }) })
    expect(wrapper.find('[data-testid="turn-rail"]').exists()).toBe(false)
  })

  it('TC-w3-2: 3 turns → 渲染 3 个 rail-node，每个含 agent-icon + 摘要 + toggle', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    expect(nodes).toHaveLength(3)
    for (const node of nodes) {
      expect(node.find('[data-testid="rail-agent-icon"]').exists()).toBe(true)
      expect(node.find('[data-testid="rail-toggle"]').exists()).toBe(true)
      // 摘要文本应非空（默认 fixture 用 "turn N"）
      expect(node.text().length).toBeGreaterThan(0)
    }
  })

  it('TC-w3-3: 点 rail-node[1] 文本区 → emit jump(1)，不 emit toggle', async () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    // 点节点本身（文本区，非 toggle）—— trigger click on the node div
    await nodes[1].trigger('click')
    expect(wrapper.emitted('jump')).toBeTruthy()
    expect(wrapper.emitted('jump')![0]).toEqual([1])
    expect(wrapper.emitted('toggle')).toBeFalsy()
  })

  it('TC-w3-4: 点 rail-node[1] 的 toggle → emit toggle(1)，不 emit jump（stopPropagation）', async () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    await toggles[1].trigger('click')
    expect(wrapper.emitted('toggle')).toBeTruthy()
    expect(wrapper.emitted('toggle')![0]).toEqual([1])
    // toggle click 用 .stop 阻断冒泡，不应触发 rail-node 的 jump
    expect(wrapper.emitted('jump')).toBeFalsy()
  })

  it('TC-w3-5: sessionActive=true → 所有 rail-toggle 禁用', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ sessionActive: true }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    expect(toggles).toHaveLength(3)
    for (const toggle of toggles) {
      // Button disabled 渲染为 button[disabled] 或 component 属性
      const button = toggle.element as HTMLElement
      // vue test-utils + Button.vue：disabled 属性会反映到 DOM
      expect(button.hasAttribute('disabled') || (button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('TC-w3-7: activeTurnIndex=1 → rail-node[1] 含 active 类，rail-node[0] 不含', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 1 }) })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    expect(nodes[1].classes()).toContain('active')
    expect(nodes[0].classes()).not.toContain('active')
  })

  it('TC-w3-8: agent-icon 颜色反映状态（done=text-neutral-ico / failed=text-danger 常驻 / streaming=呼吸弧 loader-spin + 选中 fg-2 提色）', () => {
    // 灰阶化（W2，§13.2-C + CL5 修正）+ M3a demo 选中形态（workbench.css .rail-node.on
    // .rail-row svg：选中节点图标提 fg-2，弧随选中非 accent）：
    // [chat-flow-consistency C5] loader 判据 = sessionActive ∧ turn.isStreaming（回合数据派生）：
    // turn0: done（无失败）→ neutral-ico；turn1: failed → danger（常驻，优先于选中提色）；
    // turn2: streaming（选中提色的呼吸弧 loader-spin，span，非 Bot svg）+ fg-2
    const turns = [
      makeRailTurn(0, { failed: false }),
      makeRailTurn(1, { failed: true }),
      makeRailTurn(2, { failed: false, isStreaming: true }),
    ]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, activeTurnIndex: 2, sessionActive: true }),
    })
    const icons = wrapper.findAll('[data-testid="rail-agent-icon"]')
    // done turn → text-neutral-ico（完成态中性灰 ICON 色）
    expect(icons[0].classes()).toContain('text-neutral-ico')
    // failed turn → text-danger（agentIconClass hasFailedTool 分支，§5.6B 常驻红）
    expect(icons[1].classes()).toContain('text-danger')
    // streaming turn → animate-loader-spin（呼吸弧微缩 loader，进行中信号）+ 选中 fg-2（demo 权威）
    expect(icons[2].classes()).toContain('animate-loader-spin')
    expect(icons[2].classes()).toContain('text-[color:var(--neutral-fg-2)]')
  })

  it('TC-w3-21 [C5]: loader 从回合数据派生——非选中 streaming turn 显呼吸弧，选中非 streaming turn 显 Bot（视口高亮不再驱动 loader）', () => {
    // 双工作态过渡形态（D2）：旧回合（idx=0）仍 streaming，视口/选中在新回合（idx=2）——
    // 旧判据（sessionActive ∧ idx===activeTurnIndex）会把 loader 显在 idx=2（错误节点）；
    // 新判据 loader 跟随 streaming 回合，viewport indicator / 选中高亮保持视口派生。
    const turns = [
      makeRailTurn(0, { isStreaming: true }),
      makeRailTurn(1),
      makeRailTurn(2),
    ]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, activeTurnIndex: 2, sessionActive: true }),
    })
    const icons = wrapper.findAll('[data-testid="rail-agent-icon"]')
    // streaming 的非选中回合 → 呼吸弧 loader（数据派生）
    expect(icons[0].classes()).toContain('animate-loader-spin')
    // 选中（视口首项）但非 streaming → Bot 图标（不含 loader-spin）
    expect(icons[2].classes()).not.toContain('animate-loader-spin')
    expect(icons[2].element.tagName.toLowerCase()).toBe('svg')
    // 选中高亮保持视口派生：idx=2 节点仍带 active 类（indicator/高亮语义不变）
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    expect(nodes[2].classes()).toContain('active')
  })

  it('TC-w3-22 [C5]: 双工作态并存期两个 streaming 回合各显 loader', () => {
    const turns = [
      makeRailTurn(0, { isStreaming: true }),
      makeRailTurn(1),
      makeRailTurn(2, { isStreaming: true }),
    ]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, activeTurnIndex: 1, sessionActive: true }),
    })
    const icons = wrapper.findAll('[data-testid="rail-agent-icon"]')
    expect(icons[0].classes()).toContain('animate-loader-spin')
    expect(icons[2].classes()).toContain('animate-loader-spin')
    expect(icons[1].classes()).not.toContain('animate-loader-spin')
  })

  it('TC-w3-23 [C5]: sessionActive=false 时 streaming 回合不显 loader（会话已结束不谎报进行中）', () => {
    const turns = [makeRailTurn(0, { isStreaming: true })]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, sessionActive: false }),
    })
    const icons = wrapper.findAll('[data-testid="rail-agent-icon"]')
    expect(icons[0].classes()).not.toContain('animate-loader-spin')
  })

  it('TC-w3-20: 选中节点 = demo Tier B 行类范式（无底无框仅文字提亮）：无 elevated 底/inset accent 左标，节点与 agent 摘要提 text-neutral-fg，hover 底为全节点共有', () => {
    // MF-2-1（r2）：选中范式反向收编——旧形态（bg-bg-elevated 底 + inset 2px accent 左标）
    // 与 demo 权威相反（workbench.css:727 .rail-node.on{color:var(--fg)} + :291 收编注释
    // Tier B「无底无框仅文字提亮」）；hover 底 demo .rail-node:hover 无条件命中（含选中项）。
    const turns = [makeRailTurn(0), makeRailTurn(1), makeRailTurn(2, { failed: true })]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, activeTurnIndex: 1, sessionActive: false }),
    })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    // 旧范式负断言（防回归）
    expect(nodes[1].classes()).not.toContain('bg-bg-elevated')
    expect(nodes[1].classes().some((c) => c.startsWith('shadow-[inset_2px'))).toBe(false)
    // Tier B 文字提亮：选中节点文字 text-neutral-fg
    expect(nodes[1].classes()).toContain('text-neutral-fg')
    // hover 底 = 全节点共有基础类（选中与非选中都在）
    expect(nodes[0].classes()).toContain('hover:bg-surface-hover')
    expect(nodes[1].classes()).toContain('hover:bg-surface-hover')
    // agent 摘要文字：选中节点提 fg（failed 不挡选中提亮——failed 信号由图标 danger 常驻承担）
    const summaryClasses = (i: number): string[] => {
      const agentRow = nodes[i].findAll(':scope > div')[1]
      return agentRow.findAll('span').find((s) => s.classes().includes('flex-1'))!.classes()
    }
    expect(summaryClasses(1)).toContain('text-neutral-fg')
    // 未选中普通摘要 mid；未选中 failed 摘要 mid + hover 提亮（real 超集语义）
    expect(summaryClasses(0)).toContain('text-neutral-mid')
    expect(summaryClasses(2)).toContain('text-neutral-mid')
    expect(summaryClasses(2)).toContain('hover:text-neutral-fg')
  })

  it('TC-w3-9: toggle 默认 opacity-0（hover 浮出）；非 active 节点非 hover 时隐藏', () => {
    // 注：hover 浮出行为由 Tailwind group-hover 编译时保证，happy-dom 无法触发真实 hover。
    // 本用例只验静态 class 存在，hover 视觉转换需 E2E/视觉回归补充。
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 0 }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    expect(toggles).toHaveLength(3)
    // idx=1 非 active：toggle 含 opacity-0 class（默认隐藏，hover 才浮出）
    expect(toggles[1].classes()).toContain('opacity-0')
  })

  it('TC-w3-10: active 节点的 toggle 常驻可见（!opacity-100，非 hover 也能看到）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps({ activeTurnIndex: 1 }) })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    // idx=1 是 active：toggle 含 !opacity-100（常驻可见，用户决策）
    expect(toggles[1].classes()).toContain('!opacity-100')
    // idx=0 非 active：仍是 opacity-0
    expect(toggles[0].classes()).toContain('opacity-0')
  })

  it('TC-w3-11: expandedTurns 含稳定 key u1 时，idx=1 的 toggle data-expanded=true，其余 false', () => {
    const wrapper = mount(TurnRail, {
      props: defaultProps({ expandedTurns: new Set(['u1']) }),
    })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    // turns fixture：makeRailTurn(0/1/2) → turn.user.id = u0/u1/u2（M5 stable-key，
    // expandedTurns 集合按 turnStableId 索引，非 MessageTurn.index）
    // expandedTurns={u1} → idx=1 展开态（ChevronUp），idx=0/2 折叠态（ChevronDown）
    expect(toggles[0].attributes('data-expanded')).toBe('false')
    expect(toggles[1].attributes('data-expanded')).toBe('true')
    expect(toggles[2].attributes('data-expanded')).toBe('false')
  })

  it('TC-w3-12: 未传 expandedTurns 时，所有 toggle data-expanded=false（默认折叠态）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    for (const toggle of toggles) {
      expect(toggle.attributes('data-expanded')).toBe('false')
    }
  })

  it('TC-w3-11b [chat-flow-consistency D2]: 工作展开态数据派生——sessionActive 时 streaming 回合与真末位显示已展开，视口激活的非工作回合不谎报', () => {
    // D2 双工作态形态：turns[1] streaming（插话回流后旧回合未收尾），turns[2] 真末位
    // pending 占位（userOnly，无 streaming assistant）；用户上翻使视口激活节点 = 0。
    const turns = [makeRailTurn(0), makeRailTurn(1, { isStreaming: true }), makeRailTurn(2, { userOnly: true })]
    const wrapper = mount(TurnRail, {
      props: defaultProps({ turns, activeTurnIndex: 0, sessionActive: true }),
    })
    const toggles = wrapper.findAll('[data-testid="rail-toggle"]')
    // idx=0：视口激活但非末位非 streaming → 流内实际折叠，图标如实显示折叠
    //（修复前 isTurnExpanded 以 activeTurnIndex 强制已展开，与流内不一致）
    expect(toggles[0].attributes('data-expanded')).toBe('false')
    // idx=1：streaming 回合 → 流内工作展开（Turn isWorkingTurn 同构判据），图标已展开
    expect(toggles[1].attributes('data-expanded')).toBe('true')
    // idx=2：真末位（占位 turn 尚无 streaming assistant）→ 流内强制展开，图标已展开
    expect(toggles[2].attributes('data-expanded')).toBe('true')
  })

  it('TC-w3-13: 节点含两行——user 行（User 图标）+ agent 行（Bot 图标）', () => {
    const wrapper = mount(TurnRail, { props: defaultProps() })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    // 两行 div（user 行 + agent 行），flex-col 垂直排列
    const rows = node.findAll(':scope > div')
    expect(rows).toHaveLength(2)
    // user 行含 User 图标（lucide 渲染为 svg，class 含 lucide-user）
    expect(rows[0].find('svg').exists()).toBe(true)
    // agent 行含 Bot 图标 + rail-agent-icon testid
    const agentIcon = node.find('[data-testid="rail-agent-icon"]')
    expect(agentIcon.exists()).toBe(true)
    expect(agentIcon.element.tagName.toLowerCase()).toBe('svg')
  })

  it('TC-w3-14: 无 user turn（首条 assistant）→ user 行不渲染，只显 agent 行', () => {
    const turns = [makeRailTurn(0, { userNull: true, assistantContent: '这是 assistant 回复' })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    const rows = node.findAll(':scope > div')
    // 只有一行（agent 行），user 行被 v-if="turn.user" 省略
    expect(rows).toHaveLength(1)
    expect(node.find('[data-testid="rail-agent-icon"]').exists()).toBe(true)
  })

  it('TC-w3-15: agent 摘要文本优先——assistant 有 content 时显示 content 截断', () => {
    const turns = [makeRailTurn(0, { assistantContent: '修复了 Block.vue 的折叠状态同步问题' })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    // agent 行（第二行）文本应含 assistant content 内容
    const rows = node.findAll(':scope > div')
    const agentRowText = rows[1].text()
    expect(agentRowText).toContain('修复了 Block.vue')
  })

  it('TC-w3-16: agent 摘要 fallback 计数——空 content + thinking/tools 时显示 N thoughts · M tools', () => {
    const turns = [makeRailTurn(0, { assistantContent: '', thinkingCount: 2, toolCount: 3 })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[0]
    const rows = node.findAll(':scope > div')
    const agentRowText = rows[1].text()
    // fallback 计数：2 thoughts · 3 tools
    expect(agentRowText).toContain('2 thoughts')
    expect(agentRowText).toContain('3 tools')
  })

  // ---- 占位门 TC-w3-17/18/19（D1：isPlaceholderVisible = sessionActive ∧ 真末位）----
  // 占位 DOM 文本 = t('panel.message.railInProgress')，vitest.setup.ts mock 下返回 key 本身。
  // 19 是防旧判据（isActiveTurn = sessionActive ∧ idx===activeTurnIndex）假绿的核心锁，
  // 三元组构造固定：被测 idx == activeTurnIndex 同值且 idx ≠ 末位（详见各用例注释）。

  it('TC-w3-17: sessionActive=false + 末位 user-only turn（assistants=[]）→ 无占位文本，显示 fallback', () => {
    // 三元组：被测 idx=2 == 末位(turns.length-1)；activeTurnIndex=0(defaultProps)；sessionActive=false
    const turns = [makeRailTurn(0), makeRailTurn(1), makeRailTurn(2, { userOnly: true })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[2]
    expect(node.text()).not.toContain('panel.message.railInProgress')
    // fallback = ' '（D2 空格兜底）→ agent 行文本 trim 后为空
    const rows = node.findAll(':scope > div')
    expect(rows[1].text().trim()).toBe('')
  })

  it('TC-w3-18: sessionActive=true + 末位 assistants=[] → 显示「进行中…」占位', () => {
    // 三元组：被测 idx=2 == 末位(turns.length-1)；activeTurnIndex=0(defaultProps，≠末位)；sessionActive=true
    // activeTurnIndex 不在末位 → 断言同时锁住「占位不依赖视口语义」（D1 与 isActiveTurn 分离）
    const turns = [makeRailTurn(0), makeRailTurn(1), makeRailTurn(2, { userOnly: true })]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns, sessionActive: true }) })
    const node = wrapper.findAll('[data-testid="rail-node"]')[2]
    const rows = node.findAll(':scope > div')
    expect(rows[1].text()).toContain('panel.message.railInProgress')
  })

  it('TC-w3-19: sessionActive=true + 3 turn 阵 + 非末位 user-only turn（idx==activeTurnIndex）→ 无占位（防旧判据假绿）', () => {
    // 三元组固定：被测 idx=0 == activeTurnIndex=0(defaultProps 同值) 且 idx ≠ 末位(2)；sessionActive=true
    // ——旧判据 isActiveTurn(sessionActive ∧ idx===activeTurnIndex) 在此构造判 true 会显占位 =
    // 假绿复现（设计 U2 明示：若 idx 恰为末位或传 activeTurnIndex=末位，旧判据同绿）。
    const turns = [makeRailTurn(0, { userOnly: true }), makeRailTurn(1), makeRailTurn(2)]
    const wrapper = mount(TurnRail, { props: defaultProps({ turns, sessionActive: true }) })
    const nodes = wrapper.findAll('[data-testid="rail-node"]')
    const node = nodes[0]
    expect(node.text()).not.toContain('panel.message.railInProgress')
    const rows = node.findAll(':scope > div')
    expect(rows[1].text().trim()).toBe('')
    // 全阵无占位：turns[1]/turns[2] 有 assistant 内容（agentSummary 非空不走占位分支），
    // turns[0] 门关 → 整条 rail 均不应出现占位 key
    expect(wrapper.find('[data-testid="turn-rail"]').text()).not.toContain('panel.message.railInProgress')
  })
})

// ======================================================================
// ← useTurnElapsed.test.ts
// ======================================================================

/** 测试起点系统时间（任意固定值） */
const T0 = 1_000_000

function makeAssistant(timestamp: number, content = 'text', overrides: Partial<Message> = {}): Message {
  return { id: `a-${timestamp}`, role: 'assistant', content, status: 'streaming', timestamp, ...overrides }
}

/** 最小合法 MessageTurn（聚合派生只读 user / assistants 两个字段） */
function makeTurn_m2(userTs: number | null, assistants: Message[]): MessageTurn {
  return {
    index: 1,
    user: userTs === null ? null : { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'q' }], status: 'complete', timestamp: userTs },
    assistants,
    isStreaming: assistants.some((a) => a.status === 'streaming'),
    hasFoldable: false,
  }
}

/** mock document.hidden / visibilityState（happy-dom 下 spyOn getter 生效） */
function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}

/** 模拟浏览器可见性变化事件 */
function fireVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

/**
 * mount 宿主组件驱动 useTurnElapsed（onUnmounted/watch 需组件实例）。
 * @param getAggregates 聚合事实 getter（测试直接给 TurnAggregates 或经 deriveTurnAggregates）
 * @param running 本 turn 是否进行中（驱动秒级 tick 与 isLive）
 * [chat-flow-consistency C3] getIsSessionActive / onComplete 参数已随 Turn.vue 接线退役，
 * mount 不再传入（签名双参）。
 */
function mountElapsed(
  getAggregates: () => TurnAggregates,
  running: Ref<boolean>,
) {
  const exposed = {} as {
    elapsed: Ref<string>
    isLive: Ref<boolean>
    generatedTokens: Ref<number>
  }
  const Host = defineComponent({
    setup() {
      const result = useTurnElapsed(
        getAggregates,
        () => running.value,
      )
      Object.assign(exposed, result)
      return () => null
    },
  })
  const wrapper = mount(Host)
  return { wrapper, exposed }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  setHidden(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ═════════════════════════════════════════════════════════════
// 整 turn 墙钟口径（核心修复：状态行 = 整个 agent-turn 聚合）
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed 整 turn 墙钟', () => {
  it('单条 assistant 定格 = endedAt − startedAt（回归：旧实现两条时间戳同源 → 恒显 1s）', () => {
    const start = T0
    const end = T0 + 6_800
    const aggregates: TurnAggregates = { startedAt: start, endedAt: end, generatedTokens: 322 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('7s')
    wrapper.unmount()
  })

  it('endedAt 缺失（旧历史帧）→ 回退聚合终点（= 修复前行为，不崩不虚高）', () => {
    const aggregates: TurnAggregates = { startedAt: T0, endedAt: T0, generatedTokens: 10 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('进行中每秒 tick 增长（now − 起点）', () => {
    const aggregates: TurnAggregates = { startedAt: T0, endedAt: 0, generatedTokens: 5 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(true))
    expect(exposed.elapsed.value).toBe('1s') // 挂载即 now − 起点 = 0 → min 1s
    vi.advanceTimersByTime(4_000)
    expect(exposed.elapsed.value).toBe('4s')
    wrapper.unmount()
  })

  it('工具执行 / 等待用户输入期间计时连续（含工具与等待的墙钟）', () => {
    // turn 进行中（工作 turn）→ tick 持续，期间无任何文本 delta，elapsed 仍持续增长
    const assistants = [makeAssistant(T0, '先读文件')]
    const turn = makeTurn_m2(T0 - 200, assistants)
    const aggregates = () => deriveTurnAggregates(turn)
    const { wrapper, exposed } = mountElapsed(aggregates, ref(true))
    expect(exposed.elapsed.value).toBe('1s')
    vi.advanceTimersByTime(40_000) // 40s 工具执行
    expect(exposed.elapsed.value).toBe('40s') // 计时未被工具期截断
    wrapper.unmount()
  })

  it('定格不回跳：endedAt 落定瞬间定格值 = 末帧 live 值（不再退化成 1s）', async () => {
    const assistants = ref<Message[]>([makeAssistant(T0, 'abc')])
    const turn = () => makeTurn_m2(null, assistants.value)
    const running = ref(true)
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(turn()), running)
    vi.advanceTimersByTime(12_000)
    expect(exposed.elapsed.value).toBe('12s')

    // 收尾：写入产出结束时刻（墙钟 12.4s 处）→ running false → 定格
    assistants.value = [{ ...assistants.value[0], status: 'complete', endedAt: T0 + 12_400 }]
    running.value = false
    await nextTick()
    expect(exposed.elapsed.value).toBe('12s') // 定格值 = 真实墙钟（旧实现此处回跳成 1s）
    wrapper.unmount()
  })

  it('生成 token 总量 = Σ usage.outputTokens（跨 assistant 段），随聚合值反应式更新', () => {
    const assistants = ref<Message[]>([
      makeAssistant(T0, 'abc', { usage: { inputTokens: 10, outputTokens: 120 } }),
      makeAssistant(T0 + 1000, 'de', { usage: { inputTokens: 5, outputTokens: 41 } }),
    ])
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn_m2(null, assistants.value)), ref(true))
    expect(exposed.generatedTokens.value).toBe(161)

    assistants.value = [assistants.value[0], { ...assistants.value[1], usage: { inputTokens: 5, outputTokens: 60 } }]
    expect(exposed.generatedTokens.value).toBe(180)
    wrapper.unmount()
  })

  it('无 usage 的段（live 流式中）计入 0 → 数字只反映已上报真值，收尾后跳完整值', () => {
    const first = makeAssistant(T0, 'ab', { usage: { inputTokens: 10, outputTokens: 122 } })
    const streaming = makeAssistant(T0 + 1, '正在写')
    const assistants = ref<Message[]>([first, streaming])
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn_m2(null, assistants.value)), ref(true))
    expect(exposed.generatedTokens.value).toBe(122) // 当前段未上报 → 不估算

    assistants.value = [first, { ...streaming, usage: { inputTokens: 3, outputTokens: 39 } }]
    expect(exposed.generatedTokens.value).toBe(161) // 收尾 → 完整值
    wrapper.unmount()
  })

  it('起点取 user 消息时间戳（整 turn 从用户发送算起，不从首条 assistant 算起）', () => {
    const userTs = T0
    const assistants = [makeAssistant(T0 + 3_000, 'abc', { status: 'complete', endedAt: T0 + 9_000 })]
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn_m2(userTs, assistants)), ref(false))
    expect(exposed.elapsed.value).toBe('9s')
    wrapper.unmount()
  })

  it('空 turn（无 user / 无 assistant）→ 0s / 0 tokens / startedAt 0', () => {
    const aggregates: TurnAggregates = { startedAt: 0, endedAt: 0, generatedTokens: 0 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('0s')
    expect(exposed.generatedTokens.value).toBe(0)
    wrapper.unmount()
  })
})

// ═════════════════════════════════════════════════════════════
// 可见性停表（Q1-7）
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed 可见性停表（Q1-7）', () => {
  it('可见 + 进行中：每秒 tick 正常推进 elapsed（基线回归）', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    vi.advanceTimersByTime(3_000)
    expect(exposed.elapsed.value).toBe('3s')
    wrapper.unmount()
  })

  it('失焦停止每秒 tick：hidden 后推进 10s，elapsed 不更新（interval 回调不触发）', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    setHidden(true)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)

    // tick 已停：Date.now 已推进 10s，但 elapsed 仍为定格值
    expect(Date.now()).toBe(T0 + 10_000)
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('失焦期间开始计时（running true）：不挂 interval（hidden 下 startElapsedTimer 只立即算一次）', async () => {
    const running = ref(false)
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: T0, generatedTokens: 0 }), running)
    expect(exposed.elapsed.value).toBe('1s')

    setHidden(true)
    running.value = true
    await nextTick() // watch flush:pre → startElapsedTimer（hidden 分支不挂 interval）

    vi.advanceTimersByTime(10_000)
    // 无 tick：elapsed 停在 hidden 进入时的值
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('恢复可见：elapsed 立即以 Date.now() 差值补算失焦期间耗时，并重启每秒 tick', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))

    setHidden(true)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)
    expect(exposed.elapsed.value).toBe('1s') // 失焦期间未更新

    setHidden(false)
    fireVisibilityChange()
    // 补算：now-start = 10s（Date.now 差值覆盖失焦期间）
    expect(exposed.elapsed.value).toBe('10s')

    // tick 已重启：继续每秒推进
    vi.advanceTimersByTime(2_000)
    expect(exposed.elapsed.value).toBe('12s')
    wrapper.unmount()
  })

  it('失焦期间 turn 收尾定格：恢复可见不误重启 tick（running 已 false）', async () => {
    const running = ref(true)
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: T0 + 5_000, generatedTokens: 0 }), running)

    setHidden(true)
    fireVisibilityChange()

    running.value = false
    await nextTick()
    const frozen = exposed.elapsed.value

    setHidden(false)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)

    expect(exposed.elapsed.value).toBe(frozen)
    wrapper.unmount()
  })

  it('卸载：移除 visibilitychange listener + 清 interval（无泄漏）', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    wrapper.unmount()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    vi.advanceTimersByTime(10_000)
    expect(exposed.elapsed.value).toBe('1s')
    expect(() => fireVisibilityChange()).not.toThrow()
  })

  it('完成态实例零 listener：未开始计时不挂 visibilitychange（W05 review，N 实例不叠 N listener）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const { wrapper } = mountElapsed(() => ({ startedAt: T0, endedAt: T0 + 3_000, generatedTokens: 0 }), ref(false))
    expect(addSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    wrapper.unmount()
  })

  it('listener 生命周期与进行中态对齐：开始计时挂载、收尾定格摘除、二次周期不叠加', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const addedCount = () => addSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length
    const removedCount = () => removeSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length

    const running = ref(false)
    const { wrapper } = mountElapsed(() => ({ startedAt: T0, endedAt: T0, generatedTokens: 0 }), running)
    expect(addedCount()).toBe(0) // 初始完成态：零 listener

    running.value = true
    await nextTick()
    expect(addedCount()).toBe(1)

    running.value = false
    await nextTick()
    expect(removedCount()).toBe(1)

    running.value = true
    await nextTick()
    running.value = false
    await nextTick()
    expect(addedCount()).toBe(2)
    expect(removedCount()).toBe(2)
    wrapper.unmount()
  })
})

// ═════════════════════════════════════════════════════════════
// 完成收起回调退役（[chat-flow-consistency C3] 净删回归锁）
// ═════════════════════════════════════════════════════════════
// C3 退役 onComplete / getIsSessionActive 参数：工作回合的收起由派生完成（isWorkingTurn 翻
// false → showTrace = isExpanded），显式 collapse 的唯一净效果是清挂载回合的手动展开态
// （有害无益）。本 describe 只保留「签名收敛」断言——composable 不再接收/触发收起回调，
// 回归保护点 = Turn.vue 侧的手动展开保持（turn-working.test.ts / Turn.test.ts 挂载族）。
describe('useTurnElapsed 完成收起回调退役（C3）', () => {
  it('签名双参收敛：不再暴露任何收起回调面（返回集 = elapsed/startedAt/endedAt/isLive/generatedTokens）', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))
    expect(Object.keys(exposed).sort()).toEqual(['elapsed', 'endedAt', 'generatedTokens', 'isLive', 'startedAt'])
    wrapper.unmount()
  })
})
