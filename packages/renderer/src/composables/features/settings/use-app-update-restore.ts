/**
 * useAppUpdate 恢复链轴工厂（app 启动时从 main 侧恢复「已有更新」的本地状态，零联网）。
 *
 * - restorePreloadedUpdate（功能 2：预下载）：恢复 downloaded 态，优先级高于 pending
 * - restorePendingUpdate（功能 1：常驻提醒）：恢复 available 态
 *
 * 恢复成功即置 pendingRestored=true（state.flags，见 use-app-update-state）启用防覆盖守卫：
 * 后续 30s 联网检测失败/无新版不回退已恢复的提醒。运行时由 initAutoCheck 触发
 * （use-app-update-autocheck.ts）；测试经控制器实例的 restorePreloadedUpdate/
 * restorePendingUpdate 方法直调。
 *
 * 依赖方向：本模块 → use-app-update-state + use-app-update-notes + use-app-update-ipc。
 */
import { compare } from 'compare-versions'
import type { AppUpdateIpc } from './use-app-update-ipc'
import type { UpdateStateContainer } from './use-app-update-state'
import { createNotesAxis } from './use-app-update-notes'

/** 恢复链轴依赖：所属 state 容器 + ipc 缝 */
export interface RestoreAxisDeps {
  state: UpdateStateContainer
  ipc: Pick<AppUpdateIpc, 'getPreloaded' | 'getPendingUpdate'>
}

/** 恢复链轴 */
export interface RestoreAxis {
  /**
   * 从 main 侧预下载产物恢复 downloaded 态（功能 2：预下载）。
   * @returns true 表示已恢复（initAutoCheck 据此跳过 restorePendingUpdate）
   */
  restorePreloadedUpdate(): Promise<boolean>
  /** 从持久化标志恢复「可升级」提醒（功能 1：常驻提醒） */
  restorePendingUpdate(): Promise<void>
}

/** 创建恢复链轴（绑定到指定 state 容器与 ipc 缝） */
export function createRestoreAxis(deps: RestoreAxisDeps): RestoreAxis {
  const { state, ipc } = deps
  const { renderReleaseNotes } = createNotesAxis(state)

  /**
   * 从 main 侧预下载产物恢复 downloaded 态（功能 2：预下载）。
   *
   * app 启动时调用（经 initAutoCheck 触发，优先级高于 restorePendingUpdate）：读取 main 侧
   * 预下载产物（getPreloaded），若有效 → 置 state='downloaded' + 填充 latestRelease +
   * 异步渲染 releaseNotes，并设 pendingRestored=true 启用防覆盖守卫（防 30s 联网检测回退）。
   */
  async function restorePreloadedUpdate(): Promise<boolean> {
    try {
      const preloaded = await ipc.getPreloaded()
      if (!preloaded) return false
      // 版本守卫：current >= preloaded.version 说明已升级/更旧，产物过期 → return false 回退 pending。
      // 非 semver 版本号 catch+继续恢复（信任 preloaded，对齐后端 readPreloadedUpdateRaw 的 keep 语义）。
      try {
        if (compare(__APP_VERSION__, preloaded.release.version, '>=')) return false
      } catch (e) {
        // best-effort 降级：版本号非 semver 无法比较 → 信任 preloaded 继续恢复
        // （对齐后端 readPreloadedUpdateRaw 的 keep 语义，不阻断用户正常升级流程）
        console.warn('[useAppUpdate] preloaded version compare failed, keeping:', e)
      }
      // 有效预下载产物 → 恢复 downloaded 态
      state.state.latestRelease = preloaded.release
      state.state.state = 'downloaded'
      state.flags.pendingRestored = true
      // 异步渲染 releaseNotes（与 restorePendingUpdate/checkForUpdate 命中分支一致）
      renderReleaseNotes(preloaded.release.releaseNotes)
      console.log(`[useAppUpdate] restored downloaded state for v${preloaded.release.version}`)
      return true
    } catch (e) {
      console.warn('[useAppUpdate] restorePreloadedUpdate failed:', e)
      return false
    }
  }

  /**
   * 从持久化标志恢复「可升级」提醒（功能 1：常驻提醒）。
   *
   * app 启动时调用（经 initAutoCheck 触发）：读取 main 侧 pending-update.json，
   * 若有有效 pending release（版本仍 > 当前版本）→ 置 state='available' + 填充
   * latestRelease + 异步渲染 releaseNotes，并设 pendingRestored=true 启用防覆盖守卫。
   *
   * 离线也能恢复（pending 存完整 release info，不依赖网络）。恢复后仍跑 30s 联网检测
   * 作为刷新（修正 release 被编辑等不一致），但防覆盖守卫保证联网检测失败不丢失提醒。
   */
  async function restorePendingUpdate(): Promise<void> {
    try {
      const pending = await ipc.getPendingUpdate()
      if (!pending) return
      // 版本比较已在 main 侧 readPendingUpdate 完成（currentVersion >= pending.version → 清除返回 null），
      // 此处拿到的 pending 必然是仍有效的「有待升级版本」。
      state.state.latestRelease = pending
      state.state.state = 'available'
      state.flags.pendingRestored = true
      // 异步渲染 releaseNotes（与 checkForUpdate 命中分支一致）
      renderReleaseNotes(pending.releaseNotes)
      console.log(`[useAppUpdate] restored pending update reminder for v${pending.version}`)
    } catch (e) {
      // best-effort：恢复失败不影响后续联网检测，仅 warn
      console.warn('[useAppUpdate] restorePendingUpdate failed:', e)
    }
  }

  return { restorePreloadedUpdate, restorePendingUpdate }
}
