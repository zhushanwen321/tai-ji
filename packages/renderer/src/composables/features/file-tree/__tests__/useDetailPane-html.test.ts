// @vitest-environment node

/**
 * useDetailPane HTML 渲染态接线单测（chat-html-support §6.4 D4）。
 *
 * 覆盖：
 * - .html 命中 → 默认预览（含变更集卡 forceDiff 入口：渲染态是压倒性意图）
 * - 渲染态不依赖 file.read / git.getDiff（产物目录在 cwd 外，file.read 的 cwd 守门会拒绝）
 * - servable 预检接线（lib/ipc）→ ready（iframe src）/ unavailable（原因）
 *
 * mock 策略：同 src/__tests__/composables/useDetailPane.test.ts（@/api + @/stores/session），
 * 另 mock @/lib/ipc 的 localFileServable 预检通道。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/file-tree/__tests__/useDetailPane-html.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const mockFileRead = vi.fn()
const mockGitGetDiff = vi.fn()
const mockServable = vi.fn()

vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  file: { read: (...args: unknown[]) => mockFileRead(...(args as [string, string?])) },
  git: { getDiff: (...args: unknown[]) => mockGitGetDiff(...(args as [string, string])) },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ list: [{ id: 's1', cwd: '/Users/demo/proj' }] }),
}))
vi.mock('@/lib/ipc', () => ({
  localFileServable: (...args: unknown[]) => mockServable(...(args as [string])),
}))

import { useDetailPane } from '@/composables/features/file-tree/useDetailPane'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer'

function setupSession(sid: string, path: string, status: string): void {
  useFileTreeStore().setGitOverlay(sid, [{ path, xyCode: 'M', status }])
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetSideDrawer()
  vi.clearAllMocks()
  mockServable.mockResolvedValue({ servable: true, size: 2048 })
})

describe('useDetailPane · .html 默认渲染态', () => {
  it('有 git 改动的 .html → 默认 preview（渲染态）+ servable 预检 + iframe src', async () => {
    const sid = 's1'
    const path = 'docs/report.html'
    setupSession(sid, path, 'modified')

    const sessionId = ref<string | null>(sid)
    const { state, htmlPreviewStatus, htmlSrc } = useDetailPane(sessionId)
    useFileTreeStore().selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(htmlPreviewStatus.value).toBe('ready'))

    expect(state.value.kind).toBe('html')
    expect(state.value.viewMode).toBe('preview')
    expect(state.value.status).toBe('content')
    expect(htmlSrc.value).toBe('local-file:///Users/demo/proj/docs/report.html?r=1')
    expect(mockServable).toHaveBeenCalledWith('/Users/demo/proj/docs/report.html')
    // 渲染态不依赖 file.read / git.getDiff（产物目录在 cwd 外的准入由 servable 承担）
    expect(mockFileRead).not.toHaveBeenCalled()
    expect(mockGitGetDiff).not.toHaveBeenCalled()
  })

  it('变更集卡入口（forceDiff）的 .html 仍默认渲染态（diff 经「差异 | 预览」切换到达）', async () => {
    const sid = 's1'
    const path = 'docs/report.html'
    setupSession(sid, path, 'modified')

    useSideDrawer().open('detail', { filePath: path })
    const sessionId = ref<string | null>(sid)
    const { state, htmlPreviewStatus } = useDetailPane(sessionId)
    await nextTick()
    await vi.waitFor(() => expect(htmlPreviewStatus.value).toBe('ready'))

    expect(state.value.viewMode).toBe('preview')
    expect(mockGitGetDiff).not.toHaveBeenCalled()
  })

  it('servable=false → 占位（原因 key）且不开 iframe', async () => {
    mockServable.mockResolvedValue({ servable: false, reason: 'out_of_whitelist' })
    const sid = 's1'
    const path = 'docs/report.html'
    setupSession(sid, path, 'modified')

    const sessionId = ref<string | null>(sid)
    const { htmlPreviewStatus, htmlPreviewReasonKey, htmlSrc } = useDetailPane(sessionId)
    useFileTreeStore().selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(htmlPreviewStatus.value).toBe('unavailable'))

    expect(htmlPreviewReasonKey.value).toBe('panel.detail.htmlReasonOutOfWhitelist')
    expect(htmlSrc.value).toBeNull()
  })

  it('.xml 不受影响：仍走 code 源码态（不触发 servable 预检）', async () => {
    const sid = 's1'
    const path = 'feed.xml'
    setupSession(sid, path, 'modified')
    mockGitGetDiff.mockResolvedValueOnce({ patch: 'diff --git a/feed.xml b/feed.xml\n@@ -1 +1 @@\n-a\n+b', binary: false })

    const sessionId = ref<string | null>(sid)
    const { state } = useDetailPane(sessionId)
    useFileTreeStore().selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.kind).toBe('code')
    expect(state.value.viewMode).toBe('diff')
    expect(mockServable).not.toHaveBeenCalled()
  })
})
