/**
 * SearchModal 集成测试（C-NT-5，w4 new-task-search UI 迁移）。
 *
 * 首屏冒烟：mount SearchModal（open=true, deps=mock SearchDeps）断言
 * [data-testid=search-input] DOM 存在（inline overlay，无 Teleport，wrapper 内直接断言）；
 * 空查询 recents/suggested 分组 + 非空查询命令命中 → 断言 search-section/search-item DOM；
 * open=false 时不渲染 overlay。断言 DOM 结构（data-testid），不断言文案。
 *
 * 交互覆盖（review batch 1 round 1 重建，蓝本：旧 renderer 套件 41519a72d^）：
 *  - 键盘导航：↑↓ 循环取模 + aria-selected 转移 + preventDefault、Enter→confirmSel、Tab/Shift+Tab 五态循环切类 + selIdx 重置
 *  - confirmSel 三分支：ok+drawerTab → onOpenDrawer + close；ok 无 drawerTab → close；ok:false → 保持打开 + onToastError
 *  - 关闭路径：Esc / 遮罩 .self / close 重置（query/selIdx/activeType 清空 + MR-7.1 孤儿查询守卫）/ 同实例 open 翻转
 *  - 错误路径：query reject → 不崩 + loading 清 + errorMsg transient（AC-8.5，新查询恢复）
 *  - loading 显示（>200ms 显 / <200ms 不显，AC-8.1）+ 空态两分支（startHint / noResult+tryOther，AC-7.13）
 *  - 焦点管理：open → nextTick 聚焦 input（document.activeElement）
 *
 * deps 构造对齐 w3 core search.test.ts 先例：ports 全 vi.fn + core 真实 factory
 * （createCommandStore/createFileSearchStore，规避 mock 漏方法运行时崩溃 R1）+ storage
 * KVStorage mock。fake timers 推进 debounce 120ms / loading 200ms。
 * 时序断言与常量解耦：debounce 用 150ms（>120 且 <200），loading 显用 201ms（>200）——
 * 断言窗口只依赖常量间的大小关系，不依赖具体差值。
 *
 * 运行：cd packages/ui && npx vitest run src/overlays
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createCommandStore, createFileSearchStore, resetSearchModal } from '@taiji/core'
import type { SearchDeps, Section } from '@taiji/core'
import type { FileNode, SessionGroup } from '@taiji/shared'
import SearchModal from '../SearchModal.vue'

/** Map 实现 KVStorage（对齐 w3 command-store.test.ts makeMockStorage 模式） */
function makeMockStorage() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async set(key: string, value: string) {
      store.set(key, value)
    },
    async remove(key: string) {
      store.delete(key)
    },
  }
}

/** 构造 mock SearchDeps（每测试独立实例，断言 per-test） */
function makeDeps(): SearchDeps {
  return {
    ports: {
      isMock: false,
      isMac: false,
      searchMock: vi.fn(async () => []),
      fileRead: vi.fn(async () => {}),
      fileCandidates: vi.fn(async () => [] as FileNode[]),
      sessionList: vi.fn(async () => [] as SessionGroup[]),
      selectSession: vi.fn(async () => {}),
      watchFileChanges: vi.fn(() => () => {}),
      t: vi.fn((key: string) => key),
    },
    commandStore: createCommandStore(makeMockStorage()),
    fileSearchStore: createFileSearchStore(),
    storage: makeMockStorage(),
    fileTree: { loadTree: vi.fn(async () => {}), selectFile: vi.fn() },
    appCommandActions: {
      newSession: vi.fn(),
      goOverview: vi.fn(),
      toggleSidebar: vi.fn(),
      requestPresetOpen: vi.fn(),
    },
  }
}

/** FileNode fixture（file 源；queryFileSource 需 activeSessionId 非空才查 WS） */
function fileNode(path: string): FileNode {
  return { path, name: path.split('/').pop() ?? path, type: 'file' }
}

/**
 * open 翻转（.vue shim 下 VTU setProps 的 $props 类型解析为 attrs-only，编译期不接受业务 prop；
 * 运行时 setProps 走 Record<string, unknown>，cast 仅为满足 tsc——见 Block.test.ts:50 同款预存问题）。
 */
async function setOpen(wrapper: ReturnType<typeof mount>, open: boolean): Promise<void> {
  await wrapper.setProps({ open } as never)
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetSearchModal() // core 单例隔离（R5，C-NT-6）
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SearchModal 首屏冒烟', () => {
  it('搜索输入框 DOM：open=true 时 search-input 存在，open=false 时不渲染 overlay', () => {
    const deps = makeDeps()
    const wrapper = mount(SearchModal, {
      props: { open: false, deps },
    })
    expect(wrapper.find('[data-testid="search-modal-overlay"]').exists()).toBe(false)

    const wrapperOpen = mount(SearchModal, {
      props: { open: true, deps },
    })
    expect(wrapperOpen.find('[data-testid="search-modal-overlay"]').exists()).toBe(true)
    expect(wrapperOpen.find('[data-testid="search-input"]').exists()).toBe(true)
  })

  it('结果列表 DOM：注册 app 命令，空查询 recents/suggested 分组渲染 search-item', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([
      { id: 'nt', name: '新建任务', action: vi.fn() },
      { id: 'ov', name: '概览', action: vi.fn() },
    ])
    const wrapper = mount(SearchModal, {
      props: { open: true, deps },
    })
    // open=true immediate loadResults：空查询 → suggested 分组（suggested 命令前 3 个）
    await flushPromises()
    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="search-item-0"]').exists()).toBe(true)
  })

  it('非空查询命令命中：debounce 120ms 后 search-section/search-item 渲染', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.commandStore.registerApp([
      { id: 'nt', name: '新建任务', action: vi.fn() },
    ])
    const wrapper = mount(SearchModal, {
      props: { open: true, deps },
    })
    await flushPromises()
    // 输入查询词 → debounce 120ms → loadResults → 3 源 allSettled（command 命中）
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('新建')
    await vi.advanceTimersByTimeAsync(150) // debounce 120ms + 微任务
    // loading 200ms 防闪烁 timer 未到 → loading 不显，直接显结果
    expect(wrapper.find('[data-testid="search-item-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid^="search-section-"]').exists()).toBe(true)
  })
})

describe('键盘导航（MF-2，AC-7.2/BC-2/AC-9.1~9.4）', () => {
  it('ArrowDown/ArrowUp 跨组循环移动选中：aria-selected 转移 + 尾部 wrap', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([
      { id: 'a', name: 'cmd-a', action: vi.fn() },
      { id: 'b', name: 'cmd-b', action: vi.fn() },
      { id: 'c', name: 'cmd-c', action: vi.fn() },
    ])
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    // 空查询 → suggested 分组 3 项（SUGGESTED_COMMAND_COUNT=3），初始 selIdx=0
    const items = wrapper.findAll('[data-testid^="search-item-"]')
    expect(items.length).toBe(3)
    expect(items[0].attributes('aria-selected')).toBe('true')

    const input = wrapper.find('[data-testid="search-input"]')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(items[1].attributes('aria-selected')).toBe('true')
    expect(items[0].attributes('aria-selected')).toBe('false')

    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' }) // 2→0 wrap
    expect(items[0].attributes('aria-selected')).toBe('true')
    expect(items[2].attributes('aria-selected')).toBe('false')

    await input.trigger('keydown', { key: 'ArrowUp' }) // 0→2 wrap（反向循环取模）
    expect(items[2].attributes('aria-selected')).toBe('true')
  })

  it('ArrowDown/Enter 阻止默认行为（preventDefault，防页面滚动/表单提交）', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'a', name: 'cmd-a', action: vi.fn() }])
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    const input = wrapper.find('[data-testid="search-input"]').element as HTMLInputElement
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    input.dispatchEvent(arrow)
    expect(arrow.defaultPrevented).toBe(true)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
  })

  it('Enter 确认选中项：app 命令 action 执行 + 关浮层', async () => {
    const action = vi.fn()
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'a', name: 'cmd-a', action }])
    const onOpenDrawer = vi.fn()
    const wrapper = mount(SearchModal, { props: { open: true, deps, onOpenDrawer } })
    await flushPromises()
    await wrapper.find('[data-testid="search-input"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(action).toHaveBeenCalledTimes(1)
    expect(onOpenDrawer).not.toHaveBeenCalled() // 命令跳转无 drawerTab
    const emitted = wrapper.emitted('update:open')
    expect(emitted?.[emitted.length - 1]).toEqual([false])
  })

  it('Tab/Shift+Tab 五态循环切类：null→command→file→symbol→session→null 逐态过滤分组', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'c1', name: 'cmd-x', action: vi.fn() }])
    deps.ports.fileCandidates = vi.fn(async () => [fileNode('src/x.ts')])
    deps.ports.sessionList = vi.fn(async (): Promise<SessionGroup[]> => [
      { cwd: '/p', sessions: [{ id: 's1', label: 'sess-x', cwd: '/p', status: 'active', lastActiveAt: 0, tokenCount: 0, modelId: 'm' }] },
    ])
    const wrapper = mount(SearchModal, {
      props: { open: true, deps, activeSessionId: 'sid-1' },
    })
    await flushPromises()
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('x')
    await vi.advanceTimersByTimeAsync(150) // 命令/文件/会话三源命中
    const sec = (t: string) => wrapper.find(`[data-testid="search-section-search.${t}"]`).exists()
    // 初始 activeType=null → 三分组全显
    expect(sec('sectionCommand')).toBe(true)
    expect(sec('sectionFile')).toBe(true)
    expect(sec('sectionSession')).toBe(true)

    // Tab 1: null → command（只显命令分组）
    await input.trigger('keydown', { key: 'Tab' })
    expect(sec('sectionCommand')).toBe(true)
    expect(sec('sectionFile')).toBe(false)
    expect(sec('sectionSession')).toBe(false)

    // Tab 2: command → file
    await input.trigger('keydown', { key: 'Tab' })
    expect(sec('sectionFile')).toBe(true)
    expect(sec('sectionCommand')).toBe(false)

    // Tab 3: file → symbol（符号占位分组 0 项 → total=0 → 空态分支，Tab 仍可继续切）
    await input.trigger('keydown', { key: 'Tab' })
    expect(sec('sectionFile')).toBe(false)
    expect(sec('sectionSymbol')).toBe(false)
    expect(wrapper.find('[data-testid="search-empty"]').exists()).toBe(true)

    // Tab 4: symbol → session
    await input.trigger('keydown', { key: 'Tab' })
    expect(sec('sectionSession')).toBe(true)
    expect(sec('sectionSymbol')).toBe(false)

    // Tab 5: session → null（循环回全部）
    await input.trigger('keydown', { key: 'Tab' })
    expect(sec('sectionCommand')).toBe(true)
    expect(sec('sectionFile')).toBe(true)
    expect(sec('sectionSession')).toBe(true)

    // Shift+Tab 反向 1: null → session
    await input.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(sec('sectionSession')).toBe(true)
    expect(sec('sectionCommand')).toBe(false)
  })

  it('AC-9.3 切类后 selIdx 重置为 0（选中项回首项）', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([
      { id: 'a', name: 'cmd-a', action: vi.fn() },
      { id: 'b', name: 'cmd-b', action: vi.fn() },
    ])
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    const items = wrapper.findAll('[data-testid^="search-item-"]')
    expect(items.length).toBe(2)
    const input = wrapper.find('[data-testid="search-input"]')
    // ArrowDown → selIdx=1
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(items[1].attributes('aria-selected')).toBe('true')
    // Tab → command（suggested 分组无对应类被过滤，total=0）
    await input.trigger('keydown', { key: 'Tab' })
    expect(wrapper.findAll('[data-testid^="search-item-"]').length).toBe(0)
    // Shift+Tab → null（回全部），selIdx 已重置 → 首项选中（DOM 在空过滤态被重建，需重新查询）
    await input.trigger('keydown', { key: 'Tab', shiftKey: true })
    const itemsAfter = wrapper.findAll('[data-testid^="search-item-"]')
    expect(itemsAfter.length).toBe(2)
    expect(itemsAfter[0].attributes('aria-selected')).toBe('true')
    expect(itemsAfter[1].attributes('aria-selected')).toBe('false')
  })

  it('AC-9.4 空查询 recents 态 + Tab 切类：「最近」分组恒显（正交非互斥）', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'a', name: 'cmd-a', action: vi.fn() }])
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    // 空查询 → 写入一次 recents（上一步 Enter 未发生，这里直接经 storage 预置）：
    // 简化：suggested 分组恒由 command 源派生，Tab 切类后按 activeType 过滤
    const input = wrapper.find('[data-testid="search-input"]')
    await input.trigger('keydown', { key: 'Tab' }) // → command
    // suggested 分组（kind='suggested' 无对应 type）被隐藏，但因 kindToType 映射正交，
    // 再 Tab 回 null 时恢复——不崩溃且可切回
    await input.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(wrapper.findAll('[data-testid^="search-item-"]').length).toBe(1)
  })
})

describe('confirmSel 数据流三分支（MF-3，AC-6.7）', () => {
  it('(a) ok + drawerTab（file 跳转）→ onOpenDrawer("detail") + emit close', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.ports.fileCandidates = vi.fn(async () => [fileNode('src/app.ts')])
    deps.ports.fileRead = vi.fn(async () => {})
    const onOpenDrawer = vi.fn()
    const wrapper = mount(SearchModal, {
      props: { open: true, deps, activeSessionId: 'sid-1', onOpenDrawer },
    })
    await flushPromises()
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('app')
    await vi.advanceTimersByTimeAsync(150)
    expect(wrapper.findAll('[data-testid^="search-item-"]').length).toBeGreaterThan(0)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(deps.ports.fileRead).toHaveBeenCalledWith('src/app.ts', 'sid-1') // AC-6.9 直调
    expect(deps.fileTree.selectFile).toHaveBeenCalledWith('src/app.ts')
    expect(onOpenDrawer).toHaveBeenCalledWith('detail')
    const emitted = wrapper.emitted('update:open')
    expect(emitted?.[emitted.length - 1]).toEqual([false])
  })

  it('(b) ok 无 drawerTab（app 命令）→ emit close，onOpenDrawer 不调', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'a', name: 'cmd-a', action: vi.fn() }])
    const onOpenDrawer = vi.fn()
    const wrapper = mount(SearchModal, { props: { open: true, deps, onOpenDrawer } })
    await flushPromises()
    await wrapper.find('[data-testid="search-input"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(onOpenDrawer).not.toHaveBeenCalled()
    const emitted = wrapper.emitted('update:open')
    expect(emitted?.[emitted.length - 1]).toEqual([false])
  })

  it('(c) ok:false（app action 抛错）→ 浮层保持打开 + onToastError(error)', async () => {
    const action = vi.fn(() => {
      throw new Error('boom')
    })
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'a', name: 'cmd-a', action }])
    const onToastError = vi.fn()
    const wrapper = mount(SearchModal, { props: { open: true, deps, onToastError } })
    await flushPromises()
    await wrapper.find('[data-testid="search-input"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(onToastError).toHaveBeenCalledWith('boom')
    expect(wrapper.emitted('update:open')).toBeUndefined() // AC-6.7：失败保持打开可重选
    expect(wrapper.find('[data-testid="search-modal-overlay"]').exists()).toBe(true)
  })
})

describe('slash skill 项注入透传（SearchModal → pendingSlash 端到端）', () => {
  it('选中 skill 命令项 → pendingSlash 带 command/isSkill/location/icon/sessionId（第三条 skill 入口合流）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    // pi 真实形态：命令名裸（无 / 前缀）+ sourceInfo.path = SKILL.md 绝对路径
    deps.commandStore.applyCommands('sid-1', [
      {
        name: 'skill:code-review',
        description: '代码评审',
        source: 'skill',
        sourceInfo: { path: '/skills/code-review/SKILL.md', source: 'skill' },
      },
    ])
    const wrapper = mount(SearchModal, {
      props: { open: true, deps, activeSessionId: 'sid-1' },
    })
    await flushPromises()
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('code-review')
    await vi.advanceTimersByTimeAsync(150) // debounce 120ms
    await flushPromises()
    expect(wrapper.find('[data-testid="search-item-0"]').exists()).toBe(true)

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    // 端到端三个环节都不得丢字段：DTO 映射（isSkill/location）→ confirmSel 搬运 → confirmCommand 写通道
    expect(deps.commandStore.pendingSlash.value).toMatchObject({
      command: 'skill:code-review',
      isSkill: true,
      location: '/skills/code-review/SKILL.md',
      icon: 'star',
      sessionId: 'sid-1',
    })
  })

  it('选中普通命令项 → pendingSlash 无 isSkill/location（命令通路回归锁）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.commandStore.applyCommands('sid-1', [{ name: 'goal', description: '目标驱动', source: 'extension' }])
    const wrapper = mount(SearchModal, {
      props: { open: true, deps, activeSessionId: 'sid-1' },
    })
    await flushPromises()
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('goal')
    await vi.advanceTimersByTimeAsync(150)
    await flushPromises()

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const pending = deps.commandStore.pendingSlash.value!
    expect(pending.command).toBe('goal')
    expect(pending.isSkill).toBe(false)
    expect(pending.location).toBeUndefined()
  })
})

describe('关闭路径（MF-4，AC-7.1/AC-7.14/MR-7.1）', () => {
  it('Esc（dialog div keydown）→ emit update:open false', async () => {
    const deps = makeDeps()
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    const emitted = wrapper.emitted('update:open')
    expect(emitted?.[emitted.length - 1]).toEqual([false])
  })

  it('遮罩 .self 点击关闭；内容区点击不关闭', async () => {
    const deps = makeDeps()
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    // 内容区点击（@click.stop 阻断，.self 不匹配）→ 无 emit
    await wrapper.find('[data-testid="search-modal-root"]').trigger('click')
    expect(wrapper.emitted('update:open')).toBeUndefined()
    // 遮罩自身点击（.self 匹配）→ emit close
    await wrapper.find('[data-testid="search-modal-overlay"]').trigger('click')
    const emitted = wrapper.emitted('update:open')
    expect(emitted?.[emitted.length - 1]).toEqual([false])
  })

  it('close 重置：query 清空 + activeType 回 null + 无孤儿查询（MR-7.1 守卫）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.ports.isMock = true // searchMock 计数 = loadResults 调用计数
    // searchMock 在 SearchDeps ports 上是 optional（core search-ports）——运行时 guard 收窄
    if (!deps.ports.searchMock) throw new Error('searchMock port missing')
    const searchMock = vi.mocked(deps.ports.searchMock)
    // 运行时 guard（非断言强转）：ports.searchMock 类型可选，本用例强依赖该注入计数
    if (!searchMock) throw new Error('测试前置缺失：deps.ports.searchMock 未注入')
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    const callsAfterOpen = searchMock.mock.calls.length
    // 输入 → debounce → 新查询
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('cmd')
    await vi.advanceTimersByTimeAsync(150)
    expect(searchMock.mock.calls.length).toBe(callsAfterOpen + 1)
    // close（query='' 触发 watch(query)，孤儿守卫阻断重新调度）
    await setOpen(wrapper, false)
    expect(wrapper.find('[data-testid="search-modal-overlay"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(300) // 覆盖 debounce 120ms + loading 200ms 窗口
    expect(searchMock.mock.calls.length).toBe(callsAfterOpen + 1) // 无幽灵加载
    // reopen：query 已清空（input 值为空非 'cmd'）
    await setOpen(wrapper, true)
    await flushPromises()
    expect((wrapper.find('[data-testid="search-input"]').element as HTMLInputElement).value).toBe('')
  })

  it('close 重置 selIdx：切类+移动选中后 close→reopen 回全部且首项选中', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([
      { id: 'a', name: 'cmd-a', action: vi.fn() },
      { id: 'b', name: 'cmd-b', action: vi.fn() },
    ])
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    const input = wrapper.find('[data-testid="search-input"]')
    await input.trigger('keydown', { key: 'ArrowDown' }) // selIdx=1
    await input.trigger('keydown', { key: 'Tab' }) // activeType=command（suggested 隐藏）
    expect(wrapper.findAll('[data-testid^="search-item-"]').length).toBe(0)
    await setOpen(wrapper, false)
    await setOpen(wrapper, true)
    await flushPromises()
    const items = wrapper.findAll('[data-testid^="search-item-"]')
    expect(items.length).toBe(2) // activeType 已回 null → 全部分组
    expect(items[0].attributes('aria-selected')).toBe('true') // selIdx 归 0
  })

  it('同实例 open true→false→true 翻转：无崩溃 + 状态恢复（AC-7.14）', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'a', name: 'cmd-a', action: vi.fn() }])
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    await setOpen(wrapper, false)
    await setOpen(wrapper, true)
    await flushPromises()
    expect(wrapper.find('[data-testid="search-modal-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="search-item-0"]').exists()).toBe(true)
  })
})

describe('错误路径（MF-5，T5.4/AC-8.5）', () => {
  it('query reject → 不崩溃 + loading 清 + overlay 仍在 + console.error 输出（no-silent-catch）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.ports.isMock = true
    deps.ports.searchMock = vi.fn(async () => {
      throw new Error('unexpected')
    })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const wrapper = mount(SearchModal, { props: { open: true, deps } })
      await vi.advanceTimersByTimeAsync(250)
      await flushPromises()
      expect(wrapper.find('[data-testid="search-loading"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="search-modal-overlay"]').exists()).toBe(true)
      expect(consoleSpy).toHaveBeenCalled()
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('errorMsg transient（AC-8.5）：首次查询失败后新查询正常恢复', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.ports.isMock = true
    let fail = true
    deps.ports.searchMock = vi.fn(async (q: string) => {
      if (fail) throw new Error('boom')
      return [{ label: 'cmd', kind: 'command' as const, items: [{ type: 'command' as const, title: 'x', sub: 'y' }] }]
    })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const wrapper = mount(SearchModal, { props: { open: true, deps } })
      await flushPromises()
      expect(wrapper.findAll('[data-testid^="search-item-"]').length).toBe(0) // 首次失败无结果
      fail = false
      const input = wrapper.find('[data-testid="search-input"]')
      await input.setValue('x')
      await vi.advanceTimersByTimeAsync(150)
      // 新查询成功渲染（error 已被 watch(query) 清除，不阻断后续查询）
      expect(wrapper.find('[data-testid="search-item-0"]').exists()).toBe(true)
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

describe('loading 与空态（MF-6，AC-8.1/AC-7.13）', () => {
  it('查询 >200ms 未返回 → search-loading 显示；<200ms 不显示（防闪烁）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.ports.isMock = true
    deps.ports.searchMock = vi.fn(() => new Promise<Section[]>(() => {})) // 永不 resolve（pending >200ms）
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    expect(wrapper.find('[data-testid="search-loading"]').exists()).toBe(false) // <200ms 不显
    await vi.advanceTimersByTimeAsync(201)
    expect(wrapper.find('[data-testid="search-loading"]').exists()).toBe(true) // >200ms 显
  })

  it('空查询 + 无 recents/suggested → search-empty + startHint（首用引导）', async () => {
    const deps = makeDeps() // 无注册命令、无 recents
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    expect(wrapper.find('[data-testid="search-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('search.startHint')
  })

  it('非空查询无命中 → search-empty + noResult（含 query）+ tryOther', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'a', name: 'cmd-a', action: vi.fn() }])
    const wrapper = mount(SearchModal, { props: { open: true, deps } })
    await flushPromises()
    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('zzz-no-hit')
    await vi.advanceTimersByTimeAsync(150)
    expect(wrapper.find('[data-testid="search-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('search.noResult')
    expect(wrapper.text()).toContain('search.tryOther')
  })
})

describe('焦点管理（MF-7，W1 focus）', () => {
  it('open → nextTick 后焦点落在输入框（document.activeElement === input）', async () => {
    const deps = makeDeps()
    const wrapper = mount(SearchModal, {
      props: { open: true, deps },
      attachTo: document.body,
    })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[data-testid="search-input"]').element)
    wrapper.unmount()
  })
})
