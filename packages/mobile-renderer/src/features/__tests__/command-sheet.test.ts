// CommandSheet 组件级单测（remote-use-mobile-v2 §7.2 命令面板行 / §6.13）。
//
// 锁定「命令插入输入框（不直接执行）」语义：列表项点击 → composerInjectionStore
// 一次性通道注入 `/name ` 文本（斜杠前缀 + 尾随空格，用户补参数后自行发送）+ emit close；
// 清单 = fetchSessionCommands 打开即拉（每次打开刷新），拉取失败降级空态不拖垮核心。
//
// mock 策略（对齐 model-sheet.test 先例）：app-runtime 部分模块级 mock——清单拉取
// fetchSessionCommands 替换；composerInjectionStore 用真实 store（唯一写入口
// requestInjection 断言，消费即清的通道语义由 core 单测承载）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CommandSheet from '../CommandSheet.vue'
import { i18n } from '../../i18n'
import { composerInjectionStore } from '../../shell/app-runtime'

const { fetchCommandsMock } = vi.hoisted(() => ({
  fetchCommandsMock: vi.fn<() => Promise<Array<{ name: string; description?: string; source: string }>>>(),
}))
vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  return { ...actual, fetchSessionCommands: fetchCommandsMock }
})

const SID = 'sid-command-sheet'

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

async function mountSheet(): Promise<VueWrapper> {
  const wrapper = mount(CommandSheet, {
    props: { open: true, sessionId: SID },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  fetchCommandsMock.mockReset().mockResolvedValue([])
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('CommandSheet（§6.13 命令插入输入框）', () => {
  it('打开即拉清单：命令行渲染（斜杠名 + 描述），按会话拉取', async () => {
    fetchCommandsMock.mockResolvedValue([
      { name: 'plan', description: '规划模式', source: 'skill:dev' },
      { name: 'review', source: 'skill:qa' },
    ])
    const wrapper = await mountSheet()

    expect(fetchCommandsMock).toHaveBeenCalledWith(SID)
    const row = bodyEl('command-sheet-item-plan')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('/plan')
    expect(row!.textContent).toContain('规划模式')
    // 无描述命令：仅名（描述分支 v-if 不在场）
    expect(bodyEl('command-sheet-item-review')!.textContent).toContain('/review')
    wrapper.unmount()
  })

  it('列表项点击 → 注入通道 requestInjection（target=current + 斜杠前缀 + 尾随空格）+ emit close', async () => {
    fetchCommandsMock.mockResolvedValue([{ name: 'plan', source: 'skill:dev' }])
    const wrapper = await mountSheet()

    bodyEl('command-sheet-item-plan')!.click()
    await flushPromises()

    const pending = composerInjectionStore.pendingInjection.value
    expect(pending?.target).toBe('current')
    expect(pending?.sessionId).toBe(SID)
    expect(pending?.text).toBe('/plan ')
    expect(wrapper.emitted('close')).toBeTruthy()
    // 通道消费清理（跨用例隔离：pendingInjection 是模块级 store 槽位，clearInjection 唯一清出口）
    composerInjectionStore.clearInjection()
    wrapper.unmount()
  })

  it('拉取失败降级空态：loaded 后空清单提示在场（辅助流不拖垮核心，§7.4）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchCommandsMock.mockRejectedValue(new Error('rpc failed'))

    const wrapper = await mountSheet()
    await flushPromises()

    expect(bodyEl('command-sheet-empty')).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    wrapper.unmount()
  })

  it('清单为空：空态提示在场', async () => {
    fetchCommandsMock.mockResolvedValue([])
    const wrapper = await mountSheet()

    expect(bodyEl('command-sheet-empty')).not.toBeNull()
    wrapper.unmount()
  })
})
