/**
 * 簇 1-4 合并产物（round5-f U2，主文件 trace-view）。
 *
 * 来源（基名）：
 *   - panel/session-trace/trace-view.test.ts（主文件，27 例）
 *   - panel/PanelHeader.test.ts（12 例）
 *   - panel/panel-empty-declaration.test.ts（5 例）
 *   - panel/panel-per-session-generating.test.ts（3 例）
 *
 * 改造登记（保留式 mock，模板参照 command-popover-landing 先例）：
 *   - '@/api' 原窄替换（session 2 成员 + chat 域全 stub）改为 spread actual
 *     全门面 + 仅覆写 session.getTraceEntries / fetchCurrentSystemPrompt；
 *     chat 域回真实（本节不发消息，真实成员满足挂载链导出存在性检查）。
 *
 * 剔出：App-w8.test.ts（4 例，单文件保留）——其 '@/composables/useInboundFrameGuard'
 * 窄替换只出 install/uninstall 两导出，缺 useInboundFrameGuardState；per-session 节
 * 真实挂载 InboundFrameDroppedNotice.vue（setup 解构该函数）必崩。该 mock 非本清单
 * 指明改造点，按纪律剔出（期望数 51 → 47）。
 *
 * 合并纪律：describe/it 名零改动；各节原文件级钩子下沉包裹层 describe；
 * per-session 节私有 mountPanel 改名 mountGenPanel（与 panel-empty 节同名冲突）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import type { ServerMessageMap, PiLaunchPreset } from '@taiji/shared'
import type { DerivedStatus } from '@/types'

/* ══ 来源：trace-view 的 mock（改造点 + 溯源编排 stub） ══ */

// ── mock '@/api' 门面（保留式：store 只覆写 session.getTraceEntries / fetchCurrentSystemPrompt）──
const apiMock = vi.hoisted(() => ({
  getTraceEntries: vi.fn(),
  fetchCurrentSystemPrompt: vi.fn(),
}))
// [U2 保留式改造] 原窄替换 { session: 2 成员, chat: 全 stub } → spread 全门面 +
// 仅覆写 session 两成员；chat 域回真实（挂载链只要求导出存在，本测试不发消息）
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    session: {
      ...actual.session,
      getTraceEntries: apiMock.getTraceEntries,
      fetchCurrentSystemPrompt: apiMock.fetchCurrentSystemPrompt,
    },
  }
})

// ── mock useTraceJump（TraceView 溯源链接只验证事件编排链路，真实编排归 useTraceJump.test.ts）──
const jumpMock = vi.hoisted(() => ({ jumpToParentSession: vi.fn() }))
vi.mock('@/composables/features/trace/useTraceJump', () => ({
  jumpToParentSession: jumpMock.jumpToParentSession,
}))

/* ══ 来源：PanelHeader 的 mock（usePlatformChrome 可控单例） ══ */

// helper 持单例态（beforeEach 经 platformChromeMock 复位；TrafficLight.test.ts 同范式）。
// 工厂内动态 import——vi.mock 调用被提升到 import 初始化前，工厂必须自包含（无 TDZ 引用）
import { platformChromeMock } from '@/__tests__/helpers/platform-chrome-mock'
vi.mock('@/composables/effects/usePlatformChrome', async () => {
  const { installPlatformChromeMock } = await import('@/__tests__/helpers/platform-chrome-mock')
  return installPlatformChromeMock('mac')
})

/* ══ 来源：panel-empty-declaration 的 mock（useExtensionUI overlay 订阅） ══ */

const uiMock = vi.hoisted(() => ({
  formReq: { value: undefined as undefined | Record<string, unknown> },
  respond: () => {},
  cancel: () => {},
}))
vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentFormRequest: uiMock.formReq,
    currentPlanReviewRequests: { value: [] },
    respond: uiMock.respond,
    cancel: uiMock.cancel,
  }),
  // PanelModeBar（Panel composer 上方常驻挂载）setup 消费 planReviewFilter——窄 mock 需补齐该导出清单
  planReviewFilter: (req: { planReview?: boolean }) => req.planReview === true,
}))

/* ══ 来源：panel-per-session-generating 的 mock（flow 单例态） ══ */

// flow 单例态 mock（panel-view 派生消费 isActive）：landing 场景需 flow 活跃。
// isFlowActive 与 chat streaming 解耦（D1 独立事实源），mock 不读 chat store。
const flowState = vi.hoisted(() => ({ isActive: { value: false as boolean } }))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ isActive: flowState.isActive, state: { value: 'landing' }, startFlow: vi.fn(), cancelFlow: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))

/* ══ 组件与节内依赖 import ══ */

import PanelHeader from '@/components/panel/PanelHeader.vue'
import TraceView from '@/components/panel/trace/TraceView.vue'
import {
  _resetTraceStoreForTest,
  _setTraceEntriesSoftCapForTest,
  bindTraceSessionId,
  ensureTraceLoaded,
  revealTraceEntry,
  selectTraceEntry,
  setTraceFilter,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'
import { ViewHost } from '@taiji/ui/extension-host'
import Panel from '@/components/panel/Panel.vue'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import { useChatStore } from '@/stores/chat'

/* ════════ 来源：panel/session-trace/trace-view.test.ts（主文件） ════════ */

describe('trace-view', () => {
  const SID = 'sid-trace-view-1'

  /** 12 kind + MALFORMED 全覆盖 fixture（线性链 u1→…→u3，compaction c1 firstKept=u2）。 */
  function buildFullKindsSnapshot(): ServerMessageMap['session.traceEntries'] {
    const entries: unknown[] = [
      { type: 'custom', id: 'sp1', parentId: null, customType: 'taiji:system-prompt', data: { version: 2, reason: 'resume', hash: 'aabbcc', charCount: 12702 } },
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
      sessionEnd: { outcome: 'done' },
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

    it('切换到 Trace：仅改 view 字段（数据不重新拉取），切回对话再切回状态保留', async () => {
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

      // 切回对话（卸载 TraceView）→ 再切回（重新挂载）：过滤/选中保留 + 仍不重新拉取
      view.unmount()
      await wrapper.find('[data-testid="trace-view-toggle-chat"]').trigger('click')
      expect(useSessionTrace().partition.value.view).toBe('chat')
      await wrapper.find('[data-testid="trace-view-toggle-trace"]').trigger('click')

      const view2 = await mountTraceView()
      expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)
      const msgChip = view2.find('[data-testid="trace-chip-messages"]')
      expect(msgChip.classes().join(' ')).toContain('bg-[var(--sel-bg)]')
      // 选中行仍高亮（u2 = 保留区 USER，Tier B 文字提 fg）
      const selRow = view2.find('[data-testid="trace-row-9"]')
      expect(selRow.classes().join(' ')).toContain('text-neutral-fg')
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

    it('选中态：demo Tier B 行类范式（无底无框，仅文字提 fg + fw-mid），无 ring', async () => {
      const view = await mountTraceView()
      const row = view.find('[data-testid="trace-row-10"]') // a2 保留区 assistant
      expect(row.classes().join(' ')).not.toContain('bg-bg-elevated')
      await row.trigger('click')
      const selected = view.find('[data-testid="trace-row-10"]')
      const cls = selected.classes().join(' ')
      expect(cls).not.toContain('bg-bg-elevated')
      expect(cls).not.toContain('shadow-[inset_2px_0_0_var(--accent)]')
      expect(cls).toContain('text-neutral-fg')
      expect(cls).not.toMatch(/\bring/)
      // 选中行 headline 提 fg + fw-mid（demo .trow 选中 Tier B 范式）
      const summary = selected.find('span.flex-1')
      expect(summary.classes().join(' ')).toContain('text-neutral-fg')
      expect(summary.classes().join(' ')).toContain('[font-weight:var(--fw-mid)]')
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
        entries: snap.entries.filter((e) => (e as { customType?: unknown }).customType !== 'taiji:system-prompt'),
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
      // 子行选中态（同 testid 元素高亮，Tier B 文字提 fg）
      expect(view.find('[data-testid="trace-block-row-5-1"]').classes().join(' ')).toContain('text-neutral-fg')
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

  describe('oversize 降级视图（D5④，u4c 协议扩展）', () => {
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

  describe('error 态 envelope message 透出（回流修复）', () => {
    it("status='error' → 渲染分区 errorMessage（envelope 恢复指引：分页入口 + session 文件路径），不只显示 code", async () => {
      // Gate B A11② 场景：活跃大 session 的 get_entries reply 被 D3 传输检查拦为错误
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

  describe('B11 登记清单截断降级 banner（truncated 正交字段→现有降级渲染分支，不新增 status 值）', () => {
    // 软上限注入 50：截断/降级分支语义与 5000 同构，fixture 51 条替代 5001 条
    //（TEST-STRATEGY「新写测试判据」类型码 d：上限参数化注入，消万条 fixture 与实现常量耦合）
    beforeEach(() => {
      _setTraceEntriesSoftCapForTest(50)
    })

    afterEach(() => {
      _setTraceEntriesSoftCapForTest(null)
    })

    it('超限快照：保尾部 50 + truncated 置位 → banner 可见且登记清单仍正常渲染', async () => {
      // 51 条线性链（软上限 50 → 丢弃头部 t0，保 t1..t50）
      const entries: unknown[] = []
      let parent: string | null = null
      for (let i = 0; i < 51; i++) {
        const id = `t${i}`
        entries.push({ type: 'message', id, parentId: parent, message: { role: 'user', content: `row ${i}` } })
        parent = id
      }
      apiMock.getTraceEntries.mockResolvedValue({
        sessionId: SID,
        source: 'file',
        entries,
        malformed: [],
        leafId: 't50',
      } satisfies ServerMessageMap['session.traceEntries'])

      const view = await mountTraceView()
      // 分区层：软上限生效（A8「entries ≤ 50 且 truncated 标记」）
      const p = useSessionTrace().partition.value
      expect(p.truncated).toBe(true)
      expect(p.entries).toHaveLength(50)
      expect(p.status).toBe('ready') // 登记清单仍 ready——截断不是错误态，不新增 status 值

      // 用户可见 DOM 断言：降级 banner（与 file 降级 banner 同构）+ 登记清单主体仍在
      const banner = view.find('[data-testid="trace-truncated-banner"]')
      expect(banner.exists()).toBe(true)
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
})

/* ════════ 来源：panel/PanelHeader.test.ts ════════ */

describe('PanelHeader 节', () => {
  /** session JSONL 磁盘绝对路径 fixture（短名 = id 前 8 位 + .jsonl，与 formatShortSessionFile 同源） */
  const SESSION_FILE_PATH =
    '/Users/u/.taiji/agent/sessions/cwd-hash/2026-07-09T11-16-46-632Z_019f4698-2fa8-791c-858f-d02ba39d9676.jsonl'

  function mountHeader(overrides: Record<string, unknown> = {}) {
    return mount(PanelHeader, {
      props: {
        sessionLabel: 'test',
        status: 'done' as DerivedStatus,
        ...overrides,
      },
    })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // 折叠态持久化跨测试隔离：上一用例写入的折叠态不得泄漏进下一用例的 store 初始化
    localStorage.removeItem('taiji:side-collapsed')
  })

  describe('PanelHeader 卡头构成（demo spec §3.5 + 审计 R11 + 2026-10-14 裁决回归）', () => {
    it('U1: 有 sessionLabel 时显示会话名', () => {
      const wrapper = mountHeader({ sessionLabel: '修复登录 bug' })
      expect(wrapper.find('[data-testid="panel-session-label"]').text()).toBe('修复登录 bug')
    })

    it('U2: 无 session（空态）显示「新建任务」（workspace.newTask 兜底）', () => {
      const wrapper = mountHeader({ sessionLabel: '' })
      expect(wrapper.find('[data-testid="panel-session-label"]').text()).toContain('新建任务')
    })

    it('R11-1（裁决回归）: sessionFile 存在 → .jsonl 文件名按钮渲染短文件名', () => {
      const wrapper = mountHeader({ sessionFile: SESSION_FILE_PATH })
      const el = wrapper.find('[data-testid="panel-session-file"]')
      expect(el.exists()).toBe(true)
      // 短文件名 = id 前 8 位 + .jsonl（formatShortSessionFile 同源口径）
      expect(el.text()).toContain('019f4698.jsonl')
      // title 提示复制语义（i18n key panel.header.copySessionFile）
      expect(el.attributes('title')).toBe('复制 session 文件路径')
    })

    it('R11-1b: 点击文件名 → clipboard.writeText 收到 JSONL 绝对路径（非短名）', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        writable: true,
        configurable: true,
      })
      const wrapper = mountHeader({ sessionFile: SESSION_FILE_PATH })
      await wrapper.find('[data-testid="panel-session-file"]').trigger('click')
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SESSION_FILE_PATH)
    })

    it('R11-1c: sessionFile 缺失（pi 延迟写入窗口，规则 #6）→ 按钮不渲染', () => {
      const wrapper = mountHeader()
      expect(wrapper.find('[data-testid="panel-session-file"]').exists()).toBe(false)
    })

    it('R11-1d: 文件名按钮在右侧按钮组内且在 drawer 开关之前', () => {
      const wrapper = mountHeader({ sessionFile: SESSION_FILE_PATH })
      const fileBtn = wrapper.find('[data-testid="panel-session-file"]')
      const drawerBtn = wrapper.find('[data-testid="drawer-toggle"]')
      const rightGroup = wrapper.find('.ml-auto')
      expect(rightGroup.exists()).toBe(true)
      expect(rightGroup.element.contains(fileBtn.element)).toBe(true)
      // DOM 顺序：文件名按钮在前（右侧按钮组最前，同旧版落位）
      expect(fileBtn.element.compareDocumentPosition(drawerBtn.element as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    })

    it('R11-2: 目录/分支次要行不再上卡头（三重重复形态移除，只显会话名）', () => {
      const wrapper = mountHeader()
      const labelWrap = wrapper.find('[data-testid="panel-session-label"]').element.parentElement!
      // 会话名容器内只有会话名一个文本节点（无 mono 目录名/分支后缀）
      expect(labelWrap.querySelectorAll('span').length).toBe(1)
      expect(labelWrap.textContent).toBe('test')
    })
  })

  describe('PanelHeader 折叠态 chrome 迁入（review MF-6）', () => {
    beforeEach(() => {
      platformChromeMock.isFullscreen.value = false
    })

    it('collapsed=true → header 渲染 sidebar-collapse-toggle + pl-[88px] 让位红黄绿，drawer-toggle 恒显（ui-replica MF-1-49）', async () => {
      const sidebar = useSidebarStore()
      sidebar.userCollapsed = true

      const wrapper = mountHeader()
      const header = wrapper.find('header')
      // 让位类：非全屏留 pl-[88px]（红黄绿原生 x8~60，chrome 起 x≈88 与浮层一致）
      expect(header.classes()).toContain('pl-[88px]')
      // chrome 三按钮组迁入 header（收起按钮 testid 与浮层 AppNavControls 同源）
      expect(wrapper.find('[data-testid="sidebar-collapse-toggle"]').exists()).toBe(true)
      // 折叠态右抽屉开关恒显（demo .app.folded 隐藏规则不波及 .tbtn 开关钮；侧栏折叠后
      // 本钮是右抽屉唯一鼠标入口，demo 两开关折叠态恒渲染）
      expect(wrapper.find('[data-testid="drawer-toggle"]').exists()).toBe(true)
    })

    it('collapsed=true + isFullscreen → header 回退 pl-3.5（全屏红黄绿 OS 隐藏不占位）', () => {
      const sidebar = useSidebarStore()
      sidebar.userCollapsed = true
      platformChromeMock.isFullscreen.value = true

      const wrapper = mountHeader()
      const header = wrapper.find('header')
      expect(header.classes()).toContain('pl-3.5')
      expect(header.classes()).not.toContain('pl-[88px]')
    })

    it('collapsed=false → chrome 不迁入（无 sidebar-collapse-toggle），header 保持 pl-3.5', () => {
      const wrapper = mountHeader()
      const header = wrapper.find('header')
      expect(header.classes()).toContain('pl-3.5')
      expect(header.classes()).not.toContain('pl-[88px]')
      expect(wrapper.find('[data-testid="sidebar-collapse-toggle"]').exists()).toBe(false)
      // 非折叠态 drawer toggle 保留
      expect(wrapper.find('[data-testid="drawer-toggle"]').exists()).toBe(true)
    })
  })

  describe('PanelHeader ExtensionHost panel.header 挂载点（review MF-6）', () => {
    it('传 sessionId → ViewHost 挂载且 viewId/scope/empty 正确', () => {
      const wrapper = mountHeader({ sessionId: 'sess-1' })
      const host = wrapper.findComponent(ViewHost)
      expect(host.exists()).toBe(true)
      expect(host.props('viewId')).toBe('panel.header')
      // U2 scope 联合归属：会话域 { kind: 'session', sessionId }（ViewHost.vue scope prop）
      expect(host.props('scope')).toEqual({ kind: 'session', sessionId: 'sess-1' })
      expect(host.props('empty')).toBe('hidden')
    })

    it('不传 sessionId → ViewHost 不渲染（挂载点零 DOM，不挤压右侧内置按钮）', () => {
      const wrapper = mountHeader()
      expect(wrapper.findComponent(ViewHost).exists()).toBe(false)
    })
  })
})

/* ════════ 来源：panel/panel-empty-declaration.test.ts ════════ */

describe('panel-empty-declaration 节', () => {
  /** 重子组件 stub（ModeDeclarationRow 保持真实——它是被测挂载点） */
  const panelStubs = {
    PanelHeader: { template: '<div />' },
    MessageStream: { template: '<div data-testid="msg-stream" />' },
    Composer: { template: '<div data-testid="composer-box" />' },
    Landing: { template: '<div data-testid="landing" />' },
    InboundFrameDroppedNotice: { template: '<div />' },
  }

  const FULL: PiLaunchPreset = {
    id: 'builtin:full', name: '全工具模式', builtin: true, order: 0,
    toolMode: 'all', extensionMode: 'all',
  }

  /** 自定义非默认模式（allowlist 工具 + append 提示词，声明行有内容可断言） */
  function dispatchPreset(): PiLaunchPreset {
    return {
      id: 'custom:dispatch', name: '调度模式', builtin: false, order: 1,
      toolMode: 'allowlist', allowedTools: ['read', 'grep', 'find'],
      extensionMode: 'denylist', deniedExtensions: ['@zhushanwen/pi-subagent-workflow'],
      prompt: { append: { enabled: true, prompt: '派发前写自包含 brief' } },
    }
  }

  /** 写会话列表（含 launchPresetId）；groups 整表覆盖 = store 唯一写入口 */
  function setSession(id: string, launchPresetId?: string): void {
    useSessionStore().applySnapshot({
      groups: [{
        cwd: '/repo',
        sessions: [{
          id, label: id, cwd: '/repo', status: 'idle',
          lastActiveAt: 1, launchPresetId,
        }],
      }],
    })
  }

  /** 非默认模式 + presets 已加载的公共前置 */
  function loadPresets(): void {
    const presetStore = usePresetStore()
    presetStore.setPresets([FULL, dispatchPreset()])
    presetStore.setDefaultPresetId('builtin:full')
  }

  function mountPanel(sessionId: string) {
    return mount(Panel, {
      props: { panelId: 'panel-root', sessionId, sessionDir: '/repo' },
      global: { stubs: panelStubs },
    })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    uiMock.formReq.value = undefined
    const presetStore = usePresetStore()
    presetStore.setPresets([])
    presetStore.setDefaultPresetId('')
    presetStore.setLoadError(null)
  })

  describe('Panel 空会话声明行挂载点（e2e E2E-CF-6 回归）', () => {
    it('空会话（零消息）+ 非默认模式 → 渲染 mode-declaration-row', () => {
      loadPresets()
      setSession('s1', 'custom:dispatch')
      // 显式锁前置事实：本用例零消息（走「空对话态」分支，非 MessageStream）
      expect(useChatStore().getMessages('s1')).toHaveLength(0)

      const wrapper = mountPanel('s1')

      const row = wrapper.find('[data-testid="mode-declaration-row"]')
      expect(row.exists()).toBe(true)
      expect(row.text()).toContain('调度模式')
      // 走的是空对话态分支（MessageStream 未挂载）
      expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(false)
      // 空态文案仍在（形态未被吞掉）
      expect(wrapper.text()).toContain('开始对话')
    })

    it('空会话 + 默认模式 → 不渲染声明行（判据不变）', () => {
      loadPresets()
      setSession('s1', 'builtin:full')
      expect(mountPanel('s1').find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    })

    it('空会话 + 非默认模式但 presets 未加载（E7 ①）→ 不渲染', () => {
      setSession('s1', 'custom:dispatch')
      const wrapper = mountPanel('s1')
      expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('模式已删除')
    })

    it('空会话 + 非默认模式但 presets 加载失败（E7 ③）→ 不渲染', () => {
      setSession('s1', 'custom:dispatch')
      usePresetStore().setLoadError('rpc failed')
      const wrapper = mountPanel('s1')
      expect(wrapper.find('[data-testid="mode-declaration-row"]').exists()).toBe(false)
    })

    it('有消息 + 非默认模式 → 仍走 MessageStream 分支（既有布局不变，声明行由流顶承载）', () => {
      loadPresets()
      setSession('s1', 'custom:dispatch')
      useChatStore().applyMessageEvent('s1', {
        type: 'message.message_start',
        payload: { sessionId: 's1', messageId: 'm1' },
      })
      expect(useChatStore().getMessages('s1').length).toBeGreaterThan(0)

      const wrapper = mountPanel('s1')
      // 有消息 → MessageStream 分支（stub 可见），空对话态不出现
      expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('开始对话')
    })
  })
})

/* ════════ 来源：panel/panel-per-session-generating.test.ts（mountPanel 改名 mountGenPanel 消冲突） ════════ */

describe('panel-per-session-generating 节', () => {
  const genStubs = {
    PanelHeader: { template: '<div />' },
    MessageStream: { template: '<div data-testid="msg-stream" />' },
    Composer: { template: '<div data-testid="composer" />' },
    Landing: { template: '<div data-testid="landing">landing</div>' },
  }

  function mountGenPanel(sessionId: string | null) {
    return mount(Panel, {
      props: {
        panelId: 'panel-root',
        sessionId,
        sessionLabel: sessionId ?? '',
        sessionDir: '/repo',
        status: 'done' as never,
      },
      global: { stubs: genStubs },
    })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    flowState.isActive.value = false
  })

  describe('Panel per-session 生成态检查（isGenerating 不跨 session 误伤）', () => {
    it('另一 session 流式中（sessionId=null）→ 渲染 Landing，不落兜底空态', () => {
      const chat = useChatStore()
      // 模拟 A 会话正在流式（message_start 创建 streaming entity）
      chat.applyMessageEvent('session-A', {
        type: 'message.message_start',
        payload: { sessionId: 'session-A', messageId: 'a1' },
      })
      expect(chat.isGenerating('session-A')).toBe(true)

      // 点新建后切到空 session（sessionId=null）→ flow 活跃 → 应渲染 Landing。
      // isFlowActive 与 A 的流式解耦（D1）：landing 判据不读 chat streaming
      flowState.isActive.value = true
      const wrapper = mountGenPanel(null)
      expect(wrapper.find('[data-testid="landing"]').exists()).toBe(true)
      // 关键：不落兜底空态（「选择左侧会话开始」）
      expect(wrapper.text()).not.toContain('选择左侧会话开始')
    })

    it('本 Panel 的 session 在流式（messageCount=0）→ 不渲染 Landing（AC-2.8）', () => {
      const chat = useChatStore()
      // 本 Panel 绑定的 session-B 正在流式
      chat.applyMessageEvent('session-B', {
        type: 'message.message_start',
        payload: { sessionId: 'session-B', messageId: 'b1' },
      })

      const wrapper = mountGenPanel('session-B')
      // 有会话恒 conversation（D1：landing 需 !sessionId，「有会话 × landing」不可表达），
      // 生成态只影响 conversation 分支内部子视图，不影响 landing 判据
      expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
    })

    it('终态事件收尾 streaming entity → isGenerating 恢复 false', () => {
      const chat = useChatStore()
      chat.applyMessageEvent('session-C', {
        type: 'message.message_start',
        payload: { sessionId: 'session-C', messageId: 'c1' },
      })
      expect(chat.isGenerating('session-C')).toBe(true)

      chat.applyMessageEvent('session-C', {
        type: 'message.complete',
        payload: { sessionId: 'session-C' },
      })
      expect(chat.isGenerating('session-C')).toBe(false)
    })
  })
})
