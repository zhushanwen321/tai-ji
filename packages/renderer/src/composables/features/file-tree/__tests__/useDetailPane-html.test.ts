// @vitest-environment node

/**
 * useDetailPane .html 行为回归单测（chat-html-support §6.4 D4，v16 抽屉渲染态退役）。
 *
 * 覆盖：
 * - .html 恢复实施前分发行为：git 改动 → diff（变更集卡 forceDiff 入口同）；无改动 →
 *   preview 源码（file.read cwd 通道）——不再有「默认渲染态」与 servable 预检
 * - 产物目录文件（cwd 外绝对路径）→ localFile:read 白名单通道（变更集入口可打开产物文件，
 *   §6.9 D9 两通道语义保留）
 * - 白名单读取真实失败（not_found）→ 错误态，不静默回落
 * - servable 预检通道退役：useDetailPane 不再触碰 localFileServable
 *
 * mock 策略：同 src/__tests__/composables/useDetailPane.test.ts（@/api + @/stores/session），
 * 另 mock @/lib/ipc 的 localFileRead / localFileServable。
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

/** pane 响应式 state 类型（从 useDetailPane 返回签名派生，类型未独立导出）。 */
type PaneStateRef = ReturnType<typeof useDetailPane>['state']

function setupSession(sid: string, path: string, status: string): void {
  useFileTreeStore().setGitOverlay(sid, [{ path, xyCode: 'M', status }])
}

/**
 * 挂 pane 并驱动到分发落定（树选中入口；path = null 表示经 useSideDrawer.open 入口，
 * 不走 selectFile）。等到 state.status 到达期望终态（content / error）后返回响应式 state。
 */
async function openPane(sid: string, path: string | null, expectStatus: 'content' | 'error' = 'content'): Promise<PaneStateRef> {
  const sessionId = ref<string | null>(sid)
  const { state } = useDetailPane(sessionId)
  if (path !== null) useFileTreeStore().selectFile(path)
  await nextTick()
  await vi.waitFor(() => expect(state.value.status).toBe(expectStatus))
  return state
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetSideDrawer()
  vi.clearAllMocks()
  // 缺省：白名单外（未命中白名单读取通道的用例走既有 file.read cwd 通道）
  mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'out_of_whitelist' })
})

describe('useDetailPane · .html 恢复源码分发（渲染态退役）', () => {
  it('有 git 改动的 .html → 默认 diff（实施前行为；渲染面归消息流内联容器）', async () => {
    const sid = 's1'
    const path = 'docs/report.html'
    setupSession(sid, path, 'modified')
    mockGitGetDiff.mockResolvedValue({ patch: 'diff --git a/docs/report.html b/docs/report.html\n@@ -1 +1 @@\n-a\n+b', binary: false })

    const state = await openPane(sid, path)

    expect(state.value.kind).toBe('code')
    expect(state.value.viewMode).toBe('diff')
    expect(mockGitGetDiff).toHaveBeenCalled()
  })

  it('变更集卡入口（forceDiff）的 .html → diff（与 code 类文件同语义）', async () => {
    const sid = 's1'
    const path = 'docs/report.html'
    setupSession(sid, path, 'modified')
    mockGitGetDiff.mockResolvedValue({ patch: 'diff --git a/docs/report.html b/docs/report.html\n@@ -1 +1 @@\n-a\n+b', binary: false })

    useSideDrawer().open('detail', { filePath: path })
    const state = await openPane(sid, null)

    expect(state.value.kind).toBe('code')
    expect(state.value.viewMode).toBe('diff')
  })

  it('无 git 改动的 .html → preview 源码（file.read cwd 通道），servable 预检不再被触碰', async () => {
    const sid = 's1'
    const path = 'docs/report.html'
    mockFileRead.mockResolvedValue({ content: '<html>project</html>', truncated: false })

    const state = await openPane(sid, path)

    expect(state.value.kind).toBe('code')
    expect(state.value.viewMode).toBe('preview')
    expect(state.value.content).toBe('<html>project</html>')
    expect(mockFileRead).toHaveBeenCalledWith(path, sid)
    // 渲染态退役：servable 预检通道不再是抽屉的编排步骤
    expect(mockServable).not.toHaveBeenCalled()
  })

  it('.xml 不受影响：仍走 code 类 + diff', async () => {
    const sid = 's1'
    const path = 'feed.xml'
    setupSession(sid, path, 'modified')
    mockGitGetDiff.mockResolvedValueOnce({ patch: 'diff --git a/feed.xml b/feed.xml\n@@ -1 +1 @@\n-a\n+b', binary: false })

    const state = await openPane(sid, path)

    expect(state.value.kind).toBe('code')
    expect(state.value.viewMode).toBe('diff')
  })
})

describe('useDetailPane · 产物目录文件读取（白名单通道保留，§6.9 D9）', () => {
  it('cwd 外绝对路径（产物目录）→ localFile:read 读内容，不落 file.read cwd 守门', async () => {
    const sid = 's1'
    const path = '/Users/demo/.taiji-dev/artifacts/s1/report.html'
    mockLocalFileRead.mockResolvedValue({ ok: true, content: '<html>artifact</html>', truncated: false })

    const state = await openPane(sid, path)

    expect(state.value.kind).toBe('code')
    expect(state.value.viewMode).toBe('preview')
    expect(state.value.content).toBe('<html>artifact</html>')
    expect(mockLocalFileRead).toHaveBeenCalledWith(path)
    expect(mockFileRead).not.toHaveBeenCalled()
  })

  it('cwd 外 `~` 形态路径同样走白名单通道', async () => {
    const sid = 's1'
    const path = '~/.taiji/artifacts/s1/report.html'
    mockLocalFileRead.mockResolvedValue({ ok: true, content: '<html>tilde</html>', truncated: false })

    const state = await openPane(sid, path)

    expect(mockLocalFileRead).toHaveBeenCalledWith(path)
    expect(mockFileRead).not.toHaveBeenCalled()
  })

  it('白名单读取真实失败（not_found）→ 错误态，不静默回落 file.read', async () => {
    const sid = 's1'
    const path = '/Users/demo/.taiji-dev/artifacts/s1/gone.html'
    mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'not_found' })

    const state = await openPane(sid, path, 'error')

    expect(state.value.error).toBe('文件不存在')
    expect(mockFileRead).not.toHaveBeenCalled()
  })

  it('白名单外（out_of_whitelist）→ 回落 file.read cwd 通道；通道不可用（reject）同款回落', async () => {
    const sid = 's1'
    const path = '/opt/outside/report.html'
    mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'out_of_whitelist' })
    mockFileRead.mockResolvedValue({ content: '<html>fallback</html>', truncated: false })

    const state = await openPane(sid, path)

    expect(state.value.content).toBe('<html>fallback</html>')
    expect(mockLocalFileRead).toHaveBeenCalledWith(path)
    expect(mockFileRead).toHaveBeenCalledWith(path, sid)
  })
})
