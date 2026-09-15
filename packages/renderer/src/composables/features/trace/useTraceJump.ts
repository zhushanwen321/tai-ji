/**
 * useTraceJump —— Trace 溯源跳转编排（design §3.1 样例 5：SESSION 行 parentSession
 * 链接点击 → 切源 session + 开 Trace 视图 + 定位 forkEntryId 行高亮）。
 *
 * 编排跨 store/composable（session 列表匹配 + sidebar 切换 + trace 分区状态 + drawer
 * 联动），归 features 层；解析匹配用 core resolveTraceParentSession 纯函数（两种
 * parentSession 形态：文件路径 / sessionId fallback）。
 *
 * 失败路径（返回 result，不 throw——调用方 toast 文案 i18n）：
 *  - target_not_found：源 session 不在列表（已删除/未加载）
 *  - load_failed：目标 trace 加载超时（网络/runtime 异常）
 */
import { watch } from 'vue'
import { resolveTraceParentSession } from '@taiji/core/domain/session-trace'
import { useSessionStore } from '@/stores/session'
import {
  ensureTraceLoaded,
  revealTraceEntry,
  setTraceFilter,
  setTraceView,
  useSessionTrace,
} from './useSessionTrace'

/** 目标 trace 加载等待上限（selectSession 后 getTraceEntries RPC 往返 + 首渲染）。 */
const TRACE_READY_TIMEOUT_MS = 10_000

type TraceJumpResult =
  | { ok: true; targetSessionId: string }
  | { ok: false; reason: 'target_not_found' | 'load_failed' }

/**
 * 等当前分区（跳转后 = 目标 session 分区）到达 ready 态。
 * 已 ready 立即返回；等待期间用户切走（partition 指向变化）由超时兜底。
 */
function waitForTraceReady(timeoutMs: number): Promise<boolean> {
  const { partition } = useSessionTrace()
  if (partition.value.status === 'ready') return Promise.resolve(true)
  return new Promise((resolve) => {
    const stop = watch(
      () => partition.value.status,
      (status) => {
        if (status === 'ready' || status === 'error') {
          cleanup()
          resolve(status === 'ready')
        }
      },
    )
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    function cleanup(): void {
      stop()
      clearTimeout(timer)
    }
  })
}

/**
 * 跳转到 parentSession 指向的源 session。
 *
 * @param fromSid 当前 session（trace 行所属，仅作日志/调用方上下文，不参与解析）
 * @param parentSession header 的 parentSession 原始值（文件路径或 sessionId）
 * @param forkEntryId 定位行（源 session 内 fork 点 entry id；缺省只切视图不定位）
 */
export async function jumpToParentSession(
  fromSid: string,
  parentSession: string,
  forkEntryId?: string,
): Promise<TraceJumpResult> {
  void fromSid // 当前仅用于调用方上下文；解析只依赖 parentSession 与列表
  const sessionStore = useSessionStore()
  const target = resolveTraceParentSession(parentSession, sessionStore.list)
  if (!target) return { ok: false, reason: 'target_not_found' }
  // useSidebar 动态加载：它的模块链（useChat → '@/api'.chat）在 import 期就要完整 '@/'api
  // 门面，静态引用会迫使所有 mount TraceView 的测试 mock 全量 api。延迟到真正跳转时加载，
  // import 期零重依赖。
  const { useSidebar } = await import('@/composables/features/sidebar/useSidebar')
  const { selectSession } = useSidebar()
  await selectSession(target.id)
  // 切到 Trace 视图 + 清过滤（contextOnly/chips/搜索可能隐藏 forkEntryId 行）
  setTraceView(target.id, 'trace')
  setTraceFilter(target.id, { contextOnly: false, activeGroups: [], searchText: '' })
  ensureTraceLoaded(target.id)
  const ready = await waitForTraceReady(TRACE_READY_TIMEOUT_MS)
  if (!ready) return { ok: false, reason: 'load_failed' }
  if (forkEntryId) revealTraceEntry(target.id, forkEntryId)
  return { ok: true, targetSessionId: target.id }
}
