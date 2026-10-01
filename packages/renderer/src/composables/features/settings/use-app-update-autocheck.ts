/**
 * useAppUpdate 的自动检测调度轴工厂：启动编排（initAutoCheck）+ 30s 首查 + 15min 周期
 * （递归 setTimeout）+ visibilitychange 补查（时间阈值驱动）+ 定时器生命周期清理。
 *
 * 定时器 id / 上次联网检查时刻 / disposed 标志是调度轴的私有可变态，收进
 * createAutoCheckAxis 闭包——每个控制器实例独立一份，测试建新控制器即隔离。
 *
 * 补查语义（时间阈值驱动）：恢复可见时距上次联网检查 ≥7.5min 即补查一次。不依赖
 * 「hidden 期间被跳过」的标记位（原 skippedWhileHidden 只能由周期 timer 触发置位，
 * 定时器链一旦死亡补查通道随之失活）；时间阈值使 visibility 补查成为独立自愈
 * 通路——周期链因任意形态沉默后，恢复可见即可拉起检查并重排周期。频繁切窗
 * 不致额外真实联网：main 侧 15min 缓存兜底，7.5~15min 间的补查请求命中缓存零请求。
 *
 * 依赖方向：本模块 → use-app-update-check（checkForUpdate，含 60s ipc 超时兜底）
 * + use-app-update-state（读 state 守卫）+ use-app-update-restore（启动恢复链）
 * + use-app-update-launch（启动结果通知）+ use-app-update-ipc。被 useAppUpdate.ts 消费。
 */
import { onScopeDispose } from 'vue'
import type { AppUpdateIpc } from './use-app-update-ipc'
import type { UpdateStateContainer } from './use-app-update-state'
import type { CheckSource } from './use-app-update-check'

/** 自动检测首次延迟：应用启动后 30s（避开冷启动资源竞争） */
const AUTO_CHECK_DELAY_MS = 30_000

/**
 * 自动检测周期：每 15 分钟联网检测一次（2026-10-01 用户裁决：由 60min 收紧到 15min，更快发现新版本）。
 *
 * GitHub API 未认证限额 60 次/小时，15min 一次 = 4 次/小时，配额仍宽裕；与 release-checker
 * 的 15min 缓存 TTL 同档（更密的周期也只会命中缓存，真实联网频率不超 4 次/小时）。启动后
 * 30s 已有首查 + 恢复可见补查，周期检测覆盖「应用连开数天」的长驻场景。
 * 用递归 setTimeout 而非 setInterval：checkForUpdate 是 async，setInterval 会在
 * 上一次未完成时排下一次，可能堆积并发请求；递归 setTimeout 保证「上一次完成后才排下一次」。
 */
const CHECK_INTERVAL_MINUTES = 15
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
const AUTO_CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND // 15min

/**
 * 恢复可见补查阈值：距上次联网检查 ≥7.5min 才补查。取周期（15min）的一半——
 * 比周期紧（长时间隐藏后半个周期内即可补上检查），又对频繁切窗保持防抖；
 * 7.5~15min 间的补查由 main 侧 15min 缓存兜底，真实联网频率不超周期预算。
 */
const VISIBILITY_RECHECK_AFTER_MINUTES = 7.5
const VISIBILITY_RECHECK_AFTER_MS =
  VISIBILITY_RECHECK_AFTER_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND

/** 自动检测调度轴依赖：state 容器 + 各轴方法 + ipc 缝 */
export interface AutoCheckAxisDeps {
  state: UpdateStateContainer
  checkForUpdate(force?: boolean, source?: CheckSource): Promise<void>
  restorePreloadedUpdate(): Promise<boolean>
  restorePendingUpdate(): Promise<void>
  checkLaunchResult(): Promise<void>
  ipc: Pick<AppUpdateIpc, 'getUpdateSettings'>
}

/** 自动检测调度轴 */
export interface AutoCheckAxis {
  /**
   * 启动自动检测：先恢复持久化提醒（立即），再读 autoUpdate 开关——
   * true 时 30s 首次检测 + 15min 周期 + visibilitychange 补查 listener；
   * false 时只执行恢复链（RM1：恢复链均为本地读取不联网，且不挂任何定时器/
   * listener——无自动检查则补查无意义；设置页手动「检查更新」不受影响）。
   * 开关变更下次启动生效（与 preDownload 开关现状一致）。
   *
   * 必须在活跃 effect scope 内调用，通常在组件 setup 顶层同步调用（onScopeDispose 依赖活跃 scope）；
   * 定时器不需要等 DOM 挂载，故不必放 onMounted。onScopeDispose 清理定时器避免泄漏。
   */
  initAutoCheck(): void
}

/** 创建自动检测调度轴（定时器/联网时刻收进闭包，实例间互不干扰） */
export function createAutoCheckAxis(deps: AutoCheckAxisDeps): AutoCheckAxis {
  const { state, checkForUpdate, restorePreloadedUpdate, restorePendingUpdate, checkLaunchResult, ipc } = deps

  /**
   * 上次联网检查发起时刻（epoch ms，0 = 从未）：恢复可见补查的阈值判定基准。
   * 在真正发起联网检测时更新（runAutoCheck 联网分支），hidden 跳过与状态守卫
   * 跳过均不更新——基准必须是「真实联网」而非「周期空转」。
   */
  let lastNetworkCheckAt = 0

  /**
   * 自动检测定时器 id（递归 setTimeout）。
   *
   * 存当前 pending timer，onScopeDispose 时 clearTimeout 避免泄漏
   * （scope 卸载后定时器不应再触发）。runAutoCheck 每次触发后先置 null 再排下一次。
   */
  let autoCheckTimer: ReturnType<typeof setTimeout> | null = null

  /** visibilitychange listener 挂载标记（initAutoCheck 可能被多消费者多次调用，幂等挂载防叠加） */
  let visibilityListenerAttached = false

  /**
   * dispose 标志（W05 review）：onScopeDispose 置位，initAutoCheck 复位。
   * runAutoCheck 在 await checkForUpdate 期间无 pending timer（autoCheckTimer 已置 null、
   * 下一周期尚未排）——此窗口内 scope dispose 后 clearAutoCheckTimer 无 timer 可清，
   * await 恢复仍会排上 15min timer → 卸载后继续联网。runAutoCheck 排下一周期前检查
   * 本标志，已 dispose 则直接返回。
   */
  let disposed = false

  /**
   * 自动检查可执行态守卫：idle/available/error/unsupported 才联网检测；
   * downloading/replacing/restarting/downloaded（升级流程态）跳过（不打断升级流程）。
   * runAutoCheck 与 visibility 补查共用同一判定。
   */
  function canAutoCheck(): boolean {
    const s = state.state.state
    return s === 'idle' || s === 'available' || s === 'error' || s === 'unsupported'
  }

  /**
   * 清理自动检测定时器（防泄漏）。onScopeDispose 触发时调用。
   */
  function clearAutoCheckTimer(): void {
    if (autoCheckTimer !== null) {
      clearTimeout(autoCheckTimer)
      autoCheckTimer = null
    }
  }

  /**
   * visibilitychange 补查（时间阈值驱动）：恢复可见时距上次联网检查 ≥7.5min 即补查，
   * 不必等下一个周期（应用隐藏一整天后回来，最多再等一个周期才检测到新版是
   * 不可接受的延迟）。升级流程态（canAutoCheck=false）不补查。
   * 清掉已排定的周期 timer 再跑 runAutoCheck（其内部会重排下一周期），避免补查 + 周期双跑。
   */
  function onVisibilityChange(): void {
    if (document.visibilityState !== 'visible') return
    if (!canAutoCheck()) return
    if (Date.now() - lastNetworkCheckAt < VISIBILITY_RECHECK_AFTER_MS) return
    clearAutoCheckTimer()
    void runAutoCheck()
  }

  /** 幂等挂载/卸载 visibilitychange listener（initAutoCheck 多次调用防叠加） */
  function attachVisibilityListener(): void {
    if (visibilityListenerAttached) return
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityListenerAttached = true
  }

  function detachVisibilityListener(): void {
    if (!visibilityListenerAttached) return
    document.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityListenerAttached = false
  }

  /**
   * 自动检测单次执行：守卫检查 → 检测（force=false 走 15min 缓存，RM2.1）→ 排下一个 15min 周期定时器。
   *
   * 守卫（canAutoCheck）：升级流程态跳过本次检查，但仍排下一次定时器，
   * 保证升级完成后能继续周期检测。
   *
   * visibility 守卫：document.hidden 时跳过联网检测（后台隐藏期间不发周期请求，
   * 省 GitHub API 配额），恢复可见时由 onVisibilityChange 按时间阈值补查。
   *
   * force=false（批次 4 RM2.1）：周期检查走 release-checker 15min 缓存（含负缓存），
   * 正常态 API 消耗 ≤1 次/小时；force=true 保留给设置页手动按钮。
   */
  async function runAutoCheck(): Promise<void> {
    autoCheckTimer = null // 当前 timer 已触发
    if (canAutoCheck() && !document.hidden) {
      // 联网基准时刻在发起时记录（超时兜底也计入——兜底目的是保链活着，非重试加速）
      lastNetworkCheckAt = Date.now()
      await checkForUpdate(false)
    }
    // await 期间 scope 可能已 dispose（此时无 pending timer 可清）：
    // 已 dispose 则不排下一周期，防卸载后周期定时器仍联网（W05 review）
    if (disposed) return
    // 无论本次是否检查，都排下一次周期（保证升级完成后继续周期检测）
    autoCheckTimer = setTimeout(runAutoCheck, AUTO_CHECK_INTERVAL_MS)
  }

  function initAutoCheck(): void {
    // 防重复 init：先清已有 timer（多消费者场景只保留最新周期，避免泄漏）
    clearAutoCheckTimer()
    disposed = false // 新 init 复活周期检测（此前 scope dispose 置位过则清除）
    // 恢复链无条件执行（RM1：均为本地读取不联网，开关只控制「自动检查」行为）
    // 先恢复 preloaded（downloaded 态，优先级高于 pending）
    void restorePreloadedUpdate().then((restored) => {
      if (!restored) {
        // preloaded 无效 → 回退 restorePendingUpdate（available 态）
        void restorePendingUpdate()
      }
    })
    // 读取启动结果（升级成功/失败/回滚），consumed 一次性：首次调用返回结果并清空
    void checkLaunchResult()
    // [RM1 开关消费] 异步读设置（fire-and-forget 保持 initAutoCheck 同步签名，
    // onScopeDispose 须在同步段注册）。autoUpdate 缺失/undefined 视为 true
    //（与 DEFAULT true 一致；显式 false 才关闭）。
    void ipc.getUpdateSettings().then((settings) => {
      // settings await 期间 scope 可能已 dispose：不挂任何定时器/listener
      if (disposed) return
      if (settings.autoUpdate === false) {
        console.log('[useAppUpdate] autoUpdate disabled: scheduling skipped (restore chain only)')
        return
      }
      attachVisibilityListener()
      // 30s 后首次联网检测（避开冷启动高峰 + 刷新 release info），首次完成后转周期
      autoCheckTimer = setTimeout(runAutoCheck, AUTO_CHECK_DELAY_MS)
    })
    onScopeDispose(() => {
      clearAutoCheckTimer()
      detachVisibilityListener()
      disposed = true // 标记已卸载：在跑的 runAutoCheck await 恢复后不再排下一周期
    })
  }

  return { initAutoCheck }
}
