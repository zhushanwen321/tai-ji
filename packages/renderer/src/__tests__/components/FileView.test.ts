/**
 * FileView 组件渲染测试（W15 审查 A-1/A-4，三视角防护）。
 *
 * 覆盖：
 * - A-1 竞态回归：聚焦输入中防抖 commit 到达，输入框显示值不被拉回旧提交值
 *   （受控 prop 直连 store.filterText 时，commit 渲染 flush 与新击键交错会把
 *   Input passive v-model 的本地值覆盖回旧值——输入框瞬回退）
 * - A-4 防抖 DOM 表现：连续输入期间防抖窗口内显示旧过滤结果（树不闪空态），
 *   200ms 到点 commit 后才更新为过滤/空态
 *
 * mock 策略：
 * - vi.mock('@/api') 聚合门面（VITE_MOCK=true 下 @/api 导出 mockApi，须直接 mock
 *   file/git 命名空间，与 useFileTree.test.ts 同策略）
 * - FileTreeRow / ScrollArea 用轻量 stub（FileTreeRow 透出 node.path 供树内容断言）
 * - i18n 由 vitest-i18n-setup.ts 全局 mock（t 返回 zh-CN 文案）
 *
 * fake timers 启用时机：mount + loadTree（flushPromises 内部走 setTimeout）用真实
 * timers 完成，之后再 vi.useFakeTimers() 拦截防抖 setTimeout——避免 flushPromises
 * 被 fake timer 卡死。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/components/FileView.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import FileView from '@/components/sidebar/FileView.vue'
import { useFileTreeStore } from '@/stores/fileTree'
import type { FileNode } from '@taiji/shared'

// mock @/api 门面（useFileTree 经 `import { file as fileApi, git as gitApi } from '@/api'` 依赖）
const mockFileTree = vi.fn()
const mockGitStatus = vi.fn()
vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  file: {
    tree: (...args: unknown[]) => mockFileTree(...args),
    expand: (...args: unknown[]) => vi.fn()(...args),
  },
  git: { status: (...args: unknown[]) => mockGitStatus(...args) },
}))

// [W28/D-7.2] mock virtua：Virtualizer 全量渲染 slot 项（本测试关注过滤防抖 DOM 表现，
// 不关注虚拟化窗口——虚拟化 DOM 数断言在 FileView-virtua.test.ts 用真实 Virtualizer）
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        itemSize: { type: Number, default: undefined },
        itemProps: { type: Function, default: undefined },
      },
      setup(props, { slots }) {
        return () =>
          h(
            'div',
            { 'data-testid': 'mock-virtua-list' },
            (props.data as unknown[]).map((item, index) => {
              const vnode = slots.default?.({ item, index }) ?? []
              return h('div', { key: (vnode[0] as { key?: unknown } | undefined)?.key ?? index }, vnode)
            }),
          )
      },
    }),
  }
})

// [W28/D-7.2] FileView 现在持有 useSideDrawer（onSelectRow 打开 detail 抽屉），mock 掉
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

/** 树节点 fixture：三个文件，'a' 过滤命中 a.ts，'zzz' 全无匹配 */
const TREE_NODES: FileNode[] = [
  { path: 'a.ts', name: 'a.ts', type: 'file' },
  { path: 'b.ts', name: 'b.ts', type: 'file' },
  { path: 'foo.ts', name: 'foo.ts', type: 'file' },
]

// FileTreeRow stub：透出 row.path 供 visibleRows 内容断言（data-testid 含路径）
const FileTreeRowStub = {
  props: ['row', 'selected'],
  template: '<div :data-testid="`row-${row.path}`" />',
}

/** mount FileView 并等 loadTree 完成（真实 timers 下 flushPromises） */
async function mountView(): Promise<ReturnType<typeof mount>> {
  mockFileTree.mockResolvedValueOnce(TREE_NODES)
  mockGitStatus.mockResolvedValueOnce({
    sessionId: 's1',
    isRepo: false,
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    stats: { add: 0, del: 0 },
    hasConflict: false,
  })
  const wrapper = mount(FileView, {
    props: { sessionId: 's1' },
    global: {
      stubs: {
        FileTreeRow: FileTreeRowStub,
        ScrollArea: { template: '<div><slot /></div>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

function findFilterInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-testid="file-filter-input"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  // 清掉模块级防抖 timer（filterText 全局单值，防跨用例泄漏），恢复真实 timers
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('FileView W15 过滤防抖（A-1 竞态回归 + A-4 DOM 表现）', () => {
  it('A-1 聚焦输入中防抖 commit 到达，输入框显示值不被拉回旧提交值', async () => {
    const wrapper = await mountView()
    const input = findFilterInput(wrapper)
    vi.useFakeTimers()

    // 聚焦（filterFocused=true，store→显示 同步被跳过）
    await input.trigger('focus')

    // 击键 'a' → 本地显示 'a'，pending 提交
    await input.setValue('a')
    // commit：store.filterText 写入 'a'，但渲染 flush 排队在微任务——
    // 紧接着用户再击键（显示领先 commit 的 prop 更新）
    vi.advanceTimersByTime(200)
    await input.setValue('ab')

    // 渲染 flush：commit 的 prop 更新与击键交错。显示值须保持击键后的 'ab'
    // （旧实现：prop 直连 store.filterText='a'，passive v-model 被覆盖回 'a'）
    await nextTick()
    expect((input.element as HTMLInputElement).value).toBe('ab')

    // 第二次 commit 后 store 提交值跟上显示值
    vi.advanceTimersByTime(200)
    expect(useFileTreeStore().filterText).toBe('ab')
  })

  it('A-4 连续输入的防抖窗口内 DOM 显示旧过滤结果，200ms 后才更新（空态切换）', async () => {
    const wrapper = await mountView()
    const input = findFilterInput(wrapper)
    vi.useFakeTimers()

    // 连续击键 'z' → 'zz' → 'zzz'（无任何匹配）
    await input.setValue('z')
    await input.setValue('zz')
    await input.setValue('zzz')

    // 防抖窗口内（199ms，未到 trailing 点）：store.filterText 仍空 →
    // DOM 显示旧（无过滤）结果：三个文件行都在、无空态
    vi.advanceTimersByTime(199)
    await nextTick()
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="row-a.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-b.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-foo.ts"]').exists()).toBe(true)

    // 到点（凑满 200ms）commit → 过滤生效：无匹配 → 空态（SearchX + 无匹配文件）
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-a.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="row-foo.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-empty"]').text()).toContain('无匹配文件')
  })

  it('A-4 补充：命中过滤的 commit 到达后，DOM 只保留命中行', async () => {
    const wrapper = await mountView()
    const input = findFilterInput(wrapper)
    vi.useFakeTimers()

    await input.setValue('a')
    vi.advanceTimersByTime(200)
    await nextTick()

    // 'a' 命中 a.ts（不含 b.ts/foo.ts）
    expect(wrapper.find('[data-testid="row-a.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-b.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="row-foo.ts"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(false)
  })

  it('[W28 审查 Fix-1] error hint 行点击 → 折叠目录（collapseNode，恢复旧递归「已展开→折叠」语义而非重试）', async () => {
    // 真实 FileTreeRow（error 行带 toggle 点击），仅 stub ScrollArea；mock virtua 全量渲染行
    mockFileTree.mockResolvedValueOnce([
      { path: 'src', name: 'src', type: 'dir', children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }] },
    ])
    mockGitStatus.mockResolvedValueOnce({
      sessionId: 's1',
      isRepo: false,
      files: [],
      stagedCount: 0,
      unstagedCount: 0,
      stats: { add: 0, del: 0 },
      hasConflict: false,
    })
    const wrapper = mount(FileView, {
      props: { sessionId: 's1' },
      global: {
        stubs: { ScrollArea: { template: '<div><slot /></div>' } },
      },
    })
    await flushPromises()

    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'error', reason: 'timeout' })
    await nextTick()

    // error 占位行渲染（hint 行 expanded=true 由投影保证）
    const errorRow = wrapper.find('[data-testid="file-tree-error-src"]')
    expect(errorRow.exists()).toBe(true)
    await errorRow.trigger('click')
    await nextTick()

    // 点击 = 折叠：FileView.onToggleRow 读 row.expanded=true → collapseNode → removeExpanded
    // （回归前 expanded=false → expandNode → error 态重新发请求，语义变重试）
    expect(store.getExpanded('s1').has('src')).toBe(false)

    wrapper.unmount()
  })
})
