/**
 * useSidebarCounts 单测（tab 计数口径）。
 *
 * 覆盖两个留存的 tab 计数：
 * - sessionCount（§2.3 口径）：侧边栏全量会话数 − 已归档（markedDone）
 *   数，全局口径不随焦点 session 变化。
 * - fileCount：焦点 session 文件树根层条目数（目录计入，不递归）；无焦点 session → 0。
 *
 * [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：原 subagent/workflow 计数段与 badge 口径用例
 * （D8 / U8b 两态化重述、runtime extractor 真实投影产物联动）随 Agents/Flows tab 退役删除
 * ——同口径断言现行承载 = `__tests__/panel/tray/useTrayCounts.test.ts`（P2 阶段复制迁入的托盘计数）。
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/composables/useSidebarCounts.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useSidebarCounts } from '@/composables/features/sidebar/useSidebarCounts'
import { useSessionStore } from '@/stores/session'
import { useFileTreeStore } from '@/stores/fileTree'
import { toggleMarkedDone, __resetCacheForTest } from '@/composables/useSessionMarkers'
import type { SessionGroup, SessionSummary } from '@taiji/shared'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useSidebarCounts fileCount（文件树根层条目数）', () => {
  it('无焦点 session（null）→ 0；焦点 session 无树 → 0', () => {
    const sid = ref<string | null>(null)
    const counts = useSidebarCounts(sid)
    expect(counts.fileCount.value).toBe(0)

    sid.value = 'sess-no-tree'
    expect(counts.fileCount.value).toBe(0)
  })

  it('焦点 session 根层条目数（目录计入，不递归子树）', () => {
    const sid = ref<string | null>('sess-file-count')
    const fileTreeStore = useFileTreeStore()
    fileTreeStore.setTree('sess-file-count', [
      { name: 'src', path: 'src', type: 'dir', children: [
        { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 1 },
      ] },
      { name: 'README.md', path: 'README.md', type: 'file', size: 2 },
    ])

    const counts = useSidebarCounts(sid)
    // 根层两条（子节点 index.ts 不计入——根层口径，非递归）
    expect(counts.fileCount.value).toBe(2)
  })
})

// ── sessionCount（§2.3 口径）──
// 口径 = 侧边栏全量会话数 − 已归档（markedDone）数；死会话计入；全局口径不随焦点变化。
// markers 隔离：useSessionMarkers 是模块级 cache + localStorage 持久化，跨用例残留会污染
// 归档断言——沿用 useSessionMarkers.test.ts 的隔离模式（localStorage.clear + __resetCacheForTest）。
describe('useSidebarCounts sessionCount（tab 计数口径）', () => {
  const MARKERS_STORAGE_KEY = 'taiji:session-markers'

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
