/**
 * useAppUpdate —— 自动升级的单例 composable（w4 update-frontend）。
 *
 * 本文件是装配层：订阅生命周期（subscribeProgress）+ 对外 composable 签名 + 测试后门。
 * 行为按变化轴拆在同目录 use-app-update-*.ts（依赖单向，均指向 use-app-update-state）：
 *
 * | 模块                       | 变化轴                                     |
 * |----------------------------|--------------------------------------------|
 * | use-app-update-state.ts    | 单例 state + 跨轴标志（errorHandled/pendingRestored） |
 * | use-app-update-errors.ts   | 错误码 → 文案映射（D9 追加 / A-D1 细分）    |
 * | use-app-update-notes.ts    | releaseNotes 多语言提取 + markdown 渲染     |
 * | use-app-update-check.ts    | checkForUpdate 主流程（令牌/ES4/ES5/限额退避） |
 * | use-app-update-actions.ts  | 两阶段升级动作（download/install/fallback） |
 * | use-app-update-restore.ts  | 启动恢复链（preloaded / pending 提醒）      |
 * | use-app-update-launch.ts   | 启动结果一次性 toast（D5）                  |
 * | use-app-update-autocheck.ts| 30s 首查 + 60min 周期 + visibility 补查调度 |
 *
 * 9 状态机：idle/checking/available/downloading/downloaded/replacing/restarting/error/unsupported。
 * checkForUpdate：经 ipc 检测新版，命中后异步渲染 releaseNotes 为 HTML。performUpdate 已删除
 * （批次 3 m17）；两阶段 performDownload/performInstall 替代，download 传意图（version 字符串），
 * release 数据由 main 权威解析（RC1）。initAutoCheck：先读 update:getSettings 的 autoUpdate
 * 开关——false 时只执行恢复链（零定时器/零 listener/零联网），true 时 30s 后首次检测
 * （应用启动后延迟避开冷启动高峰）。
 *
 * 单例范式：module-level state（全应用共享）+ refCount 引用计数管理订阅生命周期，
 * 对齐 usePlatformChrome.ts:34-52。UpdateButton 与 Sidebar 都读同一份 state。
 *
 * 订阅引用计数：每个消费者调 useAppUpdate() 时 refCount++，最后一个消费者 dispose 时才退订，
 * 避免「Sidebar 先于 UpdateButton 卸载→ listening=false 但 UpdateButton 仍在用 state → 进度/错误事件丢失」
 * 的多消费者竞争（旧 listening flag 只由首个调用者的 onScopeDispose 守护，有缺口）。
 *
 * 错误双通路去重：onUpdateError 为 SSOT（已收到则置 updateFlags.errorHandled=true），
 * performDownload/performInstall 的 catch 仅在 !errorHandled 时兜底置 error
 * （避免覆盖更精确的 onUpdateError 信息）。
 *
 * 依赖方向：api/domains/settings（settings 域 IPC 测试 mock 接缝层，转发 @/lib/ipc）
 * + 上述同目录轴模块。
 */
import { onScopeDispose } from 'vue'
import { UPDATE_STALE_RELEASE } from '@xyz-agent/shared'
import { onUpdateProgress, onUpdateError } from '@/api/domains/settings'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import { updateFlags, updateState, resetUpdateStateForTest } from './use-app-update-state'
import { UNSUPPORTED_ERROR_CODE, resolveErrorSuggestion } from './use-app-update-errors'
import { checkForUpdate, resetCheckForTest } from './use-app-update-check'
import { performDownload, performInstall, openFallbackUrl } from './use-app-update-actions'
import { initAutoCheck, resetAutoCheckForTest } from './use-app-update-autocheck'
import { restorePendingUpdate, restorePreloadedUpdate } from './use-app-update-restore'

// 模块级 t：subscribeProgress 的 toast 在 main 推送回调里触发，非 setup
// 同步上下文用不了 useI18n()，照抄同目录 useProviderImport.ts 的 global.t 模式（B2 review）
const t = i18n.global.t

/**
 * 订阅引用计数：每个消费者调 useAppUpdate() 时 ++，最后一个 dispose 时才退订。
 * 解决多消费者竞争：Sidebar 与 UpdateButton 各自的 onScopeDispose 独立守护，
 * 任何一个先卸载只减计数，不影响仍存活的消费者继续接收进度/错误事件。
 */
let refCount = 0

/**
 * 订阅 main 进程的进度 + 错误推送（引用计数管理生命周期）。
 * 首个消费者订阅，后续消费者只增计数；最后一个消费者 dispose 时退订。
 * onScopeDispose 注册在每个调用 useAppUpdate 的组件作用域上，随该作用域卸载而清理。
 */
function subscribeProgress(): void {
  refCount++
  if (refCount !== 1) return  // 已有订阅，只增计数
  // 首次订阅
  const offProgress = onUpdateProgress((p) => {
    // stage 映射 state：downloading/replacing（restarting 由 performInstall resolve 后置）
    if (p.stage === 'downloading' || p.stage === 'replacing') {
      updateState.state = p.stage
    }
    updateState.percent = p.percent
  })
  const offError = onUpdateError((e) => {
    // onUpdateError 为 SSOT：优先处理错误信息
    if (e.errorCode === UNSUPPORTED_ERROR_CODE) {
      updateState.state = 'unsupported'
    } else if (e.errorCode === UPDATE_STALE_RELEASE) {
      // 设计 §3.5.1②：请求版本已过期（main 权威 latest 更新）→ 自动重查拿新 latest，
      // 不进 error 态（用户无责，信息性提示 + 自动恢复）。重查命中后 state 转 available，
      // 用户再次点击下载即拿到新版本（T3 验收路径）。
      // 必须在重查前显式置稳定态：performDownload 已置 downloading 且其 catch 会被
      // errorHandled 去重跳过，不置态则下方 checkForUpdate 捕获的 prevState='downloading'，
      // 重查恰逢 rateLimited 时假 downloading 被固化（UpdateCheckCard 无按钮 + 周期检查
      // 守卫跳过 → UI 永久卡死）。置 available（latestRelease 仍在，重查成功即刷新；
      // 极端情况下用户再点下载会再次 STALE → 再次自动重查，有出路非死锁）。
      updateState.state = 'available'
      console.info('[useAppUpdate] stale release detected, auto re-checking:', e.message)
      const { info: toastInfo } = useToast()
      toastInfo(t('sidebar.update.staleRelease'))
      void checkForUpdate(true)
    } else {
      updateState.state = 'error'
      updateState.errorMessage = e.message
      // D9：网络/代理类错误在 main suggestion 末尾追加手动下载逃生通道指引
      updateState.errorSuggestion = resolveErrorSuggestion(e)
      // D4：失败 toast 触发点在 useAppUpdate 单例的 onUpdateError 回调
      // toast 只弹摘要（message），suggestion 太长不进 toast，留在 hover 浮层/设置页
      const { error: toastError } = useToast()
      toastError(e.message)
    }
    updateFlags.errorHandled = true
  })
  onScopeDispose(() => {
    refCount--
    if (refCount === 0) {
      offProgress()
      offError()
    }
  })
}

/**
 * useAppUpdate：返回单例 state + 操作方法。
 * 必须在活跃 effect scope 内调用（subscribeProgress/initAutoCheck 依赖 onScopeDispose），
 * 通常在组件 setup 顶层同步调用。
 */
export function useAppUpdate() {
  subscribeProgress()
  return {
    state: updateState,
    checkForUpdate,
    performDownload,
    performInstall,
    openFallbackUrl,
    initAutoCheck,
  }
}

/**
 * 测试后门（形态对齐 useExtensionHostBridge.__testing）：restore* 仅测试消费——
 * 绕过 initAutoCheck 的 30s 定时器直调；运行时由 initAutoCheck 内部触发，
 * 组件不需要直接调，故不进生产返回对象。
 */
export const __testing = {
  restorePendingUpdate,
  restorePreloadedUpdate,
}

/**
 * 重置单例 state（仅供测试使用）。
 * module-level state 跨测试会残留，需在 beforeEach 显式重置以保证用例隔离。
 * 各轴模块的模块级闭包变量（renderToken/rateLimitHintShown/定时器/visibility 态）
 * 一并经各轴的 reset 函数重置；refCount 在本文件（订阅轴）。
 */
export function _resetForTest(): void {
  resetAutoCheckForTest()
  resetUpdateStateForTest()
  resetCheckForTest()
  refCount = 0
}
