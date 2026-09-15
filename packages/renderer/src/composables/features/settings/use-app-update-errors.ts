/**
 * useAppUpdate 错误分类纯函数（错误码 → 文案映射轴）。
 *
 * 消费方：
 * - resolveErrorSuggestion → useAppUpdate.ts 的 subscribeProgress（onUpdateError SSOT 分支）
 * - resolveFailedToastKey → use-app-update-launch.ts 的 checkLaunchResult（启动失败 toast）
 *
 * 依赖：@/i18n 的 module-level t（非 setup 同步上下文用不了 useI18n()，
 * 照抄同目录 useProviderImport.ts 的 global.t 模式）。
 */
import type { UpdateErrorPayload } from '@xyz-agent/shared'
import i18n from '@/i18n'

const t = i18n.global.t

/** 不支持当前平台的错误码（main 侧 platform-updater 抛出，preload 透传） */
export const UNSUPPORTED_ERROR_CODE = 'UPDATE_UNSUPPORTED_PLATFORM'

/**
 * 升级失败原因码 → i18n key 后缀（A-D1，G3：失败 toast 带具体原因+恢复指引）。
 * 错误码 SSOT = 升级脚本 fail() 调用：updater-script.ts（mac/linux）+ win-updater-cmd.ts（win）。
 * 'app still running'/'app did not exit' 同为「旧进程未退出致升级中断」，共用一个文案。
 * 未收录/缺失码 → 回退通用文案 sidebar.update.upgradeFailed（resolveFailedToastKey）。
 */
const LAUNCH_FAILURE_ERROR_KEYS: Record<string, string> = {
  'read-only volume': 'upgradeFailedReadOnly',
  'backup failed': 'upgradeFailedBackup',
  'extract failed': 'upgradeFailedExtract',
  'internal error': 'upgradeFailedInternal',
  'mv failed': 'upgradeFailedMove',
  'sha mismatch': 'upgradeFailedSha',
  'swap failed': 'upgradeFailedSwap',
  'app still running': 'upgradeFailedAppRunning',
  'app did not exit': 'upgradeFailedAppRunning',
}

/** win 安装器失败为动态码（'installer exited <code>'），无法精确枚举，前缀匹配 */
const INSTALLER_EXITED_PREFIX = 'installer exited'

/**
 * 网络/代理不可达类错误码：suggestion 末尾追加手动下载逃生通道指引
 * （update-network-resilience D9 双入口之一；目录路径常驻展示在设置页手动通道区）。
 * 追加逻辑收敛在 renderer（main 文案不动，G3 兼容性约束）。
 */
const MANUAL_HINT_ERROR_CODES: ReadonlySet<string> = new Set([
  'UPDATE_PROXY_UNREACHABLE',
  'UPDATE_PROXY_ERROR',
  'UPDATE_NETWORK_FAILED',
  'UPDATE_NETWORK_TIMEOUT',
])

/**
 * 组装 errorSuggestion：main 下发的 suggestion 为基座，网络/代理类错误码末尾追加
 * 手动下载指引（浏览器/其他机器下载 zip 放入手动目录 → 零 app 网络依赖完成升级）。
 */
export function resolveErrorSuggestion(payload: UpdateErrorPayload): string {
  const base = payload.suggestion ?? ''
  if (!payload.errorCode || !MANUAL_HINT_ERROR_CODES.has(payload.errorCode)) return base
  const hint = t('sidebar.update.manualDownloadHint')
  return base ? `${base}\n${hint}` : hint
}

/** failed toast 文案选择：先精确匹配错误码，再匹配 win 安装器动态码前缀，兜底通用文案 */
export function resolveFailedToastKey(error?: string): string {
  if (error) {
    const mapped = LAUNCH_FAILURE_ERROR_KEYS[error]
    if (mapped) return `sidebar.update.${mapped}`
    if (error.startsWith(INSTALLER_EXITED_PREFIX)) return 'sidebar.update.upgradeFailedInstaller'
  }
  return 'sidebar.update.upgradeFailed'
}
