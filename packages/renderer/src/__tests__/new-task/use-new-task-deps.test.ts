// @vitest-environment jsdom

/**
 * useNewTaskDeps 组装单测（归属项目选择 wave 2026-10-22）。
 *
 * 既有 Landing/Panel 测试全部 mock useNewTaskDeps（见 landing.test.ts），本文件是唯一
 * 真实执行该 composable 的测试——守卫其 store→deps 12 字段映射不被接线回归打破：
 * - store ref 同源透传：recentWorkspaces ← workspaceStore.records、defaultSessionDir、
 *   projects ← projectStore.orderedProjects、activeProjectId（响应式同源，非快照拷贝）
 * - setPinned 适配：deps.setPinned 委托 workspaceStore.setPinned（DirSelectPopover 悬停动作）
 *
 * mock 边界：只 mock 最外层 api/composable（@/api、usePiPresets、useToast、worktreeApi、
 * ipc pickDirectory、flow 壳），workspace/preset/project 三 store 用真实现（pinia）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/use-new-task-deps.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RecentWorkspaceRecord } from '@taiji/shared'

vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  workspace: {
    listRecent: vi.fn().mockResolvedValue([]),
    record: vi.fn(),
    detect: vi.fn(),
    defaultSessionDir: vi.fn().mockResolvedValue(''),
    setPinned: vi.fn(),
  },
}))
vi.mock('@/composables/features/settings/usePiPresets', () => ({
  usePiPresets: () => ({ loadPresets: vi.fn(), setDefault: vi.fn() }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@taiji/core/transport/api/domains/worktree', () => ({
  worktreeApi: { listBranches: vi.fn(), create: vi.fn() },
}))
vi.mock('@/lib/ipc', () => ({ pickDirectory: vi.fn() }))
// flow 壳只透传引用（Landing provide 后 ui 组件消费），真实 core 状态机不在本测范围
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ state: { value: 'idle' as string } }),
  resetNewTaskFlow: vi.fn(),
}))

import { useNewTaskDeps } from '@/composables/features/new-task/useNewTaskDeps'
import { useWorkspaceStore } from '@/stores/workspace'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { workspace } from '@/api'

const mockSetPinnedApi = workspace.setPinned as unknown as ReturnType<typeof vi.fn>

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockSetPinnedApi.mockReset()
})

describe('useNewTaskDeps 组装（store ref 同源透传）', () => {
  it('recentWorkspaces 与 workspaceStore.records 同源：store 更新 → deps ref 同步变化', () => {
    const ws = useWorkspaceStore()
    const deps = useNewTaskDeps()
    expect(deps.recentWorkspaces.value).toEqual([])
    ws.records = [mkRecord('/repo-a', 300)]
    expect(deps.recentWorkspaces.value).toHaveLength(1)
    expect(deps.recentWorkspaces.value[0]!.cwd).toBe('/repo-a')
  })

  it('defaultSessionDir 透传 workspaceStore ref：store 拉取后 deps 侧可见', async () => {
    const ws = useWorkspaceStore()
    const deps = useNewTaskDeps()
    expect(deps.defaultSessionDir.value).toBe('')
    ws.defaultSessionDir = '/data/defaultSession'
    expect(deps.defaultSessionDir.value).toBe('/data/defaultSession')
  })

  it('projects/activeProjectId 透传 projectStore（orderedProjects 渲染序 + 默认 project 锚定）', async () => {
    const proj = useProjectStore()
    const deps = useNewTaskDeps()
    // 初始兜底态：默认 project 恒在（UI 永不空态），activeProjectId = 默认锚定
    expect(deps.activeProjectId.value).toBe(DEFAULT_PROJECT_ID)
    expect(deps.projects.value.some((p) => p.id === DEFAULT_PROJECT_ID)).toBe(true)
    // 同源验证：projectStore.projects 变化 → deps.projects（orderedProjects 派生）同步
    proj.projects = [
      { id: 'proj-a', name: 'Alpha', lastUsedAt: 100 },
      { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
    ]
    expect(deps.projects.value.map((p) => p.id)).toContain('proj-a')
    proj.activeProjectId = 'proj-a'
    expect(deps.activeProjectId.value).toBe('proj-a')
  })

  it('setPinned 委托 workspaceStore.setPinned（透传参数与返回值）', async () => {
    mockSetPinnedApi.mockResolvedValue({ records: [mkRecord('/x', 1)], degraded: false })
    const deps = useNewTaskDeps()
    const ok = await deps.setPinned('/x', true)
    expect(mockSetPinnedApi).toHaveBeenCalledWith('/x', true)
    expect(ok).toBe(true)
  })

  it('api 域字段透传：listBranches/createWorktree/detectWorkspace/pickDirectory/presets 等在场', () => {
    const deps = useNewTaskDeps()
    expect(typeof deps.listBranches).toBe('function')
    expect(typeof deps.createWorktree).toBe('function')
    expect(typeof deps.detectWorkspace).toBe('function')
    expect(typeof deps.pickDirectory).toBe('function')
    expect(typeof deps.loadPresets).toBe('function')
    expect(typeof deps.setDefaultPreset).toBe('function')
    expect(deps.presets.value).toEqual([])
    expect(deps.defaultPresetId.value).toBe('')
    expect(typeof deps.toast.error).toBe('function')
  })
})
