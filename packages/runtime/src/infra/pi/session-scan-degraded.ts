/**
 * 扫描降级计数 + 轮末汇总（code-harden RT-3#1/#2，自 session-file-utils.ts 拆出——
 * max-lines 预算，先例同 session-residue-cleanup / session-binding-fields）。
 *
 * 语义：scanPiSessionsFromDisk 把各失败点（坏 header / 非 session 首行 / stat 失败 /
 * 子目录列举失败 / 单文件扫描抛错）计入本结构，扫描轮末由 logScanDegradedSummary 打
 * 一条汇总 warn（计数 + 样例路径）——「会话从列表消失」从零痕迹变为可定位。
 */

/**
 * 扫描降级计数（RT-3#1 起，RT-3#2 扩展为全家族）。
 */
export interface ScanDegradedStats {
  /** 坏 header（id/cwd 缺失/空串，RT-3#1）：单条丢弃。 */
  badHeader: number
  /** 目录项 statSync 失败（权限/竞态删除）：条目被跳过。 */
  statFail: number
  /** cwd 分组子目录列举失败（EACCES 等）：整个子目录的会话未收录。 */
  dirFail: number
  /** 单文件 scanSessionMeta 抛错（防御纵深 catch）：该会话未收录。 */
  scanFail: number
  /** 首行读不出 session header（异质 .jsonl / 截断文件 / 读取失败）：未收录。 */
  noHeader: number
  /** 各类降级的样例路径（防刷屏：只取前 N 条进汇总日志）。 */
  samples: string[]
}

/** 降级样例路径进日志的条数上限（汇总 warn 里定位锚）。 */
const DEGRADED_SAMPLE_LIMIT = 5

export type DegradedCounterKey = 'badHeader' | 'statFail' | 'dirFail' | 'scanFail' | 'noHeader'

/** 全零初始化（scanPiSessionsFromDisk 每轮新建）。 */
export function createDegradedStats(): ScanDegradedStats {
  return { badHeader: 0, statFail: 0, dirFail: 0, scanFail: 0, noHeader: 0, samples: [] }
}

/** 记一笔降级：计数 +1，样例路径限量收录（RT-3#2 家族统一入口）。 */
export function noteScanDegraded(degraded: ScanDegradedStats, key: DegradedCounterKey, path: string): void {
  degraded[key]++
  if (degraded.samples.length < DEGRADED_SAMPLE_LIMIT) {
    degraded.samples.push(path)
  }
}

/**
 * 扫描轮末的降级汇总（RT-3#2）：任一计数非零打一条 warn，含各类计数与前 N 个样例
 * 路径——修复/删除对应文件即可恢复收录（per-file 细节见上方各 warn 行）。
 */
export function logScanDegradedSummary(degraded: ScanDegradedStats): void {
  const parts: string[] = []
  if (degraded.badHeader > 0) parts.push(`badHeader=${degraded.badHeader}`)
  if (degraded.noHeader > 0) parts.push(`noHeader=${degraded.noHeader}`)
  if (degraded.statFail > 0) parts.push(`statFail=${degraded.statFail}`)
  if (degraded.dirFail > 0) parts.push(`dirFail=${degraded.dirFail}`)
  if (degraded.scanFail > 0) parts.push(`scanFail=${degraded.scanFail}`)
  if (parts.length === 0) return
  console.warn(
    `[session-file-utils] scanPiSessions degraded: ${parts.join(', ')} — listed sessions may be missing. `
    + `Sample paths: ${degraded.samples.join(' ; ')}. `
    + `Recovery: fix or remove the affected files (per-file details in the warnings above).`,
  )
}
