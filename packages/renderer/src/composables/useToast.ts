/**
 * useToast —— 全局 toast 通知（最小实现）。
 *
 * 使用方式：
 *   const { toasts, error } = useToast()
 *   error('操作失败')
 *   info('goal blocked', { sessionLabel: '修通知 · taiji' })
 *
 * ToastContainer 组件负责渲染，挂载点在 main-panel 内两分支：PanelContainer 的
 * main-area（chat 主区，右上角，不遮 drawer/composer）与 MainPanel（settings
 * view 兜底）。
 *
 * 在列上限（D7 S3-W4 限流与防毒化）：在列 toast 达到 UI_TOAST_LIMITS.MAX_IN_FLIGHT
 * （shared SSOT，默认 5）时新 toast 丢弃并累计 droppedCount——通知风暴（恶意/缺陷
 * 插件高频 notify）不刷屏，runtime 侧 20/s 令牌桶是第一道防线，此处是前端兜底。
 *
 * 停留时长分级：error/warning 是需用户行动的信号（goal blocked 等），8s；info 命令回显 4s。
 * hover 暂停：多行 body（最多 5 行）阅读时间因人而异，鼠标悬停时暂停自动移除、移开恢复
 * （pause/resume 记录剩余时长，不重置计时）。
 */
import { ref } from 'vue'
import { UI_TOAST_LIMITS } from '@taiji/shared'

export interface Toast {
  id: number
  message: string
  type: 'error' | 'info' | 'warning'
  /** session 定位行（`{label} · {目录}`）：后台 session 的 notify 来源标识，点击跳转该 session */
  sessionLabel?: string
  /** toast 来源 session id：定位行点击跳转用。无 session 语义的通知（plugin-crashed）不设 */
  sessionId?: string
}

/** toast 可选参数 */
interface ToastOptions {
  sessionLabel?: string
  sessionId?: string
}

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：toast 通知列表（全局通知 UI 状态）
const toasts = ref<Toast[]>([])
let nextId = 0

/** 因在列上限被丢弃的 toast 累计计数（可观测：排查通知风暴的量级证据） */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：toast 丢弃计数（节流统计，非 GUI 数据）
const droppedCount = ref(0)

/** 停留时长：需行动的级别更久（8s），info 命令回显 4s */
const TOAST_DURATION_MS = 4000
const TOAST_DURATION_ACTIONABLE_MS = 8000

function durationFor(type: Toast['type']): number {
  return type === 'info' ? TOAST_DURATION_MS : TOAST_DURATION_ACTIONABLE_MS
}

/** [Q1-8] toast 自动移除 timer 句柄：remove 提前关 toast 时 clearTimeout，避免 4s 后空跑回调。
 * 携带 durationMs/startedAt：pause 时算剩余时长用。 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：toast 定时器句柄表，非 GUI 数据
const timers = new Map<number, { timer: ReturnType<typeof setTimeout>; durationMs: number; startedAt: number }>()

/** hover 暂停状态：pause 时算出的剩余时长，resume 时按它重建 timer */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：toast 暂停状态表，非 GUI 数据
const paused = new Map<number, { remainingMs: number }>()

/** 自动移除 toast，记录句柄供 remove 清理 */
function scheduleRemove(id: number, durationMs: number): void {
  const startedAt = Date.now()
  const timer = setTimeout(() => {
    timers.delete(id)
    paused.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, durationMs)
  timers.set(id, { timer, durationMs, startedAt })
}

/** 限流策略类型：返回 true 表示应丢弃当前 toast */
type ToastLimiter = (toasts: Toast[]) => boolean

const defaultLimiter: ToastLimiter = (toasts) => toasts.length >= UI_TOAST_LIMITS.MAX_IN_FLIGHT
let activeLimiter: ToastLimiter = defaultLimiter

/** 注入自定义限流策略（测试用）。传 null 恢复默认。 */
export function setToastLimiter(custom: ToastLimiter | null): void {
  activeLimiter = custom ?? defaultLimiter
}

/** 入列公共路径：在列上限守门（超出丢弃计数 + warn，防风暴刷屏） */
function push(type: Toast['type'], message: string, opts?: ToastOptions): void {
  if (activeLimiter(toasts.value)) {
    droppedCount.value += 1
    console.warn(
      `[toast] dropped (in-flight limit ${UI_TOAST_LIMITS.MAX_IN_FLIGHT}, total dropped ${droppedCount.value}): ${message}`,
    )
    return
  }
  const id = nextId++
  toasts.value = [...toasts.value, { id, message, type, ...opts }]
  scheduleRemove(id, durationFor(type))
}

export function useToast() {
  function error(message: string, opts?: ToastOptions): void {
    push('error', message, opts)
  }

  function info(message: string, opts?: ToastOptions): void {
    push('info', message, opts)
  }

  function warning(message: string, opts?: ToastOptions): void {
    push('warning', message, opts)
  }

  function remove(id: number): void {
    // [Q1-8] 提前关闭时清掉自动移除 timer（句柄不存在 = 已自然触发，no-op）
    const entry = timers.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      timers.delete(id)
    }
    paused.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  /** hover 暂停自动移除（按 startedAt 算剩余时长，幂等：已暂停 no-op） */
  function pause(id: number): void {
    const entry = timers.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    timers.delete(id)
    const remainingMs = Math.max(0, entry.durationMs - (Date.now() - entry.startedAt))
    paused.set(id, { remainingMs })
  }

  /** hover 离开恢复计时（按剩余时长重建 timer，未暂停 no-op） */
  function resume(id: number): void {
    const state = paused.get(id)
    if (!state) return
    paused.delete(id)
    scheduleRemove(id, state.remainingMs)
  }

  return { toasts, error, info, warning, remove, pause, resume, droppedCount }
}
