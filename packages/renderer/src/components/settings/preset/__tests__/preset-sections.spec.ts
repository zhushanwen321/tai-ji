/**
 * Pi 预设页拆分（PresetListSection / PresetDetailSection / 容器）组件测试。
 *
 * 覆盖 TC1-TC7（wave: arch-fix-v2-bfs::settings-structure::presets-page-split::preset-sections）：
 * - TC1：PresetListSection 渲染预设卡片（名称/内置徽章/默认徽章）
 * - TC2：展开态（自定义默认展开、内置默认折叠、点击头部切换）
 * - TC3：折叠态摘要行（工具/扩展 mode 概览）
 * - TC4：操作按钮 emit set-default/restore/delete + restoring disabled
 * - TC5：PresetDetailSection 字段编辑 debounce 后 emit update-field 完整镜像
 * - TC6：PresetDetailSection mode-update 透传
 * - TC7：PiPresetsPage 容器集成（首屏 + 删除确认弹窗流程）
 *
 * mock 策略：i18n 由 vitest-i18n-setup 全局 mock（zh-CN 文案）；TC7 用 vi.mock('@/api')
 * 的 preset 域 + createPinia；子组件测试纯 props/emits 驱动。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/__tests__/preset-sections.spec.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { Trash2 } from '@lucide/vue'
import type { PiLaunchPreset } from '@taiji/shared'
import PresetListSection from '@/components/settings/preset/PresetListSection.vue'
import PresetDetailSection from '@/components/settings/preset/PresetDetailSection.vue'

/** mock @/api preset 域（TC7 容器测试；usePiPresets 唯一外部依赖）。 */
const presetApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  getDefault: vi.fn(),
  setDefault: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/api', () => ({ preset: presetApiMock }))

/** 内置预设 fixture：toolMode=all + extensionMode=allowlist（3 项）——TC3 摘要断言用。 */
const BUILTIN: PiLaunchPreset = {
  id: 'builtin:full',
  name: '内置完整',
  builtin: true,
  order: 0,
  toolMode: 'all',
  extensionMode: 'allowlist',
  allowedExtensions: ['pi-goal', 'pi-todo', 'pi-subagents'],
}

/** 自定义预设 fixture：默认展开（TC2）+ 可编辑（TC5）+ 可删除（TC7）。 */
const CUSTOM: PiLaunchPreset = {
  id: 'custom:1',
  name: '我的预设',
  builtin: false,
  order: 1,
  toolMode: 'all',
  extensionMode: 'all',
  description: '自定义描述',
}

/** scoped slot 模板：在展开区渲染 detail-slot，内容为 preset.id（TC2 展开态断言载体）。 */
const DETAIL_SLOT = `<template #default="{ preset }"><div data-testid="detail-slot">{{ preset.id }}</div></template>`

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('PresetListSection（列表卡片 + 展开态 + 摘要 + 操作按钮）', () => {
  const listProps = {
    presets: [BUILTIN, CUSTOM],
    defaultPresetId: 'custom:1',
    restoring: new Set<string>(),
  }

  it('TC1: 渲染预设卡片——名称 + 内置徽章 + 默认徽章（用户可见）', () => {
    wrapper = mount(PresetListSection, {
      props: listProps,
      slots: { default: DETAIL_SLOT },
    })

    const text = wrapper.text()
    // 两个预设名称都渲染
    expect(text).toContain('内置完整')
    expect(text).toContain('我的预设')
    // 内置徽章只出现在内置卡；默认徽章只出现在默认卡（defaultPresetId=custom:1）
    expect(wrapper.findAll('.bg-surface').some((el) => el.text() === '内置')).toBe(true)
    expect(wrapper.findAll('.bg-accent-soft').some((el) => el.text() === '默认')).toBe(true)
  })

  it('TC2: 展开态——自定义默认展开、内置默认折叠、点击头部切换', async () => {
    wrapper = mount(PresetListSection, {
      props: listProps,
      slots: { default: DETAIL_SLOT },
    })

    // 自定义（custom:1）默认展开 → detail-slot 渲染 + data-state=open
    const customDetail = wrapper.findAll('[data-testid="detail-slot"]')
    expect(customDetail.some((d) => d.text() === 'custom:1')).toBe(true)
    // 内置（builtin:full）默认折叠 → 其 detail-slot 不在 DOM
    expect(customDetail.some((d) => d.text() === 'builtin:full')).toBe(false)

    // 点击内置卡头部（Trigger 内 Button）→ 展开
    const builtinTrigger = wrapper
      .findAll('button')
      .find((b) => b.text().includes('内置完整'))
    expect(builtinTrigger).toBeTruthy()
    await builtinTrigger!.trigger('click')
    await flushPromises()

    const afterClick = wrapper.findAll('[data-testid="detail-slot"]')
    expect(afterClick.some((d) => d.text() === 'builtin:full')).toBe(true)
    // 展开态 Root 标记 data-state=open
    expect(wrapper.findAll('[data-state="open"]').length).toBeGreaterThan(0)
  })

  it('TC3: 折叠态摘要行——工具/扩展 mode 概览拼接（用户可见）', () => {
    wrapper = mount(PresetListSection, {
      props: listProps,
      slots: { default: DETAIL_SLOT },
    })

    const text = wrapper.text()
    // builtin: toolMode=all → 「工具访问策略: 全部可用」；extensionMode=allowlist 3 项 → 「扩展访问策略: 白名单 3 项」
    expect(text).toContain('工具访问策略: 全部可用')
    expect(text).toContain('扩展访问策略: 白名单 3 项')
  })

  it('TC4: 操作按钮 emit——set-default / restore / delete + restoring disabled', async () => {
    wrapper = mount(PresetListSection, {
      props: listProps,
      slots: { default: DETAIL_SLOT },
    })

    // 内置卡（非默认）点「设为默认」→ set-default('builtin:full')
    const setDefaultBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('设为默认'))
    expect(setDefaultBtn).toBeTruthy()
    await setDefaultBtn!.trigger('click')
    expect(wrapper.emitted('set-default')?.[0]).toEqual(['builtin:full'])

    // 内置卡点「恢复默认」→ restore(内置 preset 对象)
    const restoreBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('恢复默认'))
    expect(restoreBtn).toBeTruthy()
    await restoreBtn!.trigger('click')
    expect(wrapper.emitted('restore')?.[0]).toEqual([BUILTIN])

    // 自定义卡点删除（Trash2 图标按钮）→ delete('custom:1')
    const deleteBtn = wrapper.findAll('button').find((b) => b.findComponent(Trash2).exists())
    expect(deleteBtn).toBeTruthy()
    await deleteBtn!.trigger('click')
    expect(wrapper.emitted('delete')?.[0]).toEqual(['custom:1'])
  })

  it('TC4b: restoring 含某 id 时该卡恢复按钮 disabled', () => {
    wrapper = mount(PresetListSection, {
      props: {
        presets: [BUILTIN],
        defaultPresetId: 'custom:1',
        restoring: new Set(['builtin:full']),
      },
      slots: { default: DETAIL_SLOT },
    })

    const restoreBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('恢复默认'))
    expect(restoreBtn?.attributes('disabled')).toBeDefined()
  })
})

describe('PresetDetailSection（详情编辑区 + debounce + 透传）', () => {
  it('TC5: 字段编辑 debounce 后 emit update-field 完整镜像（用户可见输入框）', async () => {
    vi.useFakeTimers()
    wrapper = mount(PresetDetailSection, {
      props: { preset: CUSTOM, disabled: false },
    })

    // 用户可见：名称输入框存在且值为当前 preset.name
    const nameInput = wrapper.find('input')
    expect(nameInput.exists()).toBe(true)
    expect((nameInput.element as HTMLInputElement).value).toBe('我的预设')

    // 输入新值 → 未到 400ms 不 emit
    await nameInput.setValue('新名字')
    expect(wrapper.emitted('update-field')).toBeUndefined()

    // 推进 debounce timer → flush 时 emit 完整镜像
    await vi.advanceTimersByTimeAsync(400)
    const emitted = wrapper.emitted('update-field')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as PiLaunchPreset
    expect(payload.name).toBe('新名字')
    // 完整镜像：其余字段逐字段保留
    expect(payload.id).toBe(CUSTOM.id)
    expect(payload.builtin).toBe(false)
    expect(payload.toolMode).toBe('all')
    expect(payload.extensionMode).toBe('all')
    expect(payload.description).toBe('自定义描述')
  })

  it('TC5b: 内置预设（disabled）输入框禁用不可编辑', () => {
    wrapper = mount(PresetDetailSection, {
      props: { preset: BUILTIN, disabled: true },
    })

    const nameInput = wrapper.find('input')
    expect(nameInput.attributes('disabled')).toBeDefined()
    // ID 输入框恒禁用
    const idInput = wrapper.findAll('input')[1]
    expect(idInput.attributes('disabled')).toBeDefined()
  })

  it('TC6: PresetModeSection 模式变更原样透传 mode-update', async () => {
    wrapper = mount(PresetDetailSection, {
      props: { preset: CUSTOM, disabled: false },
    })

    // 工具模式区点「白名单」（CUSTOM.toolMode=all → allowlist 变更）
    const allowlistBtn = wrapper
      .findAll('button')
      .find((b) => b.text().trim() === '白名单')
    expect(allowlistBtn).toBeTruthy()
    await allowlistBtn!.trigger('click')

    const emitted = wrapper.emitted('mode-update')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ presetId: 'custom:1', toolMode: 'allowlist' })
  })
})

describe('PiPresetsPage（容器集成）', () => {
  it('TC7: 首屏渲染 + 删除确认弹窗流程（用户可见）', async () => {
    presetApiMock.list.mockResolvedValue([BUILTIN, CUSTOM])
    presetApiMock.getDefault.mockResolvedValue('custom:1')
    presetApiMock.remove.mockResolvedValue(undefined)

    const { default: PiPresetsPage } = await import('@/components/settings/preset/PiPresetsPage.vue')
    wrapper = mount(PiPresetsPage)
    await flushPromises()

    // 首屏：标题 + 新建按钮（用户可见）
    // D4 改名：「预设」→「模式」。标题 = settings.menu.preset「模式」；
    // 页描述 = settings.preset.pageDesc「管理模式，配置工具、扩展访问策略与提示词」。
    expect(wrapper.find('h1').text()).toBe('模式')
    expect(wrapper.text()).toContain('管理模式，配置工具、扩展访问策略与提示词')
    const newBtn = wrapper.findAll('button').find((b) => b.text().includes('新建模式'))
    expect(newBtn).toBeTruthy()
    // 列表渲染（经 PresetListSection）
    expect(wrapper.text()).toContain('我的预设')
    expect(presetApiMock.list).toHaveBeenCalled()

    // 删除流程：点自定义卡删除按钮 → ConfirmDialog 弹出 → 确认 → remove 被调
    const deleteBtn = wrapper.findAll('button').find((b) => b.findComponent(Trash2).exists())
    expect(deleteBtn).toBeTruthy()
    await deleteBtn!.trigger('click')
    await flushPromises()

    // 弹窗 Teleport 到 body：标题 + 确认按钮（用户可见）
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('删除 我的预设？')
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('确认删除'),
    )
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    expect(presetApiMock.remove).toHaveBeenCalledWith('custom:1')
    // 弹窗关闭（确认后 confirmDeleteId 清空）
    expect(document.body.textContent ?? '').not.toContain('删除 我的预设？')
  })
})
