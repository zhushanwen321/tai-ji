/**
 * 复合谓词单一源 [MANDATORY]（display-containers §7.1 迁出不变量，W0 还债）。
 *
 * 唯一拼装点：`isOpen ∧ activeTab ∈ {'subagent','btw'} ∧ 选中 id` 三分量复合谓词。
 * 三个跨域消费方**只准读本文件**，禁止各处自行拼装三分量（任何拼装漂移 = 查看中的
 * btw 线 / agentcall 分区被静默驱逐（数据丢失类回归）或回放误停）：
 *   ① getViewedVids（chat LRU 驱逐豁免，selection/viewed-vids.ts）——per-sid 读；
 *   ② btw-replay 触发面（renderer stores/btw-replay.ts）——useViewedBtwVid 响应式读；
 *   ③ useBtwTabData 视口命中（renderer composables/panel/useBtwTabData.ts）——
 *      isViewingBtwVid / useBtwViewKey。
 *
 * 读取源：控制态分区（control.ts：isOpen/activeTab）× 各内容域选中态分区
 * （selection/btw.ts / selection/subagent.ts）——五字段迁出 DrawerControlState 后
 * 复合谓词跨两个分区读，本文件是它们的唯一交汇处。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { getBoundSessionId, getDrawerControlState, readDrawerControlFor } from '../control'
import type { DrawerControlState } from '../types'
import { getBtwSelectionState, readBtwSelectionFor } from './btw'
import { readSubagentSelectionFor } from './subagent'

/** 控制态三分量的两个分量（isOpen/activeTab）——复合谓词入参收窄面 */
type ControlGate = Pick<DrawerControlState, 'isOpen' | 'activeTab'>

/** btw 复合谓词唯一拼装：视口内返回选中线 vid，否则 null */
function btwViewOf(ctrl: ControlGate, vid: string | undefined): string | null {
  return ctrl.isOpen && ctrl.activeTab === 'btw' && vid ? vid : null
}

/** subagent 复合谓词唯一拼装：视口内返回选中 subagent 虚拟 id，否则 null */
function subagentViewOf(ctrl: ControlGate, vid: string | null): string | null {
  return ctrl.isOpen && ctrl.activeTab === 'subagent' && vid ? vid : null
}

/**
 * per-sid 读：该会话「正在查看」的 btw 线 vid（getViewedVids 的 btw 豁免分支）。
 * 分区不存在/已删时返回 null（updateFor 语义：已删 sid 不复活分区）。
 */
export function viewedBtwVidFor(sid: string): string | null {
  const gate = readDrawerControlFor<ControlGate>(sid, (c) => ({ isOpen: c.isOpen, activeTab: c.activeTab }))
  if (!gate) return null
  return btwViewOf(gate, readBtwSelectionFor(sid, (s) => s.selectedBtwVid))
}

/**
 * per-sid 读：该会话「正在查看」的 subagent/agentcall 虚拟 id（getViewedVids 的 B9 豁免分支）。
 */
export function viewedSubagentVidFor(sid: string): string | null {
  const gate = readDrawerControlFor<ControlGate>(sid, (c) => ({ isOpen: c.isOpen, activeTab: c.activeTab }))
  if (!gate) return null
  return subagentViewOf(gate, readSubagentSelectionFor(sid, (s) => s.selectedSubagentId) ?? null)
}

/**
 * 响应式读（当前分区）：视口内选中线 vid（btw-replay 触发面直接 watch 本 computed——
 * 关 drawer / 切走 tab / 清选中折叠为 null，重开/切回/选中翻出 vid，恰好覆盖「重开线」全部形态）。
 */
export function useViewedBtwVid(): ComputedRef<string | null> {
  return computed(() => btwViewOf(getDrawerControlState(), getBtwSelectionState().selectedBtwVid))
}

/** 同步读（当前分区）：该 vid 是否正「在视口」（useBtwTabData 视口命中判定） */
export function isViewingBtwVid(vid: string): boolean {
  return btwViewOf(getDrawerControlState(), getBtwSelectionState().selectedBtwVid) === vid
}

/**
 * 视口三元组 key（useBtwTabData 未读清除触发源）：非 btw 视口归 ''，视口内 = `绑定sid\0选中vid`。
 * 三分量判定与 btwViewOf 同源（本文件唯一拼装点），key 形态沿用消费侧既有解析约定。
 */
export function useBtwViewKey(): ComputedRef<string> {
  return computed(() => {
    const ctrl = getDrawerControlState()
    if (!ctrl.isOpen || ctrl.activeTab !== 'btw') return ''
    return `${getBoundSessionId() ?? ''}\u0000${getBtwSelectionState().selectedBtwVid ?? ''}`
  })
}
