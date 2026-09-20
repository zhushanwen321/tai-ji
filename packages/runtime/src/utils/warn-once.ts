/**
 * warn-once 去重集（code-harden RT-5#6）：读侧降级 catch 的出声助手。
 *
 * 范式先例：infra/pi/session-binding-sidecar-io.ts 的 warnSidecarDegradedOnce（模块级
 * Set + 每 key 一次）。session 读侧 extractor（segments sidecar / workflow state 文件 /
 * subagent session 目录扫描）的 catch→null 降级此前完全静默——徽标退占位、整条
 * workflow run 消失均不可观测；但扫描热路径（历史重建/列表刷新反复重扫）同一失败会
 * 反复进入 catch，逐次 warn 会刷屏，故按 key（文件路径/目录）去重。
 *
 * key 上界 = 扫描对象数（文件/目录数），Set 不清理也不构成泄漏量级；进程重启清零
 * （重启后同一失败再各出声一次，恰好是「仍然在发生」的合理信号）。
 */

const warnedKeys = new Set<string>()

/** 同 key 只出声一次的 console.warn（热路径刷屏防护）。 */
export function warnOnce(key: string, message: string, detail?: unknown): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(message, detail)
}

/** 测试隔离用：清空 warn-once 去重集。 */
export function _resetWarnOnceForTest(): void {
  warnedKeys.clear()
}
