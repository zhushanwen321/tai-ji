/**
 * preload 暴露的 electronAPI 全局类型声明（renderer 侧 window.electronAPI）。
 *
 * 单一来源：直接 re-export preload.ts 的 ElectronAPI interface，避免手工副本漂移。
 * 改 ElectronAPI 只需改 preload.ts，此处自动跟随。
 *
 * 例外：`localFile:servable` / `localFile:read` 两条通道的**方法面**（LocalFileServableChannel /
 * LocalFileReadChannel，及全局 Window.electronAPI 交集）声明在本文件；其 **payload 类型**
 * （LocalFileServableResult / LocalFileReadResult 族）不在此另立副本——定义 SSOT =
 * `packages/shared/src/ipc-payloads.ts`（C-comm-22 唯一类型源），preload.ts / renderer
 * lib/ipc / main utils 同源 import，本文件 import 后 re-export。
 *
 * 注意：renderer 不能 ES import preload（preload 是 Electron 构建产物，通过 contextBridge
 * 挂全局）。本文件以 type-only re-export 提供类型给 renderer 的 tsconfig（include 项）。
 */
import type {
  LocalFileReadReason,
  LocalFileReadResult,
  LocalFileServableReason,
  LocalFileServableResult,
} from '@taiji/shared'

export type { ElectronAPI } from './preload'

// local-file 两条通道的 payload 类型保持既有可见性（re-export），定义 SSOT 在
// `packages/shared/src/ipc-payloads.ts`——不在此另立副本。
export type {
  LocalFileReadReason,
  LocalFileReadResult,
  LocalFileServableReason,
  LocalFileServableResult,
}

/**
 * servable 预检通道的 electronAPI 方法面（IPC 通道名 `localFile:servable`，
 * chat-html-support §6.9 D9）：卡片（经 deps `probeArtifact?`）与抽屉渲染态共用。
 */
export interface LocalFileServableChannel {
  /**
   * 预检绝对路径是否可经 local-file 协议服务（挂载前准入检查）。
   *
   * @param absPath 绝对路径或 `~` 形态路径（`~` 展开 / 规范化由主进程谓词承担；IPC 入参为
   *   明文路径，不做百分号解码——解码仅存在于 URL 入口）
   * @returns servable=true 时 `size` 附字节数；false 时 `reason` 指明降级原因
   */
  localFileServable(absPath: string): Promise<LocalFileServableResult>
}

/**
 * 源码内容读取通道的 electronAPI 方法面（IPC 通道名 `localFile:read`）。
 *
 * 消费方 = DetailPane 「源码」态：产物目录 `<dataDir>/artifacts/<sessionId>` 在 session cwd
 * 外（§6.7 D7），runtime `file.read` 的 cwd 守门不可达，故源码内容走本条与 servable 同源
 * （同一白名单谓词）的读取通道。
 */
export interface LocalFileReadChannel {
  /**
   * 读白名单内文件内容。
   *
   * @param absPath 绝对路径（`~` 展开 / 规范化由主进程谓词承担）
   * @returns `ok: true` 时附 `content` / `truncated`；`ok: false` 时 `reason` 指明失败原因
   */
  localFileRead(absPath: string): Promise<LocalFileReadResult>
}

declare global {
  interface Window {
    electronAPI: import('./preload').ElectronAPI & LocalFileServableChannel & LocalFileReadChannel
  }
}
