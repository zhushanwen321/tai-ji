/**
 * useAppUpdate 单例 state 容器（useAppUpdate 按变化轴拆分的共享状态模块）。
 *
 * module-level 单例：全应用共享（UpdateButton + Sidebar 读同一份），对齐 usePlatformChrome.ts。
 * 本模块只承载「状态与跨轴标志」；行为分散在同目录 use-app-update-*.ts 各轴模块，
 * 依赖方向：各轴模块 → 本模块（单向，无回环）。
 *
 * 跨轴标志（updateFlags）：
 * - errorHandled：onUpdateError SSOT 已处理错误后置 true（useAppUpdate.ts 的 subscribeProgress），
 *   performDownload/performInstall 的 catch 据此去重兜底（use-app-update-actions.ts）。
 * - pendingRestored：restore 链恢复「已有更新」提醒后置 true（use-app-update-restore.ts），
 *   checkForUpdate 的防覆盖守卫读取（use-app-update-check.ts）：恢复后联网检测失败/无新版
 *   不回退 idle——pending 标志证明曾检测到更新，除非版本比较已清否则应保持 available。
 */
import { reactive } from 'vue'
import type { LatestReleaseInfo, UpdateState } from '@xyz-agent/shared'

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：应用更新检查状态（下载进度/错误提示 UI，12 类未覆盖）
export const updateState = reactive({
  /** 状态机当前态 */
  state: 'idle' as UpdateState,
  /** 最新版本信息（state=available 后填充） */
  latestRelease: null as LatestReleaseInfo | null,
  /** 错误信息（state=error 时填充） */
  errorMessage: '',
  /** 错误解决建议（state=error 时填充，用于展示恢复指引） */
  errorSuggestion: '',
  /** 升级进度百分比（0-100，state=downloading/replacing 时填充） */
  percent: 0,
  /** release note 渲染后的 HTML（markdown-it + shiki，异步填充） */
  releaseNotesHtml: '',
})

/** 跨轴可变标志（见模块头注释；非响应式——只参与逻辑分支，不驱动渲染） */
export const updateFlags = {
  errorHandled: false,
  pendingRestored: false,
}

/** 重置单例 state + 跨轴 flags（仅供测试 _resetForTest 组合调用） */
export function resetUpdateStateForTest(): void {
  updateState.state = 'idle'
  updateState.latestRelease = null
  updateState.errorMessage = ''
  updateState.errorSuggestion = ''
  updateState.percent = 0
  updateState.releaseNotesHtml = ''
  updateFlags.errorHandled = false
  updateFlags.pendingRestored = false
}
