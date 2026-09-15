/**
 * 系统提示音默认映射 SSOT（single source of truth）。
 *
 * 被 main 进程（apps/electron/main/gateway/sound-handlers.ts）和 renderer
 * （packages/renderer/src/composables/sound-defaults.ts）共同消费，消除双写字面量。
 *
 * 本模块是纯数据 + 纯函数，**无 fs / child_process / electron 依赖**，
 * renderer 整包 import 不会把 node 模块拖进浏览器 bundle。
 */

/**
 * 支持系统提示音的平台标识。
 * 与 Node `process.platform` 同义（仅取提示音相关的三平台）。
 * renderer 侧用 'other' 表示无法识别的平台（navigator.platform 探测失败）。
 */
export type SoundPlatform = 'darwin' | 'win32' | 'linux'

/**
 * 提示音逻辑分类：
 * - success：任务成功完成
 * - error：任务失败 / 报错
 */
export type SoundKind = 'success' | 'error'

/** 各平台默认成功音 id（用户未设置 successSound 时用） */
export const DEFAULT_SUCCESS_PLATFORM: Record<SoundPlatform, string> = {
  darwin: 'Glass',
  win32: 'Windows Notify System Generic',
  linux: 'complete',
}

/** 各平台默认失败音 id（用户未设置 errorSound 时用） */
export const DEFAULT_ERROR_PLATFORM: Record<SoundPlatform, string> = {
  darwin: 'Funk',
  win32: 'Windows Notify Email',
  linux: 'message-new-instant',
}

/**
 * 返回指定平台 + 类型（成功/失败）的默认声音 id。
 *
 * @param platform 平台标识（SoundPlatform 之一）
 * @param kind     成功 / 失败
 * @returns 默认声音 id；未知平台返回空串（main 侧 isKnownSound 会回落到默认 / 静默 no-op）
 */
export function getDefaultSound(platform: SoundPlatform, kind: SoundKind): string {
  const map = kind === 'success' ? DEFAULT_SUCCESS_PLATFORM : DEFAULT_ERROR_PLATFORM
  return map[platform] ?? ''
}
