/**
 * useForkBranchNotify —— 后台分支通知状态（FR-19，spec §4 Key States + §8.5）。
 *
 * 职责：追踪后台分支 session 的状态变化（running→done/error/stopped），把变化路由给
 * 调用方（bindForkNoticeEffect → 反馈行追加）+ 维护侧栏未读角标（unreadByBranch）。
 * transient 映射（运行期内存，不持久化）。
 *
 * 数据流：
 * - 数据源：config.sessions 全量广播（含 status/outcome）→ session store groups，
 *   由 bindForkNoticeEffect watch 后调 syncForkBranches 做分支 status diff
 * - 触发条件：分支 session 从 running（status 'active'）变为 done/error/stopped（终态）
 * - 路由目标：syncForkBranches 的 onChange 回调（调用方接线 → 反馈行追加）+ unreadByBranch 置位（角标）
 *
 * [ADR-0049 例外] 模块级单例状态，不套 useSessionScopedState：本模块是「全局 sid 协调器」——
 * 追踪键是分支 session id（跨 session 血缘，与单一活跃 session 无关），unreadByBranch 全局
 * 单例供侧栏角标读，与 useForkNoticeEffect 的 feedMap 同模式（无 sidRef 的显式 sid 协调器）。
 * 非活跃 session 的角标状态因此天然保留（切会话不清）。
 */
import { shallowRef, type Ref } from 'vue'
import type { SessionGroup, SessionStatus } from '@taiji/shared'

/** 分支状态变化的语义分类（spec §4 Key States） */
export type BranchChangeKind = 'done' | 'error' | 'stopped'

/** 分支状态变化事件（路由给调用方 → 反馈行追加 + 角标） */
export interface BranchStatusChange {
  /** 分支 session id（路由 key） */
  branchId: string
  /** 源 session id（父 session，反馈行落点） */
  srcSessionId: string
  /** 变化语义（done/error/stopped） */
  kind: BranchChangeKind
  /** 分支 label（反馈行文案用） */
  label: string
}

/** 后台分支追踪记录（transient，运行期内存） */
interface BranchTrack {
  /** 上次观测到的 status（diff 基线） */
  lastStatus: SessionStatus
  /** 源 session id（反馈行落点路由） */
  srcSessionId: string
  /** 分支 label */
  label: string
}

/** running 态（status 'active' = pi 进程存活且生成中，可被观测状态翻转） */
const RUNNING_STATUS: SessionStatus = 'active'

/**
 * status → BranchChangeKind 映射（仅 running→终态 触发通知）。
 * idle→其他不触发（idle 是默认态，非「后台跑完」语义）。
 */
function classifyChange(from: SessionStatus, to: SessionStatus): BranchChangeKind | null {
  // 仅 running 起源的翻转才通知（后台分支「跑完/出错」心智）
  if (from !== RUNNING_STATUS) return null
  switch (to) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'stopped':
      return 'stopped'
    default:
      return null
  }
}

/** 追踪表：branchId → BranchTrack（非响应式——唯一读者是 diff 自身，UI 只读 unreadByBranch） */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：branchId→BranchTrack 非响应式追踪表（fork 通知全局 SSOT 的 diff 基线，无 sidRef 的显式 sid 协调器，上方注释已述 ADR-0049 例外）
const trackMap = new Map<string, BranchTrack>()

/** 分支未读角标：branchId → true（模块级单例，SessionItemDisplay 的未读点直接读本模块，D9 合流） */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：分支未读角标全局 SSOT（无 sidRef 的显式 sid 协调器，跨 session 血缘键，侧栏角标跨组件读）
export const unreadByBranch: Ref<ReadonlyMap<string, boolean>> = shallowRef(new Map())

/**
 * diff groups：遍历所有 session，对 parentSession 有值（分支）的项做 status 对比。
 * 仅追踪中的分支触发变化检测（未注册的分支无 srcSessionId 落点，不通知）。
 * 有状态翻转时置未读角标并回调 onChange（由调用方接线反馈行追加）。
 */
export function syncForkBranches(
  groups: SessionGroup[],
  onChange: (change: BranchStatusChange) => void,
): void {
  for (const g of groups) {
    for (const s of g.sessions) {
      if (!s.parentSession) continue
      const tracked = trackMap.get(s.id)
      if (!tracked) continue // 未注册（非本模块追踪的分支），跳过
      if (s.status === tracked.lastStatus) {
        // label 可能更新（重命名），同步但不触发通知
        if (s.label !== tracked.label) tracked.label = s.label
        continue
      }
      const kind = classifyChange(tracked.lastStatus, s.status)
      // 更新基线
      tracked.lastStatus = s.status
      tracked.label = s.label
      if (kind) {
        // 触发未读角标（done/error 均需用户关注）
        unreadByBranch.value = new Map(unreadByBranch.value).set(s.id, true)
        // 派发变化事件给调用方（反馈行追加）
        onChange({
          branchId: s.id,
          srcSessionId: tracked.srcSessionId,
          kind,
          label: tracked.label,
        })
      }
    }
  }
}

/** 注册新 fork 分支：建立追踪基线（初始 status 来自下一次 groups 广播） */
export function registerFork(srcSessionId: string, branchId: string, label: string): void {
  // 初始 lastStatus 设为 running（fork 时分支刚创建必为 active）；
  // 下次 groups 广播若仍 active 则无变化，若已终态则触发通知。
  trackMap.set(branchId, { lastStatus: RUNNING_STATUS, srcSessionId, label })
}

/** 清除某分支未读角标（用户 select 跳转查看后调） */
export function clearUnread(branchId: string): void {
  if (!unreadByBranch.value.has(branchId)) return
  const next = new Map(unreadByBranch.value)
  next.delete(branchId)
  unreadByBranch.value = next
}

/** 重置全部分支追踪/角标态（bindForkNoticeEffect 卸载清理 + 测试隔离共用） */
export function resetForkBranchState(): void {
  trackMap.clear()
  unreadByBranch.value = new Map()
}
