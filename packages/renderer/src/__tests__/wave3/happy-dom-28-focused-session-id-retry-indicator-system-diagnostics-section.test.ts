import RetryIndicator from '@/components/panel/RetryIndicator.vue';
import TerminalToggleButton from '@/components/panel/TerminalToggleButton.vue';
import SystemDiagnosticsSection from '@/components/settings/system/SystemDiagnosticsSection.vue';
import { useSidebar } from '@/composables/features/sidebar/useSidebar';
import type { RetryState } from '@/stores/chat';
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel';
import { useSessionStore } from '@/stores/session';
import { bindBottomDrawerSessionId, useBottomDrawerControl, _resetBottomDrawerForTest } from '@taiji/core/domain/bottom-drawer';
import { type SessionGroup, type SessionSummary, DIAGNOSTIC_EXPORT_PRIVACY_NOTICE } from '@taiji/shared';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { effectScope, ref, defineComponent } from 'vue';

// wave3 簇 [renderer/happy-dom] 4 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/panel/focused-session-id.test.ts
 * - __tests__/panel/retry-indicator.test.ts
 * - __tests__/panel/terminal-toggle-button.test.ts
 * - __tests__/settings/system-diagnostics-section.test.ts
 */

// ======================================================================
// ← __tests__/panel/focused-session-id.test.ts
// ======================================================================

// features 层调用 api 域；本测试只验 focusedSessionId 派生，mock 成 no-op。
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }) },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
  },
}))

function makeSummary(id: string): SessionSummary {
  return { id, label: `session-${id}`, cwd: '/proj', status: 'idle', lastActiveAt: 1 }
}

function seedSession(s: SessionSummary): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: s.cwd, sessions: [s] }
  store.applySnapshot({ groups: [group] })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('focusedSessionId 派生（单 panel：session 切换 → UI 焦点 session）', () => {
  it('T1: 单 panel，leaf.sessionId=s1 → focusedSessionId=s1', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    panel.loadSession(ROOT_PANEL_ID, 's1')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    expect(sidebar.focusedSessionId.value).toBe('s1')
    scope.stop()
  })

  it('T4: focusedSession 按 focusedSessionId 查 session.list（FileView label 数据源）', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    panel.loadSession(ROOT_PANEL_ID, 's1')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    expect(sidebar.focusedSession.value?.label).toBe('session-s1')
    // focusedSessionId 指向不存在的 session → focusedSession=null
    panel.loadSession(ROOT_PANEL_ID, 'nonexistent')
    expect(sidebar.focusedSession.value).toBe(null)
    scope.stop()
  })
})

// ======================================================================
// ← __tests__/panel/retry-indicator.test.ts
// ======================================================================

function mountIndicator(state: RetryState | undefined) {
  return mount(RetryIndicator, { props: { state } })
}

const fullState: RetryState = {
  attempt: 1,
  maxAttempts: 3,
  delayMs: 800,
  errorMessage: 'The operation timed out.',
}

describe('RetryIndicator', () => {
  it('state=undefined 不渲染（store 清态后 v-if 消失）', () => {
    const w = mountIndicator(undefined)
    expect(w.find('div').exists()).toBe(false)
  })

  it('渲染轻行：根行无横幅底色与边框（去 bg-warn-soft / border 大色块）', () => {
    const w = mountIndicator(fullState)
    const root = w.get('div')
    expect(root.classes()).not.toContain('bg-warn-soft')
    expect(root.classes().some((c) => c.startsWith('border'))).toBe(false)
  })

  it('warn 语义只上图标与「重试中」chip（bg-warn-soft 小胶囊）', () => {
    const w = mountIndicator(fullState)
    const icon = w.get('svg')
    expect(icon.classes()).toContain('animate-spin')
    expect(icon.classes()).toContain('text-warn')
    const chip = w.findAll('span').find((s) => s.text() === '重试中')
    expect(chip).toBeDefined()
    expect(chip!.classes()).toContain('bg-warn-soft')
    expect(chip!.classes()).toContain('text-warn')
  })

  it('尝试次数 mono 文本 N/M；errorMessage 缩略尾展示', () => {
    const w = mountIndicator(fullState)
    const counter = w.findAll('span').find((s) => s.text() === '1/3')
    expect(counter).toBeDefined()
    expect(counter!.classes()).toContain('font-mono')
    const err = w.findAll('span').find((s) => s.text() === 'The operation timed out.')
    expect(err).toBeDefined()
    expect(err!.classes()).toContain('truncate')
  })

  it('缺 maxAttempts 时只显 attempt 数字；缺 errorMessage 时无缩略尾', () => {
    const w = mountIndicator({ attempt: 2 })
    expect(w.findAll('span').some((s) => s.text() === '2')).toBe(true)
    expect(w.text()).not.toContain('/')
    const chip = w.findAll('span').find((s) => s.text() === '重试中')
    expect(chip).toBeDefined()
    // 仅 chip + 计数两个 span（无错误消息缩略尾）
    expect(w.findAll('span')).toHaveLength(2)
  })

  it('hover title 携带上一次失败原因', () => {
    const w = mountIndicator(fullState)
    expect(w.get('div').attributes('title')).toContain('The operation timed out.')
  })
})

// ======================================================================
// ← __tests__/panel/terminal-toggle-button.test.ts
// ======================================================================

const SESSION = 's-terminal-toggle'

const sid = ref<string | null>(null)

beforeEach(() => {
  sid.value = SESSION
  bindBottomDrawerSessionId(sid)
  _resetBottomDrawerForTest()
})

afterEach(() => {
  _resetBottomDrawerForTest()
})

describe('TerminalToggleButton（顶栏鼠标路径入口，三卡化 2026-10-04 迁 PanelHeader）', () => {
  it('按钮常驻可点：title 文案 + aria-pressed 派生视图开合态；点击切换底抽屉（toggleBottomDrawer 同源）', async () => {
    const wrapper = mount(TerminalToggleButton)
    const button = wrapper.find('[data-testid="terminal-toggle-button"]')
    expect(button.exists()).toBe(true)
    expect(button.attributes('title')).toBe('开关终端')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(useBottomDrawerControl().isOpen.value).toBe(false)

    await button.trigger('click')
    await flushPromises()
    expect(useBottomDrawerControl().isOpen.value).toBe(true)
    expect(wrapper.find('[data-testid="terminal-toggle-button"]').attributes('aria-pressed')).toBe('true')

    await wrapper.find('[data-testid="terminal-toggle-button"]').trigger('click')
    await flushPromises()
    expect(useBottomDrawerControl().isOpen.value).toBe(false)
    expect(wrapper.find('[data-testid="terminal-toggle-button"]').attributes('aria-pressed')).toBe('false')
  })

  it('关闭分支焦点回 composer（§6.7 焦点契约，鼠标路径与键盘通道同款）；打开分支不抢焦点', async () => {
    document.body.innerHTML = '<div class="composer-box" data-testid="composer-box" tabindex="0"></div>'
    const composer = document.querySelector('[data-testid="composer-box"]')
    try {
      const wrapper = mount(TerminalToggleButton)
      const button = () => wrapper.find('[data-testid="terminal-toggle-button"]')

      // 打开分支：不调 focusComposer（焦点不迁移）
      await button().trigger('click')
      await flushPromises()
      expect(useBottomDrawerControl().isOpen.value).toBe(true)
      expect(document.activeElement).not.toBe(composer)

      // 关闭分支：焦点回 composer（§6.7 任一容器关闭后焦点回 composer）
      await button().trigger('click')
      await flushPromises()
      expect(useBottomDrawerControl().isOpen.value).toBe(false)
      expect(document.activeElement).toBe(composer)
    } finally {
      document.body.innerHTML = ''
    }
  })

})

// ======================================================================
// ← __tests__/settings/system-diagnostics-section.test.ts
// ======================================================================

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
