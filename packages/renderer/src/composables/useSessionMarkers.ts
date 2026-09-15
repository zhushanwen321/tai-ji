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

// ── localStorage 读写 ──

function readAll(): Record<string, SessionMarker> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, SessionMarker>
  } catch {
    return {}
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
  cache.value = new Map(Object.entries(readAll()))
}

/**
 * 写路径统一（Q1-1）：ensureCache → 基于 cache 变异 → 替换 cache.value（触发响应式）→ 立即写盘。
 * 不再每次写 readAll（消除 localStorage.getItem + 全量 JSON.parse 的重复——此前写路径完全
 * 绕过内存缓存，5 个后台 session 同时完成 = 5 次全量 parse/stringify 跑在主线程）。
 * 写盘保持立即 setItem（不引入 idle 合并，验收口径 = readAll 重复消除）。
 */
function mutateMarker(sid: string, mutate: (marker: SessionMarker) => void): void {
  ensureCache()
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
      // 直接从事件 newValue 更新缓存，不重新 parse localStorage（避免竞态）
      try {
        const data = e.newValue ? JSON.parse(e.newValue) as Record<string, SessionMarker> : {}
        cache.value = new Map(Object.entries(data))
      } catch {
        cache.value = new Map()
      }
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
}

/**
 * useSessionMarkers composable（函数式封装，方便测试 mock）。
 */
export function useSessionMarkers() {
  return { markUnread, clearUnread, isUnread, toggleMarkedDone, isMarkedDone, clearAll }
}
