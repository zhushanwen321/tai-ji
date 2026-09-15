/**
 * FileTreeRow 组件渲染测试（#4，[HISTORICAL] 三视角防护；W28/D-7.2 改纯行组件后重写）。
 *
 * 防护的事故：v-if/v-else 链断裂导致折叠目录被同时渲染为「目录行 + 同名文件行」，
 * 77 单测 + 集成全绿但用户打开发现「同名文件打不开」。根因是只有 store/composable
 * 白盒测试，缺组件渲染断言。本测试补「观察者 + 使用者」视角。
 *
 * [W28/D-7.2] 组件语义变更：FileTreeRow 从递归行改为纯行组件（收 VisibleRow 投影行，
 * 零 store 依赖）——交互经 emit('toggle'/'select') 交给 FileView。本测试改为：
 * - 构造 VisibleRow fixture 直接传 props（不再预置 store 展开态）
 * - emit 断言替代 useFileTree/useSideDrawer mock 断言
 *
 * 覆盖：
 * - 折叠/展开目录：只渲染 dir 行，不存在同名 file 行（事故根因回归防护）
 * - 文件节点：只渲染 file 行，不存在 dir 行
 * - hint 行（loading/error/empty）：各自渲染，error 行点击 emit toggle（旧递归语义）
 * - 字号一致性（D-007）：dir/file 行 name span 均含 text-[12px]
 * - chevron 槽（D-022）：dir 行含 ChevronRight，file 行含空占位
 * - W2 徽章/行数：changeCount/lineStats 全部来自 row（投影预计算，组件不再读 store）
 * - 交互：点 dir → emit toggle；点 file → emit select；selected 控制选中态样式
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/components/FileTreeRow.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import FileTreeRow from '@/components/sidebar/FileTreeRow.vue'
import type { VisibleRow } from '@/stores/fileTree'

/** VisibleRow fixture 工厂（默认最小字段，按需覆盖） */
function makeRow(overrides: Partial<VisibleRow> & Pick<VisibleRow, 'path' | 'type'>): VisibleRow {
  const { path, type } = overrides
  return {
    path,
    name: overrides.name ?? path.split('/').pop() ?? path,
    type,
    depth: overrides.depth ?? 0,
    expanded: overrides.expanded ?? false,
    changeCount: overrides.changeCount ?? 0,
    ignored: overrides.ignored ?? false,
    hint: overrides.hint,
    gitStatus: overrides.gitStatus,
    lineStats: overrides.lineStats,
  }
}

/** mount FileTreeRow（默认 stub 自身递归——纯行组件已无递归，stub 保留仅为旧测试兼容） */
function mountRow(row: VisibleRow, selected = false) {
  return mount(FileTreeRow, {
    props: { row, selected },
  })
}

beforeEach(() => {
  // 纯行组件不依赖 pinia；useI18n 由 vitest-i18n-setup.ts 全局 mock
})

describe('FileTreeRow v-if/v-else 链断裂回归防护（W28 纯行版）', () => {
  it('折叠目录：只渲染 dir 行，不渲染同名 file 行（事故根因）', () => {
    const row = makeRow({ path: '.agents', type: 'dir', expanded: false })
    const wrapper = mountRow(row)

    expect(wrapper.find('[data-testid="file-tree-dir-.agents"]').exists()).toBe(true)
    // 关键回归断言：折叠目录绝不能额外渲染同名 file 行
    expect(wrapper.find('[data-testid="file-tree-file-.agents"]').exists()).toBe(false)
  })

  it('展开目录：仍只渲染 dir 行，不渲染同名 file 行', () => {
    const row = makeRow({ path: 'src', type: 'dir', expanded: true })
    const wrapper = mountRow(row)

    expect(wrapper.find('[data-testid="file-tree-dir-src"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree-file-src"]').exists()).toBe(false)
  })

  it('文件节点：只渲染 file 行，不渲染 dir 行', () => {
    const row = makeRow({ path: 'a.ts', type: 'file' })
    const wrapper = mountRow(row)

    expect(wrapper.find('[data-testid="file-tree-file-a.ts"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree-dir-a.ts"]').exists()).toBe(false)
  })

  it('hint 行（loading/error/empty）：各态只渲染自身，不渲染 dir/file 行', () => {
    for (const hint of ['loading', 'error', 'empty'] as const) {
      const row = makeRow({ path: 'src', type: 'dir', hint })
      const wrapper = mountRow(row)
      const testid = `file-tree-${hint}-src`
      expect(wrapper.find(`[data-testid="${testid}"]`).exists()).toBe(true)
      expect(wrapper.find('[data-testid="file-tree-dir-src"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="file-tree-file-src"]').exists()).toBe(false)
    }
  })
})

describe('FileTreeRow 视觉一致性（D-007 字号 / D-022 chevron 槽）', () => {
  it('目录行字号 12px + font-mono（D-007：文件树 12px，字号在行容器上供 name span 继承）', () => {
    const row = makeRow({ path: 'src', type: 'dir' })
    const wrapper = mountRow(row)
    const dirRow = wrapper.find('[data-testid="file-tree-dir-src"]')
    expect(dirRow.classes()).toContain('text-[length:var(--text-xs)]')
    expect(dirRow.classes()).toContain('font-mono')
  })

  it('文件行字号 12px + font-mono', () => {
    const row = makeRow({ path: 'a.ts', type: 'file' })
    const wrapper = mountRow(row)
    const nameSpan = wrapper.find('[data-testid="file-tree-file-a.ts"] .shrink')
    expect(nameSpan.classes()).toContain('text-[length:var(--text-xs)]')
    expect(nameSpan.classes()).toContain('font-mono')
  })

  it('目录行与文件行渲染字号一致（D-007：均 12px，不再 11/12 混用）', () => {
    const dirWrapper = mountRow(makeRow({ path: 'src', type: 'dir' }))
    const fileWrapper = mountRow(makeRow({ path: 'a.ts', type: 'file' }))

    const dirRow = dirWrapper.find('[data-testid="file-tree-dir-src"]')
    const fileNameSpan = fileWrapper.find('[data-testid="file-tree-file-a.ts"] .shrink')
    expect(dirRow.classes()).toContain('text-[length:var(--text-xs)]')
    expect(dirRow.classes()).not.toContain('text-[11px]')
    expect(fileNameSpan.classes()).toContain('text-[length:var(--text-xs)]')
    expect(fileNameSpan.classes()).not.toContain('text-[11px]')
  })

  it('行 padding-left 用单一公式 depth*10+8（D-022，dir/file/hint 行共用投影 depth）', () => {
    const dirWrapper = mountRow(makeRow({ path: 'src', type: 'dir', depth: 2 }))
    const dirRow = dirWrapper.find('[data-testid="file-tree-dir-src"]')
    expect((dirRow.element as HTMLElement).style.paddingLeft).toBe('28px') // 2*10+8（INDENT_STEP v6 14→10）

    // hint 行 depth 已由投影 +1（子区占位缩进），组件直接用 row.depth——与旧 childHintPaddingStyle 等价
    const hintWrapper = mountRow(makeRow({ path: 'src', type: 'dir', depth: 2, hint: 'loading' }))
    const hintRow = hintWrapper.find('[data-testid="file-tree-loading-src"]')
    expect((hintRow.element as HTMLElement).style.paddingLeft).toBe('28px') // 2*10+8
  })

  it('文件行与目录行同 depth 的 padding-left 一致（icon 垂直对齐前提）', () => {
    const dirWrapper = mountRow(makeRow({ path: 'src', type: 'dir', depth: 1 }))
    const fileWrapper = mountRow(makeRow({ path: 'a.ts', type: 'file', depth: 1 }))

    const dirPad = (dirWrapper.find('[data-testid="file-tree-dir-src"]').element as HTMLElement).style.paddingLeft
    const filePad = (fileWrapper.find('[data-testid="file-tree-file-a.ts"]').element as HTMLElement).style.paddingLeft
    expect(dirPad).toBe(filePad) // 同 depth 同 padding，不再 +10 补偿
  })

  it('目录行 chevron 槽含 ChevronRight（可展开指示）', () => {
    const wrapper = mountRow(makeRow({ path: 'src', type: 'dir' }))
    const chevronSlot = wrapper.find('[data-testid="file-tree-dir-src"] [data-testid="chevron-slot"]')
    expect(chevronSlot.exists()).toBe(true)
    expect(chevronSlot.find('svg').exists()).toBe(true)
  })

  it('文件行 chevron 槽为空占位（无 svg，宽度对齐目录）', () => {
    const wrapper = mountRow(makeRow({ path: 'a.ts', type: 'file' }))
    const chevronSlot = wrapper.find('[data-testid="file-tree-file-a.ts"] [data-testid="chevron-slot"]')
    expect(chevronSlot.exists()).toBe(true)
    expect(chevronSlot.find('svg').exists()).toBe(false) // 空占位
  })
})

describe('FileTreeRow W2 目录改动徽章（changeCount 来自投影 row）', () => {
  it('目录子树有改动文件 → 渲染徽章（含改动数）', () => {
    const row = makeRow({ path: 'src', type: 'dir', changeCount: 2 })
    const wrapper = mountRow(row)

    const badge = wrapper.find('[data-testid="file-tree-dir-badge-src"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('2')
  })

  it('目录子树无改动 → 不渲染徽章', () => {
    const row = makeRow({ path: 'src', type: 'dir', changeCount: 0 })
    const wrapper = mountRow(row)

    expect(wrapper.find('[data-testid="file-tree-dir-badge-src"]').exists()).toBe(false)
  })

  it('改动数 > 999 → 显 999+', () => {
    const row = makeRow({ path: 'src', type: 'dir', changeCount: 1000 })
    const wrapper = mountRow(row)

    expect(wrapper.find('[data-testid="file-tree-dir-badge-src"]').text()).toBe('999+')
  })

  it('文件行不渲染改动数徽章（changeCount 仅目录行语义）', () => {
    const row = makeRow({ path: 'a.ts', type: 'file', changeCount: 5 })
    const wrapper = mountRow(row)

    expect(wrapper.find('[data-testid="file-tree-dir-badge-a.ts"]').exists()).toBe(false)
  })
})

describe('FileTreeRow W2 文件行数 +N −M（lineStats 来自投影 row）', () => {
  it('tracked 改动文件（有 additions/deletions）→ 显 +N −M', () => {
    const row = makeRow({
      path: 'src/existing.ts',
      type: 'file',
      lineStats: { add: 12, del: 3 },
    })
    const wrapper = mountRow(row)

    const linestats = wrapper.find('[data-testid="file-tree-linestats-src/existing.ts"]')
    expect(linestats.exists()).toBe(true)
    expect(linestats.find('.text-success').text()).toBe('+12')
    expect(linestats.find('.text-danger').text()).toBe('−3')
  })

  it('仅 additions（如 added 文件）→ 只显 +N', () => {
    const row = makeRow({ path: 'src/new.ts', type: 'file', lineStats: { add: 50 } })
    const wrapper = mountRow(row)

    const linestats = wrapper.find('[data-testid="file-tree-linestats-src/new.ts"]')
    expect(linestats.exists()).toBe(true)
    expect(linestats.find('.text-success').text()).toBe('+50')
    expect(linestats.find('.text-danger').exists()).toBe(false)
  })

  it('untracked 文件（无 numstat，有 size）→ 显 ~size 降级', () => {
    const row = makeRow({ path: 'untracked.log', type: 'file', lineStats: { size: 30 } })
    const wrapper = mountRow(row)

    const linestats = wrapper.find('[data-testid="file-tree-linestats-untracked.log"]')
    expect(linestats.exists()).toBe(true)
    expect(linestats.text()).toContain('~')
    expect(linestats.text()).toContain('30')
    expect(linestats.find('.text-success').exists()).toBe(false)
  })

  it('行数 ≥10000 → 显 9.xk 格式', () => {
    const row = makeRow({ path: 'big.ts', type: 'file', lineStats: { add: 12345, del: 0 } })
    const wrapper = mountRow(row)

    const linestats = wrapper.find('[data-testid="file-tree-linestats-big.ts"]')
    expect(linestats.find('.text-success').text()).toBe('+12.3k')
  })

  it('文件无 lineStats → 不显行数', () => {
    const wrapper = mountRow(makeRow({ path: 'clean.ts', type: 'file' }))
    expect(wrapper.find('[data-testid="file-tree-linestats-clean.ts"]').exists()).toBe(false)
  })
})

describe('FileTreeRow 交互（emit 路由，不再直调 useFileTree）', () => {
  it('点折叠目录 → emit toggle（row 载荷）', async () => {
    const row = makeRow({ path: 'src', type: 'dir', expanded: false })
    const wrapper = mountRow(row)
    await wrapper.find('[data-testid="file-tree-dir-src"]').trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([[row]])
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('点展开目录 → emit toggle（expanded 状态由投影行携带，组件不读 store）', async () => {
    const row = makeRow({ path: 'src', type: 'dir', expanded: true })
    const wrapper = mountRow(row)
    await wrapper.find('[data-testid="file-tree-dir-src"]').trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([[row]])
  })

  it('点文件 → emit select', async () => {
    const row = makeRow({ path: 'a.ts', type: 'file' })
    const wrapper = mountRow(row)
    await wrapper.find('[data-testid="file-tree-file-a.ts"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([[row]])
    expect(wrapper.emitted('toggle')).toBeUndefined()
  })

  it('点 error 占位行 → emit toggle（旧递归语义：已展开目录点击折叠/重试）', async () => {
    const row = makeRow({ path: 'src', type: 'dir', hint: 'error' })
    const wrapper = mountRow(row)
    await wrapper.find('[data-testid="file-tree-error-src"]').trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([[row]])
  })

  it('点 loading/empty 占位行 → 不 emit（无交互）', async () => {
    for (const hint of ['loading', 'empty'] as const) {
      const row = makeRow({ path: 'src', type: 'dir', hint })
      const wrapper = mountRow(row)
      await wrapper.find(`[data-testid="file-tree-${hint}-src"]`).trigger('click')
      expect(wrapper.emitted('toggle')).toBeUndefined()
      expect(wrapper.emitted('select')).toBeUndefined()
    }
  })
})

describe('FileTreeRow 选中态（selected prop，组件零 store 依赖）', () => {
  it('selected=true 的文件行 → bg-surface + 名称 accent 加粗', () => {
    const wrapper = mountRow(makeRow({ path: 'a.ts', type: 'file' }), true)
    const rowEl = wrapper.find('[data-testid="file-tree-file-a.ts"]')
    expect(rowEl.classes()).toContain('bg-surface')
    const nameSpan = wrapper.find('[data-testid="file-tree-file-a.ts"] .shrink')
    expect(nameSpan.classes()).toContain('text-accent')
    expect(nameSpan.classes()).toContain('font-semibold')
  })

  it('selected=false → 无选中态样式', () => {
    const wrapper = mountRow(makeRow({ path: 'a.ts', type: 'file' }), false)
    expect(wrapper.find('[data-testid="file-tree-file-a.ts"]').classes()).not.toContain('bg-surface')
  })
})
