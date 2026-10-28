// subagent-records —— 移动壳 subagent 记录分区宿主（remote-use A9 / U15；D5 去留表
// onSubagents 行）。v1 SubagentStatusLine.vue 清退（§7.3 M-10：状态行呈现升级为
// RunBand + SubagentSheet 两级）时分区与读口整体迁位至此——纯数据模块，无呈现面。
//
// 写分区语义 = 桌面 stores/subagent.ts applyRecords 的最小子集（D5 去留表口径）：per-session
// Map 分区（ADR-0049 派）+ 不可变整 Map 替换触发响应性（范式同源 renderer partitioned-session-records
// 四件套——移动壳不依赖 renderer 包，且无 loading/error/oversize/strike/streaming 面板族面，
// 只消费 apply + 读两件）。接线位在壳扩展层非 factory 内：onSubagents 由 bootstrap effects
// 直挂本模块导出的 applySubagentRecords（factory 不含 subagent 语义，D5 去留表）。
import { shallowRef } from 'vue'
import type { SubagentRecord } from '@taiji/shared'

/**
 * per-session subagent 记录分区（shallowRef + 不可变替换，同 partitioned-session-records 范式）。
 * @data-owner #8 —— #8 subagent 列表/状态的移动壳消费副本（权威源 / 写读口 / 清理语义见登记表 #8 行）
 */
const recordsBySession = shallowRef<Map<string, SubagentRecord[]>>(new Map())

/**
 * onSubagents 直挂写入口（bootstrap effects.onSubagents）。
 * 推送是权威数据：整体替换该 sid 分区（空数组照写——对齐桌面推送路径不经 strike 检查）。
 */
export function applySubagentRecords(sessionId: string, subagents: SubagentRecord[]): void {
  recordsBySession.value = new Map(recordsBySession.value).set(sessionId, subagents)
}

/**
 * 该 session 是否有真在跑的 subagent（remote-use U20/A14：移动列表状态点 working 态的
 * hasBackgroundWork 输入源）。占用判据与 runningSubagentRecordsOf 同式（running 且无
 * stopReason，镜像桌面 isRunningProjection SSOT 口径——core deriveSessionStatus 下沉后
 * 本读口只负责收集该布尔输入，判据本体归状态派生谓词的输入契约，不在此重复成第二判定）。
 * 读口在调用方 computed 体内调用即建立对 recordsBySession 的响应式依赖（分区变化自动重算）。
 */
export function hasRunningSubagents(sessionId: string): boolean {
  return (recordsBySession.value.get(sessionId) ?? []).some(
    (r) => r.status === 'running' && r.stopReason === undefined,
  )
}

/**
 * 该 session 运行中 subagent 记录读口（remote-use-mobile-v2 §7.3 M-10 升级：RunBand 计数
 * = running 过滤消费）。与 hasRunningSubagents 同一判据同一分区（单数据源，禁第二副本）。
 */
export function runningSubagentRecordsOf(sessionId: string): SubagentRecord[] {
  return (recordsBySession.value.get(sessionId) ?? []).filter(
    (r) => r.status === 'running' && r.stopReason === undefined,
  )
}

/** 测试重置（模块级分区单例跨用例残留清零；生产代码禁止消费，对齐 __testing 先例） */
function resetSubagentPartitionsForTest(): void {
  recordsBySession.value = new Map()
}

/** 测试后门命名空间（生产代码禁止消费，对齐 __testing 先例；MF-1-10 裸导出收编） */
export const __testing = { resetSubagentPartitionsForTest }
