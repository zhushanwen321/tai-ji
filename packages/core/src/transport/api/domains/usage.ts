/**
 * Usage 域 —— 用量统计数据 RPC 封装。
 *
 * 设计文档：usage-stats-design §3.4 W2
 */
import type { UsageStatsResult } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/**
 * 拉取用量统计数据（session JSONL 扫描聚合）。
 * 返回 UsageStatsResult（rows / scannedAt / sessionCount / skippedLines）。
 */
export function getUsageStats(): Promise<UsageStatsResult> {
  return command('usage.getStats', {}, RPC_BACKSTOP_TIMEOUT_MS)
}
