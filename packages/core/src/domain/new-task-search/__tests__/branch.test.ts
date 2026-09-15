/**
 * branch git 分支编排单测（IF4）。
 *
 * 覆盖 plan TC-9：git 守卫（openBranchPopover）/ 直切（selectBranch/confirmDirtySwitch）/
 * 飞行中守卫 + 孤儿 promise（submitCreateBranch）。
 * gitApi mock 注入；模块级状态 beforeEach resetNewTaskFlow 隔离。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resetNewTaskFlow, useNewTaskFlowState, transition } from '../flow-state'
import { useNewTaskBranch, type NewTaskBranchController } from '../branch'
import type { GitApiPort } from '../ports'

function makeController(): NewTaskBranchController {
  return {
    setBranchCreateInFlight: vi.fn(),
    transitionUnchecked: vi.fn((target: 'idle') => {
      // 模拟 flow-state 私有 transitionUnchecked 语义：直置回 idle（resetNewTaskFlow 等价——
      // 真实 transitionUnchecked 操作模块私有 ref，测试拿不到；reset 同样置 idle + 清绑定）
      resetNewTaskFlow()
    }),
  }
}

function makeGitApi(): GitApiPort {
  return {
    checkout: vi.fn(),
    checkoutByCwd: vi.fn(),
    createBranch: vi.fn(),
  }
}

/** 构造 branch 模块（getter 注入）；opts.git 非 null 表示 gitInfo 非 null */
function makeBranch(gitApi: GitApiPort, opts: { sid?: string | null; git?: unknown } = {}) {
  const controller = makeController()
  const branch = useNewTaskBranch(
    gitApi,
    () => opts.sid ?? null,
    () => (opts.git ? { branch: 'main', isRepo: true } : null),
    () => '/cwd',
    controller,
  )
  return { branch, controller }
}

describe('useNewTaskBranch', () => {
  beforeEach(() => {
    resetNewTaskFlow()
  })

  it('TC-9a: openBranchPopover git 守卫——非 git 目录抛错回 idle', () => {
    const gitApi = makeGitApi()
    const { branch, controller } = makeBranch(gitApi, { git: null })
    transition('landing')
    expect(() => branch.openBranchPopover()).toThrow('非 git 目录')
    expect(controller.transitionUnchecked).toHaveBeenCalledWith('idle')
    expect(useNewTaskFlowState().state.value).toBe('idle')
  })

  it('TC-9b: openBranchPopover git 守卫通过 → branch-popover', () => {
    const gitApi = makeGitApi()
    const { branch } = makeBranch(gitApi, { git: {} })
    transition('landing')
    branch.openBranchPopover()
    expect(useNewTaskFlowState().state.value).toBe('branch-popover')
  })

  it('TC-9c: openBranchModal 来源守卫——非 branch-popover 抛错回 idle', () => {
    const gitApi = makeGitApi()
    const { branch, controller } = makeBranch(gitApi, { git: {} })
    transition('landing')
    expect(() => branch.openBranchModal()).toThrow('仅可从 branch-popover')
    expect(controller.transitionUnchecked).toHaveBeenCalledWith('idle')
  })

  it('TC-9d: selectBranch 已建 session 直切（checkout + landing）', async () => {
    const gitApi = makeGitApi()
    const { branch } = makeBranch(gitApi, { sid: 's1', git: {} })
    transition('landing')
    branch.openBranchPopover()
    await branch.selectBranch('main')
    expect(gitApi.checkout).toHaveBeenCalledWith('s1', 'main')
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-9e: selectBranch landing 态（无 session）走 checkoutByCwd', async () => {
    const gitApi = makeGitApi()
    const { branch } = makeBranch(gitApi, { git: {} })
    transition('landing')
    branch.openBranchPopover()
    await branch.selectBranch('main')
    expect(gitApi.checkoutByCwd).toHaveBeenCalledWith('/cwd', 'main')
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-9f: selectBranch 无 cwd 也无 session → 抛错', async () => {
    const gitApi = makeGitApi()
    const controller = makeController()
    // currentCwd 返回 null（直接构造，不走 makeBranch 的固定 /cwd）
    const branch = useNewTaskBranch(
      gitApi,
      () => null,
      () => ({ branch: 'main', isRepo: true }),
      () => null,
      controller,
    )
    transition('landing')
    branch.openBranchPopover()
    await expect(branch.selectBranch('main')).rejects.toThrow('无 cwd 也无 session')
  })

  it('TC-9g: submitCreateBranch 无绑定 session → 抛错', async () => {
    const gitApi = makeGitApi()
    const { branch } = makeBranch(gitApi, { git: {} })
    await expect(branch.submitCreateBranch('feat/x')).rejects.toThrow('无绑定 session')
  })

  it('TC-9h: submitCreateBranch 成功（branch-modal 态）→ createBranch + landing', async () => {
    const gitApi = makeGitApi()
    const { branch, controller } = makeBranch(gitApi, { sid: 's1', git: {} })
    ;(gitApi.createBranch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    transition('landing')
    branch.openBranchPopover()
    branch.openBranchModal()
    expect(useNewTaskFlowState().state.value).toBe('branch-modal')
    await branch.submitCreateBranch('feat/x')
    expect(gitApi.createBranch).toHaveBeenCalledWith('s1', 'feat/x')
    expect(controller.setBranchCreateInFlight).toHaveBeenCalledWith(true)
    expect(controller.setBranchCreateInFlight).toHaveBeenLastCalledWith(false)
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-9i: submitCreateBranch 飞行中守卫——重复提交直接 return 不调 gitApi', async () => {
    const gitApi = makeGitApi()
    const { branch } = makeBranch(gitApi, { sid: 's1', git: {} })
    // 飞行中：controller setBranchCreateInFlight(true) 语义直置模块级 ref
    useNewTaskFlowController_setBranchCreateInFlight(true)
    transition('landing')
    branch.openBranchPopover()
    branch.openBranchModal()
    await branch.submitCreateBranch('feat/x')
    expect(gitApi.createBranch).not.toHaveBeenCalled()
    useNewTaskFlowController_setBranchCreateInFlight(false)
  })

  it('TC-9j: submitCreateBranch 孤儿 promise 守卫——Esc 已离开 branch-modal → resolve 后不 transition', async () => {
    const gitApi = makeGitApi()
    const { branch } = makeBranch(gitApi, { sid: 's1', git: {} })
    // createBranch 挂起（未 resolve）
    let resolveCreate!: () => void
    ;(gitApi.createBranch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((r) => { resolveCreate = r }),
    )
    transition('landing')
    branch.openBranchPopover()
    branch.openBranchModal()
    const p = branch.submitCreateBranch('feat/x')
    // Esc 已切走：state 离开 branch-modal
    transition('landing')
    resolveCreate()
    await p
    // 孤儿分支：不重复 transition（state 保持 landing 而非二次 landing——若执行 transition('landing')
    // 会因 landing→landing 非法抛错，测试即失败）
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })
})

import { useNewTaskFlowController } from '../flow-state'
function useNewTaskFlowController_setBranchCreateInFlight(v: boolean): void {
  useNewTaskFlowController().setBranchCreateInFlight(v)
}
