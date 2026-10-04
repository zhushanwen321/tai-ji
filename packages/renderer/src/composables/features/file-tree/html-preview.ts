/**
 * HTML 渲染态挂载状态机（chat-html-support §6.4 D4，R2 logic 层）。
 *
 * 职责（单一变化轴「渲染态挂载序列」）：
 *   挂载前 servable 预检（主进程 localFile:servable，与协议 handler 同一准入谓词）
 *   → servable=true 开 sandbox iframe（local-file:// URL，路径百分号编码 + ?r=n 重导航）
 *   → servable=false / IPC 拒绝 → 「无法预览」占位带原因 + 重试
 *
 * 纯逻辑模块（无 store / 无 electronAPI / 无 i18n 直依赖；类型面经 type-only import 取
 * `@taiji/shared` 的通道契约，无运行期依赖）：预检函数由调用方注入，便于单测对着契约
 * 驱动全部降级分支（u3 只依赖 u-foundation 的通道类型契约）。
 *
 * 诚实边界（设计 §6.4）：sandbox opaque origin 下父页面读不到 iframe 文档状态码，
 * 占位触发 = 两层主动检查（挂载前预检 + 刷新时重检）；不承诺区分 403/404 的精确错误 UI。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { LocalFileServableReason, LocalFileServableResult } from '@taiji/shared'

/** 渲染态视图模式：rendered=iframe 渲染（默认）/ source=既有 shiki 源码高亮 */
export type HtmlViewMode = 'rendered' | 'source'

/** 渲染态挂载状态：idle（未挂载）/ pending（预检在途，显中性加载态）/ ready（iframe 已挂载）/ unavailable（占位） */
export type HtmlPreviewStatus = 'idle' | 'pending' | 'ready' | 'unavailable'

/**
 * 不可预览原因：
 * - not_found / is_dir / out_of_whitelist = 主进程 servable 谓词三原因（§6.9 D9）
 * - service_unavailable = IPC invoke 拒绝（通道不可用，§6.4 子决策③）
 */
export type HtmlPreviewReason = LocalFileServableReason | 'service_unavailable'

// 主进程 servable 谓词入/出参面不在此另立副本：定义 SSOT = `@taiji/shared`
// （packages/shared/src/ipc-payloads.ts，C-comm-22 唯一类型源；preload 两文件 /
// renderer lib/ipc / main utils 同源 import）。`Html*` 别名保留既有消费面
// （单测直接 import 本模块的类型；useDetailPane 注入 lib/ipc.localFileServable）。
export type {
  LocalFileServableReason as HtmlServableReason,
  LocalFileServableResult as HtmlServableResult,
}

/** 预检函数（渲染态注入 lib/ipc 的真实实现；单测注入桩） */
export type HtmlProbe = (absPath: string) => Promise<LocalFileServableResult>

/** 不可预览原因 → i18n key（渲染态只消费 key，文案走 i18n 词条） */
export const HTML_PREVIEW_REASON_KEYS: Record<HtmlPreviewReason, string> = {
  not_found: 'panel.detail.htmlReasonNotFound',
  is_dir: 'panel.detail.htmlReasonIsDir',
  out_of_whitelist: 'panel.detail.htmlReasonOutOfWhitelist',
  service_unavailable: 'panel.detail.htmlReasonServiceUnavailable',
}

/**
 * 按 URL 路径段规则百分号编码（保留 `/` 分隔符，规范化为单个前导 `/`）。
 *
 * [HISTORICAL] 裸拼陷阱（设计 §6.4「路径编码规格」）：文件名含 `#` / `?` / `%` / 空格时
 * 裸拼会被 URL 解析吞成 fragment/query 或错解码（`report#1.html` 裸拼后 handler 实际
 * 收到 `report` 静默 404）。handler 侧按 `decodeURIComponent(new URL(url).pathname)`
 * 解码（成对）——本函数是配对的编码侧。
 */
export function encodeLocalFilePath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `/${normalized.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * 拼渲染态 iframe src：`local-file:///<编码路径>?r=<n>`。
 *
 * `n` 仅作重导航触发（query 不参与取文件）；「改写文件 → 刷新见新版」的缓存新鲜性
 * 由 local-file 响应的 `Cache-Control: no-store` 构造保证（§6.5 D5），本参数不是缓存机制。
 */
export function buildLocalFileUrl(absPath: string, revision: number): string {
  return `local-file://${encodeLocalFilePath(absPath)}?r=${revision}`
}

/** 渲染态控制器（挂载状态机接口面） */
export type HtmlPreviewController = {
  status: Ref<HtmlPreviewStatus>
  reason: Ref<HtmlPreviewReason | null>
  /** 不可预览原因对应 i18n key（无原因时为 null） */
  reasonKey: ComputedRef<string | null>
  /** iframe src（未挂载为 null；「刷新」按钮存在性由它判定） */
  src: Ref<string | null>
  /** 渲染态内递增计数（仅触发重导航） */
  revision: Ref<number>
  /** 重走整个挂载序列（servable 预检 + 重开 iframe）——挂载 / 刷新 / 重试同一入口 */
  mount: (absPath: string) => Promise<void>
  /** 清空（切文件 / 关抽屉） */
  reset: () => void
}

/**
 * 创建渲染态控制器。`mount` 是挂载、刷新、重试三者的同一实现（§6.4 子决策④
 * 「按钮语义归一」）——占位态调它 = 重试，iframe 已挂载态调它 = 刷新。
 */
export function createHtmlPreviewController(probe: HtmlProbe): HtmlPreviewController {
  const status = ref<HtmlPreviewStatus>('idle')
  const reason = ref<HtmlPreviewReason | null>(null)
  const src = ref<string | null>(null)
  const revision = ref(0)
  // 并发守卫：快速切文件 / 连点刷新时丢弃旧预检的 stale write
  let token = 0

  const reasonKey = computed(() => (reason.value ? HTML_PREVIEW_REASON_KEYS[reason.value] : null))

  async function mount(absPath: string): Promise<void> {
    const current = ++token
    status.value = 'pending'
    reason.value = null
    src.value = null
    try {
      const result = await probe(absPath)
      if (current !== token) return
      if (result.servable) {
        revision.value += 1
        src.value = buildLocalFileUrl(absPath, revision.value)
        status.value = 'ready'
      } else {
        reason.value = result.reason ?? 'not_found'
        status.value = 'unavailable'
      }
    } catch {
      // IPC invoke 拒绝（通道不可用）→ 占位（原因：预览服务不可用）+ 重试；诊断细分归 main 日志
      if (current !== token) return
      reason.value = 'service_unavailable'
      status.value = 'unavailable'
    }
  }

  function reset(): void {
    token++
    status.value = 'idle'
    reason.value = null
    src.value = null
  }

  return { status, reason, reasonKey, src, revision, mount, reset }
}
