/**
 * useUpdateInstallActions —— 应用更新「确认重启安装」Dialog 三路编排（UpdateCheckCard
 * 与 UpdateButton 的逐字重复收敛）。
 *
 * 状态迁移：onInstallClick 开确认 Dialog（不直接执行 install，避免误点中断会话）/
 * onConfirmInstall 关 Dialog 后执行 performInstall（替换 + 重启）/ onLater 仅关 Dialog。
 * showConfirmDialog 是 per-component 实例态（两入口各自持有确认弹窗），useAppUpdate
 * 控制器是全应用单例、不持有 UI 开关——故不并入控制器轴族，performInstall 经参数注入。
 *
 * onRetry 不属本编排（两组件语义不同：设置卡 = 强制重新检测 / 侧栏按钮 = 回 available
 * 态），留在各组件侧。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'

export function useUpdateInstallActions(performInstall: () => Promise<void>): {
  /** 确认重启安装 Dialog 开关 */
  showConfirmDialog: Ref<boolean>
  /** downloaded 入口：打开确认 Dialog（不直接执行 install） */
  onInstallClick: () => void
  /** 确认安装：关闭 Dialog 后执行 install（替换 + 重启） */
  onConfirmInstall: () => Promise<void>
  /** 稍后：仅关闭 Dialog */
  onLater: () => void
} {
  const showConfirmDialog = ref(false)

  function onInstallClick(): void {
    showConfirmDialog.value = true
  }

  async function onConfirmInstall(): Promise<void> {
    showConfirmDialog.value = false
    await performInstall()
  }

  function onLater(): void {
    showConfirmDialog.value = false
  }

  return { showConfirmDialog, onInstallClick, onConfirmInstall, onLater }
}
