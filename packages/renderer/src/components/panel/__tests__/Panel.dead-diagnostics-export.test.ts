/**
 * Panel 死态块诊断导出入口测试（crash-forensics-and-watchdog §3.3 D6 / u3b 验收断言 ⑤）。
 *
 * 背景：D6 死态页入口的「最小挂点」实施期定位——dead 分支在 Panel.vue（panelView.kind
 * === 'dead' 占位，dead 优先级吞掉 conversation 分支，MessageStream 在死态不挂载），
 * impl-plan u3b 行 214「u3b 实施时定位」授权此领地事实修正。入口 = DiagnosticsExportAction
 * 共享组件（与设置页同源，知情确认/三态反馈行为不分叉）。
 *
 * 覆盖：
 *  - dead 态（sessionStore.list status='dead'）→ 死态占位内导出按钮可见（文案走
 *    panel 命名空间「导出诊断信息」）；
 *  - 点击 → 先见知情文案（shared DIAGNOSTIC_EXPORT_PRIVACY_NOTICE）→ 确认后
 *    electronAPI.exportDiagnosticBundle 恰好调用一次（与设置页同一 mock 面）；
 *  - exported → 成功 toast 含保存路径；
 *  - 非 dead 视图不渲染该入口（dead 分支专属，不连坐 conversation/empty）。
 *
 * Mock 策略（Panel.inbound-frame-notice.test.ts 同款最小闭合集）：mock core/chat/session/
 * useNewTaskFlow/useSidebar/useToast/useExtensionUI + lib/ipc（exportDiagnosticBundle 与
 * reportRendererLog；不触 window.electronAPI——B1 IPC 门面）；Panel 与 DiagnosticsExportAction、
 * domain → lib/ipc 链路真实；ConfirmDialog stub（teleport 免处理，先例
 * ProviderPage.test.ts）；真实 Pinia。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/Panel.dead-diagnostics-export.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { DIAGNOSTIC_EXPORT_PRIVACY_NOTICE } from '@taiji/shared'
import Panel from '../Panel.vue'

// ── mock 面 ────────────────────────────────────────────────────────

const reportMock = vi.hoisted(() => vi.fn())

const exportBundleMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  reportRendererLog: reportMock,
  // B1 IPC 门面：导出动作走 domain → lib/ipc，mock 在此拦截（不触 window.electronAPI）
  exportDiagnosticBundle: exportBundleMock,
}))

/** chat store mock：Panel 只消费 readers 面（含 isRespawnPending 过渡条） */
const chatMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => [] as unknown[]),
  isActive: vi.fn(() => false),
  isCompacting: vi.fn(() => false),
  isRespawnPending: vi.fn(() => false),
  // occupancy 投影读口（缺省全 idle，对齐 store.getOccupancy 无记录缺省）
  getOccupancy: vi.fn(() => ({ turn: 'idle', compacting: false, bash: false })),
  failedHistory: new Map<string, boolean>(),
}))
vi.mock('@/stores/chat', () => ({ useChatStore: () => chatMock }))

/** session store mock：dead 判据源 = list 内 status==='dead'（usePanelView isSessionDead） */
const sessionMock = vi.hoisted(() => ({
  list: [] as Array<{ id: string; status: string }>,
}))
vi.mock('@/stores/session', () => ({ useSessionStore: () => sessionMock }))

vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ state: { value: 'idle' }, isActive: { value: false } }),
}))

vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({
    restoreSession: vi.fn(async () => {}),
    retryHistory: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
  }),
}))

const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: toastMock.warning }),
}))

vi.mock('@/composables/useExtensionUI', () => ({
  useExtensionUI: () => ({
    currentFormRequest: { value: undefined as unknown },
    respond: vi.fn(),
    cancel: vi.fn(),
  }),
  formFilter: () => true,
}))

const MessageStreamStub = defineComponent({
  name: 'MessageStream',
  render: () => h('div', { 'data-testid': 'message-stream-stub' }),
})

/** ConfirmDialog stub：open 受控 + description/confirm 同构渲染（teleport 免处理） */
const ConfirmDialogStub = defineComponent({
  name: 'ConfirmDialog',
  props: ['open', 'title', 'description', 'confirmText', 'cancelText', 'variant', 'loading'],
  emits: ['update:open', 'confirm'],
  template: `<div v-if="open" data-testid="confirm-dialog-stub">
    <span data-testid="dialog-description">{{ description }}</span>
    <button data-testid="dialog-confirm" @click="$emit('confirm')">{{ confirmText }}</button>
  </div>`,
})

function mountPanel(sessionId: string) {
  return mount(Panel, {
    props: { panelId: 'p1', sessionId, sessionDir: '/tmp/x' },
    global: {
      plugins: [createPinia()],
      stubs: { MessageStream: MessageStreamStub, Composer: true, Landing: true, FormOverlay: true, ConfirmDialog: ConfirmDialogStub },
    },
  })
}

function exportedFixture(path: string) {
  return { status: 'exported' as const, path, bytes: 1, entryCount: 9, entryNames: ['summary.md'], summary: {} }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionMock.list = []
  setActivePinia(createPinia())
})

describe('Panel 死态块诊断导出入口（D6 / u3b 断言 ⑤）', () => {
  it('dead 态：占位内导出按钮可见（panel 命名空间文案），点击 → 知情文案 → 确认后 IPC 恰好一次', async () => {
    exportBundleMock.mockResolvedValue(exportedFixture('/tmp/taiji-diag-dead.zip'))
    sessionMock.list = [{ id: 's1', status: 'dead' }]

    const wrapper = mountPanel('s1')
    await nextTick()

    // 死态占位可见（sessionDead 文案）+ 导出按钮可见（label 走 panel.panel.exportDiagnostics）
    expect(wrapper.text()).toContain('会话进程已退出')
    const btn = wrapper.find('[data-testid="diagnostics-export-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('导出诊断信息')
    expect(exportBundleMock).not.toHaveBeenCalled()

    // 先知情：确认前不出口
    await btn.trigger('click')
    const dialog = wrapper.find('[data-testid="confirm-dialog-stub"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('[data-testid="dialog-description"]').text()).toBe(DIAGNOSTIC_EXPORT_PRIVACY_NOTICE)

    // 确认 → 与设置页同一 electronAPI.exportDiagnosticBundle
    await dialog.find('[data-testid="dialog-confirm"]').trigger('click')
    await nextTick()
    expect(exportBundleMock).toHaveBeenCalledTimes(1)
    expect(toastMock.info.mock.calls[0]?.[0] as string).toContain('/tmp/taiji-diag-dead.zip')
    wrapper.unmount()
  })

  it('非 dead 视图（empty）不渲染导出入口（dead 分支专属）', async () => {
    sessionMock.list = [] // s1 不在 list → 非 dead → empty-with-session 分支

    const wrapper = mountPanel('s1')
    await nextTick()

    expect(wrapper.find('[data-testid="diagnostics-export-btn"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
