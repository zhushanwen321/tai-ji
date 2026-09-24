/**
 * useAppUpdate —— 自动升级的控制器工厂 + 单例 composable（w4 update-frontend）。
 *
 * 本文件是装配层：createAppUpdateController 产出可实例化控制器（订阅生命周期
 * subscribeProgress + 各轴装配），useAppUpdate() 是模块级惰性单例入口（消费面签名不变）。
 * 行为按变化轴拆在同目录 use-app-update-*.ts（依赖单向，均指向 use-app-update-state）：
 *
 * | 模块                       | 变化轴                                     |
 * |----------------------------|--------------------------------------------|
 * | use-app-update-state.ts    | state 容器（reactive 状态 + 跨轴标志）      |
 * | use-app-update-ipc.ts      | ipc 依赖缝（AppUpdateIpc + 真实 adapter）   |
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
 * 单例范式：useAppUpdate() 返回全应用共享的同一控制器（UpdateButton 与 Sidebar 读同一份
 * state），对齐 usePlatformChrome.ts:34-52；测试用 createAppUpdateController({ ipc }) 建独立
 * 实例即隔离，不再需要全局复位后门。
 *
 * 订阅引用计数：每个消费者调 useAppUpdate() 时 refCount++，最后一个消费者 dispose 时才退订，
 * 避免「Sidebar 先于 UpdateButton 卸载→ listening=false 但 UpdateButton 仍在用 state → 进度/错误事件丢失」
 * 的多消费者竞争（旧 listening flag 只由首个调用者的 onScopeDispose 守护，有缺口）。
 *
 * 错误双通路去重：onUpdateError 为 SSOT（已收到则置 flags.errorHandled=true），
 * performDownload/performInstall 的 catch 仅在 !errorHandled 时兜底置 error
 * （避免覆盖更精确的 onUpdateError 信息）。
 *
 * 依赖方向：use-app-update-ipc（真实 adapter 转发 api/domains/settings——settings 域 IPC
 * 测试 mock 接缝层）+ 上述同目录轴工厂。
 */
import { onScopeDispose } from 'vue'
import { UPDATE_STALE_RELEASE } from '@taiji/shared'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import { createRealAppUpdateIpc } from './use-app-update-ipc'
import type { AppUpdateIpc } from './use-app-update-ipc'
import { createUpdateState } from './use-app-update-state'
import type { UpdateStateContainer } from './use-app-update-state'
import { UNSUPPORTED_ERROR_CODE, resolveErrorSuggestion } from './use-app-update-errors'
import { createCheckAxis } from './use-app-update-check'
import type { CheckSource } from './use-app-update-check'
import { createActionsAxis } from './use-app-update-actions'
import { createAutoCheckAxis } from './use-app-update-autocheck'
import { createRestoreAxis } from './use-app-update-restore'
import { createLaunchAxis } from './use-app-update-launch'

// 模块级 t：subscribeProgress 的 toast 在 main 推送回调里触发，非 setup
// 同步上下文用不了 useI18n()，照抄同目录 useProviderImport.ts 的 global.t 模式（B2 review）
const t = i18n.global.t

/** 可实例化的更新控制器：state + 全部操作方法（组件/测试统一消费面） */
export interface AppUpdateController {
  readonly state: UpdateStateContainer['state']
  checkForUpdate(force?: boolean, source?: CheckSource): Promise<void>
  performDownload(): Promise<void>
  performInstall(): Promise<void>
  openFallbackUrl(): Promise<void>
  initAutoCheck(): void
  /** 运行时由 initAutoCheck 触发；进接口仅供测试/特殊编排直调（绕过 30s 定时器） */
  restorePendingUpdate(): Promise<void>
  /** 运行时由 initAutoCheck 触发；进接口同上 */
  restorePreloadedUpdate(): Promise<boolean>
}

/** 控制器完整形态：AppUpdateController + 订阅注册（useAppUpdate 单例与测试 setup 消费） */
export interface AppUpdateControllerInternal extends AppUpdateController {
  /**
   * 订阅 main 进度/错误推送（引用计数管理生命周期）。
   * 必须在活跃 effect scope 内调用（onScopeDispose 依赖活跃 scope），
   * 通常在组件 setup 顶层同步调用。
   */
  subscribeProgress(): void
}

/** createAppUpdateController 选项 */
export interface CreateAppUpdateControllerOptions {
  /** ipc 依赖缝；缺省用真实 adapter（转发 @/api/domains/settings） */
  ipc?: AppUpdateIpc
}

/**
 * 创建独立的更新控制器实例：state 容器 + 全轴装配 + 引用计数订阅生命周期。
 * 生产侧 useAppUpdate() 单例持一份；测试每用例建新实例即隔离。
 */
export function createAppUpdateController(
  opts?: CreateAppUpdateControllerOptions,
): AppUpdateControllerInternal {
  const ipc = opts?.ipc ?? createRealAppUpdateIpc()
  const st = createUpdateState()
  const { checkForUpdate } = createCheckAxis({ state: st, ipc })
  const { performDownload, performInstall, openFallbackUrl } = createActionsAxis({ state: st, ipc })
  const { restorePreloadedUpdate, restorePendingUpdate } = createRestoreAxis({ state: st, ipc })
  const { checkLaunchResult } = createLaunchAxis(ipc)
  const { initAutoCheck } = createAutoCheckAxis({
    state: st,
    checkForUpdate,
    restorePreloadedUpdate,
    restorePendingUpdate,
    checkLaunchResult,
    ipc,
  })

  /**
   * 订阅引用计数：每个消费者调 subscribeProgress 时 ++，最后一个 dispose 时才退订。
   * 解决多消费者竞争：Sidebar 与 UpdateButton 各自的 onScopeDispose 独立守护，
   * 任何一个先卸载只减计数，不影响仍存活的消费者继续接收进度/错误事件。
   */
  let refCount = 0

  /**
   * 订阅退订句柄（闭包级，对齐 useRollingRestartStatus 的 unsubscribe/subScope 形态）。
   * 仅首个消费者（refCount===1）创建；但触发最终退订（refCount 归 0）的可能是任意一个
   * 消费者的 onScopeDispose，故句柄必须闭包级共享——若做成 subscribeProgress 局部
   * const，第 2/3 消费者早退分支下的闭包永不赋值，末位 dispose 时取到的是 TDZ/undefined。
   */
  let offProgress: (() => void) | null = null
  let offError: (() => void) | null = null

  /**
   * 订阅 main 进程的进度 + 错误推送（引用计数管理生命周期）。
   * 首个消费者订阅，后续消费者只增计数；最后一个消费者 dispose 时退订。
   * onScopeDispose 注册在每个调用方的组件作用域上，随该作用域卸载而清理。
   */
  function subscribeProgress(): void {
    refCount++
    // 先无条件注册 onScopeDispose（含第 2/3 消费者）：每个消费者卸载都要减计数。
    // 旧写法在 `refCount !== 1` 时早退 return，导致第 2/3 消费者（UpdateButton/Sidebar/UpdateCheckCard）
    // 永不注册 onScopeDispose → refCount 只减不到 0，offProgress/offError 永不执行（订阅泄漏，
    // main 推送回调悬空）。修正顺序 = 先挂 dispose，再按 refCount===1 决定是否注册监听。
    onScopeDispose(() => {
      refCount--
      if (refCount === 0) {
        offProgress?.()
        offError?.()
        offProgress = null
        offError = null
      }
    })
    // 已有订阅（第 2/3 消费者）→ 只增计数，不重复注册 listener
    if (refCount !== 1) return
    // 首次订阅：注册进度 + 错误推送，句柄提至闭包级供末位 dispose 退订
    offProgress = ipc.onUpdateProgress((p) => {
      // stage 映射 state：downloading/replacing（restarting 由 performInstall resolve 后置）
      if (p.stage === 'downloading' || p.stage === 'replacing') {
        st.state.state = p.stage
      }
      st.state.percent = p.percent
    })
    offError = ipc.onUpdateError((e) => {
      // onUpdateError 为 SSOT：优先处理错误信息
      if (e.errorCode === UNSUPPORTED_ERROR_CODE) {
        st.state.state = 'unsupported'
      } else if (e.errorCode === UPDATE_STALE_RELEASE) {
        // 设计 §3.5.1②：请求版本已过期（main 权威 latest 更新）→ 自动重查拿新 latest，
        // 不进 error 态（用户无责，信息性提示 + 自动恢复）。重查命中后 state 转 available，
        // 用户再次点击下载即拿到新版本（T3 验收路径）。
        // 必须在重查前显式置稳定态：performDownload 已置 downloading 且其 catch 会被
        // errorHandled 去重跳过，不置态则下方 checkForUpdate 捕获的 prevState='downloading'，
        // 重查恰逢 rateLimited 时假 downloading 被固化（UpdateCheckCard 无按钮 + 周期检查
        // 守卫跳过 → UI 永久卡死）。置 available（latestRelease 仍在，重查成功即刷新；
        // 极端情况下用户再点下载会再次 STALE → 再次自动重查，有出路非死锁）。
        st.state.state = 'available'
        console.info('[useAppUpdate] stale release detected, auto re-checking:', e.message)
        const { info: toastInfo } = useToast()
        toastInfo(t('sidebar.update.staleRelease'))
        // STALE 自动重查是后台恢复动作（非用户点击）→ source='auto'，失败保持静默（RD-4#5）
        void checkForUpdate(true, 'auto')
      } else {
        st.state.state = 'error'
        st.state.errorMessage = e.message
        // D9：网络/代理类错误在 main suggestion 末尾追加手动下载逃生通道指引
        st.state.errorSuggestion = resolveErrorSuggestion(e)
        // D4：失败 toast 触发点在 onUpdateError 回调
        // toast 只弹摘要（message），suggestion 太长不进 toast，留在 hover 浮层/设置页
        const { error: toastError } = useToast()
        toastError(e.message)
      }
      st.flags.errorHandled = true
    })
  }

  return {
    state: st.state,
    checkForUpdate,
    performDownload,
    performInstall,
    openFallbackUrl,
    initAutoCheck,
    restorePendingUpdate,
    restorePreloadedUpdate,
    subscribeProgress,
  }
}

/** useAppUpdate 单例（模块级惰性创建，绑定真实 ipc adapter） */
let singleton: AppUpdateControllerInternal | null = null

/**
 * useAppUpdate：返回单例 state + 操作方法。
 * 必须在活跃 effect scope 内调用（subscribeProgress/initAutoCheck 依赖 onScopeDispose），
 * 通常在组件 setup 顶层同步调用。
 */
export function useAppUpdate() {
  if (!singleton) {
    singleton = createAppUpdateController()
  }
  singleton.subscribeProgress()
  return {
    state: singleton.state,
    checkForUpdate: singleton.checkForUpdate,
    performDownload: singleton.performDownload,
    performInstall: singleton.performInstall,
    openFallbackUrl: singleton.openFallbackUrl,
    initAutoCheck: singleton.initAutoCheck,
  }
}
