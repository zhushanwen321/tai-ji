/**
 * 系统提示音 —— renderer 侧 convenience 封装。
 *
 * 真正的 SSOT（DEFAULT_SUCCESS_PLATFORM / DEFAULT_ERROR_PLATFORM / getDefaultSound /
 * SoundPlatform / SoundKind）在 `@taiji/shared` 的 sound-defaults.ts，
 * main 与 renderer 共享同一份字面量，消除双写。
 *
 * 本文件额外提供 renderer 专有的 `detectPlatform()`（浏览器 navigator 探测），
 * 以及一个接受 `'other'`（未知平台）的 `getDefaultSound` 包装：未知平台返回空串，
 * main 侧 isKnownSound 会回落到平台默认（W3）/ 静默 no-op。
 */
import {
  getDefaultSound as sharedGetDefaultSound,
  type SoundKind,
  type SoundPlatform,
} from '@taiji/shared'

// 重导出 SSOT，renderer 消费方直接从此 import（避免散落到 @taiji/shared）
export { DEFAULT_SUCCESS_PLATFORM, DEFAULT_ERROR_PLATFORM } from '@taiji/shared'
export type { SoundPlatform, SoundKind } from '@taiji/shared'

/**
 * renderer 侧平台标识：比 SoundPlatform 多一个 'other'（navigator 探测失败时）。
 * main 侧 process.platform 永远是已知值，不需要 'other'。
 */
type DetectedPlatform = SoundPlatform | 'other'

/**
 * 浏览器侧平台检测（main 进程 process.platform 的 renderer 同义）。
 * 基于 navigator.platform：'MacIntel' / 'Win32' / 'Linux x86_64' 等。
 * SSR / 测试无 navigator 时返回 'other'。
 *
 * Q1-3：结果模块级 memo——navigator.platform 在页面生命周期内不变，
 * 无状态纯探测却被每次播放重算；调用方（useCompletionSound.resolveName 等）无需各自缓存。
 */
let platformMemo: DetectedPlatform | undefined

export function detectPlatform(): DetectedPlatform {
  if (platformMemo !== undefined) return platformMemo
  platformMemo = computePlatform()
  return platformMemo
}

function computePlatform(): DetectedPlatform {
  if (typeof navigator === 'undefined') return 'other'
  const p = navigator.platform.toLowerCase()
  // navigator.platform: 'MacIntel' / 'Win32' / 'Linux x86_64' 等
  if (p.includes('mac')) return 'darwin'
  if (p.includes('win')) return 'win32'
  if (p.includes('linux')) return 'linux'
  return 'other'
}

/** 测试专用：清空平台探测 memo（navigator 桩变更后重探测，测试隔离用）。 */
export function __resetPlatformMemoForTest(): void {
  platformMemo = undefined
}

/**
 * 返回指定平台 + 类型（成功/失败）的默认声音 id（renderer 侧包装）。
 *
 * 与 shared.getDefaultSound 的差异：接受 'other'（未知平台），此时返回空串。
 * 调用方：renderer 的 resolveName（success/error 默认音解析）、SystemPage 试听「系统默认」项。
 */
export function getDefaultSound(platform: DetectedPlatform, kind: SoundKind): string {
  if (platform === 'other') return ''
  return sharedGetDefaultSound(platform, kind)
}
