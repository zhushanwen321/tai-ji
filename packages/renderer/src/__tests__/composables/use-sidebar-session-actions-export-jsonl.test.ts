// @vitest-environment node

/**
 * useSidebarSessionActions.onExportSessionJsonl 测试（sidebar 导出 JSONL handler）。
 *
 * 锁定：
 * - EXH1: exported → 调 exportSessionJsonl IPC（payload 原样透传）+ toast info 携带
 *         sidebar.exportJsonlSuccess 文案与保存路径
 * - EXH2: error → toast error 携带 sidebar.exportJsonlFailed 文案与错误码，不抛出
 * - EXH3: canceled → 静默（用户取消保存对话框 = 导出未发生，与 DiagnosticsExportAction
 *         同口径），双 toast 通道均不出声
 *
 * mock 策略：mock '@/api/domains/session-export'（IPC 域函数）+ useToast；其余依赖
 * （pinia store / i18n）走全局 setup 与真实 pinia。对齐 use-sidebar-session-actions-forcequit
 * 测试形态。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-sidebar-session-actions-export-jsonl.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const exportSessionJsonlMock = vi.hoisted(() => vi.fn())
const toastErrorMock = vi.hoisted(() => vi.fn())
const toastSuccessMock = vi.hoisted(() => vi.fn())
const toastInfoMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/domains/session-export', () => ({
  exportSessionJsonl: exportSessionJsonlMock,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, success: toastSuccessMock, info: toastInfoMock }),
}))

import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'

/** 最小注入：onExportSessionJsonl 不消费这些依赖，stub 即可 */
function makeOptions() {
  return {
    selectSession: vi.fn(),
    restoreSession: vi.fn(),
    newSession: vi.fn(),
    loadSessions: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteFolder: vi.fn(),
    assignSessionToProject: vi.fn(),
    renameOpen: ref(false),
    targetSessionId: ref(''),
  }
}

const PAYLOAD = {
  sessionId: 'exp-1',
  sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
  suggestedName: '我的会话.jsonl',
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useSidebarSessionActions.onExportSessionJsonl', () => {
  it('EXH1: exported → IPC 域函数收到原样 payload + toast「会话已导出到 <path>」', async () => {
    exportSessionJsonlMock.mockResolvedValueOnce({ status: 'exported', path: '/Users/x/导出.jsonl', bytes: 128 })
    const actions = useSidebarSessionActions(makeOptions())

    await actions.onExportSessionJsonl(PAYLOAD)

    expect(exportSessionJsonlMock).toHaveBeenCalledWith(PAYLOAD)
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(String(toastInfoMock.mock.calls[0][0])).toContain('会话已导出到')
    expect(String(toastInfoMock.mock.calls[0][0])).toContain('/Users/x/导出.jsonl')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('EXH2: error → toast「导出失败（<code>）：<message>」，不向上抛', async () => {
    exportSessionJsonlMock.mockResolvedValueOnce({
      status: 'error',
      error: { code: 'EPATH', message: '会话文件路径不在会话数据目录内，已拒绝导出' },
    })
    const actions = useSidebarSessionActions(makeOptions())

    await expect(actions.onExportSessionJsonl(PAYLOAD)).resolves.toBeUndefined()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('导出失败')
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('EPATH')
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('EXH3: canceled → 静默（双 toast 通道均不出声）', async () => {
    exportSessionJsonlMock.mockResolvedValueOnce({ status: 'canceled' })
    const actions = useSidebarSessionActions(makeOptions())

    await actions.onExportSessionJsonl(PAYLOAD)

    expect(toastInfoMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})
