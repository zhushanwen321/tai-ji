/**
 * PiPresetsPage 模式提示词「保存闸门」测试（F2 修复 · must-fix）。
 *
 * 设计依据 `mode-system-composer-density` §6.3 D3b / §7.5 E2（用户裁决 ③）：
 * 模式级「替换」启用后，保存必须二次确认（取消 = 改为仅追加），因为替换段会顶掉 pi 内置行为规范。
 *
 * 缺陷原状（F2）：确认闸只挂在替换卡入口 `onSaveReplace`，追加卡入口直接调写盘；而写盘 payload
 * **恒含两段**（replace + append）→ 追加卡的「保存」可把启用态替换段无确认落盘。本文件把闸门
 * 钉在「唯一写点」上做黑盒验证：追加卡保存 + 替换段 dirty → 必须弹同一确认框、未确认零落盘。
 *
 * 覆盖：追加卡保存（dirty 替换段）零落盘 / 确认后一次落盘且 payload 含两段 / 取消零落盘且改回仅追加 /
 * 替换段未变更时不误拦 / 替换卡入口既有语义不回归。
 * 替换卡入口的等价既有用例在 `src/__tests__/settings/pi-presets-page.test.ts`（本次修复领地外，未改动）。
 *
 * mock 策略：mock 脚手架收敛单源——presetMock 单例 / '@/api' 与 @taiji/ui mock 注册 /
 * beforeEach 接线在 @/__tests__/helpers/preset-page-mock（import 即注册，settings 版同
 * 组件测试共享）；工厂 / 默认 impl / promptPreset fixture 在 @/__tests__/helpers/preset-page-mount。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/preset/__tests__/pi-presets-page.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { PiLaunchPreset } from '@taiji/shared'
import { promptPreset } from '@/__tests__/helpers/preset-page-mount'
import { presetMock, setupPresetPageTest, teardownPresetPage } from '@/__tests__/helpers/preset-page-mock'

import PiPresetsPage from '@/components/settings/preset/PiPresetsPage.vue'
import { usePresetStore } from '@/stores/preset'

let wrapper: ReturnType<typeof mount> | null = null

// mock 注册 + beforeEach 重置（pinia / 默认 impl / toast / transport 桩）单源在
// helpers/preset-page-mock，顶层调用一次
setupPresetPageTest()

afterEach(() => {
  teardownPresetPage(wrapper)
  wrapper = null
})

/** 挂载页面并让「替换段 + 追加段」都进入 dirty 态（追加卡保存按钮因此解禁）。 */
async function mountWithBothSegmentsDirty(): Promise<void> {
  const store = usePresetStore()
  store.setPresets([promptPreset()])
  wrapper = mount(PiPresetsPage, { attachTo: document.body })
  await flushPromises()
  await wrapper.find('[data-testid="preset-prompt-replace-input"]').setValue('draft replace')
  await wrapper.find('[data-testid="preset-prompt-append-input"]').setValue('draft append')
  await flushPromises()
  presetMock.update.mockClear()
}

/** 确认弹窗已 Teleport 到 body：按文案取按钮（无则 undefined）。 */
function dialogButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').includes(text),
  ) as HTMLButtonElement | undefined
}

describe('PiPresetsPage 提示词保存闸门（F2：两卡共用唯一写点）', () => {
  it('追加卡保存 + 替换段 dirty → 弹确认且零落盘（preset.update 不被调用）', async () => {
    await mountWithBothSegmentsDirty()

    await wrapper!.find('[data-testid="preset-prompt-append-save"]').trigger('click')
    await flushPromises()

    // 危险变更被拦下：二次确认可见，且没有任何写盘发生（替换段与追加段都不落盘）
    expect(dialogButton('仍然保存')).toBeTruthy()
    expect(presetMock.update).not.toHaveBeenCalled()
  })

  it('追加卡保存 → 确认 → 一次落盘且 payload 同时含替换段与追加段', async () => {
    await mountWithBothSegmentsDirty()

    await wrapper!.find('[data-testid="preset-prompt-append-save"]').trigger('click')
    await flushPromises()
    dialogButton('仍然保存')!.click()
    await flushPromises()

    expect(presetMock.update).toHaveBeenCalledTimes(1)
    const updated = presetMock.update.mock.calls[0][0] as PiLaunchPreset
    expect(updated.prompt?.replace).toEqual({ enabled: true, prompt: 'draft replace' })
    expect(updated.prompt?.append).toEqual({ enabled: true, prompt: 'draft append' })
  })

  it('追加卡保存 → 取消 → 零落盘，且替换开关改回仅追加（E2 恢复通道）', async () => {
    await mountWithBothSegmentsDirty()

    await wrapper!.find('[data-testid="preset-prompt-append-save"]').trigger('click')
    await flushPromises()
    dialogButton('改为仅追加')!.click()
    await flushPromises()

    // 取消 = 不落盘任何段（避免「取消了替换却悄悄存了追加」的半成功态）
    expect(presetMock.update).not.toHaveBeenCalled()
    // 用户可见：替换开关已关 → 替换输入框 disabled
    expect(
      wrapper!.find('[data-testid="preset-prompt-replace-input"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('替换段相对已保存快照未变更 → 追加卡保存不弹确认，直接落盘一次', async () => {
    const store = usePresetStore()
    store.setPresets([promptPreset()])
    wrapper = mount(PiPresetsPage, { attachTo: document.body })
    await flushPromises()

    // 只改追加段（替换段保持已落盘值 'abc'）→ 无新危险，不该多弹一次确认
    await wrapper.find('[data-testid="preset-prompt-append-input"]').setValue('only append')
    await flushPromises()
    presetMock.update.mockClear()

    await wrapper.find('[data-testid="preset-prompt-append-save"]').trigger('click')
    await flushPromises()

    expect(dialogButton('仍然保存')).toBeFalsy()
    expect(presetMock.update).toHaveBeenCalledTimes(1)
    const updated = presetMock.update.mock.calls[0][0] as PiLaunchPreset
    expect(updated.prompt?.replace).toEqual({ enabled: true, prompt: 'abc' })
    expect(updated.prompt?.append).toEqual({ enabled: true, prompt: 'only append' })
  })

  it('替换卡入口既有语义不回归：未确认零落盘 → 确认后一次落盘', async () => {
    const store = usePresetStore()
    store.setPresets([promptPreset()])
    wrapper = mount(PiPresetsPage, { attachTo: document.body })
    await flushPromises()

    await wrapper.find('[data-testid="preset-prompt-replace-input"]').setValue('new replace text')
    await flushPromises()
    presetMock.update.mockClear()

    await wrapper.find('[data-testid="preset-prompt-replace-save"]').trigger('click')
    await flushPromises()
    expect(dialogButton('仍然保存')).toBeTruthy()
    expect(presetMock.update).not.toHaveBeenCalled()

    dialogButton('仍然保存')!.click()
    await flushPromises()
    expect(presetMock.update).toHaveBeenCalledTimes(1)
    const updated = presetMock.update.mock.calls[0][0] as PiLaunchPreset
    expect(updated.prompt?.replace).toEqual({ enabled: true, prompt: 'new replace text' })
    // 确认后追加段保留当前草稿值（未被误清）
    expect(updated.prompt?.append?.prompt).toBe('de')
  })
})
