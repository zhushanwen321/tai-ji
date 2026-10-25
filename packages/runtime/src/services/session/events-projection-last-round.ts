// src/runtime/services/session/events-projection-last-round.ts
//
// [subagent-observability u3 F4 §3.3.6 wire 透传] 轮终收条帧 → SubagentRecord.lastRound
// 的运行时产出单点（shared 契约字段——renderer 失败红点判据与 SubagentTab lastRound
// 展示的数据源）。
//
// 独立模块的原因：events-projection.ts 体量已被行数上限护栏顶满（max-lines 520），
// 本函数内联即破线；独立成模块不挤占投影主文件行数预算。只映射事实字段：
// engineStopReason 取帧的引擎原值（旧帧只有迁移期展示位 stopReason——不把推断词
// 改写成事实字段，诚实缺省，渲染侧 legacy 回落判据由 record.stopReason 通道承载）；
// swept 附注不进 wire（失联标注经 record.stopReason 宿主中断族值呈现，§3.3.3⑥）。
// undefined = 无轮终收条帧（从未收尾 / 存量旧流）。

import type { SubagentRecord } from '@taiji/shared'
import type { RecordEventFoldState } from '@zhushanwen/subagent-core'

export function resolveSubagentLastRound(
  roundIdle: RecordEventFoldState['roundIdle'],
): SubagentRecord['lastRound'] {
  if (roundIdle === undefined) return undefined
  const { engineStopReason, failure, promptDisposition, resultSummary, turns, usage, retryAttempts, observations } = roundIdle
  return {
    ...(engineStopReason !== undefined ? { engineStopReason } : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(promptDisposition !== undefined ? { promptDisposition } : {}),
    ...(resultSummary !== undefined ? { result: resultSummary } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(retryAttempts !== undefined ? { retryAttempts } : {}),
    ...(observations !== undefined ? { observations } : {}),
  }
}
