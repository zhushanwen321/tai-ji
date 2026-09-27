/**
 * useSessionMarkers —— 统一 per-session 用户标记（未读 + 标记完成）。
 *
 * 设计决策（handoff §为什么合并）：
 * - 单 localStorage key `taiji:session-markers`
 * - 单 registerSessionCleanup 注册
 * - 单 storage event listener（多窗口同步）
 * - 标记完成时内部自动清除同 sid 的 unread
 *
 * 为什么不用 useSessionScopedState：标量 boolean flag 不需要 reactive 容器模式，
 * localStorage + 内存缓存更合适。但必须走 registerSessionCleanup 注册清理。
 */
import { shallowRef } from 'vue'
import { registerSessionCleanup } from '@/composables/useSessionScopedState'

interface SessionMarker {
  unread?: boolean
  markedDone?: boolean
}

const STORAGE_KEY = 'taiji:session-markers'

// ── 内存缓存（避免每次 isUnread 都 parse JSON）──
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：session 角标（unread/markedDone）localStorage 内存缓存（12 类未覆盖；权威 = localStorage）
const cache = shallowRef<Map<string, SessionMarker>>(new Map())
// 是否已尝试从 localStorage hydrate。禁止用 cache.value.size===0 推断「是否已 hydrate」——
// localStorage 存空对象 {} 时 new Map 是空 Map，size===0 恒成立，会导致每次查询都重新 parse。
let hydrated = false

// ── 损坏保护（RD-1#2 / 审计 M4 族：损坏数据读回空骨架 → 全量覆写）──
// localStorage 值解析失败时置 corrupt：此期间一切写盘被拒绝（mutateMarker early-return），
// 防止以（可能不完整的）内存表 setItem 覆写原始损坏字符串——原始值保留在 localStorage
// 供人工恢复。另一窗口经 storage 事件写入合法值（或删 key）即自动解除保护。
let corrupt = false
// warn 去重（防刷屏）：损坏发生与拒绝写各只提示一次，__resetCacheForTest 复位。
let warnedCorrupt = false
let warnedRefuseWrite = false

function warnCorruptOnce(error: unknown): void {
  if (warnedCorrupt) return
  warnedCorrupt = true
  console.warn(
    `[session-markers] localStorage key '${STORAGE_KEY}' 值损坏（JSON 解析失败），未读/完成标记暂不可读，且写入已暂停以防覆写原始数据。` +
      `恢复动作：DevTools 执行 localStorage.getItem('${STORAGE_KEY}') 检查并修复，或 localStorage.removeItem('${STORAGE_KEY}') 重置`,
    error,
  )
}

function warnRefuseWriteOnce(): void {
  if (warnedRefuseWrite) return
  warnedRefuseWrite = true
  console.warn(
    `[session-markers] 标记数据处于损坏保护中，本次标记变更不会写盘（防空表覆写）；恢复动作见上一条警告，另一窗口写入合法值后自动恢复`,
  )
}

/**
 * 解析并应用存储值（主读取 hydrate 与 storage 事件共用同一损坏方案）。
 * 空值（null/''）= 合法空表；解析失败 = 保留 cache 旧值（不置空）+ 置 corrupt。
 */
function applyParsedMarkers(raw: string | null): void {
  if (!raw) {
    cache.value = new Map()
    corrupt = false
    return
  }
  try {
    const data = JSON.parse(raw) as Record<string, SessionMarker>
    cache.value = new Map(Object.entries(data))
    corrupt = false
  } catch (error) {
    corrupt = true
    warnCorruptOnce(error)
  }
}

/**
 * 确保 cache 已从 localStorage hydrate。首次调用（无论 localStorage 为空还是有数据）hydrate 一次，
 * 之后不再重复。后续写操作（mutateMarker）会同步更新 cache.value，读取直接命中。
 * 查询函数（isUnread/isMarkedDone）调此函数保证首次读取正确，同时访问 cache.value
 * 建立响应式依赖（markUnread/clearUnread 改 cache.value 时，依赖此函数结果的 computed 重算）。
 */
function ensureCache(): void {
  if (hydrated) return
  hydrated = true
  applyParsedMarkers(localStorage.getItem(STORAGE_KEY))
}

/**
 * 写路径统一（Q1-1）：ensureCache → 基于 cache 变异 → 替换 cache.value（触发响应式）→ 立即写盘。
 * hydrate 后写路径不再全量读回 localStorage（消除 getItem + 全量 JSON.parse 的重复——此前
 * 每次写都绕过内存缓存，5 个后台 session 同时完成 = 5 次全量 parse/stringify 跑在主线程）。
 * 写盘保持立即 setItem（不引入 idle 合并，验收口径 = 读盘重复消除）。
 */
function mutateMarker(sid: string, mutate: (marker: SessionMarker) => void): void {
  ensureCache()
  // 损坏保护（RD-1#2）：hydrate 失败（corrupt）时内存表不代表真实数据，拒绝写盘——
  // 否则以空表 setItem 全量覆写，所有 session 的未读/完成标记不可逆丢失。
  if (corrupt) {
    warnRefuseWriteOnce()
    return
  }
  const marker: SessionMarker = { ...cache.value.get(sid) }
  mutate(marker)
  const next = new Map(cache.value)
  // 两个标记都为 false/undefined 时移除整个条目（不残留空对象）
  if (!marker.unread && !marker.markedDone) {
    next.delete(sid)
  } else {
    next.set(sid, marker)
  }
  cache.value = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)))
}

// ── 多窗口同步（storage event）──
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      // 直接从事件 newValue 更新缓存，不重新 parse localStorage（避免竞态）；
      // 损坏 newValue 与主读取（ensureCache）共用 applyParsedMarkers 同一方案：
      // 解析失败保留旧 cache + 置 corrupt，合法值（含 null=另一窗口删 key）则替换并解除保护
      applyParsedMarkers(e.newValue)
    }
  })
}

// ── API ──

/** 标记 session 为未读 */
export function markUnread(sid: string): void {
  mutateMarker(sid, (marker) => {
    marker.unread = true
  })
}

/** 清除 session 未读标记（无条目时 no-op，不写盘） */
export function clearUnread(sid: string): void {
  ensureCache()
  if (!cache.value.has(sid)) return
  mutateMarker(sid, (marker) => {
    marker.unread = false
  })
}

/** 查询 session 是否未读 */
export function isUnread(sid: string): boolean {
  ensureCache()
  return cache.value.get(sid)?.unread ?? false
}

/** 切换标记完成状态，内部自动清除同 sid 的 unread */
export function toggleMarkedDone(sid: string): void {
  mutateMarker(sid, (marker) => {
    marker.markedDone = !marker.markedDone
    // 标记完成时自动清除 unread
    if (marker.markedDone) {
      marker.unread = false
    }
  })
}

/** 查询 session 是否已标记完成 */
export function isMarkedDone(sid: string): boolean {
  ensureCache()
  return cache.value.get(sid)?.markedDone ?? false
}

/** 清除 session 的所有标记（registerSessionCleanup 注册用；无条目时 no-op，不写盘） */
export function clearAll(sid: string): void {
  ensureCache()
  if (!cache.value.has(sid)) return
  mutateMarker(sid, (marker) => {
    marker.unread = false
    marker.markedDone = false
  })
}

// ── 注册 session 销毁清理 ──
registerSessionCleanup(clearAll)

/** 测试专用：重新注册 cleanup（__clearSessionCleanupRegistryForTest 后补注册）。 */
export function __registerCleanupForTest(): void {
  registerSessionCleanup(clearAll)
}

/** 测试专用：重置内存缓存与 hydrated flag（localStorage.clear() 不同步模块级 cache，测试隔离用）。 */
export function __resetCacheForTest(): void {
  cache.value = new Map()
  hydrated = false
  corrupt = false
  warnedCorrupt = false
  warnedRefuseWrite = false
}

/**
 * useSessionMarkers composable（函数式封装，方便测试 mock）。
 */
export function useSessionMarkers() {
  return { markUnread, clearUnread, isUnread, toggleMarkedDone, isMarkedDone, clearAll }
}
