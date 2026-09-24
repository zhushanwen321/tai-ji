/**
 * useAppUpdate 的 state 容器工厂（useAppUpdate 控制器的共享状态单元）。
 *
 * 每次 createUpdateState() 产出一套独立实例：生产侧由 createAppUpdateController
 * 持有一份（UpdateButton + Sidebar 经 useAppUpdate() 单例共享同一控制器），
 * 测试侧每个用例建新控制器即天然隔离，无需全局复位。
 *
 * 本模块只承载「状态与跨轴标志」；行为分散在同目录 use-app-update-*.ts 各轴工厂，
 * 依赖方向：各轴工厂 → 本模块（单向，无回环）。
 *
 * 跨轴标志（flags）：
 * - errorHandled：onUpdateError SSOT 已处理错误后置 true（useAppUpdate.ts 的 subscribeProgress），
 *   performDownload/performInstall 的 catch 据此去重兜底（use-app-update-actions.ts）。
 * - pendingRestored：restore 链恢复「已有更新」提醒后置 true（use-app-update-restore.ts），
 *   checkForUpdate 的防覆盖守卫读取（use-app-update-check.ts）：恢复后联网检测失败/无新版
 *   不回退 idle——pending 标志证明曾检测到更新，除非版本比较已清否则应保持 available。
 */
import { reactive } from 'vue'
import type { Reactive } from 'vue'
import type { LatestReleaseInfo, UpdateState } from '@taiji/shared'

/** 更新流程 UI 状态机（9 态：idle/checking/available/downloading/downloaded/replacing/restarting/error/unsupported） */
export interface UpdateAppState {
  /** 状态机当前态 */
  state: UpdateState
  /** 最新版本信息（state=available 后填充） */
  latestRelease: LatestReleaseInfo | null
  /** 错误信息（state=error 时填充） */
  errorMessage: string
  /** 错误解决建议（state=error 时填充，用于展示恢复指引） */
  errorSuggestion: string
  /** 升级进度百分比（0-100，state=downloading/replacing 时填充） */
  percent: number
  /** release note 渲染后的 HTML（markdown-it + shiki，异步填充） */
  releaseNotesHtml: string
}

/** useAppUpdate 控制器的状态容器：reactive UI 状态 + 跨轴可变标志 */
export interface UpdateStateContainer {
  readonly state: Reactive<UpdateAppState>
  /** 跨轴可变标志（见模块头注释；非响应式——只参与逻辑分支，不驱动渲染） */
  readonly flags: {
    errorHandled: boolean
    pendingRestored: boolean
  }
}

/** 创建一套独立的更新状态容器（生产单控制器一份；测试每用例一份即隔离） */
export function createUpdateState(): UpdateStateContainer {
  const state = reactive<UpdateAppState>({
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    errorSuggestion: '',
    percent: 0,
    releaseNotesHtml: '',
  })
  const flags = {
    errorHandled: false,
    pendingRestored: false,
  }
  return { state, flags }
}
