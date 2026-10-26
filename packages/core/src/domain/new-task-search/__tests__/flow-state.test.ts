// flow-state.test.ts —— core C23 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/new-task-search/flow-state.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/new-task-search/__tests__/branch.test.ts（10 用例，skip 0）
//   - src/domain/new-task-search/__tests__/dir-select.test.ts（9 用例，skip 0）
//   - src/domain/new-task-search/__tests__/flow-state.test.ts（11 用例，skip 0）
//   - src/domain/new-task-search/__tests__/flow.test.ts（34 用例，skip 0）
//   - src/domain/new-task-search/__tests__/launch-config-equivalence.test.ts（81 用例，skip 0）

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { resetNewTaskFlow, useNewTaskFlowState, transition, useNewTaskFlowController, openOverlay, OVERLAY_STATES, ACTIVE_STATES, type NewTaskFlowState } from '../flow-state'
import { useNewTaskBranch, type NewTaskBranchController } from '../branch'
import { type GitApiPort, type DirectoryPickerPort, type WorkspaceApiPort, type WorkspaceStatePort, type NewTaskFlowDeps } from '../ports'
import { nextTick, computed, effectScope, ref, type ComputedRef, type Ref } from 'vue'
import { useNewTaskDirSelect } from '../dir-select'
import { type SessionSummary, type PiLaunchPreset, type ProviderId, type ProviderInfo, type Segment, BUILTIN_PRESET_IDS, type ThinkingLevel } from '@taiji/shared'
import { useNewTaskFlow, type LaunchConfigPort } from '../flow'
import { resolveLaunchConfig, type LaunchConfigInput, createLaunchConfigView, type LaunchConfig } from '../launch-config'
import { __resetLastUsedModelForTesting, lookup as lookupLastUsed, record as recordLastUsed } from '../../composer/last-used-model'
import { __resetModelThinkingMemoryForTesting, lookup as lookupMemory, record as recordMemory } from '../../composer/model-thinking-memory'
import { takeOrphanedDraft, __resetOrphanedDraftForTesting } from '../../composer/orphan-draft'
import { type CreateSessionFlowInput } from '@taiji/core/domain/session'
import { readFileSync } from 'node:fs'
import { useComposerModelThinking, type ModelThinkingDeps } from '../../composer/model-thinking'
import { providePlatform, __resetPlatformForTesting, type KVStorage, type PlatformPort } from '../../../platform/port'

// ======== 来源：branch.test.ts ========
describe("branch", () => {
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

    it('TC-9a: openBranchPopover git 检查——非 git 目录抛错回 idle', () => {
      const gitApi = makeGitApi()
      const { branch, controller } = makeBranch(gitApi, { git: null })
      transition('landing')
      expect(() => branch.openBranchPopover()).toThrow('非 git 目录')
      expect(controller.transitionUnchecked).toHaveBeenCalledWith('idle')
      expect(useNewTaskFlowState().state.value).toBe('idle')
    })

    it('TC-9b: openBranchPopover git 检查通过 → branch-popover', () => {
      const gitApi = makeGitApi()
      const { branch } = makeBranch(gitApi, { git: {} })
      transition('landing')
      branch.openBranchPopover()
      expect(useNewTaskFlowState().state.value).toBe('branch-popover')
    })

    it('TC-9c: openBranchModal 来源检查——非 branch-popover 抛错回 idle', () => {
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

    it('TC-9i: submitCreateBranch 飞行中检查——重复提交直接 return 不调 gitApi', async () => {
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

    it('TC-9j: submitCreateBranch 孤儿 promise 检查——Esc 已离开 branch-modal → resolve 后不 transition', async () => {
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

  function useNewTaskFlowController_setBranchCreateInFlight(v: boolean): void {
    useNewTaskFlowController().setBranchCreateInFlight(v)
  }
});

// ======== 来源：dir-select.test.ts ========
describe("dir-select", () => {
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
});

// ======== 来源：flow-state.test.ts ========
describe("flow-state", () => {
  /** 期望的 ALLOWED 转换表（契约锁定——测试防实现误改转换规则） */
  const EXPECTED_ALLOWED: Record<NewTaskFlowState, NewTaskFlowState[]> = {
    idle: ['landing'],
    landing: ['dir-popover', 'branch-popover', 'preset-popover', 'project-popover', 'worktree-modal', 'completed', 'cancelled'],
    'dir-popover': ['landing', 'dir-dialog', 'cancelled'],
    'branch-popover': ['landing', 'branch-modal', 'worktree-modal', 'cancelled'],
    'preset-popover': ['landing', 'cancelled'],
    'project-popover': ['landing', 'cancelled'],
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
    'project-popover',
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
      // dir-popover / branch-popover / preset-popover / project-popover / worktree-modal（landing 可直达）
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
});

// ======== 来源：flow.test.ts ========
describe("flow", () => {
  /** makeDeps 的覆盖参数：ports 支持部分覆盖 + U2b 扩展端口 launchConfig。 */
  type FlowDepsOverrides = Partial<Omit<NewTaskFlowDeps, 'ports'>> & {
    ports?: Partial<NewTaskFlowDeps['ports']> & { launchConfig?: LaunchConfigPort }
  }

  /** 构造 mock 端口集（每个测试独立实例，断言 per-test）。launchConfig 端口默认不注入（回落 core 单例基座路径）。 */
  function makeDeps(overrides?: FlowDepsOverrides): NewTaskFlowDeps {
    const deps: NewTaskFlowDeps = {
      ports: {
        createSessionFlow: {
          createSession: vi.fn(),
        },
        chat: {
          // 默认 true = 已投递（正常路径）；A 消费侧用例各自 mockResolvedValueOnce(false)
          send: vi.fn(async () => true),
          sendBash: vi.fn(async () => true),
        },
        navigation: {
          activePanelId: vi.fn(() => 'p1'),
          loadPanel: vi.fn(),
          clearActiveSession: vi.fn(),
          setActiveSession: vi.fn(),
          pushChat: vi.fn(),
        },
        toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() },
        fileTree: { loadTree: vi.fn(), selectFile: vi.fn() },
        t: vi.fn((key: string) => key),
        migrateImage: { migrateImage: vi.fn() },
        // [E] 取消收尾删已建 session（best-effort）
        session: { remove: vi.fn(async () => undefined) },
      },
      gitApi: {
        checkout: vi.fn(),
        checkoutByCwd: vi.fn(),
        createBranch: vi.fn(),
      },
      directoryPicker: { pickDirectory: vi.fn() },
      workspaceApi: {
        detect: vi.fn().mockResolvedValue({ mode: 'not-repo' }),
        listWorktrees: vi.fn().mockResolvedValue({ items: [] }),
      },
      workspaceState: {
        record: vi.fn(),
      },
    }
    if (overrides) {
      // 浅合并 ports 子对象（测试覆盖个别方法；launchConfig 为 U2b 扩展端口，运行时随合并带入）
      if (overrides.ports) {
        deps.ports = { ...deps.ports, ...overrides.ports } as NewTaskFlowDeps['ports']
      }
      if (overrides.gitApi) deps.gitApi = { ...deps.gitApi, ...overrides.gitApi }
      if (overrides.directoryPicker) deps.directoryPicker = { ...deps.directoryPicker, ...overrides.directoryPicker }
      if (overrides.workspaceApi) deps.workspaceApi = { ...deps.workspaceApi, ...overrides.workspaceApi }
      if (overrides.workspaceState) deps.workspaceState = { ...deps.workspaceState, ...overrides.workspaceState }
    }
    return deps
  }

  // ── launch-config fixture（对齐 launch-config.test.ts 同款形态）─────────

  function makePreset(p: Partial<PiLaunchPreset> = {}): PiLaunchPreset {
    return {
      id: 'custom-1',
      name: 'Custom',
      builtin: false,
      order: 10,
      toolMode: 'all',
      extensionMode: 'all',
      ...p,
    }
  }

  function makeProvider(p: Partial<ProviderInfo> = {}): ProviderInfo {
    return {
      id: 'prov-a' as ProviderId,
      name: 'Provider A',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      models: [{ id: 'model-x', supportedLevels: ['off', 'low', 'high'] }],
      ...p,
    }
  }

  /** 微任务排空（P5② 窗口断言：ensureReady 未完成时 create 不发生） */
  async function flushMicrotasks(times = 8): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve()
  }

  const textSeg = (text: string): Segment => ({ type: 'text', text })

  const imageSeg = (path: string, needsMigrate = true): Segment => ({
    type: 'image',
    id: `img-${path}`,
    path,
    fileName: 'a.png',
    displayName: 'a.png',
    needsMigrate,
  })

  const mockSession = {
    id: 's1',
    cwd: '/tmp/x',
    modelId: 'provider/model',
    label: 'hello',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as SessionSummary

  /** 进 landing（startFlow 是主链路前置） */
  async function enterLanding(flow: ReturnType<typeof useNewTaskFlow>): Promise<void> {
    await flow.startFlow()
  }

  describe('useNewTaskFlow', () => {
    beforeEach(() => {
      resetNewTaskFlow()
      // orphan 草稿槽隔离（后台投递失败保稿会写槽，防跨用例残留）
      __resetOrphanedDraftForTesting()
      // KV 单例隔离：submit 路径 ensureLaunchDataReady 会触发 loadOnce（node 环境
      // platform 未注入 → E1/E4 收敛到 loaded），reset 防跨用例状态泄漏
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
    })

    it('TC-4: startFlow 不变量——landing 态 activeId 清空 + panel 解绑 + presetCwd 回灌', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await flow.startFlow('preset-cwd')

      expect(deps.ports.navigation.clearActiveSession).toHaveBeenCalled()
      expect(deps.ports.navigation.loadPanel).toHaveBeenCalledWith('p1', null)
      expect(useNewTaskFlowState().pendingCwd.value).toBe('preset-cwd')
      expect(useNewTaskFlowState().currentSession.value).toBeNull()
      expect(useNewTaskFlowState().state.value).toBe('landing')
    })

    it('TC-4b: startFlow 幂等——landing 再 startFlow 不抛、不重复翻 state', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await flow.startFlow()
      const clearCalls = (deps.ports.navigation.clearActiveSession as ReturnType<typeof vi.fn>).mock.calls.length
      await flow.startFlow() // landing→landing 非法，幂等分支不 transition
      expect(useNewTaskFlowState().state.value).toBe('landing')
      expect((deps.ports.navigation.clearActiveSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(clearCalls + 1)
    })

    it('TC-4c: startFlow completed 终态重建（transitionUnchecked 回 idle 再进 landing）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // 直接置 completed（模拟已提交过）
      ;(useNewTaskFlowState().state as { value: string }).value = 'completed'
      await flow.startFlow()
      expect(useNewTaskFlowState().state.value).toBe('landing')
    })

    it('TC-5: submit 在数据源就绪后 create 入参 = 加载后 resolve 输出（P5② 窗口语义）+ C-W4-3 已删不补 apply', async () => {
      // 门闩：ensureReady 完成前 preset store 是占位空表（默认预设不可解析），完成后注入
      // 终值数据——若 submit 未 await 就 resolve，create 入参会固化加载前占位解析值
      let openGate!: () => void
      const gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      let presetsLoaded = false
      // 占位/终值两态数据：加载后默认预设 p-default 生效（modelOverride 压过 lastUsed 档）
      const loadedInput = (): LaunchConfigInput => ({
        presets: presetsLoaded
          ? [makePreset({ id: 'p-default', name: '默认预设', modelOverride: 'prov-a/model-preset' })]
          : [],
        defaultPresetId: 'p-default',
        lastUsedModel: 'prov-a/model-x',
        providers: [makeProvider()],
      })
      const deps = makeDeps({
        ports: {
          launchConfig: {
            getInput: () => loadedInput(),
            ensureReady: () => gate.then(() => {
              presetsLoaded = true
            }),
          },
        },
      })
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const migratedSegments = [textSeg('hello')]
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments,
      })

      const pending = flow.submitFirstMessage([textSeg('hello')], 'high')
      // P5② 窗口断言：ensureReady 未完成 → create 不发生（加载窗口内的占位值不固化进新 session）
      await flushMicrotasks()
      expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled()
      openGate()
      // 三态返回：正常交接 = 'handed-over'
      await expect(pending).resolves.toBe('handed-over')

      // 等价断言本体：create 入参 = 加载后 resolve 输出（同一 resolveLaunchConfig 计算期望值）
      const expected = resolveLaunchConfig({
        ...loadedInput(),
        pendingModel: null,
        pendingPreset: null,
        pendingCwd: null,
        pendingThinkingLevel: 'high',
      })
      // 加载后数据真正生效（防断言空转：非出厂默认预设透传 = D3，preset 模型压过 lastUsed = D2）
      expect(expected.presetId).toBe('p-default')
      expect(expected.model).toBe('prov-a/model-preset')
      expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
        cwd: null,
        presetId: expected.presetId ?? null,
        pendingModel: expected.model || null,
        segments: [textSeg('hello')],
        bashCommand: null,
        pendingThinkingLevel: expected.thinkingLevel,
        clientUuid: expect.any(String),
        projectId: null,
      })
      // 主链路不变：载入 panel + activeId + 导航 + 文件树 + send(migratedSegments) + completed
      expect(deps.ports.navigation.setActiveSession).toHaveBeenCalledWith('s1')
      expect(deps.ports.navigation.loadPanel).toHaveBeenCalledWith('p1', 's1')
      expect(deps.ports.navigation.pushChat).toHaveBeenCalledWith('s1')
      expect(deps.ports.fileTree.loadTree).toHaveBeenCalledWith('s1')
      expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', migratedSegments)
      expect(deps.ports.chat.sendBash).not.toHaveBeenCalled()
      expect(useNewTaskFlowState().state.value).toBe('completed')
    })

    it('TC-5b: launchConfig 端口未注入 → 回落 core 单例基座（preset 档不可达，explicit 档仍生效）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments: [textSeg('hello')],
      })

      // 不传 thinkingLevel（无 authored 档）：resolve 落最高可用档兜底
      await flow.submitFirstMessage([textSeg('hello')])

      // 无壳数据源：无 explicit / 无 preset / KV 空（beforeEach reset）→ model 全链空 '' 不上线
      // （null → wire undefined → runtime 全局默认），thinking 落最高可用档（无能力表归一默认五档 → high）
      expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
        cwd: null,
        presetId: null,
        pendingModel: null,
        segments: [textSeg('hello')],
        bashCommand: null,
        pendingThinkingLevel: 'high',
        clientUuid: expect.any(String),
        projectId: null,
      })
    })

    it('TC-5c: ensureReady reject → E1/E4 收敛不阻塞发送（create 仍执行）', async () => {
      const deps = makeDeps({
        ports: {
          launchConfig: {
            getInput: () => ({}),
            ensureReady: () => Promise.reject(new Error('preset rpc down')),
          },
        },
      })
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments: [textSeg('hello')],
      })

      // 加载失败回落默认继续（不 reject 不阻塞发送）
      await flow.submitFirstMessage([textSeg('hello')])
      expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledTimes(1)
      expect(deps.ports.chat.send).toHaveBeenCalledTimes(1)
    })

    it('TC-6a: bash 分支——bashCommand 传入走 sendBash + createSessionFlow 收 bashCommand', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const migratedSegments = [textSeg('')]
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments,
      })

      await flow.submitFirstMessage([textSeg('ls')], undefined, { command: 'ls', excludeFromContext: true })

      // thinkingLevel 未传（无 authored 档）→ D5 恒传 resolve 终值：落最高可用档（无数据源归一
      // 默认五档 → high），不再透传 null（快照化后 create 即带正确等级）
      expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
        cwd: null,
        presetId: null,
        pendingModel: null,
        segments: [textSeg('ls')],
        bashCommand: { command: 'ls', excludeFromContext: true },
        pendingThinkingLevel: 'high',
        clientUuid: expect.any(String),
        projectId: null,
      })
      expect(deps.ports.chat.sendBash).toHaveBeenCalledWith('s1', 'ls', true)
      expect(deps.ports.chat.send).not.toHaveBeenCalled()
    })

    it('TC-6b: createSessionFlow 返回 null（空 content guard）→ abort send', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      await flow.submitFirstMessage([textSeg('hello')])

      expect(deps.ports.chat.send).not.toHaveBeenCalled()
      expect(useNewTaskFlowState().state.value).toBe('landing') // 不变
    })

    it('TC-6c: 非 landing 态 submitFirstMessage 抛错', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      // 未进 landing（state=idle）
      await expect(flow.submitFirstMessage([textSeg('hello')])).rejects.toThrow('非 landing 态')
    })

    it('TC-6d: createInFlight 检查——飞行中重复 submitFirstMessage 幂等返回（端口零调用）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // 模拟飞行中：直接经 controller setCreateInFlight(true)（模块级 ref）
      useNewTaskFlowController_setCreateInFlight(true)

      await flow.submitFirstMessage([textSeg('hello')])

      expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled()
      expect(deps.ports.chat.send).not.toHaveBeenCalled()
      useNewTaskFlowController_setCreateInFlight(false)
    })

    it('TC-6e: send reject → 交接点已定格 completed + createInFlight 清理（D3 交接原子化探针）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments: [textSeg('hello')],
      })
      // 探针（设计 §3.3 D3）：真实 useChat.send 内部吞错（W2 策略，不 throw），
      // mock 层面直接返回 rejected promise 锁定语义——flow 终态与 send 成败解耦，
      // 交接（setActiveSession + loadPanel + pushChat）完成即 completed，send 链路
      // 未来任何演化（恢复 throw、新增前置抛错点）都不影响 flow 终态
      ;(deps.ports.chat.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('send failed'))

      // submitFirstMessage 对 send 的 await 未吞错，reject 向上抛
      await expect(flow.submitFirstMessage([textSeg('hello')])).rejects.toThrow('send failed')

      // 交接已完成且 transition('completed') 在 send 之前执行（若仍在 send 后，
      // send reject 会让 state 卡 landing——此断言即探针本体）
      expect(deps.ports.navigation.setActiveSession).toHaveBeenCalledWith('s1')
      expect(deps.ports.navigation.pushChat).toHaveBeenCalledWith('s1')
      expect(deps.ports.chat.send).toHaveBeenCalledTimes(1)
      expect(useNewTaskFlowState().state.value).toBe('completed')
      // finally 语义：异常路径 createInFlight 也必须清理
      expect(flow.isInflight.value).toBe(false)
    })

    it('TC-6f [robustness P0/③a] create 飞行中被取消（侧栏切走）→ 后台投递：消息照发、不碰视图、不碰状态机', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // 门闩：让 create 在途可控（模拟 warm 1.6s / cold 4.4s 飞行窗口）
      let openCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        openCreate = resolve
      })
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await createGate
        return { session: mockSession, migratedSegments: [textSeg('hello')] }
      })

      const pending = flow.submitFirstMessage([textSeg('hello')])
      await flushMicrotasks()
      // 竞态步：create 飞行中用户点侧栏切 session（selectSession → cancelActiveFlow →
      // transition('cancelled')，landing→cancelled 合法；随后 Landing 卸载，D4 检查查 isActive 为 noop）
      flow.cancelFlow()
      expect(useNewTaskFlowState().state.value).toBe('cancelled')
      openCreate()
      // 原缺陷：此处 throw「非法状态转换: cancelled → completed」（cancelled→completed 不在 ALLOWED）
      // → 外层 catch 误报「任务创建失败」+ restore 写死实例丢输入 + 视图已被 setActiveSession 强切
      // 三态返回：后台投递 = 'background'
      await expect(pending).resolves.toBe('background')

      // 消息照发进新建 session（不丢用户输入）
      expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', [textSeg('hello')])
      // 不碰视图：setActiveSession/pushChat 零调用；loadPanel 仅剩 startFlow 进 landing 时的
      // 解绑调用（('p1', null)），不得出现 handover 的 ('p1', 's1')（不强切用户正在看的 session）
      expect(deps.ports.navigation.setActiveSession).not.toHaveBeenCalled()
      expect(deps.ports.navigation.loadPanel).not.toHaveBeenCalledWith('p1', 's1')
      expect(deps.ports.navigation.pushChat).not.toHaveBeenCalled()
      // 文件树预取照常（只暖缓存，用户点开新 session 即见首问 + 回复）
      expect(deps.ports.fileTree.loadTree).toHaveBeenCalledWith('s1')
      // 状态机零非法转换：state 保持 cancelled（未 completed、未被非法转换重置 idle）
      expect(useNewTaskFlowState().state.value).toBe('cancelled')
      // D6：create 期绑定被清（防后续 landing 提交误走 retry 分支把新消息发进旧 session）
      expect(flow.currentSessionId.value).toBeNull()
      // [F12 可发现性] 后台投递成功 → info toast（用户切走了但消息去了新 session，不再静默）
      expect(deps.ports.toast.info).toHaveBeenCalledWith('newTask.backgroundDelivered')
      // 成功不保稿（消息已投递，take 槽为空——非 orphan 场景）
      expect(takeOrphanedDraft()).toBeNull()
      // finally：createInFlight 清理（过渡视图消失）
      expect(flow.isInflight.value).toBe(false)
    })

    it('TC-6g [robustness P0/③a] bash 首发竞态 → 后台 sendBash（参数逐位一致），send 不调', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      let openCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        openCreate = resolve
      })
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await createGate
        return { session: mockSession, migratedSegments: [] }
      })

      const pending = flow.submitFirstMessage([textSeg('!ls -la')], undefined, {
        command: 'ls -la',
        excludeFromContext: true,
      })
      await flushMicrotasks()
      flow.cancelFlow()
      openCreate()
      await expect(pending).resolves.toBe('background')

      // bash 后台投递参数与 handoverAndSend 完全一致（deliver 单源，无双实现漂移）
      expect(deps.ports.chat.sendBash).toHaveBeenCalledWith('s1', 'ls -la', true)
      expect(deps.ports.chat.send).not.toHaveBeenCalled()
      expect(deps.ports.navigation.setActiveSession).not.toHaveBeenCalled()
    })

    it('TC-6h [robustness P0/③a] retry 分支同竞态（迁移 await 中被取消）→ 后台投递，不重复 create', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // 绑定已有 session（重试/预建场景）
      bindSession(mockSession)
      let openMigrate!: () => void
      const migrateGate = new Promise<void>((resolve) => {
        openMigrate = resolve
      })
      ;(deps.ports.migrateImage.migrateImage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await migrateGate
        return { path: '/attachments/s1/a.png' }
      })

      const pending = flow.submitFirstMessage([imageSeg('/tmp/a.png', true)])
      await flushMicrotasks()
      flow.cancelFlow()
      openMigrate()
      await expect(pending).resolves.toBe('background')

      expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled()
      // 后台投递用迁移后的段（与 handover 同源）
      expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', [
        expect.objectContaining({ type: 'image', path: '/attachments/s1/a.png', needsMigrate: false }),
      ])
      expect(deps.ports.navigation.setActiveSession).not.toHaveBeenCalled()
      expect(flow.currentSessionId.value).toBeNull()
    })

    it('TC-6i [robustness P0] create reject → 异常上抛 + createInFlight 复位 + state 停留 landing（可重试）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('create failed'))

      await expect(flow.submitFirstMessage([textSeg('hello')])).rejects.toThrow('create failed')

      // 回滚清单断言：在途标志复位（过渡视图消失）、flow 停留 landing（可直接重试）、绑定未写入、视图零切换
      expect(flow.isInflight.value).toBe(false)
      expect(useNewTaskFlowState().state.value).toBe('landing')
      expect(flow.currentSessionId.value).toBeNull()
      expect(deps.ports.navigation.setActiveSession).not.toHaveBeenCalled()
    })

    it('TC-7: retry 分支——session 已绑定走 migrateImage 迁移 + 部分失败 toast 不阻断', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // 绑定已有 session（重试场景）——经真实 controller 写模块级 ref（currentSession 只读视图不可直写）
      bindSession(mockSession)
      const imgSeg = imageSeg('/tmp/a.png', true)
      // 迁移成功 1 个
      ;(deps.ports.migrateImage.migrateImage as ReturnType<typeof vi.fn>).mockResolvedValue({ path: '/attachments/s1/a.png' })

      await flow.submitFirstMessage([imgSeg])

      expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled() // 不重复 create
      expect(deps.ports.migrateImage.migrateImage).toHaveBeenCalledWith({
        fromPath: '/tmp/a.png',
        sessionId: 's1',
        fileName: 'a.png',
      })
      // send 用迁移后的段（path 更新 + needsMigrate=false）
      expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', [
        expect.objectContaining({ type: 'image', path: '/attachments/s1/a.png', needsMigrate: false }),
      ])
      // 全部迁移成功 → 无 warning toast
      expect(deps.ports.toast.warning).not.toHaveBeenCalled()
    })

    it('TC-7b: retry 分支部分迁移失败 → toastWarning + send 仍执行', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      bindSession(mockSession)
      const imgA = imageSeg('/tmp/a.png', true)
      const imgB = imageSeg('/tmp/b.png', true)
      // a 成功、b 失败
      ;(deps.ports.migrateImage.migrateImage as ReturnType<typeof vi.fn>).mockImplementation((p: { fromPath: string }) =>
        p.fromPath === '/tmp/a.png' ? Promise.resolve({ path: '/attachments/s1/a.png' }) : Promise.reject(new Error('gone')),
      )

      await flow.submitFirstMessage([imgA, imgB])

      // t 收到 key + count 参数（i18n 解析在壳侧，mock 直接返回 key）
      expect(deps.ports.t).toHaveBeenCalledWith('composable.imageMigratePartialFailed', { count: 1 })
      expect(deps.ports.toast.warning).toHaveBeenCalledTimes(1)
      // send 仍执行（b 段 path 保留原样）
      expect(deps.ports.chat.send).toHaveBeenCalledTimes(1)
    })

    it('TC-8: closeOverlay 幂等——landing 态 noop 不抛、overlay 态归 landing', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // landing 态 closeOverlay → noop（不抛、state 不变）
      flow.closeOverlay()
      expect(useNewTaskFlowState().state.value).toBe('landing')
      // overlay 态 closeOverlay → 归 landing
      flow.openDirPopover()
      expect(useNewTaskFlowState().state.value).toBe('dir-popover')
      flow.closeOverlay()
      expect(useNewTaskFlowState().state.value).toBe('landing')
    })

    it('TC-8b: 薄转换封装——cancelFlow/reenterFlow/completeFlow', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      flow.cancelFlow()
      expect(useNewTaskFlowState().state.value).toBe('cancelled')
      flow.reenterFlow()
      expect(useNewTaskFlowState().state.value).toBe('landing')
      flow.completeFlow()
      expect(useNewTaskFlowState().state.value).toBe('completed')
    })

    it('presetCwd/setPendingModel/setPendingPreset——仅 landing 态生效', async () => {
      const deps = makeDeps({
        ports: {
          // preset 数据经 launchConfig 端口注入（D1）：显式选定的 preset-1 需在列表内可解析才透传
          launchConfig: {
            getInput: () => ({ presets: [makePreset({ id: 'preset-1' })] }),
            ensureReady: async () => {},
          },
        },
      })
      const flow = useNewTaskFlow(deps)
      // 非 landing（idle）→ noop
      flow.setPendingModel('p/m')
      expect(useNewTaskFlowState().pendingModel.value).toBeNull()
      await enterLanding(flow)
      flow.presetCwd('/preset')
      expect(useNewTaskFlowState().pendingCwd.value).toBe('/preset')
      flow.setPendingModel('p/m')
      expect(useNewTaskFlowState().pendingModel.value).toBe('p/m')
      flow.setPendingPreset('preset-1')
      // 通过 submitFirstMessage 的 createSessionFlow input 验证 resolve 终值透传
      // （pendingModel/pendingPreset 作 explicit 输入 → resolve 输出原样透传）
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments: [textSeg('hello')],
      })
      await flow.submitFirstMessage([textSeg('hello')])
      expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ presetId: 'preset-1', cwd: '/preset', pendingModel: 'p/m' }),
      )
    })

    it('preset-popover 打开时 setPendingPreset 成功写入——模式选择在 overlay 内完成，不阻断透传', async () => {
      // [HISTORICAL] 缺陷回归：用户在 landing 点 PresetSelectChip 展开模式 popover（state 进
      // preset-popover），再点列表项时检查 `state !== 'landing'` 把真实选择静默丢弃——
      // pendingPreset 恒 null → chip 文案不回显（props.modeName 源自 pendingPreset）、
      // 建出的 session launchPresetId=undefined。本用例复现「点击时的真实态 = preset-popover」。
      const deps = makeDeps({
        ports: {
          launchConfig: {
            getInput: () => ({ presets: [makePreset({ id: 'builtin:session-dispatch' })] }),
            ensureReady: async () => {},
          },
        },
      })
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // 点 chip 展开模式 popover（openPresetPopover 是 Landing 的 isPresetOpen setter 调用点）
      flow.openPresetPopover()
      expect(useNewTaskFlowState().state.value).toBe('preset-popover')
      // 用户点列表项 → Landing.onPresetSelect → setPendingPreset（此时 state 是 preset-popover）
      flow.setPendingPreset('builtin:session-dispatch')
      // 修复前：pendingPreset 恒 null（chip 显示 / submit 透传双链断裂）
      expect(flow.pendingPreset.value).toBe('builtin:session-dispatch')
      // 关闭 popover 回 landing（用户点空白/Esc 关）后提交：透传所选模式（显示 ≡ 生效）
      flow.closeOverlay()
      expect(useNewTaskFlowState().state.value).toBe('landing')
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments: [textSeg('hello')],
      })
      await flow.submitFirstMessage([textSeg('hello')])
      expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ presetId: 'builtin:session-dispatch' }),
      )
    })
  })

  // ── 归属项目选择（ProjectSelectChip 数据链，2026-10-22）──────────────────────

  describe('useNewTaskFlow 归属项目选择（setPendingProject / openProjectPopover）', () => {
    beforeEach(() => {
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
      __resetOrphanedDraftForTesting()
    })

    it('setPendingProject 态检查：idle noop；landing 写入 pendingProjectId（只读视图回读一致）', async () => {
      const flow = useNewTaskFlow(makeDeps())
      // idle（startFlow 前）非 landing/project-popover → noop
      flow.setPendingProject('proj-a')
      expect(useNewTaskFlowState().pendingProjectId.value).toBeNull()
      await enterLanding(flow)
      flow.setPendingProject('proj-a')
      expect(flow.pendingProjectId.value).toBe('proj-a')
    })

    it('openProjectPopover → state 进 project-popover；overlay 内写入放行（点列表项时的真实态）', async () => {
      const flow = useNewTaskFlow(makeDeps())
      await enterLanding(flow)
      flow.openProjectPopover()
      expect(useNewTaskFlowState().state.value).toBe('project-popover')
      // 用户点列表项 → Landing.onProjectSelect → setPendingProject（此时 state 是 project-popover）
      flow.setPendingProject('proj-b')
      expect(flow.pendingProjectId.value).toBe('proj-b')
      // 关闭回 landing（用户点空白/Esc 关）后显式选择保持（chip 回显与 submit 同源）
      flow.closeOverlay()
      expect(useNewTaskFlowState().state.value).toBe('landing')
      expect(flow.pendingProjectId.value).toBe('proj-b')
    })
  })

  // ── 对抗审查修复回归（E 取消语义 / A 消费侧保稿 / B uuid 黏滞 / G 检查顺序） ──

  describe('useNewTaskFlow [E/B/A/G] 对抗审查修复', () => {
    beforeEach(() => {
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
      __resetOrphanedDraftForTesting()
    })

    /** 门闩 create（在途可控，模拟 warm 1.6s / cold 4.4s 飞行窗口） */
    function gateCreate(deps: NewTaskFlowDeps): () => void {
      let openCreate!: () => void
      const gate = new Promise<void>((resolve) => {
        openCreate = resolve
      })
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await gate
        return { session: mockSession, migratedSegments: [textSeg('hello')] }
      })
      return openCreate
    }

    it('E-1: 创建中取消（abandonSubmit）→ 不投递 + 删已建 session + 静默 abandoned（无误报）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const openCreate = gateCreate(deps)

      const pending = flow.submitFirstMessage([textSeg('hello')])
      await flushMicrotasks()
      flow.abandonSubmit() // 过渡视图「取消」按钮
      openCreate()

      // 三态返回：主动取消 = 'abandoned'（调用方归还草稿）
      await expect(pending).resolves.toBe('abandoned')
      // 不投递（消息不进幽灵 session）
      expect(deps.ports.chat.send).not.toHaveBeenCalled()
      expect(deps.ports.chat.sendBash).not.toHaveBeenCalled()
      // 删已建 session（best-effort 清理，防幽灵任务烧 token）
      expect(deps.ports.session?.remove).toHaveBeenCalledWith('s1')
      // 无误报（用户主动取消，「创建失败」是误导）
      expect(deps.ports.toast.error).not.toHaveBeenCalled()
      expect(deps.ports.toast.warning).not.toHaveBeenCalled()
      // 清绑定 + 不碰视图 + 状态机不动（创建中 state 仍是 landing）
      expect(flow.currentSessionId.value).toBeNull()
      expect(deps.ports.navigation.setActiveSession).not.toHaveBeenCalled()
      expect(deps.ports.navigation.pushChat).not.toHaveBeenCalled()
      expect(useNewTaskFlowState().state.value).toBe('landing')
      // finally：createInFlight 清理（过渡视图结束）
      expect(flow.isInflight.value).toBe(false)
    })

    it('E-2: abandoned 时 create 失败（throw）→ 静默 abandoned（不误报「创建失败」，无 session 可删）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      let openCreate!: () => void
      const gate = new Promise<void>((resolve) => {
        openCreate = resolve
      })
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await gate
        throw new Error('create failed')
      })

      const pending = flow.submitFirstMessage([textSeg('hello')])
      await flushMicrotasks()
      flow.abandonSubmit()
      openCreate()

      // throw 路径静默化：不 reject、不报错 toast（主动取消不误报）
      await expect(pending).resolves.toBe('abandoned')
      expect(deps.ports.toast.error).not.toHaveBeenCalled()
      // 未建 session 无从删（不误调 remove）
      expect(deps.ports.session?.remove).not.toHaveBeenCalled()
      expect(flow.isInflight.value).toBe(false)
    })

    it('A: 后台投递 send 返 false（未投递）→ 草稿保底暂存（takeOrphanedDraft 有段）+ 仍返 background + 无 info 误报', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const openCreate = gateCreate(deps)
      ;(deps.ports.chat.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

      const pending = flow.submitFirstMessage([textSeg('hello')])
      await flushMicrotasks()
      flow.cancelFlow() // 创建中切走（后台投递分支）
      openCreate()

      await expect(pending).resolves.toBe('background')
      // [A 消费侧] send false = 未进入任何可自动投递通道 → orphan 槽保稿（下次 landing 挂载取回）
      expect(takeOrphanedDraft()).toEqual([textSeg('hello')])
      // 失败时不发「已发送到新任务」info（消息并未去到新 session，误导；失败侧由 chat 错误通道 toast）
      expect(deps.ports.toast.info).not.toHaveBeenCalled()
    })

    it('B-1: clientUuid 黏滞——create 失败后同段重试复用同一 uuid（runtime 幂等防重复建号）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const createMock = deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>
      createMock
        .mockRejectedValueOnce(new Error('65s timeout'))
        .mockResolvedValueOnce({ session: mockSession, migratedSegments: [textSeg('hello')] })

      await expect(flow.submitFirstMessage([textSeg('hello')])).rejects.toThrow('65s timeout')
      await expect(flow.submitFirstMessage([textSeg('hello')])).resolves.toBe('handed-over')

      const uuid1 = (createMock.mock.calls[0]![0] as CreateSessionFlowInput).clientUuid
      const uuid2 = (createMock.mock.calls[1]![0] as CreateSessionFlowInput).clientUuid
      expect(uuid1).toEqual(expect.any(String))
      expect(uuid2).toBe(uuid1)
    })

    it('B-2: clientUuid 黏滞——换段重试换新 uuid（不同用户意图不串号）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const createMock = deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>
      createMock
        .mockRejectedValueOnce(new Error('65s timeout'))
        .mockResolvedValueOnce({ session: mockSession, migratedSegments: [textSeg('b')] })

      await expect(flow.submitFirstMessage([textSeg('a')])).rejects.toThrow('65s timeout')
      await expect(flow.submitFirstMessage([textSeg('b')])).resolves.toBe('handed-over')

      const uuid1 = (createMock.mock.calls[0]![0] as CreateSessionFlowInput).clientUuid
      const uuid2 = (createMock.mock.calls[1]![0] as CreateSessionFlowInput).clientUuid
      expect(uuid1).toEqual(expect.any(String))
      expect(uuid2).toEqual(expect.any(String))
      expect(uuid2).not.toBe(uuid1)
    })

    it('B-3: clientUuid 黏滞——成功后清槽（同段再提交属新意图，换新 uuid）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const createMock = deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>
      createMock.mockResolvedValue({ session: mockSession, migratedSegments: [textSeg('hello')] })

      // 第一次：创建中切走 → 后台投递成功（background = 成功，清槽）
      const openCreate = gateCreate(deps)
      const pending = flow.submitFirstMessage([textSeg('hello')])
      await flushMicrotasks()
      flow.cancelFlow()
      openCreate()
      await expect(pending).resolves.toBe('background')

      // 同段再次提交（复活 landing 后重发同样内容）：槽已清 → 新 uuid（不撞 runtime 幂等表）
      flow.reenterFlow()
      await expect(flow.submitFirstMessage([textSeg('hello')])).resolves.toBe('handed-over')

      const uuid1 = (createMock.mock.calls[0]![0] as CreateSessionFlowInput).clientUuid
      const uuid2 = (createMock.mock.calls[1]![0] as CreateSessionFlowInput).clientUuid
      expect(uuid1).toEqual(expect.any(String))
      expect(uuid2).toEqual(expect.any(String))
      expect(uuid2).not.toBe(uuid1)
    })

    it('G: startFlow 检查顺序——completed + createInFlight（⌘N 撞 deliver 窗口）零副作用', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      // handover 后 deliver 窗口：state 已 completed、绑定仍在，而 createInFlight 仍 true
      flow.completeFlow()
      bindSession(mockSession)
      expect(useNewTaskFlowState().state.value).toBe('completed')
      useNewTaskFlowController_setCreateInFlight(true)
      ;(deps.ports.navigation.clearActiveSession as ReturnType<typeof vi.fn>).mockClear()
      ;(deps.ports.navigation.loadPanel as ReturnType<typeof vi.fn>).mockClear()

      await flow.startFlow()

      // 检查前置后：不先改 state/bind 再早退——completed 不被销毁重建，导航零调用
      expect(useNewTaskFlowState().state.value).toBe('completed')
      expect(deps.ports.navigation.clearActiveSession).not.toHaveBeenCalled()
      expect(deps.ports.navigation.loadPanel).not.toHaveBeenCalled()
      expect(useNewTaskFlowState().currentSession.value).not.toBeNull() // 绑定未被清
      useNewTaskFlowController_setCreateInFlight(false)
    })
  })

  // ── branch-review round-1（G1）回归：交接投递失败保稿 / 黏滞槽与 hash 口径对齐 / abandon 收尾删除 ──

  describe('useNewTaskFlow branch-review r1（G1）修复回归', () => {
    beforeEach(() => {
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
      __resetOrphanedDraftForTesting()
    })

    it('R1-1: handed-over 投递 false → 保稿（orphan 槽）+ 不发 info 误报', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments: [textSeg('hello')],
      })
      ;(deps.ports.chat.send as ReturnType<typeof vi.fn>).mockResolvedValue(false)

      await expect(flow.submitFirstMessage([textSeg('hello')])).resolves.toBe('handed-over')

      // 修复前：handover 分支丢弃 deliver() 返回值 → 视图已交接、草稿无处归还 = 用户内容彻底丢失
      expect(takeOrphanedDraft()).toEqual([textSeg('hello')])
      expect(deps.ports.toast.info).not.toHaveBeenCalled()
      expect(useNewTaskFlowState().state.value).toBe('completed')
    })

    it('R1-3: 后台投递 false → 黏滞槽保留 + 迁移后段重发复用同一 clientUuid（hash 口径对齐保稿段）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      const createMock = deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>
      // 迁移后段：image 段 path 已被 migrateImageSegments 改写（move 进 attachments/<sid>/）+ needsMigrate 重置
      const migrated = [textSeg('hello'), imageSeg('/attachments/s1/a.png', false)]
      let openCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        openCreate = resolve
      })
      createMock.mockImplementation(async () => {
        await createGate
        return { session: mockSession, migratedSegments: migrated }
      })
      ;(deps.ports.chat.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

      const pending = flow.submitFirstMessage([textSeg('hello'), imageSeg('/tmp/a.png', true)])
      await flushMicrotasks()
      flow.cancelFlow() // 创建中切走 → 后台投递分支
      openCreate()
      await expect(pending).resolves.toBe('background')

      // 保稿存迁移后段（原始段的 tmpdir 文件已被 move 走，存原始段会还原出失效路径）
      const stashed = takeOrphanedDraft() ?? []
      expect(stashed).toEqual(migrated)

      // 同段重发（取回的保稿段）须复用同一 clientUuid——修复前 ①!delivered 也清黏滞槽
      // ②hash 记迁移前段、含图重发结构性不匹配，任一存在即换新 uuid → api.create 重复建
      // session、已建 session 空壳残留
      flow.reenterFlow()
      await expect(flow.submitFirstMessage(stashed)).resolves.toBe('handed-over')
      const uuid1 = (createMock.mock.calls[0]![0] as CreateSessionFlowInput).clientUuid
      const uuid2 = (createMock.mock.calls[1]![0] as CreateSessionFlowInput).clientUuid
      expect(uuid1).toEqual(expect.any(String))
      expect(uuid2).toBe(uuid1)
    })

    it('R1-6: handover 中抛错且已放弃 → catch 收尾删除已建 session + 清绑定（与 try 内分支同款）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        session: mockSession,
        migratedSegments: [textSeg('hello')],
      })
      let openSend!: () => void
      const sendGate = new Promise<void>((resolve) => {
        openSend = resolve
      })
      ;(deps.ports.chat.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await sendGate
        throw new Error('deliver failed')
      })

      const pending = flow.submitFirstMessage([textSeg('hello')])
      // 等交接投递真正启动（send 被调 = 已越过 try 内前置 abandoned 检查，取消落在 catch 分支）
      while ((deps.ports.chat.send as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
        await Promise.resolve()
      }
      flow.abandonSubmit() // 过渡视图「取消」按钮（投递在途）
      openSend()

      await expect(pending).resolves.toBe('abandoned')
      // 修复前：catch abandoned 分支只清槽返回 → 已建 session 残留侧栏（与 try 内前置分支不一致）
      expect(deps.ports.session?.remove).toHaveBeenCalledWith('s1')
      expect(flow.currentSessionId.value).toBeNull()
      // 主动取消不误报「创建失败」（静默语义不变）
      expect(deps.ports.toast.error).not.toHaveBeenCalled()
      expect(flow.isInflight.value).toBe(false)
    })

    it('R1-6b: 取消收尾删除失败 → 用户可见 warning toast（不阻断取消主语义）', async () => {
      const deps = makeDeps()
      const flow = useNewTaskFlow(deps)
      await enterLanding(flow)
      let openCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        openCreate = resolve
      })
      ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await createGate
        return { session: mockSession, migratedSegments: [textSeg('hello')] }
      })
      ;(deps.ports.session?.remove as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('remove rpc down'))

      const pending = flow.submitFirstMessage([textSeg('hello')])
      await flushMicrotasks()
      flow.abandonSubmit()
      openCreate()

      await expect(pending).resolves.toBe('abandoned')
      // 修复前：删除失败仅 console.warn → 侧栏残留「已取消」的多余 session 且无任何用户可见提示
      expect(deps.ports.toast.warning).toHaveBeenCalledWith('newTask.abandonCleanupFailed')
      expect(deps.ports.toast.error).not.toHaveBeenCalled()
    })
  })

  function useNewTaskFlowController_setCreateInFlight(v: boolean): void {
    useNewTaskFlowController().setCreateInFlight(v)
  }

  /** 测试辅助：绑定 session（真实 controller 写模块级 ref） */
  function bindSession(s: SessionSummary): void {
    useNewTaskFlowController().bindCurrentSession(s)
  }
});

// ======== 来源：launch-config-equivalence.test.ts ========
describe("launch-config-equivalence", () => {
  // ── KV / 平台基建（同 launch-config.test.ts / model-thinking.test.ts 形态）─────────

  /** 平面 KV stub：两 KV 单例的写穿落点（避免无 platform 时 E2 warn 噪音） */
  class MemKV implements KVStorage {
    private map = new Map<string, string>()
    async get(key: string): Promise<string | null> {
      return this.map.get(key) ?? null
    }
    async set(key: string, value: string): Promise<void> {
      this.map.set(key, value)
    }
    async remove(key: string): Promise<void> {
      this.map.delete(key)
    }
  }

  function provideMockPlatform(storage: KVStorage): void {
    const port: PlatformPort = {
      kind: 'mock',
      storage,
      webSocket: {
        create: () => {
          throw new Error('stub: WebSocketFactory 未在本测试使用')
        },
      },
    }
    providePlatform(port)
  }

  // ── fixture ───────────────────────────────────────────────────────────

  const FIVE_LEVELS = ['off', 'low', 'medium', 'high', 'max']

  /**
 * 能力表（D4 校验 + 档位解析数据源）：prov-a 三模型（lastUsed 目标 / 显式选择目标 /
 * preset override 目标），prov-default 单模型（全局默认）。
 */
  function makeProviders(): ProviderInfo[] {
    const models = (ids: string[]) => ids.map((id) => ({ id, supportedLevels: [...FIVE_LEVELS] }))
    return [
      {
        id: 'prov-a' as ProviderId,
        name: 'A',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: models(['model-x', 'model-pick', 'model-preset']),
      },
      {
        id: 'prov-default' as ProviderId,
        name: 'D',
        apiKeySet: true,
        status: 'connected',
        enabled: true,
        models: models(['model-default']),
      },
    ]
  }

  /** V4 / §2.3-③ 形态：默认预设带 modelOverride + thinkingLevel=off（压过记忆档） */
  const P_DEFAULT: PiLaunchPreset = {
    id: 'p-default',
    name: '默认预设',
    builtin: false,
    order: 10,
    toolMode: 'all',
    extensionMode: 'all',
    modelOverride: 'prov-a/model-preset',
    thinkingLevel: 'off',
  }

  /** 用户显式选定预设：无 modelOverride、thinkingLevel=low */
  const P_USER: PiLaunchPreset = {
    id: 'p-user',
    name: '用户预设',
    builtin: false,
    order: 11,
    toolMode: 'all',
    extensionMode: 'all',
    thinkingLevel: 'low',
  }

  /** 两侧消费的共同数据基座（生产形态：壳层从 preset store / settings store 注入两侧） */
  interface LaunchDb { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    presets: readonly PiLaunchPreset[]
    defaultPresetId: string | null
    providers: readonly ProviderInfo[]
    defaultModel: string | null
  }

  function makeDb(preset: 'none' | 'default' | 'explicit', defaultModel: boolean): LaunchDb {
    return {
      presets:
        preset === 'none' ? [] : preset === 'default' ? [P_DEFAULT] : [P_DEFAULT, P_USER],
      defaultPresetId: preset === 'none' ? null : 'p-default',
      providers: makeProviders(),
      defaultModel: defaultModel ? 'prov-default/model-default' : null,
    }
  }

  /** 按 'provider/modelId' 复合串查能力表条目的 supportedLevels（无条目 = undefined） */
  function supportedLevelsOf(
    modelId: string,
    providers: readonly ProviderInfo[],
  ): string[] | undefined {
    const slash = modelId.indexOf('/')
    if (slash <= 0) return undefined
    const provider = providers.find((p) => p.id === modelId.slice(0, slash))
    if (!provider || provider.enabled === false) return undefined
    return provider.models.find((m) => m.id === modelId.slice(slash + 1))?.supportedLevels
  }

  const textSeg = (text: string): Segment => ({ type: 'text', text })

  const mockSession = {
    id: 's1',
    cwd: '/tmp/x',
    modelId: 'provider/model',
    label: 'hello',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as SessionSummary

  /** 微任务排空（窗口断言：ensureReady 未完成时 create 不发生） */
  async function flushMicrotasks(times = 8): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve()
  }

  /** KV 加载落地（mt 挂载触发 loadOnce，宏任务边界后 lookup 可见） */
  async function flushKvLoads(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  // ── 等价三方 harness ──────────────────────────────────────────────────

  interface EquivalenceHarness { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    flow: ReturnType<typeof useNewTaskFlow>
    /** chip 侧真实消费方（landing 分支 launchConfigView） */
    mt: ReturnType<typeof useComposerModelThinking>
    /** preset chip 等价视图（U2c PresetSelectChip 同款接线：本地 explicitPresetId + 数据基座） */
    explicitPresetId: Ref<string | null>
    presetChipResolved: ComputedRef<LaunchConfig>
    createSession: ReturnType<typeof vi.fn>
    scope: ReturnType<typeof effectScope>
  }

  /**
 * 组装等价三方：
 * - chip 侧 = useComposerModelThinking（launchData 注入数据基座；currentModel/
 *   setPendingModel 接 flow——生产接线形态 composer-shell.ts:180-181）
 * - submit 侧 = useNewTaskFlow（ports.launchConfig 注入同一数据基座——resolve 输入
 *   经 getInput 现读，pending 三兄弟由 flow 自身覆盖）
 * - KV 双源（lastUsedModel / 记忆表）两侧同读 core 单例（launch-config 同款直接 import）
 */
  function mountHarness(
    db: LaunchDb,
    opts: {
      getInput?: () => LaunchConfigInput
      ensureReady?: () => Promise<void>
    } = {},
  ): EquivalenceHarness {
    const defaultInput = (): LaunchConfigInput => ({
      presets: db.presets,
      defaultPresetId: db.defaultPresetId,
      lastUsedModel: lookupLastUsed() ?? null,
      getRememberedThinkingLevel: (modelId) => lookupMemory(modelId),
      providers: db.providers,
      defaultModel: db.defaultModel,
      getSupportedLevels: (modelId) => supportedLevelsOf(modelId, db.providers),
    })
    const createSession = vi.fn().mockResolvedValue({
      session: mockSession,
      migratedSegments: [textSeg('hi')],
    })
    const deps: NewTaskFlowDeps = {
      ports: {
        createSessionFlow: {
          createSession,
        },
        chat: { send: vi.fn(), sendBash: vi.fn() },
        navigation: {
          activePanelId: vi.fn(() => 'p1'),
          loadPanel: vi.fn(),
          clearActiveSession: vi.fn(),
          setActiveSession: vi.fn(),
          pushChat: vi.fn(),
        },
        toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() },
        fileTree: { loadTree: vi.fn(), selectFile: vi.fn() },
        t: vi.fn((key: string) => key),
        migrateImage: { migrateImage: vi.fn() },
      },
      gitApi: { checkout: vi.fn(), checkoutByCwd: vi.fn(), createBranch: vi.fn() },
      directoryPicker: { pickDirectory: vi.fn() },
      workspaceApi: {
        detect: vi.fn().mockResolvedValue({ mode: 'not-repo' }),
        listWorktrees: vi.fn().mockResolvedValue({ items: [] }),
      },
      workspaceState: { record: vi.fn() },
    }
    const flow = useNewTaskFlow({
      ...deps,
      ports: {
        ...deps.ports,
        launchConfig: {
          getInput: opts.getInput ?? defaultInput,
          ensureReady: opts.ensureReady ?? (async () => {}),
        },
      },
    })

    const scope = effectScope()
    const explicitPresetId = ref<string | null>(null)
    const mt = scope.run(() => {
      const sessionId = ref<string | null>(null)
      const mtDeps: ModelThinkingDeps = {
        getSessionState: () => null,
        defaultModel: computed(() => db.defaultModel ?? ''),
        // 生产接线（composer-shell）：currentModel ← flow.currentModel，pendingPreset ←
        // flow.pendingPreset 只读视图，setPendingModel → flow
        currentModel: flow.currentModel,
        pendingPreset: () => flow.pendingPreset.value,
        setPendingModel: (model: string) => flow.setPendingModel(model),
        switchModel: vi.fn(),
        setThinkingLevel: vi.fn(),
        getThinkingLevelMap: () => undefined,
        getSupportedLevels: (modelId) => supportedLevelsOf(modelId, db.providers),
        launchData: {
          presets: () => db.presets,
          defaultPresetId: () => db.defaultPresetId,
          providers: () => db.providers,
        },
      }
      return useComposerModelThinking(sessionId, mtDeps)
    })!

    // preset chip 等价视图（U2c PresetSelectChip.vue:92-96 同款：本地 explicitPresetId
    // （resolve 输入）+ emit select → Landing.onPresetSelect → flow.setPendingPreset）
    const presetChipResolved = scope.run(() =>
      createLaunchConfigView(() => ({
        pendingPreset: explicitPresetId.value,
        presets: db.presets,
        defaultPresetId: db.defaultPresetId,
      })),
    )!

    return { flow, mt, explicitPresetId, presetChipResolved, createSession, scope }
  }

  /** 矩阵格执行器：真实用户路径动作（onModelSelect/onThinkingSelect/setPendingPreset）→ 读 chip → submit */
  async function runMatrixCell(cell: {
    pickModel: boolean
    authored: boolean
    lastUsed: 'none' | 'valid' | 'invalid'
    preset: 'none' | 'default' | 'explicit'
    defaultModel: boolean
  }): Promise<void> {
    const db = makeDb(cell.preset, cell.defaultModel)
    const h = mountHarness(db)
    try {
      await h.flow.startFlow()
      await flushKvLoads()
      // KV fixtures：lastUsedModel 轴（valid/invalid 均写真实 KV——D4 校验的对象是原值）
      if (cell.lastUsed === 'valid') recordLastUsed('prov-a/model-x')
      if (cell.lastUsed === 'invalid') recordLastUsed('prov-gone/model-z')
      // 记忆表 fixture：lastUsed 目标记忆 high；preset override 目标记忆 max（V4 形态——
      // preset 档 off 与记忆档 max 的发散对）
      recordMemory('prov-a/model-x', 'high')
      recordMemory('prov-a/model-preset', 'max')

      // 用户显式动作（生产路径，顺序：模型 → preset → 档位）
      if (cell.pickModel) {
        await h.mt.onModelSelect({ modelId: 'model-pick', provider: 'prov-a' as ProviderId })
      }
      if (cell.preset === 'explicit') {
        h.explicitPresetId.value = 'p-user'
        h.flow.setPendingPreset('p-user')
      }
      if (cell.authored) await h.mt.onThinkingSelect('low')
      await nextTick()

      // A：chip 显示值（读显示侧真实 computed）
      const chipModel = h.mt.currentModelId.value
      const chipThinking = h.mt.currentThinkingLevel.value ?? ''
      const chipPresetId = h.presetChipResolved.value.presetId

      // 快照 resolve 输入 = submit 侧实际合并形态（launchPort.getInput 基座 + flow pending 覆盖）
      const snapshot: LaunchConfigInput = {
        presets: db.presets,
        defaultPresetId: db.defaultPresetId,
        lastUsedModel: lookupLastUsed() ?? null,
        getRememberedThinkingLevel: (modelId) => lookupMemory(modelId),
        providers: db.providers,
        defaultModel: db.defaultModel,
        getSupportedLevels: (modelId) => supportedLevelsOf(modelId, db.providers),
        pendingModel: useNewTaskFlowState().pendingModel.value,
        // submit 的 thinkingLevel 参数 = localThinkingLevel（生产形态 send.ts:237）
        pendingThinkingLevel: h.mt.localThinkingLevel.value ?? null,
        // 与 submit 侧同读 flow pendingPreset 只读视图（U4r2 通道）
        pendingPreset: h.flow.pendingPreset.value,
        pendingCwd: null,
      }
      const B = resolveLaunchConfig(snapshot)

      // C：create 入参（真实 submitFirstMessage → mock ports 捕获）
      await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)

      // ── 三段等价断言 ──
      expect(h.createSession).toHaveBeenCalledTimes(1)
      // A ≡ B（chip 侧未脱离 resolve 单源）
      expect(chipModel).toBe(B.model)
      expect(chipThinking).toBe(B.thinkingLevel)
      expect(chipPresetId).toBe(B.presetId)
      // C ≡ B（submit 侧未脱离 resolve 单源；'' 全链空防御形态不上线 → null → runtime 全局默认）
      expect(h.createSession).toHaveBeenCalledWith({
        cwd: null,
        presetId: B.presetId ?? null,
        pendingModel: B.model || null,
        segments: [textSeg('hi')],
        bashCommand: null,
        pendingThinkingLevel: B.thinkingLevel as ThinkingLevel,
        clientUuid: expect.any(String),
        projectId: null, // landing 未显式选归属项目（pendingProjectId 默认 null）
      })
    } finally {
      h.scope.stop()
    }
  }

  // ── 1. 三段等价矩阵（全组合 72 格）────────────────────────────────────

  interface MatrixCell { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    label: string
    pickModel: boolean
    authored: boolean
    lastUsed: 'none' | 'valid' | 'invalid'
    preset: 'none' | 'default' | 'explicit'
    defaultModel: boolean
  }

  const MATRIX: MatrixCell[] = []

  for (const pickModel of [false, true]) {
    for (const authored of [false, true]) {
      for (const lastUsed of ['none', 'valid', 'invalid'] as const) {
        for (const preset of ['none', 'default', 'explicit'] as const) {
          for (const defaultModel of [true, false]) {
            MATRIX.push({
              label: `pendingModel=${pickModel ? '显式pick' : '无'} · authored档=${authored ? 'low' : '无'} · lastUsed=${lastUsed} · preset=${preset} · 全局默认=${defaultModel ? '有' : '无'}`,
              pickModel,
              authored,
              lastUsed,
              preset,
              defaultModel,
            })
          }
        }
      }
    }
  }

  describe('L1 等价矩阵 · chip 显示 ≡ resolve 输出 ≡ create 入参（全组合）', () => {
    beforeEach(() => {
      provideMockPlatform(new MemKV())
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
    })

    afterEach(() => {
      __resetPlatformForTesting()
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
    })

    it.each(MATRIX)('$label', async (cell) => {
      await runMatrixCell(cell)
    })
  })

  // ── 2. 锚点用例（设计 §2.2/§2.3 发散条件钉具体值，防空转等价）──────────

  describe('L1 锚点 · 发散条件具体值（§2.2/§2.3 全覆盖）', () => {
    beforeEach(() => {
      provideMockPlatform(new MemKV())
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
    })

    afterEach(() => {
      __resetPlatformForTesting()
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
    })

    it('§2.3-① 本次 bug：lastUsed≠全局默认且不点 chip 直接发送 → chip 显示 lastUsed 且 create 携带同一值（不再是 null→runtime 落默认）', async () => {
      const db = makeDb('none', true)
      const h = mountHarness(db)
      try {
        await h.flow.startFlow()
        await flushKvLoads()
        recordLastUsed('prov-a/model-x')
        recordMemory('prov-a/model-x', 'high')
        await nextTick()

        // 显示链：chip 显示 lastUsed（bug 场景的「用户看到的」）
        expect(h.mt.currentModelId.value).toBe('prov-a/model-x')
        // 发送（不点任何 chip）
        await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)

        // 生效链：create 携带解析终值 = lastUsed（旧 bug 形态 = pendingModel null →
        // runtime 落 pi 全局默认 mimo → 对话流显示默认模型，chip≠生效）
        expect(h.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            pendingModel: 'prov-a/model-x',
            pendingThinkingLevel: 'high', // 记忆档（model-x 有 high 记忆）
            presetId: null,
          }),
        )
        // provenance 锚定（lastUsed 档，非默认档）
        const B = resolveLaunchConfig({
          presets: [],
          defaultPresetId: null,
          lastUsedModel: 'prov-a/model-x',
          getRememberedThinkingLevel: (m) => lookupMemory(m),
          providers: db.providers,
          defaultModel: 'prov-default/model-default',
          getSupportedLevels: (m) => supportedLevelsOf(m, db.providers),
          pendingModel: null,
          pendingThinkingLevel: null,
          pendingPreset: null,
        })
        expect(B.modelProvenance).toBe('lastUsed')
        expect(B.thinkingProvenance).toBe('memory')
      } finally {
        h.scope.stop()
      }
    })

    it('§2.3-③/V4：默认预设 thinkingLevel=off + 记忆档 max → chip 显示 off 且 create 生效 off（preset 档优先于记忆档，不再被自动值遮蔽）', async () => {
      const db = makeDb('default', true)
      const h = mountHarness(db)
      try {
        await h.flow.startFlow()
        await flushKvLoads()
        recordLastUsed('prov-a/model-x') // lastUsed 有效——同时锚 preset.modelOverride > lastUsed
        recordMemory('prov-a/model-preset', 'max') // 发散对：记忆 max vs preset off
        await nextTick()

        // 显示：模型/档位均 = preset 捆绑值（off 压过记忆 max——V4 断言）
        expect(h.mt.currentModelId.value).toBe('prov-a/model-preset')
        expect(h.mt.currentThinkingLevel.value).toBe('off')
        // preset chip 等价视图显示默认预设
        expect(h.presetChipResolved.value.presetId).toBe('p-default')

        await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
        expect(h.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            pendingModel: 'prov-a/model-preset',
            pendingThinkingLevel: 'off',
            presetId: 'p-default',
          }),
        )
      } finally {
        h.scope.stop()
      }
    })

    it('显式恒赢：pendingModel + authored 档 + 显式 preset 并存 → 三字段均 explicit 档（赢过 preset 捆绑与 lastUsed）', async () => {
      const db = makeDb('explicit', true)
      const h = mountHarness(db)
      try {
        await h.flow.startFlow()
        await flushKvLoads()
        recordLastUsed('prov-a/model-x')
        recordMemory('prov-a/model-preset', 'max')
        await h.mt.onModelSelect({ modelId: 'model-pick', provider: 'prov-a' as ProviderId })
        h.explicitPresetId.value = 'p-user'
        h.flow.setPendingPreset('p-user')
        await h.mt.onThinkingSelect('low')
        await nextTick()

        expect(h.mt.currentModelId.value).toBe('prov-a/model-pick')
        expect(h.mt.currentThinkingLevel.value).toBe('low')
        expect(h.presetChipResolved.value.presetId).toBe('p-user')

        await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
        expect(h.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            pendingModel: 'prov-a/model-pick',
            pendingThinkingLevel: 'low',
            presetId: 'p-user',
          }),
        )
      } finally {
        h.scope.stop()
      }
    })

    it('D4 失效回落：lastUsedModel 指向能力表外死模型 → chip 与 create 均落全局默认，KV 原值保留不覆写', async () => {
      const db = makeDb('none', true)
      const h = mountHarness(db)
      try {
        await h.flow.startFlow()
        await flushKvLoads()
        recordLastUsed('prov-gone/model-z')
        await nextTick()

        // 显示：不显示死模型，静默回落全局默认（D4）
        expect(h.mt.currentModelId.value).toBe('prov-default/model-default')

        await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
        expect(h.createSession).toHaveBeenCalledWith(
          expect.objectContaining({ pendingModel: 'prov-default/model-default' }),
        )
        // KV 非破坏性跳过：原值保留（provider 恢复后用户选择自动回来的前提）
        expect(lookupLastUsed()).toBe('prov-gone/model-z')
      } finally {
        h.scope.stop()
      }
    })
  })

  // ── 3. 窗口语义轻断言（D1/E2；主检查在 flow.test.ts TC-5，见文件头声明）──

  describe('L1 窗口语义（D1/E2）· ensureLaunchDataReady 门闩', () => {
    beforeEach(() => {
      provideMockPlatform(new MemKV())
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
    })

    afterEach(() => {
      __resetPlatformForTesting()
      resetNewTaskFlow()
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()
    })

    it('ensureReady 未完成 → 不 create（加载窗口占位值不固化）；完成后 create 入参 = 加载后 resolve 输出', async () => {
      let openGate!: () => void
      const gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      let presetsLoaded = false
      const db = makeDb('none', true)
      // 占位/终值两态数据：加载前 preset store 空（preset 档不可达），加载后默认预设生效
      const getInput = (): LaunchConfigInput => ({
        presets: presetsLoaded ? [P_DEFAULT] : [],
        defaultPresetId: presetsLoaded ? 'p-default' : null,
        lastUsedModel: lookupLastUsed() ?? null,
        getRememberedThinkingLevel: (m) => lookupMemory(m),
        providers: db.providers,
        defaultModel: db.defaultModel,
        getSupportedLevels: (m) => supportedLevelsOf(m, db.providers),
      })
      const h = mountHarness(db, {
        getInput,
        ensureReady: () => gate.then(() => {
          presetsLoaded = true
        }),
      })
      try {
        await h.flow.startFlow()
        await flushKvLoads()
        recordLastUsed('prov-a/model-x')
        await nextTick()

        const pending = h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
        // 门闩：ensureReady 未完成 → create 不发生（若未 await 就 resolve，会把加载前的
        // 占位解析值——lastUsed 档 model-x——固化进新 session）
        await flushMicrotasks()
        expect(h.createSession).not.toHaveBeenCalled()

        openGate()
        await pending

        // create 入参 = 加载后 resolve 输出：默认预设 p-default 生效（modelOverride 压过
        // lastUsed 档），≠ 加载前占位解析值（model-x）——占位不固化
        expect(h.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            presetId: 'p-default',
            pendingModel: 'prov-a/model-preset',
          }),
        )
        expect(h.createSession).not.toHaveBeenCalledWith(
          expect.objectContaining({ pendingModel: 'prov-a/model-x' }),
        )
      } finally {
        h.scope.stop()
      }
    })
  })

  // ── 4. grep 结构检查（D7-L1：测试内源码文本扫描，不进构建脚本）─────────

  const MODEL_THINKING_SRC = readFileSync(
    new URL('../../composer/model-thinking.ts', import.meta.url),
    'utf8',
  )

  /**
 * 源文本（保长度）剥注释：行/块注释替换为等长空白——索引不漂移，且注释里的
 * "record"/"watch(" 字样不参与结构判定（防注释措辞误伤结构检查）。
 * 已知边界（可接受）：字符串字面量内的 "//"（如 URL）会被误剥——本文件无此形态；
 * 检查红时先核对源码再更新结构锁。
 */
  function stripComments(src: string): string {
    let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    return out
  }

  /** 提取 openIdx 处 '(' 或 '{' 起的平衡段（跳过字符串字面量；注释已由 stripComments 剥除）。 */
  function extractBalanced(code: string, openIdx: number): string {
    const open = code[openIdx]!
    const close = open === '(' ? ')' : '}'
    let depth = 0
    let i = openIdx
    while (i < code.length) {
      const ch = code[i]!
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch
        i++
        while (i < code.length && code[i] !== quote) {
          if (code[i] === '\\') i++
          i++
        }
        i++
        continue
      }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return code.slice(openIdx, i + 1)
      }
      i++
    }
    throw new Error('extractBalanced: 源码括号不平衡（结构检查扫描器异常，先核对源码）')
  }

  /** 提取指定函数的完整定义段（签名定位 → 参数表 → 函数体花括号平衡段）。 */
  function functionSpan(code: string, name: string): string {
    const sigRe = new RegExp(`function\\s+${name}\\s*\\(`)
    const sig = sigRe.exec(code)
    if (!sig) throw new Error(`grep 检查：model-thinking.ts 缺少函数 ${name}（结构锁需先更新本测试）`)
    const params = extractBalanced(code, code.indexOf('(', sig.index))
    const bodyOpen = code.indexOf('{', sig.index + params.length - 1)
    return extractBalanced(code, bodyOpen)
  }

  /** 提取全部顶层 watch( 调用段（含回调体）。 */
  function watchSpans(code: string): string[] {
    const spans: string[] = []
    const re = /(?<![A-Za-z0-9_$.])watch\s*\(/g
    for (let m = re.exec(code); m; m = re.exec(code)) {
      spans.push(extractBalanced(code, code.indexOf('(', m.index)))
    }
    return spans
  }

  describe('grep 结构检查 · 记录路径 authored-only（D2/D7-L1）', () => {
    // 剥注释后的源码：结构判定只看可执行代码，注释措辞不误伤
    const code = stripComments(MODEL_THINKING_SRC)

    it('landing auto 值机制零残留：followRememberedOrDefault / localAuthored 无命中（U2a 删除项复发即红）', () => {
      expect(code).not.toMatch(/followRememberedOrDefault/)
      expect(code).not.toMatch(/localAuthored/)
    })

    it('记录路径结构性无 watch：全部 watch 注册段零 record 族调用（「生效即记录」watch 复发即红）', () => {
      const spans = watchSpans(code)
      // 扫描器健全性：至少存在换绑清 armed 的合法 watch（若零命中说明扫描器失效=检查空转）
      expect(spans.length).toBeGreaterThanOrEqual(1)
      for (const span of spans) {
        // watch 内任何 record 族调用（record / recordAuthoredThinking / recordLastUsed）
        // 都是「非显式选择写入 KV」通道——记忆污染（D2 不采用③）或 lastUsed 污染
        expect(span).not.toMatch(/record/)
      }
    })

    it('onThinkingSelect 显式入口正常入表：recordAuthoredThinking 调用在入口体内，且全文件仅此一个调用点', () => {
      const onSpan = functionSpan(code, 'onThinkingSelect')
      // 入口仍在（U2a 后唯一记录点）
      expect(onSpan).toMatch(/recordAuthoredThinking\s*\(/)
      // 全文件 recordAuthoredThinking( 出现次数 = 定义签名 1 + onThinkingSelect 调用 1
      // （出现第三处 = 新增了绕过用户入口的记录通道）
      const total = code.match(/recordAuthoredThinking\s*\(/g)?.length ?? 0
      expect(total).toBe(2)
    })

    it('直接 record( 写点唯一在 recordAuthoredThinking 体内；自动对齐路由 routeThinkingLevel 零记录', () => {
      // record( 不匹配 recordLastUsed( / recordAuthoredThinking(（后随字符非 '('）
      const directCalls = [...code.matchAll(/(?<![A-Za-z0-9_$])record\s*\(/g)]
      // 非空检查：零命中 = 写点被移走/改名，结构锁需先更新
      expect(directCalls.length).toBeGreaterThanOrEqual(1)
      const recordSpan = functionSpan(code, 'recordAuthoredThinking')
      const rel = code.indexOf(recordSpan)
      expect(rel).toBeGreaterThanOrEqual(0)
      for (const call of directCalls) {
        const idx = call.index ?? -1
        // 直接写点必须落在 recordAuthoredThinking 定义段内
        expect(idx).toBeGreaterThanOrEqual(rel)
        expect(idx).toBeLessThanOrEqual(rel + recordSpan.length)
      }
      // 自动对齐走 routeThinkingLevel（非用户入口）——零记录（authored-only 结构前提）
      const routeSpan = functionSpan(code, 'routeThinkingLevel')
      expect(routeSpan).not.toMatch(/record/)
    })
  })
});
