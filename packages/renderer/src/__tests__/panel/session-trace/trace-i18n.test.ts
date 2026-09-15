/**
 * A51 trace i18n 文案收口单测（trace-i18n 单元，spec .cw-specs/trace-i18n.json）。
 *
 * 覆盖（spec：zh-CN/en-US 文案键全存在且被引用；空态/损坏行/降级/SYSTEM 无留痕
 * 四类边界文案；状态行与 chips 标签双语——对应 design §3.1 失败路径与终态图）：
 * 1. 键完整性：panel.trace 命名空间 zh-CN/en-US 键集合对称（无单侧缺失/多余）。
 * 2. 双语值：四类边界文案 + 状态行 + chips 在两 locale 下均有非回退文案。
 * 3. 键被引用：trace 组件源码实际调用 t()（无死键——spec-review 确认的收口缺口
 *    降级 banner / 现取当前值 / 当前值非历史 / 打开所在目录）。
 * 4. 组件渲染：mount 后 DOM 断言四类边界文案可见（zh-CN，vitest-i18n-setup mock）。
 *
 * 运行（A51 验收命令）：pnpm --filter @taiji/frontend exec vitest run trace-i18n
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computed, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import type { ServerMessageMap } from '@taiji/shared'
import { _resetDrawerForTest } from '@taiji/core/domain/drawer'
import i18n, { setLocale } from '@/i18n'
import zhPanel from '@/i18n/locales/zh-CN/panel'
import enPanel from '@/i18n/locales/en-US/panel'

// ── mock '@/api' 门面（store 只消费 session.getTraceEntries）──
const apiMock = vi.hoisted(() => ({ getTraceEntries: vi.fn() }))
vi.mock('@/api', () => ({
  session: { getTraceEntries: apiMock.getTraceEntries },
}))

import TraceView from '@/components/panel/trace/TraceView.vue'
import TraceInspector from '@/components/panel/trace/TraceInspector.vue'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  ensureTraceLoaded,
  selectTraceEntry,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'

const SID = 'sid-trace-i18n-1'

/** 带 SYSTEM 留痕 + 损坏行的 file 源快照（§3.1 路径 B：RPC 失败/非活跃文件直读）。 */
function buildFileSnapshot(): ServerMessageMap['session.traceEntries'] {
  return {
    sessionId: SID,
    source: 'file',
    filePath: `/data/agent/sessions/${SID}.jsonl`,
    header: { type: 'session', version: 1, id: 'h0', cwd: '/w/demo' },
    entries: [
      { type: 'custom', id: 'sp1', parentId: 'h0', customType: 'taiji:system-prompt', data: { version: 2, reason: 'resume', hash: 'aabbcc', charCount: 12702 } },
      { type: 'message', id: 'u1', parentId: 'sp1', message: { role: 'user', content: '修复重试逻辑' } },
      { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', provider: 'p', model: 'm-pro', content: [{ type: 'text', text: 'done' }] } },
    ],
    malformed: [{ lineNumber: 4, raw: 'not json' }],
    leafId: 'a1',
  }
}

/** 无 SYSTEM 留痕的 rpc 源快照（§3.1 降级：留痕包未装/被禁/旧 session）。 */
function buildNoSystemSnapshot(): ServerMessageMap['session.traceEntries'] {
  const snap = buildFileSnapshot()
  return {
    ...snap,
    source: 'rpc',
    entries: snap.entries.filter((e) => (e as { customType?: unknown }).customType !== 'taiji:system-prompt'),
    malformed: [],
  }
}

async function mountTraceView(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(TraceView, { props: { sessionId: SID } })
  await vi.waitFor(() => expect(useSessionTrace().partition.value.status).toBe('ready'))
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getTraceEntries.mockReset()
  apiMock.getTraceEntries.mockResolvedValue(buildFileSnapshot())
  _resetTraceStoreForTest()
  _resetDrawerForTest()
  setActivePinia(createPinia())
  bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
})

/** 拍平 locale 对象为 '.' 路径键集合（panel.trace 子树）。 */
function traceKeys(locale: object): Set<string> {
  const out = new Set<string>()
  const walk = (obj: unknown, prefix: string): void => {
    if (obj == null || typeof obj !== 'object') return
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const full = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object') walk(v, full)
      else out.add(full)
    }
  }
  walk((locale as { trace?: unknown }).trace, '')
  return out
}

describe('A51 trace i18n：zh-CN/en-US 键集合对称 + 双语值 + 组件引用', () => {
  it('panel.trace 键集合 zh-CN === en-US（无单侧缺失/多余）', () => {
    const zh = traceKeys(zhPanel)
    const en = traceKeys(enPanel)
    expect(zh.size).toBeGreaterThan(35) // trace-ui 预置 35 键 + 本单元收口新增
    expect([...zh].filter((k) => !en.has(k))).toEqual([])
    expect([...en].filter((k) => !zh.has(k))).toEqual([])
  })

  it('四类边界文案 zh-CN 值：空态 / 损坏行 / 降级 banner / SYSTEM 无留痕', async () => {
    await setLocale('zh-CN')
    // 空态（session 未落盘）
    expect(i18n.global.t('panel.trace.emptyNotPersisted')).toContain('尚未落盘')
    // 损坏行：行内占位 + hover 提示 + 打开所在目录按钮
    expect(i18n.global.t('panel.trace.malformedLine', { line: 4 })).toContain('无法解析')
    expect(i18n.global.t('panel.trace.malformedOpenDir')).toBe('打开所在目录')
    // RPC 降级 banner
    expect(i18n.global.t('panel.trace.degradedFileSource')).toBe('来自磁盘文件（实时更新不可用）')
    // SYSTEM 无留痕：标注 + 现取 + 非历史说明
    expect(i18n.global.t('panel.trace.promptNoTrace')).toContain('无留痕')
    expect(i18n.global.t('panel.trace.systemNoTraceHint')).toContain('留痕 extension 未启用')
    expect(i18n.global.t('panel.trace.systemFetchCurrent')).toBe('现取当前值')
    expect(i18n.global.t('panel.trace.systemCurrentNotHistory')).toBe('当前值，非历史')
  })

  it('四类边界文案 en-US 值（非回退、非 zh 残留）', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('panel.trace.emptyNotPersisted')).toBe('Session not persisted yet (visible after the first assistant reply)')
    expect(i18n.global.t('panel.trace.malformedLine', { line: 4 })).toBe('Unparseable entry (line 4)')
    expect(i18n.global.t('panel.trace.malformedOpenDir')).toBe('Reveal in folder')
    expect(i18n.global.t('panel.trace.degradedFileSource')).toBe('From disk file (live updates unavailable)')
    expect(i18n.global.t('panel.trace.systemNoTraceHint')).toContain('not active in that period')
    expect(i18n.global.t('panel.trace.systemFetchCurrent')).toBe('Fetch current')
    expect(i18n.global.t('panel.trace.systemCurrentNotHistory')).toBe('Current value, not historical')
  })

  it('状态行与 chips 标签双语值（zh-CN / en-US 成对断言）', async () => {
    await setLocale('zh-CN')
    for (const k of ['entriesCount', 'inContextCount', 'compactionCount', 'promptVersion']) {
      expect(i18n.global.t(`panel.trace.${k}`)).not.toBe(`panel.trace.${k}`)
    }
    const zhChips = ['chipAll', 'chipMessages', 'chipTools', 'chipSystem', 'chipLifecycle', 'chipBoundaries'].map(
      (k) => i18n.global.t(`panel.trace.${k}`),
    )
    await setLocale('en-US')
    const enChips = ['chipAll', 'chipMessages', 'chipTools', 'chipSystem', 'chipLifecycle', 'chipBoundaries'].map(
      (k) => i18n.global.t(`panel.trace.${k}`),
    )
    expect(enChips).toEqual(['All', 'Messages', 'Tools', 'System', 'Lifecycle', 'Boundaries'])
    // 双语成对非空且互异（同键两语言值不应相同——发现相同即单语漏翻）
    for (let i = 0; i < enChips.length; i++) {
      expect(zhChips[i]).toBeTruthy()
      expect(enChips[i]).not.toBe(zhChips[i])
    }
  })

  it('新收口键被 trace 组件源码实际引用（t() 调用存在，无死键）', () => {
    const traceDir = resolve(__dirname, '../../../components/panel/trace')
    const sources = ['TraceView.vue', 'TraceToolbar.vue', 'TraceInspector.vue', 'TraceRowItem.vue', 'TraceListItem.vue']
      .map((f) => readFileSync(resolve(traceDir, f), 'utf-8'))
      .join('\n')
    for (const key of [
      'degradedFileSource',
      'systemNoTraceHint',
      'systemFetchCurrent',
      'systemCurrentNotHistory',
      'systemFetchedSummary',
      'fetchNotActive',
      'fetchBusy',
      'fetchTimeout',
      'fetchFailed',
      'malformedOpenDir',
      'malformedRevealFailed',
      // 预置键抽查（空态/损坏行/无留痕标注——四类边界的渲染入口）
      'emptyNotPersisted',
      'malformedLine',
      'malformedHint',
      'promptNoTrace',
    ]) {
      expect(sources, `panel.trace.${key} 应被组件 t() 引用`).toContain(`panel.trace.${key}`)
    }
  })
})

describe('A51 四类边界文案组件渲染（zh-CN mount DOM 断言）', () => {
  it('空态：source=empty → 「尚未落盘」文案可见 + 重试入口', async () => {
    apiMock.getTraceEntries.mockResolvedValue({
      sessionId: SID,
      source: 'empty',
      entries: [],
      malformed: [],
    } satisfies ServerMessageMap['session.traceEntries'])
    const view = await mountTraceView()
    const empty = view.find('[data-testid="trace-empty-not-persisted"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('尚未落盘')
    expect(empty.find('[data-testid="trace-retry"]').exists()).toBe(true)
    // 空态不是降级 banner 场景（无数据可读，无文件源）
    expect(view.find('[data-testid="trace-degraded-banner"]').exists()).toBe(false)
    view.unmount()
  })

  it('损坏行：行内占位文案（含行号）+ inspector「打开所在目录」按钮与提示', async () => {
    const view = await mountTraceView()
    const malformedRow = view.find('[data-testid="trace-row-4"]')
    expect(malformedRow.attributes('data-kind')).toBe('MALFORMED')
    expect(malformedRow.text()).toContain('无法解析的 entry（第 4 行）')
    expect(malformedRow.attributes('title')).toContain('第 4 行')

    // inspector：选中损坏行 → 打开所在目录按钮（快照带 filePath → 可点；reveal 调用链
    // 归 trace-inspector.test.ts）+ 行号提示
    selectTraceEntry(SID, 'malformed:4')
    await nextTick()
    const inspector = mount(TraceInspector, { props: { sessionId: SID } })
    const actions = inspector.find('[data-testid="trace-malformed-actions"]')
    expect(actions.exists()).toBe(true)
    expect(actions.text()).toContain('打开所在目录')
    expect(actions.text()).toContain('第 4 行')
    expect(actions.find('[data-testid="trace-malformed-reveal"]').attributes('disabled')).toBeUndefined()
    inspector.unmount()
    view.unmount()
  })

  it('RPC 降级 banner：source=file 显示「来自磁盘文件」；source=rpc 不显示', async () => {
    const view = await mountTraceView() // file 源 fixture
    const banner = view.find('[data-testid="trace-degraded-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toBe('来自磁盘文件（实时更新不可用）')
    view.unmount()

    apiMock.getTraceEntries.mockResolvedValue({
      ...buildFileSnapshot(),
      source: 'rpc',
      malformed: [], // RPC 路径 pi 已静默跳坏行，恒空（protocol 约定）
    } satisfies ServerMessageMap['session.traceEntries'])
    _resetTraceStoreForTest()
    setActivePinia(createPinia())
    bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
    usePanelStore().loadSession(ROOT_PANEL_ID, SID)
    const rpcView = await mountTraceView()
    expect(rpcView.find('[data-testid="trace-degraded-banner"]').exists()).toBe(false)
    rpcView.unmount()
  })

  it('SYSTEM 无留痕：无 SYSTEM 行 → 标注 + hover hint + 可点现取按钮（idle）+「当前值，非历史」；有留痕 → promptVersion 且无降级 UI', async () => {
    apiMock.getTraceEntries.mockResolvedValue(buildNoSystemSnapshot())
    const view = await mountTraceView()
    const prompt = view.find('[data-testid="trace-stats-prompt"]')
    expect(prompt.text()).toContain('无留痕')
    expect(prompt.attributes('title')).toContain('留痕 extension 未启用')
    const fetchBtn = view.find('[data-testid="trace-fetch-current"]')
    expect(fetchBtn.exists()).toBe(true)
    expect(fetchBtn.text()).toContain('现取当前值')
    // idle 可点（busy 才置灰；交互链归 trace-view.test.ts C2 块）
    expect(fetchBtn.attributes('disabled')).toBeUndefined()
    expect(view.find('[data-testid="trace-fetch-current-note"]').text()).toBe('当前值，非历史')
    view.unmount()

    // 对照：有留痕（file fixture 含 sp1 v2）→ promptVersion 渲染 + 无无留痕降级 UI
    apiMock.getTraceEntries.mockResolvedValue(buildFileSnapshot())
    _resetTraceStoreForTest()
    setActivePinia(createPinia())
    bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
    usePanelStore().loadSession(ROOT_PANEL_ID, SID)
    const tracedView = await mountTraceView()
    expect(tracedView.find('[data-testid="trace-stats-prompt"]').text()).toContain('v2')
    expect(tracedView.find('[data-testid="trace-fetch-current"]').exists()).toBe(false)
    tracedView.unmount()
  })
})

describe('A51 状态行与 chips 标签双语（zh-CN mount + en-US t 值）', () => {
  it('状态行四段统计（总数 / context 内 / 压缩 / prompt 版本）zh-CN 渲染', async () => {
    const view = await mountTraceView()
    const stats = view.find('[data-testid="trace-stats"]')
    expect(stats.text()).toContain('共 5 条') // SESSION + SYSTEM + 3 message + 1 malformed
    expect(stats.text()).toContain('在当前 context')
    expect(stats.text()).toContain('压缩')
    expect(stats.text()).toContain('system prompt v2')
    view.unmount()
  })

  it('chips 六标签 zh-CN 渲染（全部 / 消息 / 工具 / 系统 / 生命周期 / 边界）', async () => {
    const view = await mountTraceView()
    for (const [key, label] of [
      ['all', '全部'],
      ['messages', '消息'],
      ['tools', '工具'],
      ['system', '系统'],
      ['lifecycle', '生命周期'],
      ['boundaries', '边界'],
    ] as const) {
      expect(view.find(`[data-testid="trace-chip-${key}"]`).text()).toContain(label)
    }
    view.unmount()
  })

  it('en-US locale 下状态行与 chips 值切换为英文（i18n 实例双语成对）', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('panel.trace.entriesCount', { count: 5 })).toBe('5 entries')
    expect(i18n.global.t('panel.trace.inContextCount', { count: 3 })).toBe('3 in current context')
    expect(i18n.global.t('panel.trace.compactionCount', { count: 1 })).toBe('1 compactions')
    expect(i18n.global.t('panel.trace.chipAll')).toBe('All')
    await setLocale('zh-CN') // 复位，不污染其他测试
  })
})
