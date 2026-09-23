/**
 * useAppUpdate 的联网检测主流程轴（checkForUpdate 状态机 + 守卫族）。
 *
 * - 请求令牌（renderToken）：用户快速连续点击检测时丢弃陈旧解析
 * - 防覆盖守卫：pendingRestored（恢复链已提醒）时不进 checking / 不回退 idle
 * - 限额退避（rateLimited）：「限额未知」≠「确认无新版」，恢复原态 + 一次性提示
 * - 状态守卫 ES4/ES5：downloaded 态不被联网检测误覆盖（同版本保持 / 新版本退回 available）
 *
 * 依赖方向：本模块 → use-app-update-state（读改 updateState + 读 pendingRestored）
 * + use-app-update-notes（渲染 releaseNotes）。被 useAppUpdate.ts / use-app-update-autocheck 消费。
 */
import type { LatestReleaseInfo, UpdateState } from '@taiji/shared'
import { checkForUpdate as ipcCheckForUpdate } from '@/api/domains/settings'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import { updateFlags, updateState } from './use-app-update-state'
import { renderReleaseNotes } from './use-app-update-notes'

const t = i18n.global.t

/**
 * 限额提示去重标记（RM2.3）：一次退避窗口内只弹一次非侵入提示，
 * 窗口结束后（某次 check 返回 rateLimited=false）复位，下个窗口可再提示。
 */
let rateLimitHintShown = false

/**
 * 请求令牌（renderToken）：用户快速连续点击检测时，旧请求的 ipc 返回/releaseNotes 渲染可能
 * 在状态已变后才 resolve，会覆盖更新（正确）的状态。用递增令牌丢弃陈旧解析：每次进入本次调用
 * 递增 renderToken，await 后若令牌已变（说明期间又发了新 checkForUpdate）则丢弃本次结果。
 */
let renderToken = 0

/**
 * 检查触发源（RD-4#5）：区分用户主动点击（manual）与后台自动检查（auto）。
 * manual = 设置页「检查更新」按钮 + error 态「重试」按钮；auto = 启动 30s 首查 / 60min 周期 /
 * visibility 补查 / STALE 自动重查。仅 manual 失败置 error 态显形，auto 失败保持静默。
 *
 * 背景：旧签名 checkForUpdate(force=false) 无 source，且 force=true 同时被手动检查与 error 重试
 * 使用——不能拿 force 当 manual 判据（审查 E 订正）。故显式加 source 参数。
 */
type CheckSource = 'manual' | 'auto'

/**
 * 进入 checking 态前的状态守卫：记录本次检测前的稳定态（prevState）并按需置 checking。
 *
 * 防覆盖守卫：若已从 pending 恢复 available 态，联网检测不进入 checking 态
 * （否则 available→checking→idle 会短暂隐藏提醒，且失败/无更新会丢失已恢复的提醒）。
 * 仅当未恢复 pending（首次检测 / 正常流程）时才进入 checking 态。
 * prevState：限额退避（rateLimited）时恢复原态——「限额未知」≠「确认无新版」，
 * 不应把已有 available 提醒回退成 idle（RM2.3，2026-08 一致性审查补齐）。
 * 降级守卫：理论并发（上一 check 未返回又触发本次）时 state 可能仍是瞬态 checking，
 * 恢复瞬态态会被周期检查守卫卡死（canCheck 不含 checking），降级为 idle。
 */
function beginCheckTransition(): UpdateState {
  const prevState = updateState.state === 'checking' ? 'idle' : updateState.state
  if (!updateFlags.pendingRestored) {
    updateState.state = 'checking'
  }
  return prevState
}

/**
 * 限额退避处理（RM2.3）：main 侧 2h 窗口零联网短路 → 状态恢复原样，不当作「无新版」；
 * 一次性非侵入提示（不进 error 态；周期/补查/手动同路径，手动点「检查更新」
 * 也能得到解释而非静默无反应）
 */
function handleRateLimited(prevState: UpdateState): void {
  updateState.state = prevState
  if (!rateLimitHintShown) {
    rateLimitHintShown = true
    const { info: toastInfo } = useToast()
    toastInfo(t('sidebar.update.rateLimited'))
  }
}

/**
 * 检测命中新版：应用 release 信息 + 置 available + 异步渲染 releaseNotes。
 * myToken 用于渲染完成后的防陈旧检查（令牌语义见 checkForUpdate）。
 */
function applyCheckResult(info: LatestReleaseInfo, myToken: number): void {
  // 状态守卫 ES4：downloaded/replacing/restarting 不被覆盖（除非检测到更新版本=ES5）
  const currentVersion = updateState.latestRelease?.version
  const isUpgrading = info.version !== currentVersion // 检测到不同（更新）版本
  if (
    updateState.state === 'downloaded' ||
    updateState.state === 'replacing' ||
    updateState.state === 'restarting'
  ) {
    if (updateState.state === 'downloaded' && isUpgrading) {
      // ES5：downloaded 态检测到更新版本 → 退回 available（追新版，旧 preloaded 由 main 侧下次 download 时自动清）
      console.log(
        `[useAppUpdate] newer version ${info.version} detected during downloaded, rolling back to available`,
      )
      // 继续走下面的 available 设置（不 return）
    } else {
      // ES4：正在替换/重启 或 downloaded 同版本 → 不覆盖当前态
      // 但更新 state.latestRelease（刷新 release info，如 releaseNotes 可能有变化）
      updateState.latestRelease = info
      return
    }
  }
  updateState.latestRelease = info
  updateState.state = 'available'
  // releaseNotes 异步渲染（markdown-it + shiki WASM 首次加载），不阻塞 UI；
  // 防陈旧：渲染期间若又发了新 checkForUpdate，丢弃本次 html（避免覆盖更新版本的信息）
  renderReleaseNotes(info.releaseNotes, () => myToken === renderToken)
}

/**
 * 无新版回退 idle。防覆盖守卫：若已从 pending 恢复（pendingRestored=true），保持 available——
 * pending 标志证明曾检测到更新，联网检测此刻未发现可能是缓存/网络问题，不应丢失提醒。
 * 检测失败路径（handleCheckFailure）复用同一守卫，语义一致。
 */
function resetToIdleAfterMiss(): void {
  if (!updateFlags.pendingRestored) {
    updateState.state = 'idle'
  }
}

/**
 * 检测失败处理（RD-4#5）：区分触发源决定失败是否显形。
 * - manual（用户点击「检查更新」/「重试」）：置 state='error' + errorMessage 指向恢复动作
 *   （「网络不可达，请检查连接或前往下载页」）——失败与「已是最新版」（idle）必须可区分。
 * - auto（周期/补查/STALE 重查）：保持既有静默 + 防覆盖守卫回退，不打扰用户。
 * 两者都先做防陈旧丢弃（丢弃陈旧的失败结果）并 console.warn 便于诊断。
 */
function handleCheckFailure(e: unknown, myToken: number, source: CheckSource): void {
  // 防陈旧：丢弃陈旧的失败结果
  if (myToken !== renderToken) return
  console.warn('[useAppUpdate] checkForUpdate failed:', e)
  if (source === 'manual') {
    // 手动检查失败显形：errorMessage 指向恢复动作（检查连接 / 前往下载页）。
    // errorSuggestion 留空——UpdateCheckCard 内已有常驻手动升级通道引导，不重复堆叠。
    updateState.state = 'error'
    updateState.errorMessage = t('settings.system.checkUpdateFailed')
    updateState.errorSuggestion = ''
  } else {
    // 自动检查保持静默：防覆盖守卫 pendingRestored 时不回退 idle（见 resetToIdleAfterMiss 理由）
    resetToIdleAfterMiss()
  }
}

/**
 * 检测最新版本。命中新版 → state='available' + latestRelease 填充 + 异步渲染 releaseNotes；
 * 无新版/失败 → state='idle'。
 *
 * @param force true 强制刷新缓存（默认走 1h 缓存）
 * @param source 触发源（RD-4#5）：'manual' 失败置 error 态显形；'auto'（默认）失败静默回退。
 */
export async function checkForUpdate(force = false, source: CheckSource = 'auto'): Promise<void> {
  const myToken = ++renderToken
  const prevState = beginCheckTransition()
  try {
    const { info, rateLimited } = await ipcCheckForUpdate({ force })
    // 防陈旧：若期间又发了新 checkForUpdate，丢弃本次结果
    if (myToken !== renderToken) return
    if (rateLimited) {
      handleRateLimited(prevState)
      return
    }
    // 拿到确定答案（有/无新版）→ 退避窗口已结束，复位提示去重标记
    rateLimitHintShown = false
    if (info) {
      applyCheckResult(info, myToken)
    } else {
      resetToIdleAfterMiss()
    }
  } catch (e) {
    handleCheckFailure(e, myToken, source)
  }
}

/** 重置检测轴的模块级测试态（仅供测试 _resetForTest 组合调用） */
export function resetCheckForTest(): void {
  rateLimitHintShown = false
  renderToken = 0
}
