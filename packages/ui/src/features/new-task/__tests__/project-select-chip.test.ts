/**
 * ProjectSelectChip 测试（归属项目选择 chip，2026-10-22）。
 *
 * 覆盖：landing 态渲染 + 回显链（flow.pendingProjectId 显式档 > activeProjectId 锚定档）/
 * 默认项目名空串兜底 / 点击 emit select / 锁定态与历史态。
 * 断言 DOM 结构与 emitted（vitest.setup mock vue-i18n，文案不断言）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/new-task/__tests__/project-select-chip.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import ProjectSelectChip from '../ProjectSelectChip.vue'
import { Popover } from '../../../primitives/popover'
import { NewTaskDepsKey, type NewTaskDeps } from '../new-task-deps'
import type { Project } from '@taiji/shared'

const sampleProjects: Project[] = [
  { id: 'proj-a', name: 'Project A', lastUsedAt: 2 },
  { id: 'proj-b', name: 'Project B', lastUsedAt: 1 },
  { id: 'proj-default', name: '', lastUsedAt: 0 },
]

function makeDeps(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
  const base: NewTaskDeps = {
    flow: {
      pendingProjectId: ref(null),
    } as NewTaskDeps['flow'],
    recentWorkspaces: ref([]),
    setPinned: vi.fn(async () => true),
    defaultSessionDir: ref(''),
    listBranches: vi.fn(async () => ({ local: [], remote: [], defaultBranch: 'main' })),
    createWorktree: vi.fn(async () => ({ cwd: '', branch: '' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'not-repo' as const, wsRoot: '', barePath: '', repoRoot: '', defaultBranch: '',
    })),
    pickDirectory: vi.fn(async () => ({ canceled: true })),
    presets: ref([]),
    defaultPresetId: ref(''),
    presetOpenRequest: ref(0),
    loadPresets: vi.fn(async () => {}),
    setDefaultPreset: vi.fn(async () => {}),
    projects: ref(sampleProjects),
    activeProjectId: ref('proj-a'),
    toast: { error: vi.fn() },
  }
  return overrides ? { ...base, ...overrides } : base
}

function mountChip(
  deps: NewTaskDeps,
  props: { sessionId: string | null; projectId?: string },
  /** 展开态挂载（受控 open；PopoverContent lazy 渲染，closed 态下列表项不在 DOM） */
  projectOpen = false,
) {
  return mount(ProjectSelectChip, {
    props: { ...props, projectOpen },
    global: { provide: { [NewTaskDepsKey]: deps } },
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('ProjectSelectChip', () => {
  it('landing 态渲染 chip-project，回显 activeProjectId 锚定档（pendingProjectId=null）', () => {
    const wrapper = mountChip(makeDeps(), { sessionId: null })
    expect(wrapper.find('[data-testid="chip-project"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-project"]').text()).toContain('Project A')
  })

  it('显式选择档优先：flow.pendingProjectId 非空时回显它', () => {
    const deps = makeDeps()
    ;(deps.flow.pendingProjectId as ReturnType<typeof ref>).value = 'proj-b'
    const wrapper = mountChip(deps, { sessionId: null })
    expect(wrapper.find('[data-testid="chip-project"]').text()).toContain('Project B')
  })

  it('默认项目 name 空串 → 回显默认项目文案档（projects 里 name 空的条目不裸显空名）', () => {
    const deps = makeDeps({ activeProjectId: ref('proj-default') })
    const wrapper = mountChip(deps, { sessionId: null })
    const text = wrapper.find('[data-testid="chip-project"]').text()
    expect(text).not.toBe('')
  })

  it('点击项目项 → emit select({projectId})', async () => {
    const wrapper = mountChip(makeDeps(), { sessionId: null }, true)
    await flushPromises() // PopoverContent Teleport 到 body（PresetSelectChip 测试同款手法：flush 后 document.querySelector + 原生 click）
    const option = document.querySelector<HTMLElement>('[data-testid="project-option-proj-b"]')
    expect(option).not.toBeNull()
    option!.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([[{ projectId: 'proj-b' }]])
  })

  it('已创建态（projectId 有值）→ 锁定 chip-project-locked，无 popover', () => {
    const wrapper = mountChip(makeDeps(), { sessionId: 's1', projectId: 'proj-a' })
    expect(wrapper.find('[data-testid="chip-project-locked"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chip-project"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chip-project-locked"]').text()).toContain('Project A')
  })

  it('历史态（projectId undefined）→ 锁定形态渲染且不崩', () => {
    const wrapper = mountChip(makeDeps(), { sessionId: 's1' })
    expect(wrapper.find('[data-testid="chip-project-locked"]').exists()).toBe(true)
  })

  it('popover open 变化回传 update:projectOpen（v-model:projectOpen 透传，flow 状态机互斥驱动）', async () => {
    const wrapper = mountChip(makeDeps(), { sessionId: null })
    wrapper.findComponent(Popover).vm.$emit('update:open', true)
    await flushPromises()
    expect(wrapper.emitted('update:projectOpen')).toEqual([[true]])
  })

  // 悬停 tooltip 打开（portal 挂 body，vue-test-utils 树外）：reka HoverCardTrigger 监听
  // pointerenter（SystemNotice.test 同款手法），open-delay 200ms 后 vi.waitFor 轮询 document。
  it('锁定态悬停 → HoverCard tooltip 渲染归属提示；历史态加注（未记录归属）', async () => {
    const wrapper = mountChip(makeDeps(), { sessionId: 's1', projectId: 'proj-a' })
    try {
      await wrapper.find('[data-testid="chip-project-locked"]').trigger('pointerenter')
      // reka HoverCardContent 无 role 语义（探针核实）：外层 popper wrapper 是唯一稳定锚点
      const tooltip = await vi.waitFor(
        () => {
          const el = document.querySelector<HTMLElement>('[data-reka-popper-content-wrapper]')
          expect(el).not.toBeNull()
          return el!
        },
        { timeout: 2000, interval: 50 },
      )
      // vue-i18n mock 回 key + 命名参数追加：锁定提示含归属项目名（显示 ≡ 归属真源）
      expect(tooltip.textContent).toContain('Project A')

      // 历史态（projectId undefined）→ 加注文案拼接（legacy 后缀段进入 tooltip）
      const legacy = mountChip(makeDeps(), { sessionId: 's2' })
      try {
        await legacy.find('[data-testid="chip-project-locked"]').trigger('pointerenter')
        await vi.waitFor(() => {
          const tooltips = document.querySelectorAll<HTMLElement>('[data-reka-popper-content-wrapper]')
          expect(tooltips.length).toBe(2)
          expect(tooltips[1]!.textContent).toContain('newTask.projectSelect.legacySessionTooltip')
        }, { timeout: 2000, interval: 50 })
      } finally {
        legacy.unmount()
      }
    } finally {
      wrapper.unmount()
      document.body.innerHTML = ''
    }
  })
})
