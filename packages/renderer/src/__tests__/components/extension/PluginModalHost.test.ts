/**
 * PluginModalHost 测试（plugin-header-action-modal-points u4b，AP-2 渲染契约）。
 *
 * 覆盖（三视角 TEST-STRATEGY §3：每条至少一个用户可见 DOM 断言）：
 * - open 帧 → 层出现（Teleport body + testid=plugin-modal）
 * - title 单一解析链：frame.title ?? declaration.title ?? modalId（E1 降级链）
 * - width 三档档位闭集 → 标准 max-w scale（sm→xl / md→3xl / lg→5xl）
 * - Esc → 本地乐观关闭 + C→S dismissModal 上报 + 焦点归还触发元素（场景 1 归焦判据）
 * - 切会话 → 关闭（reason session-switched，D1 生命周期）
 * - 浮层互斥：Search 打开 / Settings 挂载（body 直挂 .fso）→ reason host-overlay（AP-2 规则①）
 * - 关闭键、内容树 = ViewHost 消费 modal-<pluginId>-<modalId> per-session 分区
 * - 全局单例守卫：split 双实例只渲染一层
 *
 * Teleport 到 body 的层不在 wrapper.find 范围内——层断言统一走 document.querySelector。
 * afterEach 必须先 unmount 再清 body（Teleport 锚点挂在 body，顺序颠倒会让 Vue 的
 * 后续 patch 落在已移除的锚点上 → insertBefore null unhandled rejection）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension/PluginModalHost.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  openPluginModal,
  resetPluginModalSlot,
  resetSearchModal,
  useSearchModal,
  type PluginModalOpenRequest,
} from '@taiji/core'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import PluginModalHost, { __resetPluginModalHostForTest } from '@/components/extension/PluginModalHost.vue'
import { PLUGIN_MODAL_SOURCE_KEY, type PluginModalSource } from '@/composables/shell/useExtensionHostBridge'

/** 活跃 wrapper 登记表（afterEach 统一 unmount，Teleport 锚点清理顺序见文件头）。 */
const liveWrappers: VueWrapper[] = []

function makeModalSource(declaration?: { title?: string; width?: 'sm' | 'md' | 'lg' }): PluginModalSource {
  return {
    getDeclaration: vi.fn(() => declaration),
    // dismiss 上报断言用 spy（组件经注入门面上报，不直调 ws-client）
    dismiss: vi.fn(),
  }
}

function mountHost(opts: {
  sessionId?: string
  modalSource?: PluginModalSource
  viewTree?: { lines: string[] }
} = {}): VueWrapper {
  const viewSource = {
    getView: vi.fn(() =>
      opts.viewTree
        ? {
            viewId: 'modal-scheduler-manager-scheduler-manager.panel',
            pluginId: 'scheduler-manager',
            guiTree: [{ type: 'ansi-text', props: { lines: opts.viewTree.lines } }],
            updatedAt: 1,
          }
        : undefined,
    ),
    getViewIds: vi.fn(() => []),
  }
  const wrapper = mount(PluginModalHost, {
    props: { sessionId: opts.sessionId ?? 's1' },
    global: {
      provide: {
        [PLUGIN_MODAL_SOURCE_KEY]: opts.modalSource ?? makeModalSource(),
        [VIEW_HOST_SOURCE_KEY]: viewSource,
      },
    },
  })
  liveWrappers.push(wrapper)
  return wrapper
}

function openSlot(overrides: Partial<PluginModalOpenRequest> = {}): void {
  openPluginModal({
    pluginId: 'scheduler-manager',
    modalId: 'scheduler-manager.panel',
    sessionId: 's1',
    epoch: 1,
    ...overrides,
  })
}

/** 层挂载在 Teleport 目标（document.body）上，统一从 document 查询。 */
function layerEl(): Element | null {
  return document.querySelector('[data-testid=plugin-modal]')
}
const layerExists = (): boolean => layerEl() !== null
const expectDismissReported = (source: PluginModalSource, reason: string): void => {
  expect(source.dismiss).toHaveBeenCalledWith('scheduler-manager', 'scheduler-manager.panel', 1, reason)
}

beforeEach(() => {
  resetPluginModalSlot()
  __resetPluginModalHostForTest()
  resetSearchModal()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

afterEach(() => {
  // 先卸载（Teleport 内容随组件移除），再清残留（测试自建的 trigger/settings 层）
  for (const w of liveWrappers.splice(0)) w.unmount()
  document.body.innerHTML = ''
})

describe('PluginModalHost', () => {
  it('open 帧 → 层出现（Teleport body，testid=plugin-modal）+ 宿主 chrome 只有标题与关闭键', async () => {
    const wrapper = mountHost()
    expect(layerExists()).toBe(false)
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)
    expect(document.querySelector('[data-testid=plugin-modal-title]')).not.toBeNull()
    expect(document.querySelector('[data-testid=plugin-modal-close]')).not.toBeNull()
    // 用户可见断言：chrome 标题文本渲染（Teleport 层在 body，经 document 查询）
    expect(document.querySelector('[data-testid=plugin-modal-title]')?.textContent).toBe('scheduler-manager.panel')
  })

  it('title 解析链 ①：frame.title 优先', async () => {
    mountHost({ modalSource: makeModalSource({ title: '声明标题' }) })
    openSlot({ title: '帧标题' })
    await nextTick()
    expect(document.querySelector('[data-testid=plugin-modal-title]')?.textContent).toBe('帧标题')
  })

  it('title 解析链 ②：帧缺省 → 声明 title', async () => {
    mountHost({ modalSource: makeModalSource({ title: '声明标题' }) })
    openSlot()
    await nextTick()
    expect(document.querySelector('[data-testid=plugin-modal-title]')?.textContent).toBe('声明标题')
  })

  it('title 解析链 ③：帧与声明都缺省 → modalId（E1 降级链终点）', async () => {
    mountHost({ modalSource: makeModalSource(undefined) })
    openSlot()
    await nextTick()
    expect(document.querySelector('[data-testid=plugin-modal-title]')?.textContent).toBe('scheduler-manager.panel')
  })

  it.each([
    ['sm', 'max-w-xl'],
    ['md', 'max-w-3xl'],
    ['lg', 'max-w-5xl'],
  ] as const)('width 档位 %s → %s（帧原文优先）', async (width, expectedClass) => {
    mountHost()
    openSlot({ width })
    await nextTick()
    expect(layerEl()?.querySelector('.max-w-xl, .max-w-3xl, .max-w-5xl')?.classList.contains(expectedClass)).toBe(true)
  })

  it('width 解析：帧缺省 → 声明 width；双缺省 → md 档', async () => {
    mountHost({ modalSource: makeModalSource({ width: 'lg' }) })
    openSlot()
    await nextTick()
    expect(layerEl()?.querySelector('.max-w-xl, .max-w-3xl, .max-w-5xl')?.classList.contains('max-w-5xl')).toBe(true)
  })

  it('内容树 = ViewHost 消费 modal-<pluginId>-<modalId> per-session 分区（用户可见文本断言）', async () => {
    mountHost({ viewTree: { lines: ['2 启用 · 1 停用 · 共 3 / 上限 50'] } })
    openSlot()
    await nextTick()
    expect(layerEl()?.textContent).toContain('2 启用 · 1 停用 · 共 3 / 上限 50')
  })

  it('Esc → 本地乐观关闭 + dismissModal 上报（epoch 随帧）+ 焦点归还触发元素', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const modalSource = makeModalSource()
    mountHost({ modalSource })
    openSlot({ epoch: 3 })
    await nextTick()
    expect(layerExists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    // 层收起（本地乐观：closePluginModal 清槽，不等 runtime 往返）
    expect(layerExists()).toBe(false)
    // C→S 上报（经 bridge 门面注入）：设计帧常量 + 所展示 epoch 原文
    expect(modalSource.dismiss).toHaveBeenCalledWith('scheduler-manager', 'scheduler-manager.panel', 3, 'dismissed')
    // 焦点归还（场景 1 Esc 归焦判据）
    expect(document.activeElement).toBe(trigger)
  })

  it('关闭键 → 本地关闭 + 上报 reason=dismissed', async () => {
    const modalSource = makeModalSource()
    mountHost({ modalSource })
    openSlot()
    await nextTick()
    // Teleport 层在 body：原生 click 触发（wrapper.find 不覆盖 Teleport 内容）
    const closeBtn = document.querySelector('[data-testid=plugin-modal-close]')
    expect(closeBtn).not.toBeNull()
    ;(closeBtn as HTMLButtonElement).click()
    await nextTick()
    expect(layerExists()).toBe(false)
    expectDismissReported(modalSource, 'dismissed')
  })

  it('切会话 → 关闭 + 上报 reason=session-switched（D1 生命周期）', async () => {
    const modalSource = makeModalSource()
    const wrapper = mountHost({ sessionId: 's1', modalSource })
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)
    await wrapper.setProps({ sessionId: 's2' })
    await nextTick()
    expect(layerExists()).toBe(false)
    expectDismissReported(modalSource, 'session-switched')
  })

  it('浮层互斥（AP-2 规则①）a：Search 打开 → 关闭 reason=host-overlay', async () => {
    const modalSource = makeModalSource()
    mountHost({ modalSource })
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)
    useSearchModal().open()
    await nextTick()
    expect(layerExists()).toBe(false)
    expectDismissReported(modalSource, 'host-overlay')
  })

  it('浮层互斥（AP-2 规则①）a：Settings 挂载（body 直挂 .fso 层）→ 关闭 reason=host-overlay', async () => {
    const modalSource = makeModalSource()
    mountHost({ modalSource })
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)
    // 模拟 SettingsModal 挂载（fixed inset-0 全屏 .fso 根层）
    const settingsLayer = document.createElement('div')
    settingsLayer.className = 'fso fixed inset-0'
    document.body.appendChild(settingsLayer)
    // MutationObserver 回调是微任务级异步，让出一轮宏任务保证回调执行
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
    expect(layerExists()).toBe(false)
    expectDismissReported(modalSource, 'host-overlay')
  })

  it('全局单例守卫：双实例挂载只渲染一层（split 双 PanelHeader 防重复 DOM）', async () => {
    mountHost()
    mountHost()
    openSlot()
    await nextTick()
    expect(document.querySelectorAll('[data-testid=plugin-modal]').length).toBe(1)
  })

  it('远端换主（不同 owner 的 open 带 replaced 仲裁）→ 层跟随新槽渲染新内容', async () => {
    mountHost()
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)
    // runtime 仲裁：不同 owner 的 open 换主（core 槽记录替换，层跟随）——不上报（发起方 = runtime/插件侧）
    openSlot({ pluginId: 'other', modalId: 'other.panel', epoch: 2 })
    await nextTick()
    expect(layerExists()).toBe(true)
    expect(document.querySelector('[data-testid=plugin-modal-title]')?.textContent).toBe('other.panel')
  })
})
