// @vitest-environment node
import { apiProjectMock } from '@/__tests__/helpers/api-facade-mock';
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer';
import { useDetailPane } from '@/composables/features/file-tree/useDetailPane';
import { useExtensionUIStore } from '@/stores/extension-ui';
import { useFileTreeStore } from '@/stores/fileTree';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, nextTick } from 'vue';

// wave3 簇 [renderer/node] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - composables/features/file-tree/__tests__/useDetailPane-html.test.ts
 * - stores/__tests__/extension-ui-permission.test.ts
 */

// ======================================================================
// ← composables/features/file-tree/__tests__/useDetailPane-html.test.ts
// ======================================================================

const mockFileRead = vi.fn()
const mockGitGetDiff = vi.fn()
const mockServable = vi.fn()
const mockLocalFileRead = vi.fn()

vi.mock('@/api', () => ({
  project: apiProjectMock(),
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
  // main W3 起双参（per-session 分区）：selectFile(sid, path)
  if (path !== null) useFileTreeStore().selectFile(sid, path)
  await nextTick()
  await vi.waitFor(() => expect(state.value.status).toBe(expectStatus), { interval: 1 })
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
  it('有 git 改动的 .html → 默认 diff（实施前行为；渲染范围归消息流内联容器）', async () => {
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

describe('useDetailPane · drawer 入口位置分流（forceDiff 仅限 cwd 内）', () => {
  it('产物目录绝对路径经 drawer 入口 → preview + localFile:read，不发 git.getDiff', async () => {
    const sid = 's1'
    const path = '/Users/demo/.taiji-dev/artifacts/s1/report.html'
    mockLocalFileRead.mockResolvedValue({ ok: true, content: '<html>artifact</html>', truncated: false })

    useSideDrawer().open('detail', { filePath: path })
    const state = await openPane(sid, null)

    expect(state.value.viewMode).toBe('preview')
    expect(state.value.content).toBe('<html>artifact</html>')
    expect(mockLocalFileRead).toHaveBeenCalledWith(path)
    // 分流防误伤断言：cwd 外不走 forceDiff 的 diff 加载（免必空的 git diff 往返）
    expect(mockGitGetDiff).not.toHaveBeenCalled()
  })

  it('cwd 内绝对路径经 drawer 入口 → forceDiff 语义保持（diff 模式）', async () => {
    const sid = 's1'
    const path = '/Users/demo/proj/docs/report.html'
    mockGitGetDiff.mockResolvedValue({ patch: 'diff --git a/docs/report.html b/docs/report.html\n@@ -1 +1 @@\n-a\n+b', binary: false })

    useSideDrawer().open('detail', { filePath: path })
    const state = await openPane(sid, null)

    expect(state.value.viewMode).toBe('diff')
    expect(mockGitGetDiff).toHaveBeenCalled()
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

// ======================================================================
// ← stores/__tests__/extension-ui-permission.test.ts
// ======================================================================

/** permission 审批请求形状（runtime event-adapter translatePlainDialogRequest 附加键后的
 *  extension.ui_request 广播 payload；CompanionBand 直连消费同款形状）。 */
function mkPermissionReq(requestId: string): Record<string, unknown> {
  return {
    sessionId: 's1',
    requestId,
    dialogKind: 'select',
    title: '[pi-permission] Approval required\nTool: bash\nCommand: echo hi',
    permission: true,
  }
}

/** 普通 select（无 permission 键——第三方扩展 / permission 扩展被禁用形态，行为回落现状）。 */
function mkPlainSelectReq(requestId: string): Record<string, unknown> {
  return { sessionId: 's1', requestId, dialogKind: 'select', title: 'Pick one', options: ['a', 'b'] }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('extension-ui store — hasPendingBlockingOverlay permission 键（U9/S4）', () => {
  it('permission 键命中 waiting 判定（未水合会话缺口的修复面：无消息分区也能经 store 命中）', () => {
    const store = useExtensionUIStore()
    expect(store.hasPendingBlockingOverlay('s1')).toBe(false)
    store.applyRecords('s1', [mkPermissionReq('req-1') as never])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
  })

  it('respond 移除后判定回落 false（等待消退联动）', () => {
    const store = useExtensionUIStore()
    store.applyRecords('s1', [mkPermissionReq('req-1') as never])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
    store.removeRequest('s1', 'req-1')
    expect(store.hasPendingBlockingOverlay('s1')).toBe(false)
  })

  it('既有键不回归：form / planReview 仍命中；普通 select 与 false 值不命中', () => {
    const store = useExtensionUIStore()
    store.applyRecords('s1', [
      { sessionId: 's1', requestId: 'r-form', dialogKind: 'select', form: true } as never,
    ])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
    store.clearSession('s1')
    store.applyRecords('s1', [
      { sessionId: 's1', requestId: 'r-plan', dialogKind: 'select', planReview: true } as never,
    ])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
    store.clearSession('s1')
    store.applyRecords('s1', [
      mkPlainSelectReq('r-plain') as never,
      { sessionId: 's1', requestId: 'r-false', dialogKind: 'select', permission: false } as never,
    ])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(false)
  })

  it('per-session 分区隔离（ADR-0049）：s1 的 permission 挂起不影响 s2 判定', () => {
    const store = useExtensionUIStore()
    store.applyRecords('s1', [mkPermissionReq('req-1') as never])
    expect(store.hasPendingBlockingOverlay('s2')).toBe(false)
  })
})
