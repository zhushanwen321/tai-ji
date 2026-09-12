/**
 * useSidebarCounts badge 口径单测（设计 subagent-sidebar-filter D8 / T3）。
 * 另含 sessionCount（非归档口径：全量会话数 − 已归档，sidebar-tab-count-restore §2.3/§3.1）套件。
 *
 * subagentRunningCount 判据 = 「进行中」桶 SSOT（subagentBucket(r) === 'active'，
 * D6 #5 收敛——曾为本地重复实现 `status === 'running' && !isDoneProjection(r)`，
 * 与分桶判据同义但两处维护）：done 投影（one-shot 轮终等 GC，renderer 侧永久态）
 * 不计入、waiting（可复活非终态）计入——badge 语义与列表 active 桶恒同源，
 * 消除 badge 永久虚亮 / 口径漂移分叉。
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/composables/useSidebarCounts.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useSidebarCounts } from '@/composables/features/sidebar/useSidebarCounts'
import { useSessionStore } from '@/stores/session'
import { useSubagentStore } from '@/stores/subagent'
import { toggleMarkedDone, __resetCacheForTest } from '@/composables/useSessionMarkers'
import { countSubagents } from '@/lib/subagent-bucket'
import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { SessionGroup, SessionSummary, SubagentRecord } from '@xyz-agent/shared'
// R3-1④：跨包消费 runtime extractor 真实投影产物构造 fixture——手工拼 SubagentRecord
// 会掩盖 runtime 投影白名单断链（origin 恒 undefined 时下游过滤用例照样绿，假绿）。
// 投影白名单删 origin 时本文件的投影断言与下游过滤断言共同转红（红锚联动）。
// eslint 探针已验证：vitest 从被引文件位置向上解析，runtime 内部依赖链可达。
import { scanSubagentEntries } from '../../../../runtime/src/services/session/subagent-extractor.js'

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'bg-badge-1-111',
    sessionFile: '/data/sub.jsonl',
    agent: 'reviewer',
    slug: 'review',
    task: 'Review the code changes',
    status: 'done',
    ...overrides,
  }
}

/** 自描述 subagent-record entry 构造（pi JSONL 持久化形态 = runtime extractor 输入）。 */
function recordEntry(data: Record<string, unknown>): Record<string, unknown> {
  return { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data }
}

/** extractor 真实投影产物：entry data 列表 → scanSubagentEntries 派生（fixture 源 = runtime 投影）。 */
function projectedRecords(entriesData: Array<Record<string, unknown>>): SubagentRecord[] {
  return scanSubagentEntries(entriesData.map(recordEntry))
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useSidebarCounts D8 badge 口径（subagentRunningCount）', () => {
  it('done 投影（running + result + chatMode false）不计入，真 running 计入', () => {
    const sid = ref<string | null>('sess-badge')
    const store = useSubagentStore()
    store.applyRecords('sess-badge', [
      makeRecord({ subagentId: 'bg-live-1', status: 'running' }),
      makeRecord({ subagentId: 'bg-done-proj-1', status: 'running', result: '本轮产出', chatMode: false }),
      makeRecord({ subagentId: 'bg-terminal-1', status: 'done' }),
    ])

    const counts = useSidebarCounts(sid)
    // 3 条记录里仅 bg-live-1 真在跑：done 投影（绿点滞留）与显式终态都不点亮 badge
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  it('waiting（resumable 等续聊）仍计入（与「进行中」桶口径一致：可复活非终态）', () => {
    const sid = ref<string | null>('sess-wait')
    const store = useSubagentStore()
    store.applyRecords('sess-wait', [
      makeRecord({ subagentId: 'bg-wait-1', status: 'running', resumable: true }),
    ])

    const counts = useSidebarCounts(sid)
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  // H2 W1（record-unification D1②）：workflow 脚本派发的 record（origin='workflow'）
  // 不点亮 subagent badge——workflow 进度由 workflow tab 承载。用户可见行为 = 徽标
  // 数字只数手动派发的进行中 subagent。
  it('origin=workflow 的 record 不计入 badge（tool record 正常计入）', () => {
    const sid = ref<string | null>('sess-wf')
    const store = useSubagentStore()
    store.applyRecords('sess-wf', [
      makeRecord({ subagentId: 'bg-tool-live', status: 'running' }),
      makeRecord({ subagentId: 'bg-wf-live', status: 'running', origin: 'workflow' }),
      makeRecord({ subagentId: 'bg-wf-wait', status: 'running', resumable: true, origin: 'workflow' }),
    ])

    const counts = useSidebarCounts(sid)
    // 3 条记录里仅手动派发的 bg-tool-live 点亮 badge；workflow 来源（含 waiting 形态）全被滤除
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  it('origin 缺省（存量 record，undefined = tool 语义）不受过滤影响（W1 零迁移保障）', () => {
    const sid = ref<string | null>('sess-legacy')
    const store = useSubagentStore()
    store.applyRecords('sess-legacy', [
      makeRecord({ subagentId: 'bg-legacy-1', status: 'running' }),
    ])

    const counts = useSidebarCounts(sid)
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  it('无焦点 session（null）→ 0；空分区 → 0', () => {
    const sid = ref<string | null>('sess-empty')
    const counts = useSidebarCounts(sid)
    expect(counts.subagentRunningCount.value).toBe(0)

    sid.value = null
    expect(counts.subagentRunningCount.value).toBe(0)
  })

  it('与「进行中」桶计数恒一致（D6 #5：判据直接引用 subagentBucket SSOT，混合 fixture 下 badge = countSubagents.active）', () => {
    const sid = ref<string | null>('sess-mix')
    const store = useSubagentStore()
    const records = [
      makeRecord({ subagentId: 'm1', status: 'running' }),
      makeRecord({ subagentId: 'm2', status: 'running', resumable: true }),
      makeRecord({ subagentId: 'm3', status: 'running', result: '本轮产出', chatMode: false }),
      makeRecord({ subagentId: 'm4', status: 'done' }),
      makeRecord({ subagentId: 'm5', status: 'failed', error: 'boom' }),
    ]
    store.applyRecords('sess-mix', records)

    const counts = useSidebarCounts(sid)
    // badge（D8 收窄）= 2（m1 streaming + m2 waiting；m3 done 投影排除）
    expect(counts.subagentRunningCount.value).toBe(2)
    // 与分桶 SSOT 的 active 桶计数恒等（同源判据，badge ↔ 桶不再分叉）
    expect(counts.subagentRunningCount.value).toBe(countSubagents(records).active)
  })
})

// R3-1④ + R3-7（H2 阶段 3 一致性审查修复）：fixture 源 = runtime extractor 真实投影。
// 既有用例手工拼 origin（makeRecord override）只能验证 composable 判据本身；runtime
// 投影白名单断链（origin 恒 undefined）时它们照样绿。本组用例经 scanSubagentEntries
// 派生——白名单删 origin → 投影断言 undefined → 下游过滤断言同步转红（红锚联动）。
describe('useSidebarCounts × runtime extractor 真实投影产物（R3-1④/R3-7）', () => {
  it('投影透传 + badge：extractor 产出的 workflow record 不计入 badge（投影白名单删 origin 即红）', () => {
    const records = projectedRecords([
      { v: 1, id: 'bg-proj-tool', status: 'running' },
      { v: 1, id: 'bg-proj-wf', status: 'running', origin: 'workflow' },
    ])
    // fixture 源证明：origin 由 runtime 投影产出，非手工拼装
    expect(records.find((r) => r.subagentId === 'bg-proj-wf')?.origin).toBe('workflow')

    const sid = ref<string | null>('sess-proj')
    const store = useSubagentStore()
    store.applyRecords('sess-proj', records)

    const counts = useSidebarCounts(sid)
    // 2 条投影记录里仅手动派发的 bg-proj-tool 点亮 badge
    expect(counts.subagentRunningCount.value).toBe(1)
  })

  it('R3-7 列表链：workflow origin record 不进 subagentList（running 与终态都不进，GUI 列表域 = 手动派发）', () => {
    const records = projectedRecords([
      { v: 1, id: 'bg-list-tool', status: 'running' },
      { v: 1, id: 'bg-list-wf-running', status: 'running', origin: 'workflow' },
      { v: 1, id: 'bg-list-wf-closed', status: 'closed', origin: 'workflow', closedReason: 'gc', endedAt: 2000 },
    ])
    const sid = ref<string | null>('sess-list-proj')
    const store = useSubagentStore()
    store.applyRecords('sess-list-proj', records)

    const counts = useSidebarCounts(sid)
    const ids = counts.subagentList.value.map((r) => r.subagentId)
    expect(ids).toContain('bg-list-tool')
    expect(ids).not.toContain('bg-list-wf-running')
    expect(ids).not.toContain('bg-list-wf-closed')
  })

  it('R3-7 零迁移：extractor 缺省投影（存量 record，origin undefined）保留在列表', () => {
    const records = projectedRecords([{ v: 1, id: 'bg-list-legacy', status: 'running' }])
    expect(records[0]?.origin).toBeUndefined()

    const sid = ref<string | null>('sess-list-legacy')
    const store = useSubagentStore()
    store.applyRecords('sess-list-legacy', records)

    const counts = useSidebarCounts(sid)
    expect(counts.subagentList.value.map((r) => r.subagentId)).toEqual(['bg-list-legacy'])
  })
})

// ── sessionCount（设计 sidebar-tab-count-restore §2.3 口径表第 1 行 / §3.1 终态）──
// 口径 = 侧边栏全量会话数 − 已归档（markedDone）数；死会话计入；全局口径不随焦点变化。
// markers 隔离：useSessionMarkers 是模块级 cache + localStorage 持久化，跨用例残留会污染
// 归档断言——沿用 useSessionMarkers.test.ts 的隔离模式（localStorage.clear + __resetCacheForTest）。
describe('useSidebarCounts sessionCount（sidebar-tab-count-restore 口径）', () => {
  const MARKERS_STORAGE_KEY = 'xyz-agent:session-markers'

  function makeSummary(id: string, status: SessionSummary['status'] = 'idle'): SessionSummary {
    return { id, label: id, cwd: '/proj', status, lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
  }

  function seedSessions(sessions: SessionSummary[]): void {
    useSessionStore().applySnapshot({ groups: [{ cwd: '/proj', sessions }] } satisfies SessionGroup[])
  }

  beforeEach(() => {
    localStorage.clear()
    __resetCacheForTest()
  })

  it('无归档时 = session.list 长度；列表为空 → 0', () => {
    const sid = ref<string | null>('sess-count-a')
    const counts = useSidebarCounts(sid)

    // 空列表（加载失败 / 未加载时 groups 为空同形态）→ 0
    expect(counts.sessionCount.value).toBe(0)

    seedSessions([makeSummary('s1'), makeSummary('s2'), makeSummary('s3')])
    expect(counts.sessionCount.value).toBe(3)
  })

  it('归档一条后 −1，取消归档恢复（markers cache 响应式联动）', () => {
    const sid = ref<string | null>('sess-count-b')
    seedSessions([makeSummary('s1'), makeSummary('s2'), makeSummary('s3')])

    const counts = useSidebarCounts(sid)
    expect(counts.sessionCount.value).toBe(3)

    // 写入口 = useSessionMarkers.toggleMarkedDone（SessionItem Archive 按钮同源链路），
    // 替换 cache.value 触发 computed 重算
    toggleMarkedDone('s2')
    expect(counts.sessionCount.value).toBe(2)

    toggleMarkedDone('s2')
    expect(counts.sessionCount.value).toBe(3)
  })

  it('死会话（dead）计入——侧边栏列表仍渲染（置灰降权），数字与列表一致不穿帮', () => {
    const sid = ref<string | null>('sess-count-c')
    seedSessions([makeSummary('s1', 'dead'), makeSummary('s2', 'idle'), makeSummary('s3', 'idle')])

    const counts = useSidebarCounts(sid)
    expect(counts.sessionCount.value).toBe(3)
  })

  it('markers 未 hydrate 首读正确：localStorage 已有归档标记，首次计算即扣减', () => {
    // beforeEach 已 __resetCacheForTest（hydrated=false），此处先落盘再读——
    // 走 isMarkedDone → ensureCache 的首次 hydrate 路径，不允许依赖任何前置读取
    localStorage.setItem(
      MARKERS_STORAGE_KEY,
      JSON.stringify({ s2: { markedDone: true }, s1: { unread: true } }),
    )
    seedSessions([makeSummary('s1'), makeSummary('s2'), makeSummary('s3')])

    const sid = ref<string | null>('sess-count-d')
    const counts = useSidebarCounts(sid)
    // 仅 s2 markedDone 扣减；s1 只 unread 不影响归档口径
    expect(counts.sessionCount.value).toBe(2)
  })
})
