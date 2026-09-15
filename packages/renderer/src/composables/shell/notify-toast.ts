/**
 * notify-toast —— extension notify → toast 的壳层编排（session 定位 + 前台/后台分级）。
 *
 * NotificationHostController 只透传 message/level/sessionId（core 零 UI 依赖），本模块在壳侧
 * 消费 sessionId 做两件事：
 *
 * 1. 定位行：`{label} · {目录名}`。多 session 并行时右上角 toast 必须能回答「这是哪个会话在说」。
 *    label 兜底链（对应「rename-session 未触发」窗口）：
 *      显式/rename 后的 label → 首条 user prompt 前 15 字（label 仍为 runtime 派生的
 *      basename(cwd) 时）→ 派生 label 本身。prompt 兜底只在 toast 查询时即时派生，
 *      不写回 sessionStore（不改 sidebar 展示语义，label 真源仍是 runtime）。
 * 2. 分级过滤（goal 等过程性通知的降噪裁决）：
 *      - 无 sessionId（plugin-crashed 等全局事件）→ 照弹（保守，不丢通知）
 *      - error / warning → 照弹（需要用户行动：goal blocked、budget 90% 等）
 *      - info：前台（focused）照弹——/goal、/permission 等命令回显的唯一反馈通道，砍掉即零反馈；
 *        后台丢弃——goal start / budget 70% / objective completed 是过程信息，
 *        完成信号已有提示音 + 未读标记双通道（useCompletionNotify），toast 只剩噪音
 *
 * pinia 时序：bridge 装配在 main.ts 先于 app.use(createPinia)，故 store 必须在回调触发时
 * （运行期，pinia 已激活）惰性解析，不能在模块顶层调用 useXxxStore。
 */
import type { SessionSummary } from '@taiji/shared'
import { normalizeContent } from '@taiji/shared'
import { useSessionStore } from '@/stores/session'
import { useChatStore } from '@/stores/chat'
import { usePanelStore } from '@/stores/panel'
import { useToast } from '@/composables/useToast'

/** prompt 兜底 label 长度（字符）。用户裁决值：足以定位、不至于撑爆定位行。 */
const PROMPT_FALLBACK_LEN = 15

/** 路径目录名（POSIX/macOS 与 Windows 分隔符都取最后段）。 */
function basename(p: string): string {
  const segs = p.split(/[/\\]/).filter(Boolean)
  return segs.length > 0 ? segs[segs.length - 1] : p
}

/**
 * 解析展示 label。session.label 为 runtime 派生值（basename(cwd)，session-lifecycle W1
 * 派生不持久化）时说明 rename-session 尚未触发，用首条 user prompt 前缀补足辨识度。
 */
function resolveDisplayLabel(session: SessionSummary, dir: string): string {
  if (session.label && session.label !== dir) return session.label
  return firstUserPromptPrefix(session.id) ?? session.label ?? dir
}

/**
 * 首条 user prompt 前 15 字（空白折叠）。读 chat store 分区——LRU 保留最近 8 个 session，
 * 未触发 rename 的 session 必然近期活跃（首 turn 内），分区存在；被驱逐的旧 session
 * 兜底退化用 label（可接受降级）。user content 是 Segment[]（badge 载体），normalizeContent 归一。
 */
function firstUserPromptPrefix(sessionId: string): string | null {
  const partition = useChatStore().messages.get(sessionId)
  const first = partition?.value.find((m) => m.role === 'user')
  if (!first) return null
  const text = normalizeContent(first.content).trim().replace(/\s+/g, ' ')
  return text.length > 0 ? text.slice(0, PROMPT_FALLBACK_LEN) : null
}

/**
 * session 定位行文本：`{label} · {目录名}`（label 与目录同名时只显示一段）。
 * session 不在 store（未知/已删除/内部隐藏 session）→ null（toast 不渲染定位行，退化为纯消息）。
 */
export function buildSessionLocator(sessionId: string | undefined): string | null {
  if (!sessionId) return null
  const session = useSessionStore().list.find((s) => s.id === sessionId)
  if (!session) return null
  const dir = basename(session.cwd)
  const label = resolveDisplayLabel(session, dir)
  return label === dir ? dir : `${label} · ${dir}`
}

/**
 * 分级过滤：本次 notify 是否应弹 toast（规则见模块头注释）。
 * warn 归一：runtime event-adapter 把 pi 的 warning 翻译为 'warn'，两级都视为需行动。
 */
export function shouldShowSessionNotify(sessionId: string | undefined, level: string | undefined): boolean {
  if (!sessionId) return true
  if (level === 'error' || level === 'warning' || level === 'warn') return true
  return sessionId === usePanelStore().focusedSessionId
}

/**
 * NotificationHostController deps.showToast 装配（bridge 消费）：过滤 → 定位行 → level 映射
 * （error→error / warn|warning→warning / 其余→info，对齐旧线 useExtensionNotify）。
 * 定位行双条件（ToastContainer：sessionLabel && sessionId）——sessionId 必须透传，
 * 非字符串归一 undefined；抽为工厂供壳层与装配测试共用（真实入口走 useToast 模块单例）。
 */
export function createNotifyToastHandler(): (message: string, level: string | undefined, sessionId?: unknown) => void {
  const { error, info, warning } = useToast()
  return (message, level, sessionId) => {
    const sid = typeof sessionId === 'string' ? sessionId : undefined
    if (!shouldShowSessionNotify(sid, level)) return
    const sessionLabel = buildSessionLocator(sid) ?? undefined
    const options = { sessionLabel, sessionId: sid }
    if (level === 'error') error(message, options)
    else if (level === 'warning' || level === 'warn') warning(message, options)
    else info(message, options)
  }
}
