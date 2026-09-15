/**
 * A42/A43 trace 视图与行渲染单测（trace-ui）。
 *
 * A42 SegmentedTab「对话 | Trace」per-pane 视图状态：
 * - PanelHeader 渲染 toggle（两段，chat 默认激活）
 * - 切换只改 store 分区 view 字段：不重发 RPC（数据不重建）
 * - TraceView 卸载（切回对话）再挂载：过滤/选中状态保留 + 仍不重拉
 *
 * A43 行组件渲染：
 * - 12 kind + MALFORMED 行摘要齐全（§3.4 渲染模型表）
 * - 影子化降透明（shadowed 行 opacity 类 + data-shadowed）
 * - 选中态 surface-hover + 强调字色（无 ring，v6 §3.4 列表项型 + SearchModal sm-item 例外）
 * - >500 虚拟滚动启用（不全量渲染）；≤500 全量
 * - BASH meta excludeFromContext（core 小改）行内「不进上下文」注记
 * - kind chips / 搜索 / 仅当前 context toggle / context 分界行
 *
 * 三视角：构建者（fixture 快照驱动 rows 派生）/ 使用者（点击 toggle/行/chip 交互）/
 * 观察者（data-testid + data-kind + class DOM 断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-trace/trace-view.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import type { ServerMessageMap } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'

// ── mock '@/api' 门面（store 只消费 session.getTraceEntries / fetchCurrentSystemPrompt）──
const apiMock = vi.hoisted(() => ({
  getTraceEntries: vi.fn(),
  fetchCurrentSystemPrompt: vi.fn(),
}))
vi.mock('@/api', () => ({
  session: {
    getTraceEntries: apiMock.getTraceEntries,
    fetchCurrentSystemPrompt: apiMock.fetchCurrentSystemPrompt,
  },
}))

// ── mock useTraceJump（TraceView 溯源链接只验证事件编排链路，真实编排归 useTraceJump.test.ts）──
const jumpMock = vi.hoisted(() => ({ jumpToParentSession: vi.fn() }))
vi.mock('@/composables/features/trace/useTraceJump', () => ({
  jumpToParentSession: jumpMock.jumpToParentSession,
}))

import PanelHeader from '@/components/panel/PanelHeader.vue'
import TraceView from '@/components/panel/trace/TraceView.vue'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  ensureTraceLoaded,
  revealTraceEntry,
  selectTraceEntry,
  setTraceFilter,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'

const SID = 'sid-trace-view-1'

/** 12 kind + MALFORMED 全覆盖 fixture（线性链 u1→…→u3，compaction c1 firstKept=u2）。 */
function buildFullKindsSnapshot(): ServerMessageMap['session.traceEntries'] {
  const entries: unknown[] = [
    { type: 'custom', id: 'sp1', parentId: null, customType: 'xyz:system-prompt', data: { version: 2, reason: 'resume', hash: 'aabbcc', charCount: 12702 } },
    { type: 'message', id: 'u1', parentId: 'sp1', message: { role: 'user', content: '修一下重试逻辑' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', provider: 'p', model: 'm-pro', usage: { input: 21318, output: 160, cacheRead: 192, cost: { total: 0 } }, content: [{ type: 'thinking', thinking: '先定位问题\n再改代码' }, { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.ts' } }, { type: 'text', text: 'done' }] } },
    { type: 'message', id: 'tr1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', isError: false, content: 'file body' } },
    { type: 'message', id: 'b1', parentId: 'tr1', message: { role: 'bashExecution', command: 'npm test', output: 'FAIL', exitCode: 1, excludeFromContext: true } },
    { type: 'custom_message', id: 'cm1', parentId: 'b1', customType: 'demo:notice', content: '通知内容', display: true },
    { type: 'message', id: 'u2', parentId: 'cm1', message: { role: 'user', content: '继续保留区' } },
    { type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant', provider: 'p', model: 'm-pro', content: [{ type: 'text', text: '保留区回复' }] } },
    { type: 'compaction', id: 'c1', parentId: 'a2', summary: '压缩摘要正文', firstKeptEntryId: 'u2', tokensBefore: 152311 },
    { type: 'branch_summary', id: 'bs1', parentId: 'c1', fromId: 'u1', summary: '分支摘要正文' },
    { type: 'model_change', id: 'mc1', parentId: 'bs1', provider: 'xiaomi', modelId: 'm-pro' },
    { type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', thinkingLevel: 'max' },
    { type: 'session_info', id: 'si1', parentId: 'tl1', name: 'demo' },
    { type: 'label', id: 'l1', parentId: 'si1', targetId: 'u2', label: 'checkpoint' },
    { type: 'custom', id: 'cd1', parentId: 'l1', customType: 'demo:data', data: { k: 1 } },
    { type: 'message', id: 'u3', parentId: 'cd1', message: { role: 'user', content: 'leaf 消息' } },
    { type: 'handoff_marker', handedOffTo: 'sid-next' },
  ]
  return {
    sessionId: SID,
    source: 'file',
    header: { type: 'session', version: 1, id: 'h0', cwd: '/w/demo' },
    entries,
    malformed: [{ lineNumber: 3, raw: 'not json' }],
    sessionEnd: { type: 'session_end', outcome: 'done' },
    leafId: 'u3',
  }
}

async function mountTraceView(sid = SID): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(TraceView, { props: { sessionId: sid } })
  await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('ready'))
  return wrapper
}

function findRows(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('[data-testid^="trace-row-"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getTraceEntries.mockReset()
  apiMock.getTraceEntries.mockResolvedValue(buildFullKindsSnapshot())
  _resetTraceStoreForTest()
  setActivePinia(createPinia())
  bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
})

describe('A42 SegmentedTab 对话|Trace per-pane 视图状态', () => {
  it('PanelHeader 渲染「对话 | Trace」toggle，默认对话段激活', () => {
    const wrapper = mount(PanelHeader, {
      props: { sessionLabel: 't', sessionDir: '/w', status: 'done' as DerivedStatus, sessionId: SID },
    })
    expect(wrapper.find('[data-testid="trace-view-toggle"]').exists()).toBe(true)
    const chatBtn = wrapper.find('[data-testid="trace-view-toggle-chat"]')
    const traceBtn = wrapper.find('[data-testid="trace-view-toggle-trace"]')
    expect(chatBtn.exists() && traceBtn.exists()).toBe(true)
    expect(chatBtn.attributes('aria-pressed')).toBe('true')
    expect(traceBtn.attributes('aria-pressed')).toBe('false')
  })

  it('切换到 Trace：仅改 view 字段（数据不重拉），切回对话再切回状态保留', async () => {
    // 预加载（模拟此前打开过 Trace）
    ensureTraceLoaded(SID)
    await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('ready'))
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    const wrapper = mount(PanelHeader, {
      props: { sessionLabel: 't', sessionDir: '/w', status: 'done' as DerivedStatus, sessionId: SID },
    })
    // 点 Trace 段 → view=trace；不发新 RPC（数据已在分区）
    await wrapper.find('[data-testid="trace-view-toggle-trace"]').trigger('click')
    expect(useSessionTrace().partition.value.view).toBe('trace')
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    // TraceView 挂载（Panel 渲染分支切换）→ ready 分区 ensureLoaded no-op
    const view = await mountTraceView()
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    // 设过滤 + 选中（per-session 分区）
    setTraceFilter(SID, { activeGroups: ['messages'] })
    selectTraceEntry(SID, 'u2')

    // 切回对话（卸载 TraceView）→ 再切回（重新挂载）：过滤/选中保留 + 仍不重拉
    view.unmount()
    await wrapper.find('[data-testid="trace-view-toggle-chat"]').trigger('click')
    expect(useSessionTrace().partition.value.view).toBe('chat')
    await wrapper.find('[data-testid="trace-view-toggle-trace"]').trigger('click')

    const view2 = await mountTraceView()
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)
    const msgChip = view2.find('[data-testid="trace-chip-messages"]')
    expect(msgChip.classes().join(' ')).toContain('bg-bg-elevated')
    // 选中行仍高亮（u2 = 保留区 USER）
    const selRow = view2.find('[data-testid="trace-row-9"]')
    expect(selRow.classes().join(' ')).toContain('bg-surface-hover')
    view2.unmount()
  })
})

describe('A43 行组件渲染（12 kind + 影子化 + 选中态 + 虚拟滚动）', () => {
  it('12 kind + MALFORMED 行摘要齐全（§3.4 渲染模型），损坏行占位可见', async () => {
    const view = await mountTraceView()
    const kinds = new Set(findRows(view).map((r) => r.attributes('data-kind')))
    for (const kind of ['SESSION', 'SYSTEM', 'MALFORMED', 'USER', 'ASSISTANT', 'TOOL', 'BASH', 'NOTICE', 'COMPACTED', 'BRANCH', 'LIFECYCLE', 'DATA', 'BOUNDARY']) {
      expect(kinds.has(kind), `kind ${kind} 应渲染`).toBe(true)
    }
    // 损坏行 i18n 文案（第 3 行）+ 保留原文于 title
    const malformedRow = view.find('[data-testid="trace-row-3"]')
    expect(malformedRow.text()).toContain('无法解析的 entry')
    expect(malformedRow.attributes('title')).toContain('3')
    view.unmount()
  })

  it('影子化降透明：压缩前可进 context 行 data-shadowed + opacity；保留区/压缩后正常', async () => {
    const view = await mountTraceView()
    // seq 4 = u1（compaction 前、保留区外）→ 影子化
    const shadowed = view.find('[data-testid="trace-row-4"]')
    expect(shadowed.attributes('data-shadowed')).toBe('true')
    expect(shadowed.classes().join(' ')).toContain('opacity-40')
    // seq 9 = u2（保留区起点 firstKept）→ inContext
    const kept = view.find('[data-testid="trace-row-9"]')
    expect(kept.attributes('data-in-context')).toBe('true')
    expect(kept.attributes('data-shadowed')).toBeUndefined()
    // seq 13 = mc1（lifecycle 不可进类型）→ 不影子化 + 「不进 context」标记
    const lifecycle = view.find('[data-testid="trace-row-13"]')
    expect(lifecycle.attributes('data-shadowed')).toBeUndefined()
    expect(lifecycle.text()).toContain('不进 context')
    view.unmount()
  })

  it('选中态：surface-hover + 强调字色、无 ring（SearchModal sm-item 例外登记）', async () => {
    const view = await mountTraceView()
    const row = view.find('[data-testid="trace-row-10"]') // a2 保留区 assistant
    expect(row.classes().join(' ')).not.toContain('bg-surface-hover')
    await row.trigger('click')
    const selected = view.find('[data-testid="trace-row-10"]')
    const cls = selected.classes().join(' ')
    expect(cls).toContain('bg-surface-hover')
    expect(cls).not.toMatch(/\bring/)
    // 摘要强调字色（选中行内的 summary span）
    const summary = selected.find('span.flex-1')
    expect(summary.classes().join(' ')).toContain('text-accent')
    view.unmount()
  })

  it('BASH 行 meta：exitCode + excludeFromContext（core 小改）「不进上下文」注记', async () => {
    const view = await mountTraceView()
    const bashRow = view.find('[data-testid="trace-row-7"]') // b1
    expect(bashRow.attributes('data-kind')).toBe('BASH')
    expect(bashRow.text()).toContain('npm test')
    expect(bashRow.text()).toContain('exit 1')
    expect(bashRow.text()).toContain('不进上下文')
    view.unmount()
  })

  it('context 分界行在最后一次压缩后；「仅当前 context」toggle 隐藏影子化与不进行', async () => {
    const view = await mountTraceView()
    // c1 = seq 11，divider 紧随其后
    expect(view.find('[data-testid="trace-context-divider"]').exists()).toBe(true)
    const divider = view.find('[data-testid="trace-context-divider"]')
    expect(divider.text()).toContain('当前 context')
    const rows = findRows(view)
    const dividerSeqBefore = rows.findIndex((r) => r.attributes('data-testid') === 'trace-row-11')
    expect(dividerSeqBefore).toBeGreaterThan(-1)

    // toggle：只剩 inContext 行（无 shadowed / 无 lifecycle-DATA 等）
    await view.find('[data-testid="trace-context-toggle"]').trigger('click')
    const remaining = findRows(view)
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.every((r) => r.attributes('data-in-context') === 'true')).toBe(true)
    expect(view.find('[data-testid="trace-context-divider"]').exists()).toBe(false)
    view.unmount()
  })

  it('kind chips 过滤 + 文本搜索（demo 语义：不匹配隐藏）', async () => {
    const view = await mountTraceView()
    // chips：工具 = TOOL/BASH
    await view.find('[data-testid="trace-chip-tools"]').trigger('click')
    let rows = findRows(view)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => ['TOOL', 'BASH'].includes(r.attributes('data-kind') ?? ''))).toBe(true)
    // 回「全部」
    await view.find('[data-testid="trace-chip-all"]').trigger('click')
    // 搜索：npm test → 仅 BASH b1
    await view.find('[data-testid="trace-search"]').setValue('npm test')
    rows = findRows(view)
    expect(rows.length).toBe(1)
    expect(rows[0]!.attributes('data-kind')).toBe('BASH')
    view.unmount()
  })

  it('>500 启用虚拟滚动（不全量渲染）', async () => {
    // 600 行 fixture（user/assistant 交替线性链，无压缩）
    const many: unknown[] = []
    let parent: string | null = null
    for (let i = 0; i < 600; i++) {
      const id = `g${i}`
      many.push({
        type: 'message',
        id,
        parentId: parent,
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `row ${i}` },
      })
      parent = id
    }
    apiMock.getTraceEntries.mockResolvedValue({
      sessionId: SID,
      source: 'file',
      entries: many,
      malformed: [],
      leafId: 'g599',
    } satisfies ServerMessageMap['session.traceEntries'])

    const view = await mountTraceView()
    const rendered = findRows(view).length
    expect(rendered).toBeLessThan(601) // 虚拟化路径：不全量渲染（happy-dom 下 virtua 窗口可为 0）
    view.unmount()
  })

  it('≤500 全量渲染（免 virtua 测量开销）', async () => {
    // 400 行（<500 阈值 → 直接 v-for）
    const few: unknown[] = []
    let parent: string | null = null
    for (let i = 0; i < 400; i++) {
      const id = `g${i}`
      few.push({
        type: 'message',
        id,
        parentId: parent,
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `row ${i}` },
      })
      parent = id
    }
    apiMock.getTraceEntries.mockResolvedValue({
      sessionId: SID,
      source: 'file',
      entries: few,
      malformed: [],
      leafId: 'g399',
    } satisfies ServerMessageMap['session.traceEntries'])
    const view2 = await mountTraceView()
    expect(findRows(view2).length).toBe(400)
    view2.unmount()
  })
})

describe('溯源跳转（§3.1 样例 5：SESSION 行 parentSession 链接 + reveal 定位）', () => {
  it('SESSION 行有 parentSession 时渲染溯源链接，点击经 stopPropagation 调 jumpToParentSession（不带 ref 的行无链接）', async () => {
    // header 带 parentSession（sessionId fallback 形态）+ forkEntryId
    const snap = buildFullKindsSnapshot()
    snap.header = { type: 'session', version: 1, id: 'h0', cwd: '/w/demo', parentSession: 'sid-fork-src', forkEntryId: 'u1' }
    apiMock.getTraceEntries.mockResolvedValue(snap)
    const view = await mountTraceView()
    const sessionRow = view.find('[data-kind="SESSION"]')
    const link = sessionRow.find('[data-testid="trace-row-jump-parent"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('fork')

    jumpMock.jumpToParentSession.mockResolvedValue({ ok: true, targetSessionId: 'sid-fork-src' })
    await link.trigger('click')
    expect(jumpMock.jumpToParentSession).toHaveBeenCalledTimes(1)
    expect(jumpMock.jumpToParentSession).toHaveBeenCalledWith(SID, 'sid-fork-src', 'u1')
    view.unmount()
  })

  it('默认 fixture（header 无 parentSession）SESSION 行不渲染溯源链接', async () => {
    const view = await mountTraceView()
    expect(view.find('[data-testid="trace-row-jump-parent"]').exists()).toBe(false)
    view.unmount()
  })

  it('revealTraceEntry：非虚拟路径 scrollIntoView 到目标行（溯源定位滚动）', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      const view = await mountTraceView()
      revealTraceEntry(SID, 'u1')
      await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalled())
      // 滚动目标是 u1 行（seq 4）：非虚拟路径 querySelector 命中同一元素
      const calledOn = scrollSpy.mock.contexts[0] as HTMLElement | undefined
      expect(calledOn?.getAttribute('data-testid')).toBe('trace-row-4')
      view.unmount()
    } finally {
      scrollSpy.mockRestore()
    }
  })
})

describe('C2 现取当前 system prompt（§3.1 失败路径：无留痕降级，RPC session.fetchCurrentSystemPrompt）', () => {
  /** 无 SYSTEM 留痕快照（留痕包未装/被禁/旧 session → 状态行降级出现现取按钮）。 */
  function buildNoSystemSnapshot(): ServerMessageMap['session.traceEntries'] {
    const snap = buildFullKindsSnapshot()
    return {
      ...snap,
      entries: snap.entries.filter((e) => (e as { customType?: unknown }).customType !== 'xyz:system-prompt'),
    }
  }

  /** fetchedAt 用无时区 ISO（本地时刻语义），断言时间字符串不受 vitest 运行时区影响。 */
  const FETCHED_AT = '2026-08-21T10:00:00'

  it('点击现取 → busy 态（置灰 + spin）且重入不发第二发；成功后展示摘要 +「当前值，非历史」标注', async () => {
    apiMock.getTraceEntries.mockResolvedValue(buildNoSystemSnapshot())
    let resolveFetch!: (v: ServerMessageMap['session.currentSystemPrompt']) => void
    apiMock.fetchCurrentSystemPrompt.mockImplementation(
      () => new Promise((res) => { resolveFetch = res }),
    )
    const view = await mountTraceView()
    const btn = view.find('[data-testid="trace-fetch-current"]')
    // idle：可点 + 标注可见
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(view.find('[data-testid="trace-fetch-current-note"]').text()).toBe('当前值，非历史')

    await btn.trigger('click')
    expect(apiMock.fetchCurrentSystemPrompt).toHaveBeenCalledWith(SID)
    // busy：按钮置灰 + icon 转 spin
    const busyBtn = view.find('[data-testid="trace-fetch-current"]')
    expect(busyBtn.attributes('disabled')).toBeDefined()
    expect(busyBtn.find('svg').classes().join(' ')).toContain('animate-spin')
    // 重入保护：busy 期间再点不发第二个 RPC
    await busyBtn.trigger('click')
    expect(apiMock.fetchCurrentSystemPrompt).toHaveBeenCalledTimes(1)

    resolveFetch({ sessionId: SID, fullText: 'prompt body', charCount: 12702, fetchedAt: FETCHED_AT })
    await vi.waitFor(() => expect(view.find('[data-testid="trace-fetch-current-result"]').exists()).toBe(true))
    const result = view.find('[data-testid="trace-fetch-current-result"]')
    expect(result.text()).toContain('12702')
    expect(result.text()).toContain('10:00:00')
    // 标注仍在（成功态不掩盖「当前值，非历史」）+ 按钮恢复可点（可重新现取）
    expect(view.find('[data-testid="trace-fetch-current-note"]').text()).toBe('当前值，非历史')
    expect(view.find('[data-testid="trace-fetch-current-error"]').exists()).toBe(false)
    expect(view.find('[data-testid="trace-fetch-current"]').attributes('disabled')).toBeUndefined()
    view.unmount()
  })

  it('session 不活跃（code=session_not_active）→ 专属错误文案替换标注，按钮恢复可点', async () => {
    apiMock.getTraceEntries.mockResolvedValue(buildNoSystemSnapshot())
    apiMock.fetchCurrentSystemPrompt.mockRejectedValue(
      Object.assign(new Error('Session not active'), { code: 'session_not_active' }),
    )
    const view = await mountTraceView()
    await view.find('[data-testid="trace-fetch-current"]').trigger('click')
    await vi.waitFor(() => expect(view.find('[data-testid="trace-fetch-current-error"]').exists()).toBe(true))
    expect(view.find('[data-testid="trace-fetch-current-error"]').text()).toContain('session 不活跃')
    // 错误态：无结果摘要 + 无「当前值，非历史」标注（错误文案优先）+ 按钮可重试
    expect(view.find('[data-testid="trace-fetch-current-result"]').exists()).toBe(false)
    expect(view.find('[data-testid="trace-fetch-current-note"]').exists()).toBe(false)
    expect(view.find('[data-testid="trace-fetch-current"]').attributes('disabled')).toBeUndefined()
    view.unmount()
  })

  it('现取超时（code=fetch_current_prompt_timeout）→ 超时文案；未知 code → 通用文案', async () => {
    apiMock.getTraceEntries.mockResolvedValue(buildNoSystemSnapshot())
    apiMock.fetchCurrentSystemPrompt.mockRejectedValueOnce(
      Object.assign(new Error('Timed out'), { code: 'fetch_current_prompt_timeout' }),
    )
    const view = await mountTraceView()
    await view.find('[data-testid="trace-fetch-current"]').trigger('click')
    await vi.waitFor(() => expect(view.find('[data-testid="trace-fetch-current-error"]').text()).toContain('超时'))

    // 未知 code（如传输层 disconnected 之外的意外错误）→ 通用文案兜底
    apiMock.fetchCurrentSystemPrompt.mockRejectedValueOnce(new Error('surprise'))
    await view.find('[data-testid="trace-fetch-current"]').trigger('click')
    await vi.waitFor(() => expect(view.find('[data-testid="trace-fetch-current-error"]').text()).toContain('现取失败'))
    view.unmount()
  })

  it('对照：有 SYSTEM 留痕（promptVersion 非空）→ 无现取按钮/标注（仅降级路径可见）', async () => {
    const view = await mountTraceView() // 默认 fixture 含 sp1 v2
    expect(view.find('[data-testid="trace-fetch-current"]').exists()).toBe(false)
    expect(view.find('[data-testid="trace-fetch-current-note"]').exists()).toBe(false)
    expect(apiMock.fetchCurrentSystemPrompt).not.toHaveBeenCalled()
    view.unmount()
  })
})

describe('assistant 聚合行子 block 内联展开（chevron + block 子行 + 选中寻址）', () => {
  it('chevron 显隐：有 content 的 ASSISTANT 行显示展开开关，其余行占位对齐不显示', async () => {
    const view = await mountTraceView()
    // a1（seq 5，3 个 block）与 a2（seq 10，1 个 text block）有 toggle；USER 行（seq 3）无
    expect(view.find('[data-testid="trace-expand-toggle-5"]').exists()).toBe(true)
    expect(view.find('[data-testid="trace-expand-toggle-10"]').exists()).toBe(true)
    expect(view.find('[data-testid="trace-expand-toggle-3"]').exists()).toBe(false)
    view.unmount()
  })

  it('点击 assistant 整行 → 选中 + 展开（三个 block 子行按序出现），再点收起', async () => {
    const view = await mountTraceView()
    expect(view.find('[data-testid="trace-block-row-5-0"]').exists()).toBe(false)

    await view.find('[data-testid="trace-row-5"]').trigger('click')
    // 整行点击两件事同时发生：选中（selectedKey）+ 展开（expandedKeys）
    expect(useSessionTrace().partition.value.selectedKey).toBe('a1')
    const b0 = view.find('[data-testid="trace-block-row-5-0"]')
    const b1 = view.find('[data-testid="trace-block-row-5-1"]')
    const b2 = view.find('[data-testid="trace-block-row-5-2"]')
    expect(b0.attributes('data-block-kind')).toBe('thinking')
    expect(b0.text()).toContain('先定位问题')
    expect(b1.attributes('data-block-kind')).toBe('toolCall')
    expect(b1.text()).toContain('read')
    expect(b1.text()).toContain('a.ts')
    expect(b2.attributes('data-block-kind')).toBe('text')
    expect(b2.text()).toContain('done')
    expect(useSessionTrace().partition.value.expandedKeys).toContain('a1')

    await view.find('[data-testid="trace-row-5"]').trigger('click')
    expect(view.find('[data-testid="trace-block-row-5-0"]').exists()).toBe(false)
    expect(useSessionTrace().partition.value.expandedKeys).not.toContain('a1')
    view.unmount()
  })

  it('点击子 block 行 → selectedKey = `<entryKey>#block-N`（drawer 联动寻址）', async () => {
    const view = await mountTraceView()
    await view.find('[data-testid="trace-row-5"]').trigger('click')
    await view.find('[data-testid="trace-block-row-5-1"]').trigger('click')
    expect(useSessionTrace().partition.value.selectedKey).toBe('a1#block-1')
    // 子行选中态（同 testid 元素高亮）
    expect(view.find('[data-testid="trace-block-row-5-1"]').classes().join(' ')).toContain('bg-surface-hover')
    view.unmount()
  })

  it('toolCall 子行尾缀配对结果态（ok/error），与 TOOL 结果行区分「调用 vs 结果」', async () => {
    const view = await mountTraceView()
    await view.find('[data-testid="trace-row-5"]').trigger('click')
    // a1 的 toolCall（tc1）与 tr1（isError:false）配对 → 子行尾缀 ok
    const sub = view.find('[data-testid="trace-block-row-5-1"]')
    expect(sub.text()).toContain('read')
    expect(sub.text().endsWith('ok')).toBe(true)
    // thinking 子行无结果态尾缀
    expect(view.find('[data-testid="trace-block-row-5-0"]').text().endsWith('ok')).toBe(false)
    view.unmount()
  })

  it('子行跟随父行过滤：assistant 被过滤掉时展开的子行不出现', async () => {
    const view = await mountTraceView()
    await view.find('[data-testid="trace-row-5"]').trigger('click')
    expect(view.find('[data-testid="trace-block-row-5-0"]').exists()).toBe(true)

    // 只留 tools 组（TOOL/BASH）→ assistant 行隐藏，子行随之消失
    setTraceFilter(SID, { activeGroups: ['tools'] })
    await nextTick()
    expect(view.find('[data-testid="trace-row-4"]').exists()).toBe(false)
    expect(view.find('[data-testid="trace-block-row-5-0"]').exists()).toBe(false)
    view.unmount()
  })
})

describe('oversize 降级视图（crash-resilience §3.3 D5④，u4c 协议扩展）', () => {
  it("source='oversize' → 降级分支渲染文案（体积 + 源文件绝对路径可见），分区透传 oversizeMessage，不落空态", async () => {
    const MB = 1024 * 1024
    const bytes = 35.6 * MB
    const filePath = `/agent/sessions/${SID}.jsonl`
    // runtime formatTraceOversizeMessage 的文案形态（体积 MB + 绝对路径）
    const oversizeMessage = `Trace 过大无法渲染（${(bytes / MB).toFixed(1)} MB），源文件：${filePath}`
    apiMock.getTraceEntries.mockResolvedValue({
      sessionId: SID,
      source: 'oversize',
      filePath,
      entries: [],
      malformed: [],
      oversizeMessage,
    } satisfies ServerMessageMap['session.traceEntries'])

    const view = await mountTraceView()
    // 分区透传（loadTrace 不再丢弃 oversizeMessage）
    expect(useSessionTrace().partition.value.oversizeMessage).toBe(oversizeMessage)

    // 降级分支：专属 testid + 文案含体积与路径（用户可见 DOM 断言）
    const degrade = view.find('[data-testid="trace-oversize"]')
    expect(degrade.exists()).toBe(true)
    expect(degrade.find('[data-testid="trace-oversize-message"]').text()).toBe(oversizeMessage)
    expect(degrade.text()).toContain('35.6 MB')
    expect(degrade.text()).toContain(filePath)
    // 重试入口（组件形态对齐 empty/error 分支）
    expect(degrade.find('[data-testid="trace-retry"]').exists()).toBe(true)

    // 非空态混淆：不落 empty（未落盘）与过滤空态分支
    expect(view.find('[data-testid="trace-empty-not-persisted"]').exists()).toBe(false)
    expect(view.find('[data-testid="trace-empty"]').exists()).toBe(false)
    view.unmount()
  })
})

describe('error 态 envelope message 透出（crash-resilience §3.4 回流修复）', () => {
  it("status='error' → 渲染分区 errorMessage（envelope 恢复指引：分页入口 + session 文件路径），不只显示 code", async () => {
    // Gate B A11② 场景：活跃大 session 的 get_entries reply 被 D3 传输守卫拦为错误
    // envelope（code=payload_too_large），message 携带恢复指引——此前 UI 只渲染 code，
    // 指引文案被藏掉。message-broker reply envelope 生成处透传的 err.message 即原文。
    const envelopeMessage =
      '该内容过大无法传输（37.7 MB），请用「加载更早」分页查看或查阅 session 文件：/agent/sessions/big.jsonl'
    apiMock.getTraceEntries.mockRejectedValue(
      Object.assign(new Error(envelopeMessage), { code: 'payload_too_large' }),
    )

    const view = mount(TraceView, { props: { sessionId: SID } })
    await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('error'))
    await nextTick()

    // 分区数据层：code 与 message 都保留（loadTrace catch 既有行为）
    expect(useSessionTrace().partition.value.errorCode).toBe('payload_too_large')
    expect(useSessionTrace().partition.value.errorMessage).toBe(envelopeMessage)

    // 用户可见 DOM 断言：错误态同时可见 code 与 envelope message（恢复指引完整透出）
    const errBox = view.find('[data-testid="trace-error"]')
    expect(errBox.exists()).toBe(true)
    expect(errBox.text()).toContain('payload_too_large')
    expect(errBox.find('[data-testid="trace-error-message"]').text()).toBe(envelopeMessage)
    expect(errBox.text()).toContain('加载更早')
    expect(errBox.text()).toContain('/agent/sessions/big.jsonl')
    // 重试入口保留
    expect(errBox.find('[data-testid="trace-retry"]').exists()).toBe(true)
    view.unmount()
  })

  it("errorMessage 为 null（无 message 的异常形态）→ message 行不渲染，error 分支不空窗", async () => {
    apiMock.getTraceEntries.mockRejectedValue(new Error('boom'))

    const view = mount(TraceView, { props: { sessionId: SID } })
    await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('error'))
    await nextTick()

    // loadTrace catch 的兜底：err.message 恒有值（'boom'），此处验证 v-if 门控形态——
    // message 行渲染的是兜底文案而非空节点
    expect(useSessionTrace().partition.value.errorMessage).toBe('boom')
    expect(view.find('[data-testid="trace-error-message"]').text()).toBe('boom')
    view.unmount()
  })
})

describe('B11 台账截断降级 banner（truncated 正交字段→现有降级渲染分支，不新增 status 值）', () => {
  it('超限快照：保尾部 5000 + truncated 置位 → banner 可见且台账仍正常渲染', async () => {
    // 5001 条线性链（软上限 5000 → 丢弃头部 e0，保 e1..e5000）
    const entries: unknown[] = []
    let parent: string | null = null
    for (let i = 0; i < 5001; i++) {
      const id = `t${i}`
      entries.push({ type: 'message', id, parentId: parent, message: { role: 'user', content: `row ${i}` } })
      parent = id
    }
    apiMock.getTraceEntries.mockResolvedValue({
      sessionId: SID,
      source: 'file',
      entries,
      malformed: [],
      leafId: 't5000',
    } satisfies ServerMessageMap['session.traceEntries'])

    const view = await mountTraceView()
    // 分区层：软上限生效（A8「entries ≤ 5000 且 truncated 标记」）
    const p = useSessionTrace().partition.value
    expect(p.truncated).toBe(true)
    expect(p.entries).toHaveLength(5000)
    expect(p.status).toBe('ready') // 台账仍 ready——截断不是错误态，不新增 status 值

    // 用户可见 DOM 断言：降级 banner（与 file 降级 banner 同构）+ 台账主体仍在
    const banner = view.find('[data-testid="trace-truncated-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('5000')
    expect(banner.text()).toContain('已停止追加')
    expect(view.find('[data-testid="trace-list"]').exists()).toBe(true)
    view.unmount()
  })

  it('未截断分区：banner 不渲染（默认无降级噪音）', async () => {
    const view = await mountTraceView() // beforeEach 默认 fixture（十几个 entry，远低于上限）
    expect(useSessionTrace().partition.value.truncated).toBe(false)
    expect(view.find('[data-testid="trace-truncated-banner"]').exists()).toBe(false)
    view.unmount()
  })
})
