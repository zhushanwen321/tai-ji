/**
 * drawer 写入入口测试（W3, U10-U12）。
 *
 * 验证三个入口点击后正确写入 composerInjectionStore.pendingInjection：
 *  - U10 DetailPane header 按钮注入 path（无行范围，target=current）
 *  - U11 DiffView 行号点击 emit line-inject（单行）
 *  - U12 GitPanel 文件名注入按钮注入 path-only
 *
 * 策略：stub 重依赖（useDetailPane/git/shiki），mount 组件，找按钮 click，
 * 断言 composerInjectionStore.pendingInjection 字段。store 用真实 pinia。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── stub 重依赖 ──
vi.mock('@/composables/features/file-tree/useDetailPane', () => ({
  useDetailPane: () => ({
    state: ref({ path: 'src/foo.ts', content: '', viewMode: 'preview', kind: 'code', status: 'success', hasGitChange: false }),
    toggleView: vi.fn(),
    sessionCwd: () => '/cwd',
  }),
}))
vi.mock('@/composables/panel/useCopy', () => ({
  useCopy: () => ({ copied: ref(null), copy: vi.fn() }),
}))
vi.mock('@/composables/logic/file-type', () => ({ extToLang: () => 'ts' }))
vi.mock('@/lib/path-utils', () => ({ resolvePreviewPath: () => ({ absolute: '/cwd/src/foo.ts' }) }))
vi.mock('@/components/panel/detail-renderers/CodeBlock.vue', () => ({
  default: { template: '<div />' },
}))

// [w6 chat-ui-and-shell T7] DetailPane 壳 provide 真 deps（useChatViewDeps）→ mock 该装配器，
// 容器内 ui MarkdownRenderer 等经 deps inject 消费 mock（原 vi.mock 旧组件路径失效，改模板按名 stub）。
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())

// GitPanel 重依赖
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  useGitStatusOrFail: () => ({
    result: ref({
      isRepo: true,
      hasConflict: false,
      branch: 'main',
      files: [{ path: 'src/foo.ts', status: 'M' }],
      stats: { add: 1, del: 0 },
      staged: new Set(),
      stagedCount: 0,
      unstagedCount: 1,
      ahead: 0,
      behind: 0,
    }),
    state: ref('dirty'),
    pending: ref(false),
    error: ref(null),
    commitMsg: ref(''),
    refresh: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    commit: vi.fn(),
  }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ selectFile: vi.fn() }),
}))
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: { id: 's1', cwd: '/cwd' } }),
}))

import DetailPane from '@/components/panel/DetailPane.vue'
import DiffView from '@/components/panel/detail-renderers/DiffView.vue'
import GitPanel from '@/components/panel/GitPanel.vue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

beforeEach(() => {
  setActivePinia(createPinia())
})

const SIMPLE = { template: '<div />' }

describe('W3: drawer 写入入口', () => {
  it('U10: DetailPane header 按钮注入 path（无行范围 target=current）', async () => {
    const wrapper = mount(DetailPane, {
      props: { sessionId: 's1' },
      global: {
        stubs: {
          HoverCard: SIMPLE, HoverCardContent: SIMPLE, HoverCardTrigger: SIMPLE,
          CodeBlock: SIMPLE, DiffView: SIMPLE, MarkdownRenderer: SIMPLE,
        },
      },
    })
    const store = composerInjectionStore
    const btn = wrapper.find('[data-testid="detail-inject-file"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')

    expect(store.pendingInjection.value).not.toBeNull()
    expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
    expect(store.pendingInjection.value?.target).toBe('current')
    expect(store.pendingInjection.value?.sessionId).toBe('s1')
    expect(store.pendingInjection.value?.lineStart).toBeUndefined()
  })

  it('U11: DiffView 行号点击 emit line-inject（path + lineNo）', async () => {
    // 简单 patch：一个 hunk 含带 newNo 的行
    const patch = '@@ -1,3 +1,4 @@\n context\n-old\n+new line\n+added\n'
    const wrapper = mount(DiffView, { props: { patch, path: 'src/foo.ts' } })
    const store = composerInjectionStore

    // 找所有有 newNo 的行号 span（cursor-pointer 的）
    const newNoSpans = wrapper.findAll('span.cursor-pointer')
    expect(newNoSpans.length).toBeGreaterThan(0)
    await newNoSpans[0].trigger('click')

    const emitted = wrapper.emitted('lineInject')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toMatchObject({ path: 'src/foo.ts' })
    expect((emitted![0][0] as { lineNo: number }).lineNo).toBeTypeOf('number')
  })

  it('U12: GitPanel 文件名注入按钮注入 path-only（target=current）', async () => {
    const wrapper = mount(GitPanel, { global: { stubs: { Input: SIMPLE } } })
    const store = composerInjectionStore
    const btn = wrapper.find('[data-testid="git-inject-file"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')

    expect(store.pendingInjection.value).not.toBeNull()
    expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
    expect(store.pendingInjection.value?.target).toBe('current')
    expect(store.pendingInjection.value?.lineStart).toBeUndefined()
  })
})
