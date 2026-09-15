/**
 * preload 暴露的 electronAPI 全局类型声明（renderer 侧 window.electronAPI）。
 *
 * 单一来源：直接 re-export preload.ts 的 ElectronAPI interface，避免手工副本漂移。
 * 改 ElectronAPI 只需改 preload.ts，此处自动跟随。
 *
 * 注意：renderer 不能 ES import preload（preload 是 Electron 构建产物，通过 contextBridge
 * 挂全局）。本文件以 type-only re-export 提供类型给 renderer 的 tsconfig（include 项）。
 */
export type { ElectronAPI } from './preload'

declare global {
  interface Window {
    electronAPI: import('./preload').ElectronAPI
  }
}
