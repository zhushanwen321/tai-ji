/**
 * dir-select 选目录编排单测（IF4）。
 *
 * 覆盖 plan TC-10：openDirPopover 互斥 / selectWorkspace（cwd 未变 noop / 变则记 pendingCwd + record）/
 * openDirDialog 三态（取消落回 / 选中 / reject 重抛）/ watch currentCwd 派生（mode/isBare/worktreeItems）。
 * 三端口 mock 注入；模块级状态 beforeEach resetNewTaskFlow 隔离；watch 异步 flush 用 nextTick 驱动。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { resetNewTaskFlow, useNewTaskFlowState, transition } from '../flow-state'
import { useNewTaskDirSelect } from '../dir-select'
import type { DirectoryPickerPort, WorkspaceApiPort, WorkspaceStatePort } from '../ports'

function makeDeps(): {
  directoryPicker: DirectoryPickerPort
  workspaceApi: WorkspaceApiPort
  workspaceState: WorkspaceStatePort
} {
  return {
    directoryPicker: {
      pickDirectory: vi.fn(),
    },
    workspaceApi: {
      detect: vi.fn().mockResolvedValue({ mode: 'not-repo' }),
      listWorktrees: vi.fn().mockResolvedValue({ items: [] }),
    },
    workspaceState: {
      defaultCwd: vi.fn(() => '/default'),
      record: vi.fn(),
    },
  }
}

function makeDirSelect(deps: ReturnType<typeof makeDeps>, cwdGetter: () => string | null) {
  return useNewTaskDirSelect(deps, cwdGetter)
}

describe('useNewTaskDirSelect', () => {
  beforeEach(() => {
    resetNewTaskFlow()
  })

  it('TC-10a: openDirPopover 互斥——已开 branch-popover 先归 landing 再开 dir-popover', () => {
    const deps = makeDeps()
    const dirSelect = makeDirSelect(deps, () => '/cwd')
    transition('landing')
    // 先开 branch-popover（模拟）
    transition('branch-popover')
    dirSelect.openDirPopover()
    expect(useNewTaskFlowState().state.value).toBe('dir-popover')
  })

  it('TC-10b: selectWorkspace cwd 未变 → noop 仅关 popover（record 不调）', async () => {
    const deps = makeDeps()
    const dirSelect = makeDirSelect(deps, () => '/same')
    transition('landing')
    dirSelect.openDirPopover()
    await dirSelect.selectWorkspace('/same')
    expect(useNewTaskFlowState().state.value).toBe('landing')
    expect(deps.workspaceState.record).not.toHaveBeenCalled()
  })

  it('TC-10c: selectWorkspace cwd 变 → 记 pendingCwd + record + landing', async () => {
    const deps = makeDeps()
    const dirSelect = makeDirSelect(deps, () => '/old')
    transition('landing')
    dirSelect.openDirPopover()
    await dirSelect.selectWorkspace('/new')
    expect(useNewTaskFlowState().pendingCwd.value).toBe('/new')
    expect(useNewTaskFlowState().state.value).toBe('landing')
    expect(deps.workspaceState.record).toHaveBeenCalledWith('/new')
  })

  it('TC-10d: openDirDialog 取消 → 落回 dir-popover', async () => {
    const deps = makeDeps()
    const dirSelect = makeDirSelect(deps, () => '/cwd')
    ;(deps.directoryPicker.pickDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: true,
      path: null,
    })
    transition('landing')
    dirSelect.openDirPopover()
    await dirSelect.openDirDialog()
    expect(useNewTaskFlowState().state.value).toBe('dir-popover') // 取消落回
    expect(deps.workspaceState.record).not.toHaveBeenCalled()
  })

  it('TC-10e: openDirDialog 选中 → 记 pendingCwd + record + landing', async () => {
    const deps = makeDeps()
    const dirSelect = makeDirSelect(deps, () => '/cwd')
    ;(deps.directoryPicker.pickDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      path: '/picked',
    })
    transition('landing')
    dirSelect.openDirPopover()
    await dirSelect.openDirDialog()
    expect(useNewTaskFlowState().pendingCwd.value).toBe('/picked')
    expect(useNewTaskFlowState().state.value).toBe('landing')
    expect(deps.workspaceState.record).toHaveBeenCalledWith('/picked')
  })

  it('TC-10f: openDirDialog reject（E5 IPC 招错）→ 落回 dir-popover + 重抛', async () => {
    const deps = makeDeps()
    const dirSelect = makeDirSelect(deps, () => '/cwd')
    ;(deps.directoryPicker.pickDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ipc error'),
    )
    transition('landing')
    dirSelect.openDirPopover()
    await expect(dirSelect.openDirDialog()).rejects.toThrow('ipc error')
    expect(useNewTaskFlowState().state.value).toBe('dir-popover') // 落回不卡 dir-dialog
  })

  it('TC-10g: watch currentCwd null → mode/isBare/worktreeItems 清空（不调 RPC）', async () => {
    const deps = makeDeps()
    const dirSelect = makeDirSelect(deps, () => null)
    await nextTick()
    expect(dirSelect.mode.value).toBe('not-repo')
    expect(dirSelect.isBare.value).toBe(false)
    expect(dirSelect.worktreeItems.value).toEqual([])
    expect(deps.workspaceApi.detect).not.toHaveBeenCalled()
    expect(deps.workspaceApi.listWorktrees).not.toHaveBeenCalled()
  })

  it('TC-10h: watch currentCwd 非 null → detect 成功回填 mode/isBare + worktree 列表', async () => {
    const deps = makeDeps()
    // 先设置 mock 再创建 dirSelect（immediate watch 在创建时同步触发，须先就绪 mock 值）
    ;(deps.workspaceApi.detect as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'bare-workspace' })
    ;(deps.workspaceApi.listWorktrees as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ path: '/ws/main', branch: 'main', HEAD: true, bare: false }],
    })
    const dirSelect = makeDirSelect(deps, () => '/ws')
    // async watch 回调链需要 2 次 microtask flush（immediate 触发 → allSettled → 写 mode）
    await nextTick()
    await nextTick()
    expect(dirSelect.mode.value).toBe('bare-workspace')
    expect(dirSelect.isBare.value).toBe(true)
    expect(dirSelect.worktreeItems.value).toEqual([
      { path: '/ws/main', branch: 'main', HEAD: true, bare: false },
    ])
  })

  it('TC-10i: watch currentCwd detect 失败 → 静默降级 not-repo + list 失败空列表', async () => {
    const deps = makeDeps()
    // 先设置 reject mock 再创建 dirSelect（immediate watch 同步触发）
    ;(deps.workspaceApi.detect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('detect fail'))
    ;(deps.workspaceApi.listWorktrees as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NOT_BARE_REPO'))
    const dirSelect = makeDirSelect(deps, () => '/ws')
    await nextTick()
    await nextTick()
    expect(dirSelect.mode.value).toBe('not-repo')
    expect(dirSelect.isBare.value).toBe(false)
    expect(dirSelect.worktreeItems.value).toEqual([])
  })
})
