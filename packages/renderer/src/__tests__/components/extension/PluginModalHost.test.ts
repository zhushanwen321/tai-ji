/**
 * PluginModalHost 测试（plugin-header-action-modal-points u4b，AP-2 渲染契约）。
 *
 * 覆盖（三视角 TEST-STRATEGY §3：每条至少一个用户可见 DOM 断言）：
 * - open 帧 → 层出现（Teleport body + testid=plugin-modal）
 * - title 单一解析链：frame.title ?? declaration.title ?? modalId（E1 降级链）
 * - width 三档档位闭集 → 标准 max-w scale（sm→xl / md→3xl / lg→5xl）
 * - Esc → 本地乐观关闭 + C→S dismissModal 上报 + 焦点归还触发元素（场景 1 归焦判据）
 * - AP-2 规则③：CompanionBand 确认层挂起时 Esc 不关 modal（撤层后恢复）；
 *   层级序 modal（--z-modal）< 确认层（--z-dialog，style.css token 序守卫）
 * - 切会话 → 关闭（reason session-switched，D1 生命周期）
 * - 浮层互斥：Search 打开 / Settings 挂载（body 直挂 .fso）→ reason host-overlay（AP-2 规则①）
 * - 关闭键、内容树 = ViewHost 消费 modal-<pluginId>-<modalId> per-session 分区
 * - 全局单例守卫：split 双实例只渲染一层
 * - 键盘细节（test-coverage SG-1 补防线）：Esc 去重（层内 keydown preventDefault 后
 *   window 级兜底不二次 dismiss）+ Tab 焦点陷阱首末循环（末→首 / 首 Shift→末 / 中间放行）
 *
 * Teleport 到 body 的层不在 wrapper.find 范围内——层断言统一走 document.querySelector。
 * afterEach 必须先 unmount 再清 body（Teleport 锚点挂在 body，顺序颠倒会让 Vue 的
 * 后续 patch 落在已移除的锚点上 → insertBefore null unhandled rejection）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/extension/PluginModalHost.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  it('AP-2 规则③：CompanionBand 确认层挂起时 Esc 不关 modal（裁决权归确认层），撤层后恢复', async () => {
    const modalSource = makeModalSource()
    mountHost({ modalSource })
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)

    // 模拟 CompanionBand 确认层挂起（band 挂载 = 存在待决 ui-request，含 minimized 收起态）
    const band = document.createElement('div')
    band.setAttribute('data-testid', 'companion-band')
    document.body.appendChild(band)

    // window 级兜底 Esc：跳过 dismiss（modal 仍开，confirm 不被顺手吞掉）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(layerExists()).toBe(true)
    expect(modalSource.dismiss).not.toHaveBeenCalled()

    // 层内 Esc（焦点在层内的路径）：同样跳过
    layerEl()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(layerExists()).toBe(true)
    expect(modalSource.dismiss).not.toHaveBeenCalled()

    // 确认层撤下（用户已应答）→ Esc 恢复关闭 modal（守卫不滞留）
    band.remove()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(layerExists()).toBe(false)
    expectDismissReported(modalSource, 'dismissed')
  })

  it('AP-2 规则③层级：modal 层钉 --z-modal 档，低于确认层 --z-dialog 档（新到 ui-request 叠其上）', async () => {
    mountHost()
    openSlot()
    await nextTick()
    // modal 层（Teleport body）钉在 modal 档 token
    expect(layerEl()?.className).toContain('z-[var(--z-modal)]')
    // 叠放序的数值前提：renderer style.css 中 --z-dialog > --z-modal（读源守卫 token 序；
    // 本包测试运行契约 = cwd 在 packages/renderer，见文件头运行说明）
    const css = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf-8')
    const tokenValue = (name: string): number => {
      const m = css.match(new RegExp(`--${name}:\\s*(\\d+)`))
      if (!m) throw new Error(`style.css missing token --${name}（层级契约被破坏）`)
      return Number(m[1])
    }
    expect(tokenValue('z-dialog')).toBeGreaterThan(tokenValue('z-modal'))
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

  it('Esc 去重（window 级兜底）：层内 keydown 先 preventDefault，冒泡到 window 不二次 dismiss', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const modalSource = makeModalSource()
    mountHost({ modalSource })
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)
    // Esc 从层内焦点元素发起（bubbles 冒泡经层内 @keydown → window 兜底监听双路可达）；
    // 显式聚焦关闭键（open 自动聚焦是异步 nextTick 回调，显式聚焦使命中路径确定）
    const closeBtn = document.querySelector('[data-testid=plugin-modal-close]') as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    closeBtn.focus()
    expect(layerEl()?.contains(document.activeElement)).toBe(true)

    closeBtn.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await nextTick()

    // 双路只 dismiss 一次（层内先 preventDefault，window 兜底 defaultPrevented 跳过）
    expect(modalSource.dismiss).toHaveBeenCalledTimes(1)
    expectDismissReported(modalSource, 'dismissed')
    expect(layerExists()).toBe(false)
    // 焦点归还触发元素（场景 1 归焦判据，window 兜底路径同样成立）
    expect(document.activeElement).toBe(trigger)
  })

  it('Tab 焦点陷阱（a11y 契约）：末个 Tab → 首个；首个 Shift+Tab → 末个', async () => {
    mountHost()
    openSlot()
    await nextTick()
    expect(layerExists()).toBe(true)

    // 层内内容区补两个可聚焦元素（ViewHost 空内容首帧无 focusable，构造首末序）：
    // 文档序 = [关闭键(header), extra-1, extra-2]
    const content = layerEl()?.querySelector('.overflow-auto') ?? layerEl()!
    const extra1 = document.createElement('button')
    extra1.textContent = 'extra-1'
    const extra2 = document.createElement('a')
    extra2.textContent = 'extra-2'
    extra2.setAttribute('href', '#')
    content.append(extra1, extra2)

    const closeBtn = document.querySelector('[data-testid=plugin-modal-close]') as HTMLButtonElement
    expect(closeBtn).not.toBeNull()

    // 末个（extra-2）非 shift Tab → preventDefault + 聚焦首个（关闭键）
    extra2.focus()
    expect(document.activeElement).toBe(extra2)
    const tabFwd = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    extra2.dispatchEvent(tabFwd)
    expect(tabFwd.defaultPrevented).toBe(true) // 陷阱接管（不外泄浏览器原生顺序）
    expect(document.activeElement).toBe(closeBtn)

    // 首个（关闭键）shift Tab → preventDefault + 聚焦末个（extra-2）
    const tabBack = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    closeBtn.dispatchEvent(tabBack)
    expect(tabBack.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(extra2)

    // 中间元素（extra-1）非 shift Tab：不接管（defaultPrevented false，交浏览器原生顺序）
    extra1.focus()
    const tabMid = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    extra1.dispatchEvent(tabMid)
    expect(tabMid.defaultPrevented).toBe(false)
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
