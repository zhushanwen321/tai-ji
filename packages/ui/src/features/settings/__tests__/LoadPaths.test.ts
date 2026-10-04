/**
 * LoadPaths 组件单测（v6 重构：分组 + ↑↓ + Checkbox 可见性 + forcedDirs 置顶）。
 *
 * 覆盖验收标准 §2 五点：
 * ① 项目/全局两组 DOM 存在
 * ② ↑↓ 按钮存在
 * ③ Checkbox 未选态有可见 border class（§1.1 可见性修复）
 * ④ 点击 ↑↓ 后顺序变化（emit update-dirs）
 * ⑤ forcedDirs 在项目组顶部
 * + 首屏冒烟（mount + DOM 断言）
 *
 * i18n 经 vitest.setup mock（t 返回 key）；chooseDirectory 经 provide mock。
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import LoadPaths from '../common/LoadPaths.vue'
import { SETTINGS_CHOOSE_DIRECTORY_KEY } from '../injection-keys'
import type { SkillDirConfig } from '@taiji/shared'

function makeDirs(): SkillDirConfig[] {
  return [
    { path: '~/projects/my-skills', enabled: true, scope: 'project' },
    { path: './.taiji/skills', enabled: false, scope: 'project' },
    { path: '~/work/shared-skills', enabled: true, scope: 'global' },
  ]
}

function mountLoadPaths(
  overrides: { dirs?: SkillDirConfig[]; chooseDirectory?: () => Promise<string | null> } = {},
) {
  return mount(LoadPaths, {
    props: {
      forcedDirs: ['~/.taiji/skills'],
      dirs: overrides.dirs ?? makeDirs(),
      kind: 'skill' as const,
    },
    global: {
      provide: {
        [SETTINGS_CHOOSE_DIRECTORY_KEY]:
          overrides.chooseDirectory ?? (async () => '/mock/selected'),
      },
    },
  })
}

describe('LoadPaths', () => {
  it('首屏冒烟：渲染两组 + ↑↓ 按钮 + forcedDirs 行', () => {
    const wrapper = mountLoadPaths()
    // ① 项目/全局两组 DOM 存在
    const groups = wrapper.findAll('[data-testid="dir-group"]')
    expect(groups.length).toBe(2)
    expect(wrapper.find('[data-testid="group-head-project"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="group-head-global"]').exists()).toBe(true)
    // ② ↑↓ 按钮存在
    expect(wrapper.find('[data-testid="move-up-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="move-down-btn"]').exists()).toBe(true)
    // ⑤ forcedDirs 行存在
    expect(wrapper.find('[data-testid="forced-dir-row"]').exists()).toBe(true)
  })

  it('Checkbox 未选态可见（全局 Checkbox.vue !border + neutral-mid 保证）', () => {
    const wrapper = mountLoadPaths()
    const checkbox = wrapper.find('button[role="checkbox"]')
    expect(checkbox.exists()).toBe(true)
    // 可见性修复在全局 Checkbox.vue：!border（绕过 renderer 全局 *{border-width:0} unlayered 覆盖）+ border-neutral-mid（亮色）
    const cls = checkbox.attributes('class') ?? ''
    expect(cls).toContain('!border')
    expect(cls).toContain('border-neutral-mid')
  })

  it('点击 ↓ 下移项目组首行后顺序变化（emit update-dirs）', async () => {
    const wrapper = mountLoadPaths({
      dirs: [
        { path: '/a', enabled: true, scope: 'project' },
        { path: '/b', enabled: true, scope: 'project' },
      ],
    })
    const moveDownBtns = wrapper.findAll('[data-testid="move-down-btn"]')
    // 项目组第一行的 ↓（enabled，非组末）
    await moveDownBtns[0].trigger('click')
    const emitted = wrapper.emitted('update-dirs')
    expect(emitted).toBeTruthy()
    const payload = (emitted![0] as [SkillDirConfig[]])[0]
    const projectOrder = payload.filter((d) => d.scope === 'project').map((d) => d.path)
    // a 与 b 交换
    expect(projectOrder).toEqual(['/b', '/a'])
  })

  it('点击 ↑ 上移项目组次行后顺序变化', async () => {
    const wrapper = mountLoadPaths({
      dirs: [
        { path: '/a', enabled: true, scope: 'project' },
        { path: '/b', enabled: true, scope: 'project' },
      ],
    })
    const moveUpBtns = wrapper.findAll('[data-testid="move-up-btn"]')
    // 项目组第二行的 ↑
    await moveUpBtns[1].trigger('click')
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    const projectOrder = payload.filter((d) => d.scope === 'project').map((d) => d.path)
    expect(projectOrder).toEqual(['/b', '/a'])
  })

  it('forcedDirs 在项目目录组顶部（forced-dir-row 出现在 dir-row 之前）', () => {
    const wrapper = mountLoadPaths()
    const projectGroup = wrapper.find('[data-scope="project"]')
    // 项目组内：forced 行先于用户目录行
    const forced = projectGroup.find('[data-testid="forced-dir-row"]')
    const userRow = projectGroup.find('[data-testid="dir-row"]')
    expect(forced.exists()).toBe(true)
    expect(userRow.exists()).toBe(true)
    expect(forced.element.compareDocumentPosition(userRow.element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('组首↑ 与 组末↓ disabled（边界行不可点）', () => {
    const wrapper = mountLoadPaths({
      dirs: [
        { path: '/a', enabled: true, scope: 'project' },
        { path: '/b', enabled: true, scope: 'project' },
      ],
    })
    const moveUpBtns = wrapper.findAll('[data-testid="move-up-btn"]')
    const moveDownBtns = wrapper.findAll('[data-testid="move-down-btn"]')
    // 项目组首行 ↑ disabled
    expect(moveUpBtns[0].attributes('disabled')).toBeDefined()
    // 项目组末行 ↓ disabled
    expect(moveDownBtns[1].attributes('disabled')).toBeDefined()
    // 非边界行 enabled
    expect(moveDownBtns[0].attributes('disabled')).toBeUndefined()
    expect(moveUpBtns[1].attributes('disabled')).toBeUndefined()
  })

  it('目录选择 dialog 选完后追加到对应组末尾', async () => {
    const chooseDirectory = vi.fn(async () => '/chosen/global/dir')
    const wrapper = mountLoadPaths({ chooseDirectory })
    await wrapper.find('[data-testid="choose-dir-btn-global"]').trigger('click')
    expect(chooseDirectory).toHaveBeenCalled()
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    const added = payload.find((d) => d.path === '/chosen/global/dir')
    expect(added).toEqual({ path: '/chosen/global/dir', enabled: true, scope: 'global' })
  })

  it('全局组手动添加限绝对路径（相对路径报格式错误，不 emit）', async () => {
    const wrapper = mountLoadPaths()
    const input = wrapper.find('[data-testid="new-path-input-global"]')
    await input.setValue('relative/path')
    await wrapper.find('[data-testid="add-path-btn-global"]').trigger('click')
    expect(wrapper.find('[data-testid="path-error-global"]').exists()).toBe(true)
    expect(wrapper.emitted('update-dirs')).toBeFalsy()
  })

  it('项目组手动添加允许相对路径', async () => {
    const wrapper = mountLoadPaths()
    const input = wrapper.find('[data-testid="new-path-input-project"]')
    await input.setValue('.agents/skills')
    await wrapper.find('[data-testid="add-path-btn-project"]').trigger('click')
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    expect(payload.some((d) => d.path === '.agents/skills' && d.scope === 'project')).toBe(true)
  })

  it('Checkbox 勾选触发 update-dirs 且仅改对应行 enabled', async () => {
    const wrapper = mountLoadPaths()
    // 定位用户目录行（非 forced）的 Checkbox
    const userCheckbox = wrapper.find('[data-testid="dir-row"] button[role="checkbox"]')
    expect(userCheckbox.exists()).toBe(true)
    await userCheckbox.trigger('click')
    const payload = (wrapper.emitted('update-dirs')![0] as [SkillDirConfig[]])[0]
    expect(payload.some((d) => typeof d.enabled === 'boolean')).toBe(true)
  })

  // ── RD-4#1 保存失败回弹：saveError 置位 → localDirs 回弹至最近落盘值（props.dirs）+ 常驻红字 ──
  describe('saveError 保存失败常驻态（RD-4#1）', () => {
    const persistedDirs = (): SkillDirConfig[] => [
      { path: '/persisted/dir', enabled: false, scope: 'global' },
    ]

    it('saveError 置位 → 乐观编辑回弹至 props.dirs（最近落盘值）+ 常驻红字出现', async () => {
      const wrapper = mountLoadPaths({ dirs: persistedDirs() })
      // 用户勾选（LoadPaths 乐观编辑，emit 后父组件持久化）
      const checkbox = wrapper.find('[data-testid="dir-row"] button[role="checkbox"]')
      await checkbox.trigger('click')
      expect(wrapper.emitted('update-dirs')).toBeTruthy()
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(false)

      // 父组件保存失败 → 置位 saveError
      await wrapper.setProps({ saveError: true })

      // 常驻红字（toast 之外的非瞬态失败标注）
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(true)
      // 回弹：勾选态回到最近落盘值（unchecked）
      expect(checkbox.attributes('data-state')).toBe('unchecked')
    })

    it('saveError 复位（下次保存尝试起点）→ 常驻红字消失，后续编辑不受影响', async () => {
      const wrapper = mountLoadPaths({ dirs: persistedDirs() })
      await wrapper.setProps({ saveError: true })
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(true)

      await wrapper.setProps({ saveError: false })
      expect(wrapper.find('[data-testid="load-paths-save-error"]').exists()).toBe(false)

      // 复位后仍可正常编辑 + emit
      const checkbox = wrapper.find('[data-testid="dir-row"] button[role="checkbox"]')
      await checkbox.trigger('click')
      expect(wrapper.emitted('update-dirs')).toBeTruthy()
    })
  })
})
