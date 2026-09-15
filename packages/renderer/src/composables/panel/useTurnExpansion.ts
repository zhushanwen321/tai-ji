/**
 * useTurnExpansion —— 「消息 turn 展开/折叠」状态的薄包装（w4 store 重构 IF1）。
 *
 * 职责：保持 IF1 公开 API（w1 既定签名）不变，内部委托 turn-expansion store。
 *
 * 为什么改薄包装：w1 阶段基于 useSessionScopedState（per-instance Map），w4 接线发现
 * Turn.vue 与 MessageStream.vue 各调一次本 composable，两个实例各自维护一份 Map 分区，
 * 同一 session 下展开态不共享（rail 展开 turn，Turn 内 trace 不跟）。改用 Pinia store
 * 单例后，所有调用方共享同一份 state，per-session 隔离由 store 内 sessionId 分区保证。
 *
 * 响应式契约：store 内用双层 reactive Map（见 stores/turn-expansion.ts），下游 effect/computed
 * 在 isExpanded(idx) 读取时建立对 `partition.get(idx)` 的依赖，expand/collapse mutate 时
 * 依赖失效重算（TC-w1-7 / TC-w1-9 契约保持）。
 *
 * null sid 语义：所有写方法 no-op（不污染空串分区），isExpanded/hasAnyExpanded 返回 false。
 * 与 w1 的 null sid no-op 契约一致。
 */
import type { Ref } from 'vue'
import { useTurnExpansionStore } from '@/stores/turn-expansion'

/**
 * turn key：MessageTurn 的稳定标识（首条消息 id），由 turnStableId 派生。
 * [M5 stable-key] 旧契约用 MessageTurn.index（number），消息插删时漂移；
 * string 稳定 key 后展开态跟随 turn 而非索引。
 */
export type TurnKey = string

export function useTurnExpansion(sessionId: Ref<string | null>): {
  isExpanded: (turnKey: TurnKey) => boolean
  toggle: (turnKey: TurnKey) => void
  expand: (turnKey: TurnKey) => void
  collapse: (turnKey: TurnKey) => void
  isTakeover: (turnKey: TurnKey) => boolean
  setTakeover: (turnKey: TurnKey, on: boolean) => void
  expandAll: (turnKeys: TurnKey[]) => void
  collapseAll: (turnKeys: TurnKey[]) => void
  hasAnyExpanded: (turnKeys: TurnKey[]) => boolean
} {
  const store = useTurnExpansionStore()

  /** 取当前 sid（null → 空串，store 操作空串分区无害但写方法仍按 null 语义 no-op） */
  function sid(): string | null {
    return sessionId.value
  }

  return {
    /** 查询指定 turn 是否展开。null sid 返回 false（与 w1 契约一致）。 */
    isExpanded: (turnKey: TurnKey): boolean => {
      const s = sid()
      return s !== null && store.isExpanded(s, turnKey)
    },
    /** 翻转展开态。null sid 时 no-op */
    toggle: (turnKey: TurnKey): void => {
      const s = sid()
      if (s !== null) store.toggle(s, turnKey)
    },
    /** 设为展开。null sid 时 no-op */
    expand: (turnKey: TurnKey): void => {
      const s = sid()
      if (s !== null) store.expand(s, turnKey)
    },
    /** 设为折叠。null sid 时 no-op */
    collapse: (turnKey: TurnKey): void => {
      const s = sid()
      if (s !== null) store.collapse(s, turnKey)
    },
    /** 查询「展开全部」接管态。null sid 返回 false（D6/TC2，窗口级语义，驱动 computeTraceWindow） */
    isTakeover: (turnKey: TurnKey): boolean => {
      const s = sid()
      return s !== null && store.isTakeover(s, turnKey)
    },
    /** 设/清「展开全部」接管态。null sid 时 no-op */
    setTakeover: (turnKey: TurnKey, on: boolean): void => {
      const s = sid()
      if (s !== null) store.setTakeover(s, turnKey, on)
    },
    /** 批量展开。null sid 时 no-op */
    expandAll: (turnKeys: TurnKey[]): void => {
      const s = sid()
      if (s !== null) store.expandAll(s, turnKeys)
    },
    /** 批量折叠。null sid 时 no-op */
    collapseAll: (turnKeys: TurnKey[]): void => {
      const s = sid()
      if (s !== null) store.collapseAll(s, turnKeys)
    },
    /** 任一 turn 处于展开态。null sid 返回 false */
    hasAnyExpanded: (turnKeys: TurnKey[]): boolean => {
      const s = sid()
      return s !== null && store.hasAnyExpanded(s, turnKeys)
    },
  }
}
