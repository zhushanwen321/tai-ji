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
const mockLocalFileRead = vi.fn()

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
  localFileRead: (...args: unknown[]) => mockLocalFileRead(...(args as [string])),
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
  // 缺省：白名单外（未命中白名单读取通道的用例走既有 file.read cwd 通道）
  mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'out_of_whitelist' })
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

describe('useDetailPane · .html 源码态（白名单读取通道，§8.2 S3）', () => {
  it('产物目录文件（cwd 外、白名单内）→ localFile:read 读内容，不落 file.read cwd 守门', async () => {
    const sid = 's1'
    const path = '/Users/demo/.taiji-dev/artifacts/s1/report.html'
    mockLocalFileRead.mockResolvedValue({ ok: true, content: '<html>artifact</html>', truncated: false })

    const sessionId = ref<string | null>(sid)
    const { state, htmlView, htmlPreviewStatus, setHtmlView } = useDetailPane(sessionId)
    useFileTreeStore().selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(htmlPreviewStatus.value).toBe('ready'))

    await setHtmlView('source')
    expect(htmlView.value).toBe('source')
    expect(state.value.status).toBe('content')
    expect(state.value.content).toBe('<html>artifact</html>')
    expect(mockLocalFileRead).toHaveBeenCalledWith(path)
    expect(mockFileRead).not.toHaveBeenCalled()
  })

  it('白名单外项目文件 → 回落 file.read cwd 通道（§5.2「在项目内直接看源码」）', async () => {
    const sid = 's1'
    const path = 'docs/report.html'
    mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'out_of_whitelist' })
    mockFileRead.mockResolvedValue({ content: '<html>project</html>', truncated: false })

    const sessionId = ref<string | null>(sid)
    const { state, setHtmlView, htmlPreviewStatus } = useDetailPane(sessionId)
    useFileTreeStore().selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(htmlPreviewStatus.value).toBe('ready'))

    await setHtmlView('source')
    expect(state.value.status).toBe('content')
    expect(state.value.content).toBe('<html>project</html>')
    expect(mockFileRead).toHaveBeenCalledWith(path, sid)
  })

  it('白名单读取真实失败（not_found）→ 错误态，不静默回落 file.read', async () => {
    const sid = 's1'
    const path = '/Users/demo/.taiji-dev/artifacts/s1/gone.html'
    mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'not_found' })

    const sessionId = ref<string | null>(sid)
    const { state, setHtmlView, htmlPreviewStatus } = useDetailPane(sessionId)
    useFileTreeStore().selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(htmlPreviewStatus.value).toBe('ready'))

    await setHtmlView('source')
    expect(state.value.status).toBe('error')
    expect(mockFileRead).not.toHaveBeenCalled()
  })

  it('源码态加载失败后切回渲染态 → 清掉遗留 error 态（渲染态状态归 htmlPreview 状态机）', async () => {
    const sid = 's1'
    const path = '/Users/demo/.taiji-dev/artifacts/s1/gone.html'
    mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'not_found' })

    const sessionId = ref<string | null>(sid)
    const { state, htmlView, setHtmlView, htmlPreviewStatus } = useDetailPane(sessionId)
    useFileTreeStore().selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(htmlPreviewStatus.value).toBe('ready'))

    await setHtmlView('source')
    expect(state.value.status).toBe('error')

    await setHtmlView('rendered')
    expect(htmlView.value).toBe('rendered')
    expect(state.value.status).toBe('content')
    expect(state.value.error).toBe('')
  })
})
