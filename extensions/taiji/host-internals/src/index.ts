/**
 * taiji host internals extension for Pi — pi 侧 taiji 内部协议设施单包
 * （taiji 集成组、infrastructure 层不可禁）。两个职责各自保留独立模块
 * （registerHostCommands / registerMsgIdMapper），由 default 导出统一装配。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerHostCommands } from "./host-commands.ts";
import { registerMsgIdMapper } from "./msg-id-mapper.ts";

export default function (pi: ExtensionAPI): void {
  registerHostCommands(pi);
  registerMsgIdMapper(pi);
}
