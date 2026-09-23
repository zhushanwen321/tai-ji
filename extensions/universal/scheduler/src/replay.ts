// 折叠器单源于 @zhushanwen/extension-protocol（U2 折叠器下沉）。包内实现零 pi 依赖
// （logger 以 ReplayFoldOptions.warn 注入），本文件是扩展侧薄 wrapper：注入共享 logger
// 保持降级日志行为不变，并保持既有 import 路径与二参签名不变（backend.ts 零改动）。

import {
  replayFoldEntries as replayFoldEntriesShared,
  type ScheduledTask,
  type SchedulerEntryLike,
} from '@zhushanwen/extension-protocol'
import { getLogger } from '@zhushanwen/pi-extension-logger'

const logger = getLogger('scheduler')

export function replayFoldEntries(
  entries: Iterable<SchedulerEntryLike>,
  currentSessionFile: string | undefined,
): Map<string, ScheduledTask> {
  return replayFoldEntriesShared(entries, currentSessionFile, {
    warn: (message, context) => logger.warn(message, context),
  })
}

export type { SchedulerEntryLike } from '@zhushanwen/extension-protocol'
