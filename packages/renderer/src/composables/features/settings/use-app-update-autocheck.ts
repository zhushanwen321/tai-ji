/**
 * useAppUpdate 的自动检测调度轴：启动编排（initAutoCheck）+ 60min 周期（递归 setTimeout）
 * + visibilitychange 补查（Q1-6）+ 定时器生命周期清理。
 *
 * 依赖方向：本模块 → use-app-update-check（checkForUpdate）+ use-app-update-state
 * （读 updateState.state 守卫）+ use-app-update-restore（启动恢复链）+ use-app-update-launch
 * （启动结果通知）。被 useAppUpdate.ts 消费。
 */
import { onScopeDispose } from 'vue'
import { getUpdateSettings as ipcGetUpdateSettings } from '@/api/domains/settings'
import { updateState } from './use-app-update-state'
import { checkForUpdate } from './use-app-update-check'
import { restorePreloadedUpdate, restorePendingUpdate } from './use-app-update-restore'
import { checkLaunchResult } from './use-app-update-launch'

/** 自动检测首次延迟：应用启动后 30s（避开冷启动资源竞争） */
const AUTO_CHECK_DELAY_MS = 30_000

/**
 * 自动检测周期：每 60 分钟联网检测一次。
 *
 * GitHub API 未认证限额 60 次/小时，1h 一次 = 1 次/小时，配额宽裕；与 release-checker
 * 的 1h 缓存 TTL 同档（更密的周期也只会命中缓存）。启动后 30s 已有首查 + 恢复可见
 * 补查，周期检测只覆盖「应用连开数天」的长驻场景，无需更高频率。
 * 用递归 setTimeout 而非 setInterval：checkForUpdate 是 async，setInterval 会在
 * 上一次未完成时排下一次，可能堆积并发请求；递归 setTimeout 保证「上一次完成后才排下一次」。
 */
const CHECK_INTERVAL_MINUTES = 60
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
const AUTO_CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND // 60min

/** 可见性补查最小间隔（RM2.4：10min 内不重复补查，堵频繁切窗 = 频繁联网） */
const VISIBILITY_RECHECK_WINDOW_MINUTES = 10
const VISIBILITY_CHECK_MIN_INTERVAL_MS =
  VISIBILITY_RECHECK_WINDOW_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND

/** 上次可见性补查时刻（epoch ms，0 = 从未）：10min 节流窗口用 */
let lastVisibilityCheckAt = 0

/**
 * 自动检测定时器 id（递归 setTimeout）。
 *
 * 用模块级变量存当前 pending timer，onScopeDispose 时 clearTimeout 避免泄漏
 * （scope 卸载后定时器不应再触发）。runAutoCheck 每次触发后先置 null 再排下一次。
 */
let autoCheckTimer: ReturnType<typeof setTimeout> | null = null

/**
 * visibility 守卫（Q1-6）：hidden 期间被跳过的周期联网检测标记。
 * 恢复可见时据此立即补查一次，不必等下一个周期（应用隐藏一整天后回来，
 * 最多再等一个周期才检测到新版是不可接受的延迟）。
 */
let skippedWhileHidden = false

/** visibilitychange listener 挂载标记（initAutoCheck 可能被多消费者多次调用，幂等挂载防叠加） */
let visibilityListenerAttached = false

/**
 * dispose 标志（W05 review）：onScopeDispose / _resetForTest 置位，initAutoCheck 复位。
 * runAutoCheck 在 await checkForUpdate 期间无 pending timer（autoCheckTimer 已置 null、
 * 下一周期尚未排）——此窗口内 scope dispose 后 clearAutoCheckTimer 无 timer 可清，
 * await 恢复仍会排上 60min timer → 卸载后继续联网。runAutoCheck 排下一周期前检查
 * 本标志，已 dispose 则直接返回。
 */
let disposed = false

/**
 * 清理自动检测定时器（防泄漏）。onScopeDispose 与 _resetForTest 都调它。
 */
function clearAutoCheckTimer(): void {
  if (autoCheckTimer !== null) {
    clearTimeout(autoCheckTimer)
    autoCheckTimer = null
  }
}

/**
 * visibilitychange 补查（Q1-6）：hidden 期间被跳过的联网检测，恢复可见时立即补一次。
 * 清掉已排定的周期 timer 再跑 runAutoCheck（其内部会重排下一周期），避免补查 + 周期双跑。
 */
function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible' || !skippedWhileHidden) return
  skippedWhileHidden = false
  // 节流（RM2.4）：10min 内已补查过 → 跳过本次，保留原周期 timer 不动
  if (Date.now() - lastVisibilityCheckAt < VISIBILITY_CHECK_MIN_INTERVAL_MS) {
    console.log('[useAppUpdate] visibility check throttled (within 10min window)')
    return
  }
  lastVisibilityCheckAt = Date.now()
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
 * 自动检测单次执行：守卫检查 → 检测（force=false 走 1h 缓存，RM2.1）→ 排下一个 60min 周期定时器。
 *
 * 守卫：仅在 idle/available/error/unsupported 态调 checkForUpdate；downloading/
 * replacing/restarting/downloaded 态跳过本次检查（不打断升级流程），但仍排下一次定时器，
 * 保证升级完成后能继续周期检测。
 *
 * visibility 守卫（Q1-6）：document.hidden 时跳过联网检测（后台隐藏期间不发周期请求，
 * 省GitHub API 配额），置 skippedWhileHidden 标记，恢复可见时由 onVisibilityChange 补查。
 *
 * force=false（批次 4 RM2.1）：周期检查走 release-checker 1h 缓存（含负缓存），
 * 正常态 API 消耗 ≤1 次/小时；force=true 保留给设置页手动按钮。
 */
async function runAutoCheck(): Promise<void> {
  autoCheckTimer = null // 当前 timer 已触发
  const canCheck =
    updateState.state === 'idle' ||
    updateState.state === 'available' ||
    updateState.state === 'error' ||
    updateState.state === 'unsupported'
  if (canCheck && document.hidden) {
    // 后台隐藏期间不联网，恢复可见时补查
    skippedWhileHidden = true
  } else if (canCheck) {
    skippedWhileHidden = false
    await checkForUpdate(false)
  }
  // await 期间 scope 可能已 dispose（此时无 pending timer 可清）：
  // 已 dispose 则不排下一周期，防卸载后周期定时器仍联网（W05 review）
  if (disposed) return
  // 无论本次是否检查，都排下一次周期（保证升级完成后继续周期检测）
  autoCheckTimer = setTimeout(runAutoCheck, AUTO_CHECK_INTERVAL_MS)
}

/**
 * 启动自动检测：先恢复持久化提醒（立即），再读 autoUpdate 开关——
 * true 时 30s 首次检测 + 60min 周期 + visibilitychange 补查 listener；
 * false 时只执行恢复链（RM1：恢复链均为本地读取不联网，且不挂任何定时器/
 * listener——无自动检查则补查无意义；设置页手动「检查更新」不受影响）。
 * 开关变更下次启动生效（与 preDownload 开关现状一致）。
 *
 * 必须在活跃 effect scope 内调用，通常在组件 setup 顶层同步调用（onScopeDispose 依赖活跃 scope）；
 * 定时器不需要等 DOM 挂载，故不必放 onMounted。onScopeDispose 清理定时器避免泄漏。
 *
 * 周期机制：30s 首次 → 首次完成（await）→ 60min 周期（递归 setTimeout）。详见 runAutoCheck。
 */
export function initAutoCheck(): void {
  // 防重复 init：先清已有 timer（多消费者场景只保留最新周期，避免泄漏）
  clearAutoCheckTimer()
  skippedWhileHidden = false
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
  void ipcGetUpdateSettings().then((settings) => {
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

/** 重置调度轴的模块级测试态（仅供测试 _resetForTest 组合调用） */
export function resetAutoCheckForTest(): void {
  clearAutoCheckTimer()
  detachVisibilityListener()
  skippedWhileHidden = false
  disposed = false
  // u4a：可见性补查节流时刻也属模块级测试态，一并重置
  lastVisibilityCheckAt = 0
}
