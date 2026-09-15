/**
 * [W28/D-7.2] FileView + 真实 virtua 虚拟滚动测试（探针 P-D7-1）。
 *
 * 与 FileView.test.ts（mock virtua，关注过滤防抖 DOM 表现）互补——本文件用真实
 * <Virtualizer> 验证「万级可见行只渲染视口 ± 缓冲」：
 * - happy-dom 无布局引擎（clientHeight 恒 0，实测），virtua 的视口/条目尺寸全靠
 *   ResizeObserver 回调——本文件注入 fake ResizeObserver（同步回填几何尺寸）驱动窗口化，
 *   不 mock virtua 组件本身（DOM 行数断言必须走真实 Virtualizer 的窗口逻辑）
 * - 滚动容器 = Virtualizer 的 parentElement（ScrollArea stub 内联高度样式）
 * - 断言：DOM 行数远小于总可见行数（10000 文件目录 → < 200 行）
 *
 * 运行：npx vitest run src/__tests__/components/FileView-virtua.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import FileView from '@/components/sidebar/FileView.vue'
import { useFileTreeStore } from '@/stores/fileTree'
import type { FileNode } from '@taiji/shared'

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

vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

/**
 * fake ResizeObserver：happy-dom 无布局引擎，virtua 依赖 RO 回调拿视口/条目尺寸。
 * 同步回填：滚动容器（scroll-stub，无 item 语义）报告 400px 视口，其余（条目）报告 24px。
 * 与真实浏览器行为等价的部分：窗口化计算（视口大小 / 条目尺寸）由真实 virtua 执行。
 * 两个 happy-dom 缺口需显式补齐（实测）：
 * - offsetParent 恒 undefined → virtua RO 回调 `if (i.offsetParent)` 全跳过（视口尺寸永远不更新）
 * - RO 本身存在但回调不触发 → 用同步回填的 fake RO
 */
const ITEM_H = 24
const VIEWPORT_H = 400
class FakeResizeObserver {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe(el: Element): void {
    queueMicrotask(() => {
      const isContainer = el.classList.contains('scroll-stub')
      this.cb(
        [
          {
            target: el,
            contentRect: {
              height: isContainer ? VIEWPORT_H : ITEM_H,
              width: 300,
            } as DOMRectReadOnly,
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      )
    })
  }
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)
// happy-dom offsetParent 恒 undefined（实测）——virtua RO 回调要求 truthy 才处理
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  get(this: HTMLElement) {
    return this.parentElement ?? document.body
  },
  configurable: true,
})

/** 万级文件目录 fixture：big/ 下 10000 个文件（与 e2e「展开 5000 文件目录」同量级） */
function buildBigTree(): FileNode[] {
  return [
    {
      path: 'big',
      name: 'big',
      type: 'dir',
      children: Array.from({ length: 10000 }, (_, i) => ({
        path: `big/f${i}.ts`,
        name: `f${i}.ts`,
        type: 'file' as const,
      })),
    },
  ]
}

/** ScrollArea stub：带内联高度的滚动容器（真实 virtua 的 parentElement） */
const ScrollAreaStub = {
  template: '<div class="scroll-stub" style="height: 400px; overflow-y: auto;"><slot /></div>',
}

async function mountView(nodes: FileNode[]): Promise<ReturnType<typeof mount>> {
  mockFileTree.mockResolvedValueOnce(nodes)
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
    attachTo: document.body,
    global: {
      stubs: { ScrollArea: ScrollAreaStub },
    },
  })
  await flushPromises()
  return wrapper
}

/**
 * 等 virtua 窗口化链稳定：onMounted rAF（容器 RO 注册）→ fake RO queueMicrotask 回填
 * 尺寸 → 窗口计算 → item 挂载 → item RO 回填。happy-dom 下 nextTick 不冲刷 rAF/
 * microtask 链，需真实 macrotask 延时（实测 3×nextTick + 2×setTimeout(10ms) 足够）。
 */
async function flushVirtua(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await nextTick()
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('FileView 真实 virtua 虚拟滚动（P-D7-1：万级可见行 DOM 行数远小于总行数）', () => {
  it('展开 10000 文件目录 → DOM 只挂载视口 ± 缓冲的行（< 200），远小于 10001 总行', async () => {
    const wrapper = await mountView(buildBigTree())
    // 展开 big/（useFileTree.expandNode：loaded 早退 → addExpanded → 投影产出 10001 行）
    const store = useFileTreeStore()
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    await flushVirtua()

    // 真实 FileTreeRow 渲染（未 stub）——断言 DOM 中的实际行节点数
    const dirRows = wrapper.findAll('[data-testid^="file-tree-dir-"]')
    const fileRows = wrapper.findAll('[data-testid^="file-tree-file-"]')
    expect(dirRows.length).toBe(1) // big 目录行在 DOM
    expect(fileRows.length).toBeGreaterThan(0) // 视口内至少渲染了若干文件行
    // P-D7-1 量化 bound：DOM 行数 < 200（总可见行 10001）
    expect(fileRows.length + dirRows.length).toBeLessThan(200)
    expect(fileRows.length + dirRows.length).toBeLessThan(10001)

    wrapper.unmount()
  })

  it('大数据量投影 + 虚拟滚动下过滤仍工作（命中后投影重算，DOM 行随投影收缩）', async () => {
    const wrapper = await mountView(buildBigTree())
    const store = useFileTreeStore()
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    await flushVirtua()

    // 无匹配过滤 → 空态（投影 [] → file-empty）
    store.setFilter('zzz_no_match')
    await flushVirtua()
    expect(wrapper.find('[data-testid="file-empty"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid^="file-tree-file-"]').length).toBe(0)

    wrapper.unmount()
  })

  it('折叠后投影收缩（可见行 10001 → 1），DOM 行数跟随', async () => {
    const wrapper = await mountView(buildBigTree())
    const store = useFileTreeStore()
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    await flushVirtua()
    expect(wrapper.findAll('[data-testid^="file-tree-file-"]').length).toBeGreaterThan(0)

    store.removeExpanded('s1', 'big')
    await flushVirtua()
    expect(wrapper.findAll('[data-testid^="file-tree-file-"]').length).toBe(0)
    expect(wrapper.find('[data-testid="file-tree-dir-big"]').exists()).toBe(true)

    wrapper.unmount()
  })
})
