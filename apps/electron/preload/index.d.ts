/**
 * preload 暴露的 electronAPI 全局类型声明（renderer 侧 window.electronAPI）。
 *
 * 单一来源：直接 re-export preload.ts 的 ElectronAPI interface，避免手工副本漂移。
 * 改 ElectronAPI 只需改 preload.ts，此处自动跟随。
 *
 * 例外：`localFile:servable` 预检通道的类型面在本文件先行落地（chat-html-support
 * §7「桥接」行——本文件是 u-foundation 共享契约根，u3-detailpane / u4-card 并行开发时
 * 即需可见）；实现与 ElectronAPI 成员由 u2-infra 补入 preload.ts，两侧形状一致
 * （见下方 LocalFileServableChannel 注释）。
 *
 * 注意：renderer 不能 ES import preload（preload 是 Electron 构建产物，通过 contextBridge
 * 挂全局）。本文件以 type-only re-export 提供类型给 renderer 的 tsconfig（include 项）。
 */
export type { ElectronAPI } from './preload'

/**
 * local-file servable 预检结果（chat-html-support §6.9 D9 / §6.4 D4「同一谓词」）。
 *
 * 谓词 = 白名单成员资格（先行短路）→ 存在性 → 目录性，与 local-file 协议 handler 复用
 * 同一模块函数：
 * - `servable: true`  → `size` 附文件字节数（HtmlPreviewCard 显示文件名与大小）
 * - `servable: false` → `reason` ∈ `not_found` / `is_dir` / `out_of_whitelist`（降级原因）
 */
export interface LocalFileServableResult {
  servable: boolean
  reason?: 'not_found' | 'is_dir' | 'out_of_whitelist'
  size?: number
}

/**
 * servable 预检通道的 electronAPI 方法面（IPC 通道名 `localFile:servable`，
 * chat-html-support §6.9 D9）：卡片（经 deps `probeArtifact?`）与抽屉渲染态共用。
 */
export interface LocalFileServableChannel {
  /**
   * 预检绝对路径是否可经 local-file 协议服务（挂载前准入检查）。
   *
   * @param absPath 绝对路径（`~` 展开 / 百分号解码 / 规范化由主进程谓词承担）
   * @returns servable=true 时 `size` 附字节数；false 时 `reason` 指明降级原因
   */
  localFileServable(absPath: string): Promise<LocalFileServableResult>
}

declare global {
  interface Window {
    electronAPI: import('./preload').ElectronAPI & LocalFileServableChannel
  }
}
