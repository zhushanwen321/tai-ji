/**
 * SystemDiagnosticsSection + DiagnosticsExportAction 测试（crash-forensics-and-watchdog
 * §3.3 D6 / u3b，三视角）。
 *
 * 覆盖（u3b 验收断言 ①-④ + canceled 回归）：
 *  - ① 设置页诊断分区渲染：GroupCard 标题「诊断」+ 导出按钮可见（用户可见 DOM）；
 *  - ② 知情确认时序：点击导出按钮 → 先见知情文案（shared DIAGNOSTIC_EXPORT_PRIVACY_NOTICE
 *    原样，D6「本机路径」「会话标识」要素）→ 确认前 exportDiagnosticBundle 不被调 →
 *    确认后恰好一次（vi.mock('@/lib/ipc')，走真实 domain → lib/ipc 链路）；
 *  - ③ exported 态：成功 toast 含保存路径 + 对话框关闭；
 *  - ④ error 态：错误 toast 可见且含 errno / message / 重试指引（可操作信息），
 *    对话框保持开启（确认按钮即重试）；
 *  - canceled 态（回归）：静默关对话框，不弹任何 toast。
 *
 * mock 策略：
 *  - lib/ipc：vi.mock('@/lib/ipc') 覆盖 exportDiagnosticBundle（B1 IPC 门面——测试不触
 *    window.electronAPI；importOriginal 展开其余导出，未 mock 函数走无 IPC 降级无副作用）；
 *  - ConfirmDialog stub（ProviderPage.test.ts 先例）：对话框经 DialogPortal（Teleport 到
 *    body），stub 渲染 description/confirm 的同构 DOM 使断言无需处理 teleport；
 *  - toast：useToast mock 捕获 info/error；i18n 走全局 setup（t() 按 zh-CN 解析）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/system-diagnostics-section.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { DIAGNOSTIC_EXPORT_PRIVACY_NOTICE } from '@taiji/shared'

const exportBundleMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

// mock '@/lib/ipc'（B1 IPC 门面：组件链是 domain → lib/ipc，不触 window.electronAPI）。
// importOriginal 展开其余导出（lib/ipc 顶层捕获 window.electronAPI，测试环境为 undefined，
// 未 mock 的函数全走无 IPC 降级路径，无副作用）。
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  exportDiagnosticBundle: exportBundleMock,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: toastMock.warning }),
}))

import SystemDiagnosticsSection from '@/components/settings/system/SystemDiagnosticsSection.vue'

/** ConfirmDialog stub：open 受控 + description/confirm 同构渲染（teleport 免处理）。 */
const ConfirmDialogStub = defineComponent({
  name: 'ConfirmDialog',
  props: ['open', 'title', 'description', 'confirmText', 'cancelText', 'variant', 'loading'],
  emits: ['update:open', 'confirm'],
  template: `<div v-if="open" data-testid="confirm-dialog-stub">
    <span data-testid="dialog-title">{{ title }}</span>
    <span data-testid="dialog-description">{{ description }}</span>
    <button data-testid="dialog-confirm" @click="$emit('confirm')">{{ confirmText }}</button>
  </div>`,
})

function mountSection() {
  return mount(SystemDiagnosticsSection, {
    global: { stubs: { ConfirmDialog: ConfirmDialogStub } },
  })
}

/** exported 三态结果（组件仅消费 status/path，字段按 shared 契约给全）。 */
function exportedFixture(path: string) {
  return {
    status: 'exported' as const,
    path,
    bytes: 2048,
    entryCount: 9,
    entryNames: ['summary.md'],
    summary: {
      exportedAt: '2026-09-10T00:00:00.000Z',
      appVersion: '0.0.0-test',
      piVersion: 'unknown',
      platform: 'darwin',
      trippedConditionIds: [],
      evaluatedConditionCount: 20,
      entryCount: 9,
      missingEntries: [],
      privacyNotice: DIAGNOSTIC_EXPORT_PRIVACY_NOTICE,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SystemDiagnosticsSection（u3b 诊断导出入口）', () => {
  it('① 分区渲染：GroupCard「诊断」标题 + 导出按钮可见', () => {
    const wrapper = mountSection()

    expect(wrapper.find('[data-testid="diagnostics-section"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('诊断')
    const btn = wrapper.find('[data-testid="diagnostics-export-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('导出诊断包')
    wrapper.unmount()
  })

  it('② 知情确认时序：点击按钮先见知情文案，确认后 exportDiagnosticBundle 恰好调用一次', async () => {
    exportBundleMock.mockResolvedValue(exportedFixture('/tmp/taiji-diag.zip'))
    const wrapper = mountSection()

    await wrapper.find('[data-testid="diagnostics-export-btn"]').trigger('click')

    // 先知情：对话框可见，文案 = shared SSOT 常量原样（本机路径/会话标识要素）
    const dialog = wrapper.find('[data-testid="confirm-dialog-stub"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('[data-testid="dialog-description"]').text()).toBe(DIAGNOSTIC_EXPORT_PRIVACY_NOTICE)
    // 知情确认前不触发导出
    expect(exportBundleMock).not.toHaveBeenCalled()

    await dialog.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(exportBundleMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('③ exported 态：成功 toast 含保存路径，对话框关闭', async () => {
    exportBundleMock.mockResolvedValue(exportedFixture('/tmp/taiji-diag.zip'))
    const wrapper = mountSection()

    await wrapper.find('[data-testid="diagnostics-export-btn"]').trigger('click')
    await wrapper.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(toastMock.info).toHaveBeenCalledTimes(1)
    expect(toastMock.info.mock.calls[0][0] as string).toContain('/tmp/taiji-diag.zip')
    expect(wrapper.find('[data-testid="confirm-dialog-stub"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('④ error 态：错误 toast 含 errno/message/重试指引，对话框保持开启可重试', async () => {
    exportBundleMock.mockResolvedValue({
      status: 'error',
      error: { code: 'ENOSPC', message: 'no space left on device' },
    })
    const wrapper = mountSection()

    await wrapper.find('[data-testid="diagnostics-export-btn"]').trigger('click')
    await wrapper.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    const msg = toastMock.error.mock.calls[0][0] as string
    expect(msg).toContain('ENOSPC')
    expect(msg).toContain('no space left on device')
    expect(msg).toContain('重试')
    // 对话框保持开启：确认按钮即重试入口（设计失败路径「重试」语义）
    expect(wrapper.find('[data-testid="confirm-dialog-stub"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('canceled 态（回归）：静默关对话框，不弹 toast', async () => {
    exportBundleMock.mockResolvedValue({ status: 'canceled' })
    const wrapper = mountSection()

    await wrapper.find('[data-testid="diagnostics-export-btn"]').trigger('click')
    await wrapper.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(toastMock.info).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="confirm-dialog-stub"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
