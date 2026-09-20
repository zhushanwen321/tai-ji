/**
 * Renderer 全局错误捕获三件套（D2-① / u2-renderer-errors）。
 *
 * E3 教训：renderer 崩溃前零日志——9/9 OOM 崩溃后 `~/.taiji/logs/` 里没有任何
 * renderer 侧现场。本模块在 app 创建后立即安装三个捕获面：
 * ① `app.config.errorHandler`——组件 render / setup / 生命周期钩子错误（Vue 体系内；
 *    handler 不 rethrow，Vue 不再走默认 console 报错链路，组件树不卸载）
 * ② `window` error 事件——Vue 体系外的全局 JS 错误（addEventListener 形态，等价
 *    window.onerror 捕获面且不覆盖第三方注册；资源加载错误事件无 message，跳过）
 * ③ `unhandledrejection`——未接住的 Promise rejection
 * 捕获后组装错误记录（时间戳 / 错误栈 / 可选 performance.memory 快照 / 当前
 * sessionId / 来源）经 electronAPI.reportRendererLog 上报，main 侧落盘
 * renderer-error-<date>.log（限流与 windowId 由 main 权威处理）。
 *
 * **三件套自身零抛错**：任何环节（含发送失败 / pinia 未激活 / performance.memory
 * 缺失）一律静默降级——日志通道故障不得再炸 renderer（D2 的降级契约，错误捕获器
 * 自身成为新崩溃源是最坏形态）。
 */
import type { App } from 'vue'
import type { RendererErrorSource, RendererLogPayload, RendererMemorySnapshot } from '@taiji/shared'
import i18n from '../i18n'
import { reportRendererLog } from '../lib/ipc'
import { usePanelStore } from '../stores/panel'
import { useToast } from '../composables/useToast'

/**
 * 安装三件套。main.ts 在 createApp 后、pinia/mount 之前调用（尽早覆盖启动期错误；
 * sessionId 读取是惰性的——安装早期 pinia 未激活时捕获的错误省略该字段）。
 */
export function installRendererErrorReporting(app: App): void {
  try {
    app.config.errorHandler = (err, _instance, info) => {
      report('vue-error-handler', err, info)
      // RD-2#1 上屏显形：只落盘用户不可见——渲染面异常时补一次 toast（限流防风暴）
      toastVueError()
      // 不 rethrow：Vue 3 存在 errorHandler 时错误不再向默认链路传播，组件树保留
      // （设计确认语义：抑制默认错误处理，不卸载整树）
    }
  // eslint-disable-next-line taste/no-silent-catch -- 安装失败静默降级为「无 errorHandler」，与历史行为等价，不得阻断启动（D2 降级契约：错误捕获器不得成为新崩溃源）
  } catch {
    // no-op
  }
  try {
    window.addEventListener('error', (e: ErrorEvent) => {
      // 资源加载错误（img/script 失败）事件无 error 对象与 message，非 JS 错误，跳过
      if (!e.error && !e.message) return
      report('window-onerror', e.error ?? e.message)
    })
  // eslint-disable-next-line taste/no-silent-catch -- 安装失败不阻断启动（D2 降级契约）
  } catch {
    // no-op
  }
  try {
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      report('unhandledrejection', e.reason)
    })
  // eslint-disable-next-line taste/no-silent-catch -- 安装失败不阻断启动（D2 降级契约）
  } catch {
    // no-op
  }
}

// ── 上报组装（全部容错，零抛错）────────────────────────────────────

/**
 * Vue 渲染错误的统一上报入口（D2 单一上报通道）：全局 errorHandler 与组件级错误边界
 * （StreamItemBoundary，RD-2#1）共用。source 沿用 'vue-error-handler'——本质同为 Vue
 * 体系错误，区分点记在 message 前缀（调用方传入 vueInfo）。
 *
 * 容错契约与 report 一致：任何环节异常静默（上报器不得成为新崩溃源）。
 */
export function reportCapturedError(err: unknown, vueInfo?: string): void {
  report('vue-error-handler', err, vueInfo)
}

/** RD-2#1 上屏限流窗口：渲染错误风暴（连环坏帧）下 toast 不刷屏，30s 至多一条。 */
const VUE_ERROR_TOAST_INTERVAL_MS = 30_000
let lastVueErrorToastAt = 0

/**
 * errorHandler 附加的上屏 toast（RD-2#1 ③）：全局 handler 原本只落盘，用户对渲染面
 * 异常零感知。补一条含 sessionId 的 error toast——与落盘互补（落盘管取证、toast 管显形）。
 * 组件级边界捕获的错误不经过这里（return false 已阻断），本 toast 只显形边界外的漏网错误。
 * 全链路 try/catch：i18n 未就绪 / pinia 未激活 / toast 通道故障均静默放弃上屏（落盘已在先）。
 */
function toastVueError(): void {
  try {
    const now = Date.now()
    if (now - lastVueErrorToastAt < VUE_ERROR_TOAST_INTERVAL_MS) return
    lastVueErrorToastAt = now
    useToast().error(i18n.global.t('panel.message.renderErrorToast'), {
      ...(readActiveSessionId() !== undefined ? { sessionId: readActiveSessionId() } : {}),
    })
  // eslint-disable-next-line taste/no-silent-catch -- 上屏是落盘之后的增值显形：任何环节失败静默放弃，与模块零抛错契约一致
  } catch {
    // no-op
  }
}

function report(source: RendererErrorSource, err: unknown, vueInfo?: string): void {
  try {
    const message = formatMessage(err, vueInfo)
    if (!message) return
    const payload: RendererLogPayload = {
      source,
      message,
      timestamp: Date.now(),
      ...(readActiveSessionId() !== undefined ? { sessionId: readActiveSessionId() } : {}),
      ...(extractStack(err) !== undefined ? { stack: extractStack(err) } : {}),
      ...(readMemorySnapshot() !== undefined ? { memory: readMemorySnapshot() } : {}),
    }
    // 经 api 门面（lib/ipc，B1 IPC 封装层惯例）上报：其内部全容错（无 IPC / invoke
    // reject / 同步抛错均静默），这里不再重复包发送层
    reportRendererLog(payload)
  // eslint-disable-next-line taste/no-silent-catch -- 组装环节任何异常静默：错误捕获器自身零抛错是 D2 降级契约
  } catch {
    // no-op
  }
}

/**
 * RD-3#2：runtime 启动失败真因落台账。连接屏显示之外的可观测留痕——经 renderer-log
 * 通道落 renderer-error-<date>.log（main 侧限流权威）。调用方 = App.vue（runtime-error
 * 推送 / get-runtime-start-error 拉取兜底到达时，与显示共用同一到达路径）。
 * 容错契约与 report 一致：任何环节异常静默（上报器不得成为新崩溃源）。
 */
export function reportRuntimeStartError(message: string): void {
  report('runtime-start-failed', message)
}

/** Error → message；其余值安全字符串化（String() 对 Symbol/异常对象也可能抛，再兜一层）。 */
function formatMessage(err: unknown, vueInfo?: string): string {
  let message: string
  if (err instanceof Error && err.message) {
    message = err.message
  } else {
    try {
      message = String(err)
    // String(Symbol 等 exotic 值) 可抛；无消息则放弃上报
    } catch {
      return ''
    }
  }
  if (!message) return ''
  // Vue info（如 'render function' / 'setup function'）标注错误发生环节，取证增值
  return vueInfo ? `${message} (vue:${vueInfo})` : message
}

function extractStack(err: unknown): string | undefined {
  if (err instanceof Error && typeof err.stack === 'string' && err.stack.length > 0) {
    return err.stack
  }
  return undefined
}

/** 当前活跃 session（panel focusedSessionId）；pinia 未激活 / 无活跃 session 时省略。 */
function readActiveSessionId(): string | undefined {
  try {
    const sid = usePanelStore().focusedSessionId
    return typeof sid === 'string' && sid.length > 0 ? sid : undefined
  // 安装早期 pinia 未激活（getActivePinia 抛错）属预期窗口；sessionId 是可选取证字段
  } catch {
    return undefined
  }
}

// ── performance.memory 窄化（禁 any：unknown + 运行时 guard）────────

/**
 * Chromium 专属非标准 API（探针 P-mem-api 留 u6/阶段 5 验证）：不可用时整字段省略，
 * 不阻塞上报（设计 D6-③ 降级路径）。guard 与 main 侧 handler 的 payload 校验同构
 * （跨进程边界，无法共享运行时实现，仅共享类型 RendererMemorySnapshot）。
 */
function readMemorySnapshot(): RendererMemorySnapshot | undefined {
  try {
    const mem = (performance as Performance & { memory?: unknown }).memory
    if (!isMemorySnapshot(mem)) return undefined
    return {
      usedJSHeapSize: mem.usedJSHeapSize,
      totalJSHeapSize: mem.totalJSHeapSize,
      jsHeapSizeLimit: mem.jsHeapSizeLimit,
    }
  // performance 全局异常环境（极端）静默省略快照
  } catch {
    return undefined
  }
}

function isMemorySnapshot(v: unknown): v is RendererMemorySnapshot {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Partial<RendererMemorySnapshot>
  return (
    typeof m.usedJSHeapSize === 'number' &&
    typeof m.totalJSHeapSize === 'number' &&
    typeof m.jsHeapSizeLimit === 'number'
  )
}
