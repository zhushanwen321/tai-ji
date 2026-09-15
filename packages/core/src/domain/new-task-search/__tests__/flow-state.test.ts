/**
 * flow-state 状态机单测（IF4/DM4）。
 *
 * 覆盖 plan TC-1..TC-3：全转换表合法转换 / 非法转换回 idle 抛错 / 终态重建
 * transitionUnchecked + openOverlay 互斥幂等 + controller + reset。
 * node 环境实测 vue reactivity；模块级单例跨用例共享，beforeEach resetNewTaskFlow 隔离。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  resetNewTaskFlow,
  transition,
  openOverlay,
  OVERLAY_STATES,
  ACTIVE_STATES,
  useNewTaskFlowController,
  useNewTaskFlowState,
  type NewTaskFlowState,
} from '../flow-state'
import type { SessionSummary } from '@taiji/shared'

/** 期望的 ALLOWED 转换表（契约锁定——测试防实现误改转换规则） */
const EXPECTED_ALLOWED: Record<NewTaskFlowState, NewTaskFlowState[]> = {
  idle: ['landing'],
  landing: ['dir-popover', 'branch-popover', 'preset-popover', 'worktree-modal', 'completed', 'cancelled'],
  'dir-popover': ['landing', 'dir-dialog', 'cancelled'],
  'branch-popover': ['landing', 'branch-modal', 'worktree-modal', 'cancelled'],
  'preset-popover': ['landing', 'cancelled'],
  'dir-dialog': ['landing', 'dir-popover', 'cancelled'],
  'branch-modal': ['landing', 'cancelled'],
  'worktree-modal': ['landing', 'cancelled'],
  completed: [],
  cancelled: ['landing'],
}

const ALL_STATES: NewTaskFlowState[] = [
  'idle',
  'landing',
  'dir-popover',
  'branch-popover',
  'preset-popover',
  'dir-dialog',
  'branch-modal',
  'worktree-modal',
  'completed',
  'cancelled',
]

/** 经合法路径把状态机直置到指定态（测试辅助） */
function setState(s: NewTaskFlowState): void {
  resetNewTaskFlow()
  if (s === 'idle') return
  if (s === 'landing') {
    transition('landing')
  } else if (s === 'completed') {
    transition('landing')
    transition('completed')
  } else if (s === 'cancelled') {
    transition('landing')
    transition('cancelled')
  } else if (s === 'dir-dialog') {
    transition('landing')
    transition('dir-popover')
    transition('dir-dialog')
  } else if (s === 'branch-modal') {
    transition('landing')
    transition('branch-popover')
    transition('branch-modal')
  } else {
    // dir-popover / branch-popover / preset-popover / worktree-modal（landing 可直达）
    transition('landing')
    transition(s)
  }
}

describe('flow-state 状态机', () => {
  beforeEach(() => {
    resetNewTaskFlow()
  })

  it('TC-1: 全转换表合法转换——每个 from 的期望目标均可转换', () => {
    for (const from of ALL_STATES) {
      for (const to of EXPECTED_ALLOWED[from]) {
        setState(from)
        transition(to)
        expect(
          useNewTaskFlowState().state.value,
          `转换 ${from} → ${to} 应成功`,
        ).toBe(to)
      }
    }
  })

  it('TC-2: 非法转换 → 回 idle + 抛错（AC-3.11）', () => {
    setState('landing')
    expect(() => transition('idle')).toThrow('非法状态转换')
    expect(useNewTaskFlowState().state.value).toBe('idle')
  })

  it('TC-2b: completed 终态无出口（transition 抛错回 idle）', () => {
    setState('completed')
    expect(() => transition('landing')).toThrow('非法状态转换')
    expect(useNewTaskFlowState().state.value).toBe('idle')
  })

  it('TC-3: 终态重建 transitionUnchecked(\'idle\') 直置成功 + 可再进 landing', () => {
    setState('completed')
    const controller = useNewTaskFlowController()
    controller.transitionUnchecked('idle')
    expect(useNewTaskFlowState().state.value).toBe('idle')
    transition('landing')
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-3b: openOverlay 互斥——已开 overlay 先归 landing 再开 target', () => {
    setState('landing')
    openOverlay('dir-popover')
    expect(useNewTaskFlowState().state.value).toBe('dir-popover')
    openOverlay('branch-popover')
    expect(useNewTaskFlowState().state.value).toBe('branch-popover')
  })

  it('TC-3c: openOverlay 幂等早退（已在 target 不闪态）', () => {
    setState('landing')
    openOverlay('dir-popover')
    openOverlay('dir-popover') // 已在 target → 早退，不经历 landing→dir-popover
    expect(useNewTaskFlowState().state.value).toBe('dir-popover')
  })

  it('TC-3d: openOverlay 从 idle 调用抛错（上游漏 startFlow 暴露）', () => {
    expect(() => openOverlay('dir-popover')).toThrow('非法状态转换')
    expect(useNewTaskFlowState().state.value).toBe('idle')
  })

  it('TC-3e: controller setter 生效（bindCurrentSession/setCreateInFlight/setBranchCreateInFlight）', () => {
    const controller = useNewTaskFlowController()
    controller.bindCurrentSession({ id: 's1' } as SessionSummary)
    expect(useNewTaskFlowState().currentSession.value?.id).toBe('s1')
    controller.setCreateInFlight(true)
    expect(useNewTaskFlowState().createInFlight.value).toBe(true)
    controller.setBranchCreateInFlight(true)
    expect(useNewTaskFlowState().branchCreateInFlight.value).toBe(true)
  })

  it('TC-3f: 只读视图——pendingCwd 可写（记 landing 选定值）', () => {
    setState('landing')
    const view = useNewTaskFlowState()
    view.pendingCwd.value = '/tmp/x'
    expect(useNewTaskFlowState().pendingCwd.value).toBe('/tmp/x')
  })

  it('resetNewTaskFlow 全字段重置', () => {
    const controller = useNewTaskFlowController()
    setState('landing')
    useNewTaskFlowState().pendingCwd.value = '/tmp/reset-test'
    controller.bindCurrentSession({ id: 's1' } as SessionSummary)
    controller.setCreateInFlight(true)
    controller.setBranchCreateInFlight(true)

    resetNewTaskFlow()
    const view = useNewTaskFlowState()
    expect(view.state.value).toBe('idle')
    expect(view.currentSession.value).toBeNull()
    expect(view.pendingCwd.value).toBeNull()
    expect(view.pendingModel.value).toBeNull()
    expect(view.createInFlight.value).toBe(false)
    expect(view.branchCreateInFlight.value).toBe(false)
  })

  it('OVERLAY_STATES ⊂ ACTIVE_STATES（isOverlay/isActive 依赖的包含关系契约）', () => {
    for (const s of OVERLAY_STATES) {
      expect(ACTIVE_STATES.has(s), `overlay 态 ${s} 应在 ACTIVE_STATES`).toBe(true)
    }
    expect(ACTIVE_STATES.has('landing')).toBe(true)
    expect(ACTIVE_STATES.has('idle')).toBe(false)
    expect(ACTIVE_STATES.has('completed')).toBe(false)
    expect(ACTIVE_STATES.has('cancelled')).toBe(false)
  })
})
