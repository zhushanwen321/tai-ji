// @vitest-environment node

/**
 * session-trace 域测试合并文件（波 2a 簇 1-10 语义子集）。
 *
 * 节 1 — useSessionTrace：A41 per-session trace store（ADR-0049 useSessionScopedState
 *        分区）+ B11 登记清单治理（软上限/truncated）。
 * 节 2 — useTraceJump：jumpToParentSession 溯源跳转编排（design §3.1 样例 5）。
 *
 * 合并说明：两节 '@/api' mock 工厂逐字相同（session.getTraceEntries 受控）→ 去重
 * 共享一个 apiMock；节 2 的 useSidebar mock（仅 selectSession）对节 1 链零消费；
 * 节 2 原文件级 beforeEach 下沉进其 describe 节内。describe/it 名零改动。
 * 真实 events 模块（内存路由，dispatchSession 触发订阅 handler——非 mock 订阅链路）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/session-trace/useSessionTrace.test.ts --pool=threads
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import * as events from '@taiji/core/transport/api'
import { triggerSessionCleanups } from '@taiji/core/foundation/use-session-scoped-state'
import { mapSessionTraceRows, resolveTraceRowKind } from '@taiji/core/domain/session-trace'
import type { ServerMessageMap, SessionGroup } from '@taiji/shared'

// ── mock '@/api' 门面（两节同工厂去重；store 只消费 session.getTraceEntries）──
const apiMock = vi.hoisted(() => ({ getTraceEntries: vi.fn() }))
vi.mock('@/api', () => ({
  session: { getTraceEntries: apiMock.getTraceEntries },
}))

// ── mock useSidebar（节 2 专用）：selectSession 记录调用 + 模拟 focusedSessionId 切换 ──
// selectSession mock 为 panel focusedSessionId 切换（生产里 selectSession 内部
// syncSessionToPanel 同步做同一件事），避免拉起 useSidebar 的重依赖链。
const sidebarMock = vi.hoisted(() => ({ selectSession: vi.fn() }))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: sidebarMock.selectSession }),
}))

// 动态 import 让 vi.mock 先生效
import * as traceStore from '@/composables/features/trace/useSessionTrace'
import { mergeTraceLines } from '@/composables/features/trace/trace-lines'
import { jumpToParentSession } from '@/composables/features/trace/useTraceJump'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  setTraceFilter,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'

// ══════════ 节 1/2 — 来源: useSessionTrace.test.ts ══════════


/** 切换 panel 绑定的 session（分区键跟随，模拟 sidebar selectSession 主路径） */
function focusSession(sid: string | null): void {
  usePanelStore().loadSession(ROOT_PANEL_ID, sid)
}

/** 当前分区的只读快照（A 分区断言用；partition 是跟分区键的 computed） */
function partitionOf(sid: string): traceStore.TraceSessionPartition {
  focusSession(sid)
  return JSON.parse(JSON.stringify(traceStore.useSessionTrace().partition.value)) as traceStore.TraceSessionPartition
}

function snapshotOf(sid: string, entries: unknown[], extra: Partial<ServerMessageMap['session.traceEntries']> = {}): ServerMessageMap['session.traceEntries'] {
  return { sessionId: sid, source: 'file', entries, malformed: [], ...extra }
}

function pushAppend(sid: string, entries: unknown[], leafId: string | null): void {
  events.dispatchSession(sid, {
    type: 'session.traceEntryAppended',
    id: `push-${Math.random().toString(36).slice(2, 8)}`,
    payload: { sessionId: sid, entries, leafId },
  })
}

const SID_A = 'sid-a-1111'
const SID_B = 'sid-b-2222'

describe('A41 per-session trace store（ADR-0049 useSessionScopedState 分区）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.getTraceEntries.mockReset()
    traceStore._resetTraceStoreForTest()
    setActivePinia(createPinia())
    // 重绑分区键（_resetForTest 解绑后模拟产品接线）
    traceStore.bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
    focusSession(null)
  })

  it('加载按 session 分区：各 session 各自数据，切走再切回不重新拉取不丢失', async () => {
    const entriesA = [{ type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'A 的消息' } }]
    const entriesB = [{ type: 'message', id: 'f1', parentId: null, message: { role: 'user', content: 'B 的消息' } }]
    apiMock.getTraceEntries.mockImplementation(async (sid: string) =>
      sid === SID_A ? snapshotOf(SID_A, entriesA) : snapshotOf(SID_B, entriesB))

    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'), { interval: 1 })
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    // 切到 B：独立分区加载，A 数据不被覆盖/清空
    focusSession(SID_B)
    traceStore.ensureTraceLoaded(SID_B)
    await vi.waitFor(() => expect(partitionOf(SID_B).status).toBe('ready'), { interval: 1 })
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(2)

    // 切回 A：数据保留 + 不重新拉取（幂等：ready 态 ensureTraceLoaded no-op）
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await Promise.resolve()
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(2)
    expect(partitionOf(SID_A).entries).toHaveLength(1)
    expect((partitionOf(SID_A).entries[0] as { id?: string }).id).toBe('e1')
  })

  it('增量路径：traceEntryAppended 按消息所属 session 写分区（去重追加 + leafId 滚动），不串其他 session', async () => {
    const u1 = { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q1' } }
    apiMock.getTraceEntries.mockResolvedValue(snapshotOf(SID_A, [u1]))
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'), { interval: 1 })

    // 增量：新 entry 追加 + leafId 更新
    const a1 = { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [] } }
    pushAppend(SID_A, [a1], 'e2')
    expect(partitionOf(SID_A).entries).toHaveLength(2)
    expect(partitionOf(SID_A).leafId).toBe('e2')

    // 重复推送同一 id：去重（protocol「消费端按 entry.id 去重追加」）
    pushAppend(SID_A, [a1], 'e2')
    expect(partitionOf(SID_A).entries).toHaveLength(2)

    // B 的增量推给 B：A 不受影响；B 未加载过（idle）不增量
    const b1 = { type: 'message', id: 'x9', parentId: null, message: { role: 'user', content: 'B 增量' } }
    pushAppend(SID_B, [b1], 'x9')
    expect(partitionOf(SID_A).entries).toHaveLength(2)
    expect(partitionOf(SID_B).status).toBe('idle')
    expect(partitionOf(SID_B).entries).toHaveLength(0)
  })

  it('过滤/选中/视图状态 per-session 隔离：A 设置后切 B 是默认值，切回 A 保留', async () => {
    apiMock.getTraceEntries.mockResolvedValue(snapshotOf(SID_A, []))
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'), { interval: 1 })

    // A：切 Trace 视图 + 设过滤 + 选中
    traceStore.setTraceView(SID_A, 'trace')
    traceStore.setTraceFilter(SID_A, { contextOnly: true, activeGroups: ['messages'], searchText: 'retry' })
    traceStore.selectTraceEntry(SID_A, 'e1')
    const partA = partitionOf(SID_A)
    expect(partA.view).toBe('trace')
    expect(partA.contextOnly).toBe(true)
    expect(partA.activeGroups).toEqual(['messages'])
    expect(partA.searchText).toBe('retry')
    expect(partA.selectedKey).toBe('e1')

    // 切 B：默认值（不串）
    const partB = partitionOf(SID_B)
    expect(partB.view).toBe('chat')
    expect(partB.contextOnly).toBe(false)
    expect(partB.activeGroups).toEqual([])
    expect(partB.searchText).toBe('')
    expect(partB.selectedKey).toBeNull()

    // 切回 A：保留
    expect(partitionOf(SID_A).selectedKey).toBe('e1')
    traceStore.clearTraceSelection(SID_A)
    expect(partitionOf(SID_A).selectedKey).toBeNull()
  })

  it('empty（未落盘）→ 收到增量自动全量重新拉取（「落盘后自动加载」）', async () => {
    let call = 0
    apiMock.getTraceEntries.mockImplementation(async () => {
      call++
      // 首次 empty（延迟写入窗口），重新拉取返回真实数据
      return call === 1
        ? snapshotOf(SID_A, [], { source: 'empty' })
        : snapshotOf(SID_A, [{ type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q' } }])
    })
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).source).toBe('empty'), { interval: 1 })

    pushAppend(SID_A, [], 'e1') // 触发事件到达（delta 可能已并入下次全量）
    await vi.waitFor(() => expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(2), { interval: 1 })
    await vi.waitFor(() => expect(partitionOf(SID_A).entries).toHaveLength(1), { interval: 1 })
    expect(partitionOf(SID_A).source).toBe('file')
  })

  it('加载失败进 error 态（code 保留供失败路径文案），重试可恢复', async () => {
    let call = 0
    apiMock.getTraceEntries.mockImplementation(async () => {
      call++
      if (call === 1) throw Object.assign(new Error('boom'), { code: 'trace_fetch_failed' })
      return snapshotOf(SID_A, [])
    })
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('error'), { interval: 1 })
    expect(partitionOf(SID_A).errorCode).toBe('trace_fetch_failed')

    traceStore.retryTraceLoad(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'), { interval: 1 })
  })

  it('loading 窗口内的推送不丢：回包后 flush（快照已有 id 去重 + 快照后新 entry 追加 + leafId 滚动）', async () => {
    // 复现 review 竞态：runtime 写增量基线后，traceEntryAppended 推送先于 RPC reply 到达
    // renderer——手动 resolve 制造 loading 窗口，推送既不在快照里也不会被 sync 补发
    let resolveSnap!: (v: ServerMessageMap['session.traceEntries']) => void
    apiMock.getTraceEntries.mockImplementation(
      () => new Promise<ServerMessageMap['session.traceEntries']>((res) => { resolveSnap = res }),
    )
    const u1 = { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q1' } }
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('loading'), { interval: 1 })

    // 窗口内推送：e1 快照里已有（flush 时去重）+ e2 是快照后新 entry（不得丢，否则登记清单永久缺行）
    const a1 = { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [] } }
    pushAppend(SID_A, [u1, a1], 'e2')

    resolveSnap(snapshotOf(SID_A, [u1]))
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'), { interval: 1 })
    expect(partitionOf(SID_A).entries.map((e) => (e as { id?: string }).id)).toEqual(['e1', 'e2'])
    expect(partitionOf(SID_A).leafId).toBe('e2')
  })

  it('cleanup 退订增量 handler：triggerSessionCleanups 后 events.off 移除该 sid 的订阅 handler', async () => {
    apiMock.getTraceEntries.mockResolvedValue(snapshotOf(SID_A, []))
    const onSpy = vi.spyOn(events, 'on')
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'), { interval: 1 })
    // 前置：loadTrace → ensureIncrementSubscription 确实建立了订阅
    const handler = onSpy.mock.calls.find(([sid]) => sid === SID_A)?.[1]
    expect(handler).toBeTypeOf('function')
    onSpy.mockRestore()

    const offSpy = vi.spyOn(events, 'off')
    triggerSessionCleanups(SID_A) // useSidebar.deleteSession 的 session 销毁编排路径
    // 不退订则 handler 永久滞留 events 内部 Map（per 删除 session 泄漏）+ 迟到推送可复活已删分区
    expect(offSpy).toHaveBeenCalledWith(SID_A, handler)
    offSpy.mockRestore()
  })

  it('payload → rows 派生：mergeTraceLines 坏行归并 + core 映射（损坏行占位原位可见）', () => {
    const header = { type: 'session', version: 1, id: 'h0', cwd: '/w' }
    const entries = [
      { type: 'message', id: 'e1', parentId: 'h0', message: { role: 'user', content: 'q1' } },
      { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [] } },
    ]
    const malformed = [{ lineNumber: 3, raw: 'not json' }]
    const lines = mergeTraceLines(header, entries, malformed)
    // 行1 header / 行2 e1 / 行3 坏行（原位归并）/ 行4 e2
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4])
    expect(lines[2]).toMatchObject({ ok: false, raw: 'not json' })

    const rows = mapSessionTraceRows({
      lines,
      sessionEnd: { type: 'session_end', outcome: 'done' },
      leafId: 'e2',
    })
    expect(rows.map((r) => r.kind)).toEqual(['SESSION', 'USER', 'MALFORMED', 'ASSISTANT', 'BOUNDARY'])
    expect(rows[2]).toMatchObject({ key: 'malformed:3', raw: 'not json' })
    // 12 kind 映射冒烟：resolveTraceRowKind 对关键 entry 的归类
    expect(resolveTraceRowKind({ type: 'message', message: { role: 'bashExecution', command: 'ls' } })).toBe('BASH')
    expect(resolveTraceRowKind({ type: 'model_change', provider: 'p', modelId: 'm' })).toBe('LIFECYCLE')
  })

  it('文件尾坏行：直读快照 → rows 尾部 MALFORMED 占位可见，后续增量追加不吞占位（GUI 回归 pin）', () => {
    // GUI 实测形态（dsh调研 session）：文件尾部注入坏行后，直读路径快照 malformed 带
    // 尾部行号；后续增量路径（如现取 DATA taiji:current-system-prompt）往 entries 尾部追加
    // 新 entry。两者交互下 MALFORMED 占位必须仍可见且位于追加行之前（坏行行号锚点归并）。
    const header = { type: 'session', version: 1, id: 'h0', cwd: '/w' }
    const fileEntries = [
      { type: 'message', id: 'e1', parentId: 'h0', message: { role: 'user', content: 'q' } },
      { type: 'session_info', name: 'repro' },
    ]
    const tailMalformed = [{ lineNumber: 4, raw: '{invalid json!!!' }]

    // 阶段 1：快照直出 → MALFORMED 是尾行
    const rows1 = mapSessionTraceRows({ lines: mergeTraceLines(header, fileEntries, tailMalformed) })
    expect(rows1.map((r) => r.kind)).toEqual(['SESSION', 'USER', 'LIFECYCLE', 'MALFORMED'])
    expect(rows1[3]).toMatchObject({ key: 'malformed:4', lineNumber: 4, raw: '{invalid json!!!' })

    // 阶段 2：增量追加后（现取 DATA 行 append 到 entries 尾部）→ MALFORMED 归并在追加行之前
    const appended = [...fileEntries, { type: 'custom', customType: 'taiji:current-system-prompt', data: {} }]
    const rows2 = mapSessionTraceRows({ lines: mergeTraceLines(header, appended, tailMalformed) })
    expect(rows2.map((r) => r.kind)).toEqual(['SESSION', 'USER', 'LIFECYCLE', 'MALFORMED', 'DATA'])
    expect(rows2[3]).toMatchObject({ key: 'malformed:4' })
    expect(rows2[4]).toMatchObject({ kind: 'DATA' })
  })
})

describe('B11 登记清单治理（内存泄漏审计中危#9：seenIds 增量去重 + 软上限 + truncated 正交字段）', () => {
  // 软上限注入 50：停采/保尾/复位/flush 四边界语义与 5000 完全同构（阈值相对语义不变），
  // fixture 从万条缩到 50 量级——单测只测逻辑正确性（TEST-STRATEGY「新写测试判据」类型码 d）。
  const CAP = 50

  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.getTraceEntries.mockReset()
    traceStore._resetTraceStoreForTest()
    setActivePinia(createPinia())
    traceStore.bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
    focusSession(null)
    traceStore._setTraceEntriesSoftCapForTest(CAP)
  })

  afterEach(() => {
    traceStore._setTraceEntriesSoftCapForTest(null)
  })

  /** 线性链 entry fixture（id 可控，去重断言用）。 */
  function chainEntry(id: string, parentId: string | null): unknown {
    return { type: 'message', id, parentId, message: { role: 'user', content: `q-${id}` } }
  }

  /** 强制拉取到 ready（retryTraceLoad 无条件重新拉取——ensureTraceLoaded 对 ready 分区 no-op）。 */
  async function loadReady(sid: string, entries: unknown[], extra: Partial<ServerMessageMap['session.traceEntries']> = {}): Promise<void> {
    apiMock.getTraceEntries.mockResolvedValue(snapshotOf(sid, entries, extra))
    focusSession(sid)
    traceStore.retryTraceLoad(sid)
    await vi.waitFor(() => expect(partitionOf(sid).status).toBe('ready'), { interval: 1 })
  }

  it('增量去重等价性：seenIds 增量维护下重复 id 不追加（快照内/历史增量/重新拉取后均一致）', async () => {
    await loadReady(SID_A, [chainEntry('e1', null)])

    // 与快照重叠的 id + 新 id 混合推送：重叠丢弃、新增追加（与旧全量重建语义等价）
    pushAppend(SID_A, [chainEntry('e1', null), chainEntry('e2', 'e1')], 'e2')
    expect(partitionOf(SID_A).entries.map((e) => (e as { id?: string }).id)).toEqual(['e1', 'e2'])

    // 历史增量的 id 再推：仍去重（seen 集跨推送存活——增量维护不丢历史）
    pushAppend(SID_A, [chainEntry('e2', 'e1')], 'e2')
    expect(partitionOf(SID_A).entries).toHaveLength(2)

    // 无 id entry：不进去重集但照常追加（旧语义保留——protocol 无 id 行不丢）
    const noId = { type: 'session_info', name: 'no-id' }
    pushAppend(SID_A, [noId], 'e2')
    expect(partitionOf(SID_A).entries).toHaveLength(3)

    // 重新拉取（error→retry 或手动刷新路径）：快照替换后 seen 集随新快照重建，重复 id 仍不追加
    await loadReady(SID_A, [chainEntry('e1', null), chainEntry('e9', 'e1')], { leafId: 'e9' })
    expect(partitionOf(SID_A).entries).toHaveLength(2)
    pushAppend(SID_A, [chainEntry('e9', 'e1')], 'e9')
    expect(partitionOf(SID_A).entries).toHaveLength(2)
  })

  it('软上限边界：49 + 2 增量 → 恰 50 停采 + truncated 置位；重复 id 不触截断', async () => {
    const base = Array.from({ length: CAP - 1 }, (_, i) => chainEntry(`e${i}`, i === 0 ? null : `e${i - 1}`))
    await loadReady(SID_A, base, { leafId: `e${CAP - 2}` })
    expect(partitionOf(SID_A).truncated).toBe(false)

    // 第 50 条：达上限但未超——追加成功且不置 truncated
    pushAppend(SID_A, [chainEntry(`e${CAP - 1}`, `e${CAP - 2}`)], `e${CAP - 1}`)
    expect(partitionOf(SID_A).entries).toHaveLength(CAP)
    expect(partitionOf(SID_A).truncated).toBe(false)

    // 已达上限后再推重复 id：去重先行，不触截断标记
    pushAppend(SID_A, [chainEntry(`e${CAP - 1}`, `e${CAP - 2}`)], `e${CAP - 1}`)
    expect(partitionOf(SID_A).truncated).toBe(false)

    // 第 51 条：停止追加 + truncated 置位；leafId 仍滚动（单字符串不占内存，保 core 边界计算输入最新）
    pushAppend(SID_A, [chainEntry(`e${CAP}`, `e${CAP - 1}`)], `e${CAP}`)
    expect(partitionOf(SID_A).entries).toHaveLength(CAP)
    expect(partitionOf(SID_A).truncated).toBe(true)
    expect(partitionOf(SID_A).leafId).toBe(`e${CAP}`)
    expect((partitionOf(SID_A).entries.at(-1) as { id?: string }).id).toBe(`e${CAP - 1}`)
  })

  it('超限快照：保尾部 50 + truncated 置位；后续增量立即停采', async () => {
    const entries = Array.from({ length: CAP + 3 }, (_, i) => chainEntry(`e${i}`, i === 0 ? null : `e${i - 1}`))
    await loadReady(SID_A, entries, { leafId: `e${CAP + 2}` })

    expect(partitionOf(SID_A).entries).toHaveLength(CAP)
    expect(partitionOf(SID_A).truncated).toBe(true)
    // 保尾部：丢弃最前 e0/e1/e2，保留 e3..e52（最新 entry 靠尾 + leafId 在尾部）
    expect((partitionOf(SID_A).entries[0] as { id?: string }).id).toBe('e3')
    expect((partitionOf(SID_A).entries.at(-1) as { id?: string }).id).toBe(`e${CAP + 2}`)
    expect(partitionOf(SID_A).leafId).toBe(`e${CAP + 2}`)

    // 截断后的增量：直接停采（新 id 不可进入，登记清单恒有界）
    pushAppend(SID_A, [chainEntry(`e${CAP + 3}`, `e${CAP + 2}`)], `e${CAP + 3}`)
    expect(partitionOf(SID_A).entries).toHaveLength(CAP)
    expect(partitionOf(SID_A).truncated).toBe(true)
  })

  it('重新拉取小快照后 truncated 复位：全量快照是权威状态，截断标记随新快照重置', async () => {
    await loadReady(SID_A, Array.from({ length: CAP + 1 }, (_, i) => chainEntry(`e${i}`, i === 0 ? null : `e${i - 1}`)), { leafId: `e${CAP}` })
    expect(partitionOf(SID_A).truncated).toBe(true)

    await loadReady(SID_A, [chainEntry('n1', null)], { leafId: 'n1' })
    expect(partitionOf(SID_A).truncated).toBe(false)
    expect(partitionOf(SID_A).entries).toHaveLength(1)
    // seen 集已随新快照重建：旧 id 不再被认成重复（新登记清单独立）
    pushAppend(SID_A, [chainEntry('e0', null)], 'e0')
    expect(partitionOf(SID_A).entries).toHaveLength(2)
  })

  it('loading 窗口缓冲 flush 同受软上限约束：快照 + 缓冲合计超 50 停采并置位', async () => {
    let resolveSnap!: (v: ServerMessageMap['session.traceEntries']) => void
    apiMock.getTraceEntries.mockImplementation(
      () => new Promise<ServerMessageMap['session.traceEntries']>((res) => { resolveSnap = res }),
    )
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('loading'), { interval: 1 })

    // 窗口内缓冲 3 条（含 1 条与快照重叠）
    pushAppend(SID_A, [chainEntry(`e${CAP - 2}`, `e${CAP - 3}`), chainEntry(`e${CAP - 1}`, `e${CAP - 2}`), chainEntry(`e${CAP}`, `e${CAP - 1}`)], `e${CAP}`)

    resolveSnap(snapshotOf(SID_A, Array.from({ length: CAP - 1 }, (_, i) => chainEntry(`e${i}`, i === 0 ? null : `e${i - 1}`)), { leafId: `e${CAP - 2}` }))
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'), { interval: 1 })
    // 快照 49 + flush 去重后新增 e49（50 达上限）+ e50 停采置位
    expect(partitionOf(SID_A).entries).toHaveLength(CAP)
    expect(partitionOf(SID_A).truncated).toBe(true)
    expect((partitionOf(SID_A).entries.at(-1) as { id?: string }).id).toBe(`e${CAP - 1}`)
    expect(partitionOf(SID_A).leafId).toBe(`e${CAP}`)
  })
})


// ══════════ 节 2/2 — 来源: useTraceJump.test.ts ══════════

/**
 * useTraceJump 溯源跳转编排单测（design §3.1 样例 5，trace-jump）。
 *
 * 覆盖：
 * - target_not_found：parentSession 两形态都无法解析到列表 session
 * - 成功路径（sessionId 形态 + 文件路径形态）：selectSession 切换 + 目标分区切 Trace 视图
 *   + 清过滤 + 等 ready + revealTraceEntry 定位 forkEntryId（selectedKey + revealRequest）
 * - 目标 trace 加载失败（error 态）→ load_failed
 */
const FORK_SID = 'sid-fork-child'
const SRC_SID = 'sid-fork-src'
const SRC_FILE = '/root/dirA/2026-08-20T09-41-02_sid-fork-src.jsonl'

/** 源 session trace snapshot（header 带 forkEntryId 指回的 entry 由测试数据表达）。 */
function buildSrcSnapshot(): ServerMessageMap['session.traceEntries'] {
  return {
    sessionId: SRC_SID,
    source: 'file',
    header: { type: 'session', version: 1, id: 'h-src', cwd: '/w/src' },
    entries: [
      { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: '源消息' } },
      { type: 'message', id: 'fork-point', parentId: 'e1', message: { role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'text', text: 'fork 点' }] } },
    ],
    malformed: [],
    leafId: 'fork-point',
  }
}

/** 装配 sidebar 列表（两个 session：fork 子 + 源）。 */
function seedSessions(): void {
  const groups: SessionGroup[] = [
    {
      cwd: '/w',
      sessions: [
        {
          id: FORK_SID, label: 'fork-child', cwd: '/w', status: 'done', lastActiveAt: 1,
          sessionFile: '/root/dirA/2026-08-20T10-00-00_sid-fork-child.jsonl',
        },
        {
          id: SRC_SID, label: 'fork-src', cwd: '/w', status: 'done', lastActiveAt: 2,
          sessionFile: SRC_FILE,
        },
      ],
    },
  ]
  // ADR-0059 薄壳 store 无 setGroups 整表入口（main 侧 W 修订），走 applySnapshot
  //（new-task use-new-task-flow.test.ts 同款范式）
  useSessionStore().applySnapshot({ groups })
}

/** 挂载后的响应式上下文建立（模块级 watch 无需组件；await 一轮微任务让初始 ensureLoaded 启动）。 */
async function setupShim(): Promise<void> {
  await Promise.resolve()
}

describe('jumpToParentSession（溯源跳转编排）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.getTraceEntries.mockReset()
    apiMock.getTraceEntries.mockResolvedValue(buildSrcSnapshot())
    sidebarMock.selectSession.mockReset()
    // selectSession mock：模拟生产 selectSession 内部的 focusedSessionId 切换（同步）
    sidebarMock.selectSession.mockImplementation(async (id: string) => {
      usePanelStore().loadSession(ROOT_PANEL_ID, id)
    })
    _resetTraceStoreForTest()
    setActivePinia(createPinia())
    bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
    usePanelStore().loadSession(ROOT_PANEL_ID, FORK_SID)
    seedSessions()
  })

  it('目标不在列表 → target_not_found，不切 session', async () => {
    const result = await jumpToParentSession(FORK_SID, 'gone-id')
    expect(result).toEqual({ ok: false, reason: 'target_not_found' })
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })

  it('sessionId fallback 形态：切源 session + Trace 视图 + 清过滤 + 定位 forkEntryId', async () => {
    await setupShim()
    // 预置目标分区的脏过滤态（验证跳转清过滤保证行可见）
    setTraceFilter(SRC_SID, { contextOnly: true, activeGroups: ['messages'], searchText: 'xx' })
    const result = await jumpToParentSession(FORK_SID, SRC_SID, 'fork-point')
    expect(result).toEqual({ ok: true, targetSessionId: SRC_SID })
    // 切换 + 视图 + 过滤清空
    expect(sidebarMock.selectSession).toHaveBeenCalledWith(SRC_SID)
    const p = useSessionTrace().partition.value
    expect(p.view).toBe('trace')
    expect(p.contextOnly).toBe(false)
    expect(p.activeGroups).toEqual([])
    expect(p.searchText).toBe('')
    // 定位：选中 + reveal 请求指向 forkEntryId
    expect(p.selectedKey).toBe('fork-point')
    expect(p.revealRequest?.key).toBe('fork-point')
    expect(p.revealRequest?.nonce).toBeGreaterThan(0)
  })

  it('文件路径形态：sessionFile 精确匹配命中同一源', async () => {
    await setupShim()
    const result = await jumpToParentSession(FORK_SID, SRC_FILE, 'fork-point')
    expect(result).toEqual({ ok: true, targetSessionId: SRC_SID })
    expect(useSessionTrace().partition.value.selectedKey).toBe('fork-point')
  })

  it('目标 trace 加载失败 → load_failed，不写定位', async () => {
    await setupShim()
    apiMock.getTraceEntries.mockRejectedValue(new Error('boom'))
    const result = await jumpToParentSession(FORK_SID, SRC_SID, 'fork-point')
    expect(result).toEqual({ ok: false, reason: 'load_failed' })
    expect(useSessionTrace().partition.value.revealRequest).toBeNull()
  })

  it('无 forkEntryId：只切视图不定位（selectedKey 不写）', async () => {
    await setupShim()
    const result = await jumpToParentSession(FORK_SID, SRC_SID)
    expect(result).toEqual({ ok: true, targetSessionId: SRC_SID })
    const p = useSessionTrace().partition.value
    expect(p.view).toBe('trace')
    expect(p.selectedKey).toBeNull()
    expect(p.revealRequest).toBeNull()
  })
})
