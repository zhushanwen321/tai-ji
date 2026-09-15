/**
 * platform —— 平台判定工具（跨平台快捷键/UI 显示用）。
 *
 * 用 navigator.platform 判定 mac（SSR 安全，Electron renderer 环境可用）。
 * 判定结果缓存（navigator.platform 运行时不变，避免每次快捷键渲染都判一遍）。
 *
 * 依赖方向：无下游（读全局 navigator，纯函数）。
 */

/** navigator.platform 是否包含 'Mac'（macOS）。首次调用后缓存。 */
let _isMac: boolean | null = null

/** 当前是否 macOS 平台（基于 navigator.platform）。 */
export function isMacPlatform(): boolean {
  if (_isMac === null) {
    _isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
  }
  return _isMac
}
