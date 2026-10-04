// src/execution/ui/ui-request-observability.ts
//
// UI 请求可观测性状态（从 subagent-service.ts 提取，降低主文件行数）。
// 持有 sessionMode（主进程运行模式），经 SessionBaselines 写入（initSession）、
// chat-rounds / workflow-dispatch 的 createBackgroundStream 读取（stream 通道形态判据）。

import type { ExtensionMode } from "../assembly/host-mode.ts";

/** UI 请求可观测性状态：sessionMode（主进程运行模式，W4 守卫透传）的往返存储。 */
export class UiRequestObservability {
  private sessionMode: ExtensionMode | undefined;

  setMode(mode: ExtensionMode | undefined): void {
    this.sessionMode = mode;
  }

  getMode(): ExtensionMode | undefined {
    return this.sessionMode;
  }
}
