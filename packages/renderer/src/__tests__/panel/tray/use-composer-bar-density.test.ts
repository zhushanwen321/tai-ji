/**
 * use-composer-bar-density 单测（u6b / D6 接线件）。
 *
 * 覆盖（接线件本职，不含状态机的穷举——那在 `composer-density.test.ts`，100% 覆盖）：
 * - 阈值边界驱动：ResizeObserver 实测宽 → 档位（640 含 → expanded / 639 → compact / 520 含 → compact
 *   / 519 → narrow）；首帧未实测 → 全展开（不闪聚合态）。
 * - 能力标志：`pluginToolbarContributionCount`（挂载点 view 有内容 → 1，无内容/未 provide → 0）；
 *   `hasTrayItems`（缺省 true，`onTrayItemsChange(false)` → 序 4 不生效）。
 * - 脏输入：entry 缺 contentRect / width 非有限值 → 不崩，非有限值落最保守档（narrow）。
 * - **fit 收敛回路**（方案 A）：实测「两簇占宽 > 可用宽」→ 逐级收紧到放得下；变宽 → 逐级放松；
 *   同宽度 regime 内不反复升降（迟滞）。
 * - 生命周期：无 ResizeObserver 宿主跳过观测并**一次性告警**（降级留痕，多实例不刷屏）；卸载断开
 *   observer（派发不再触达）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/use-composer-bar-density.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, nextTick } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewCacheEntry, ViewHostSource } from '@taiji/ui/extension-host'
import { ManualResizeObserverStub } from '../../effects/_virtua-mock-helper'
import {
  useComposerBarDensity,
  composerModelGroupClass,
  MERGED_CHIP_CLASS,
  MERGED_CHIP_SEPARATOR_CLASS,
  MODEL_MERGED_CHIP_CLASS,
  MODEL_SIMPLIFIED_CHIP_CLASS,
  EXPANDED_GROUP_CLASS,
} from '@/components/panel/tray/use-composer-bar-density'
import type { ComposerDensityLayout } from '@/components/panel/composer-density'

const SID = 's-hook'

interface HostExposed {
  getDensity(): ComposerDensityLayout
  setTrayItems(value: boolean): void
}

/** 最小宿主：只把接线件暴露给断言（形态 → DOM 的映射由 Composer 级用例覆盖）。
 *  底栏内带左右两簇（`data-composer-cluster`）：fit 回路据二者占宽之和判「放不放得下」。 */
const Host = defineComponent({
  props: { sessionId: { type: String, default: SID } },
  setup(props, { expose }) {
    const { barRef, density, onTrayItemsChange } = useComposerBarDensity(
      computed(() => props.sessionId),
    )
    expose({ getDensity: () => density.value, setTrayItems: onTrayItemsChange })
    return { barRef }
  },
  template: `
    <div ref="barRef" data-testid="host-bar" class="flex flex-nowrap items-center justify-end gap-0 px-2.5">
      <div data-composer-cluster="left" data-testid="host-left" class="flex shrink-0 items-center">left</div>
      <span class="min-w-0 flex-1" />
      <div data-composer-cluster="right" data-testid="host-right" class="flex shrink-0 items-center">right</div>
    </div>
  `,
})

/** 挂载点数据源替身（getViewIds 恒空：只服务 plugin toolbar 贡献面查询） */
function makeSource(entry?: ViewCacheEntry): ViewHostSource {
  return {
    getView: (sid, viewId) => (sid === SID && viewId === 'composer.toolbar' ? entry : undefined),
    getViewIds: () => [],
  }
}

function toolbarEntry(): ViewCacheEntry {
  return {
    viewId: 'composer.toolbar',
    pluginId: 'ext-x',
    guiTree: [{ type: 'ansi-text', props: { lines: ['toolbar'] } }],
    updatedAt: 1_760_000_000_000,
  }
}

let wrapper: VueWrapper | null = null

function mountHost(source?: ViewHostSource | null): HostExposed {
  wrapper = mount(Host, {
    global: source ? { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: source } } : {},
  })
  return wrapper.vm as unknown as HostExposed
}

async function dispatchWidth(width: unknown): Promise<void> {
  const observer = ManualResizeObserverStub.created()[0]
  if (!observer) throw new Error('ResizeObserver 未创建：接线件未挂载')
  observer.dispatch([{ contentRect: { width } as DOMRectReadOnly }])
  await nextTick()
}

/** 派发一条缺 contentRect 的脏 entry（polyfill/异常宿主形态） */
async function dispatchBareEntry(): Promise<void> {
  const observer = ManualResizeObserverStub.created()[0]
  if (!observer) throw new Error('ResizeObserver 未创建：接线件未挂载')
  observer.dispatch([{}])
  await nextTick()
}

/**
 * 打桩宿主几何：底栏可用宽（clientWidth − padding）+ 左右两簇占宽，并派发一次 RO 回调
 * （无 target 的 entry 按底栏条目处理，与宿主 polyfill 形态一致）。
 *
 * @param avail 底栏内容可用宽（px）
 * @param left 左簇占宽（px）
 * @param right 右簇占宽（px）
 */
async function dispatchGeometry(avail: number, left: number, right: number): Promise<void> {
  const bar = hostEl('[data-testid="host-bar"]')
  const leftEl = hostEl('[data-testid="host-left"]')
  const rightEl = hostEl('[data-testid="host-right"]')
  // px-2.5 两侧 = 20px；clientWidth 含内边距，故 +20 才是元素盒宽
  Object.defineProperty(bar, 'clientWidth', { value: avail + 20, configurable: true })
  vi.spyOn(leftEl, 'getBoundingClientRect').mockReturnValue({ width: left } as DOMRect)
  vi.spyOn(rightEl, 'getBoundingClientRect').mockReturnValue({ width: right } as DOMRect)
  const observer = ManualResizeObserverStub.created()[0]
  observer.dispatch([{ target: bar, contentRect: { width: avail } as DOMRectReadOnly }])
  await flushFitPasses()
}

/** 宿主内查询元素（走 VTU 包装器：根节点自身也命中，无需依赖 document 挂载） */
function hostEl(selector: string): HTMLElement {
  const node = wrapper?.find(selector)
  if (!node?.exists()) throw new Error(`宿主节点缺失（${selector}）：模板与 fit 回路不同步？`)
  return node.element as HTMLElement
}

/** 等 fit 回路跑完（rAF 链；happy-dom 有 rAF，兜底宏任务同样被覆盖） */
async function flushFitPasses(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })
  }
  await nextTick()
}

beforeEach(() => {
  ManualResizeObserverStub.install()
})

afterEach(() => {
  ManualResizeObserverStub.uninstall()
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useComposerBarDensity：首帧与阈值边界', () => {
  it('首帧未实测 → 全展开（不闪聚合/合流态）', () => {
    const host = mountHost(makeSource())
    expect(host.getDensity().tier).toBe('expanded')
    expect(ManualResizeObserverStub.created()).toHaveLength(1)
  })

  it('实测宽驱动三档（边界：640 含 → expanded / 520 含 → compact）', async () => {
    const host = mountHost(makeSource())
    expect(ManualResizeObserverStub.created()[0]?.observe).toBeDefined()

    await dispatchWidth(640)
    expect(host.getDensity().tier).toBe('expanded')
    await dispatchWidth(639)
    expect(host.getDensity().tier).toBe('compact')
    await dispatchWidth(520)
    expect(host.getDensity().tier).toBe('compact')
    await dispatchWidth(519)
    expect(host.getDensity().tier).toBe('narrow')
    await dispatchWidth(1920)
    expect(host.getDensity().tier).toBe('expanded')
  })
})

describe('useComposerBarDensity：能力标志供给', () => {
  it('插件 toolbar 有贡献（挂载点 view 非空）→ 窄档 overflowMenuVisible，宽档不显', async () => {
    const host = mountHost(makeSource(toolbarEntry()))
    await dispatchWidth(700)
    expect(host.getDensity().slots.pluginToolbar).toBe('expanded')
    expect(host.getDensity().overflowMenuVisible).toBe(false)

    await dispatchWidth(560)
    expect(host.getDensity().slots.pluginToolbar).toBe('collapsed-to-menu')
    expect(host.getDensity().overflowMenuVisible).toBe(true)
  })

  it('未 provide 数据源 / 挂载点无 view → 贡献数 0（不留死入口）', async () => {
    const noSource = mountHost(null)
    await dispatchWidth(400)
    expect(noSource.getDensity().slots.pluginToolbar).toBe('absent')
    expect(noSource.getDensity().overflowMenuVisible).toBe(false)

    wrapper?.unmount()
    const emptyView = mountHost(makeSource())
    await dispatchWidth(400)
    expect(emptyView.getDensity().slots.pluginToolbar).toBe('absent')
    expect(emptyView.getDensity().overflowMenuVisible).toBe(false)
  })

  it('托盘三态上抛：缺省有面；onTrayItemsChange(false) → 序 4 不生效（slot = absent）', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(400)
    expect(host.getDensity().slots.tray).toBe('aggregated')
    expect(host.getDensity().appliedOrders).toContain(4)

    host.setTrayItems(false)
    await nextTick()
    expect(host.getDensity().slots.tray).toBe('absent')
    expect(host.getDensity().appliedOrders).not.toContain(4)
  })
})

describe('useComposerBarDensity：脏输入与生命周期', () => {
  it('entry 缺 contentRect → 不崩且不改变已实测档位', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(700)
    expect(host.getDensity().tier).toBe('expanded')

    await dispatchBareEntry()
    expect(host.getDensity().tier).toBe('expanded')
  })

  it('width 非有限值 / 负值 → 落最保守档（narrow），不污染后续实测', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(Number.NaN)
    expect(host.getDensity().tier).toBe('narrow')
    await dispatchWidth(-10)
    expect(host.getDensity().tier).toBe('narrow')
    await dispatchWidth(700)
    expect(host.getDensity().tier).toBe('expanded')
  })

  it('无 ResizeObserver 宿主 → 跳过观测（不崩，停留全展开）+ 降级一次性告警（多实例不刷屏）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ManualResizeObserverStub.uninstall()
    vi.stubGlobal('ResizeObserver', undefined)
    const host = mountHost(makeSource())
    expect(host.getDensity().tier).toBe('expanded')
    expect(ManualResizeObserverStub.created()).toHaveLength(0)
    // 降级留痕：一次性告警带可检索前缀，不静默
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[composer-density] ResizeObserver 不可用，底栏停留在全展开档（可能横向溢出）',
    )
    // 同模块第二次挂载（分屏另一 pane / 重挂载）不再重复刷告警
    wrapper?.unmount()
    wrapper = null
    mountHost(makeSource())
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('卸载断开 observer：派发不再触达（宿主 DOM 已消失）', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(400)
    expect(host.getDensity().tier).toBe('narrow')
    const observer = ManualResizeObserverStub.created()[0]
    wrapper?.unmount()
    wrapper = null
    observer?.dispatch([{ contentRect: { width: 700 } as DOMRectReadOnly }])
    await nextTick()
    expect(document.querySelector('[data-testid="host-bar"]')).toBeNull()
  })
})

describe('useComposerBarDensity：导出形态类（形态 → class 单点）', () => {
  it('V2 合流类：无实心底（badge 感根因），只留收紧内边距 + 容器级截断前提', () => {
    // V2：去掉 bg-surface-2 / rounded-sm —— 整行两个实心 chip 读作「徽章墙」，与展开态纯文本触发器断裂
    expect(MERGED_CHIP_CLASS).not.toContain('bg-surface-2')
    expect(MERGED_CHIP_CLASS).not.toContain('rounded-sm')
    expect(MERGED_CHIP_CLASS).toContain('[&_button]:px-1')
    // 分组改由发丝分隔表达（1px 竖线，landing meta-row 同款范式）
    expect(MERGED_CHIP_SEPARATOR_CLASS).toContain('w-px')
    expect(MERGED_CHIP_SEPARATOR_CLASS).toContain('bg-border-strong')
  })

  it('模型容器：合体态 88px 截断；fit L1 收紧到 56px；展开态无容器级约束', () => {
    expect(MODEL_MERGED_CHIP_CLASS.startsWith(MERGED_CHIP_CLASS)).toBe(true)
    expect(MODEL_MERGED_CHIP_CLASS).toContain('max-w-[88px]')
    expect(MODEL_MERGED_CHIP_CLASS).toContain('truncate')
    // min-w-0：span 才可能被压到 max-w 以下并出省略号（flex 子项默认 min-width:auto）
    expect(MODEL_MERGED_CHIP_CLASS).toContain('[&_button_span]:min-w-0')

    expect(MODEL_SIMPLIFIED_CHIP_CLASS).toContain('max-w-[56px]')
    expect(MODEL_SIMPLIFIED_CHIP_CLASS).toContain('truncate')
  })

  it('composerModelGroupClass：四象限各取唯一 class（不叠加两条 max-w）', () => {
    // 展开 + full：无容器级约束（保持原视觉）
    expect(composerModelGroupClass(false, false)).toBe(EXPANDED_GROUP_CLASS)
    // 合体 + full：88px
    expect(composerModelGroupClass(true, false)).toBe(MODEL_MERGED_CHIP_CLASS)
    // fit L1：无论合体与否都收紧到 56px（同一 class，不叠加）
    expect(composerModelGroupClass(false, true)).toBe(MODEL_SIMPLIFIED_CHIP_CLASS)
    expect(composerModelGroupClass(true, true)).toBe(MODEL_SIMPLIFIED_CHIP_CLASS)
  })
})

describe('useComposerBarDensity：fit 收敛回路（方案 A 内容自适应）', () => {
  it('放得下 → 不施加 fit 退化（fitLevel 0，两组 full）', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(640)
    await dispatchGeometry(400, 80, 300)
    expect(host.getDensity().fitLevel).toBe(0)
    expect(host.getDensity().fit.capacityMetrics).toBe('full')
  })

  it('放不下 → 逐级收紧直到放得下（两级即够则停在 2，不到顶）', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(400)
    // 右簇占宽随当前 fit 级回落（模拟「形态收紧 → 需求宽下降」）：
    // L0 540 > 400 → L1；L1 480 > 400 → L2；L2 320 ≤ 400 → 收敛在 L2
    const widthByFit: Record<number, number> = { 0: 520, 1: 460, 2: 300, 3: 200 }
    const rightEl = hostEl('[data-testid="host-right"]')
    vi.spyOn(rightEl, 'getBoundingClientRect').mockImplementation(
      () => ({ width: widthByFit[host.getDensity().fitLevel] }) as DOMRect,
    )
    const leftEl = hostEl('[data-testid="host-left"]')
    vi.spyOn(leftEl, 'getBoundingClientRect').mockReturnValue({ width: 20 } as DOMRect)
    const bar = hostEl('[data-testid="host-bar"]')
    Object.defineProperty(bar, 'clientWidth', { value: 420, configurable: true })
    const observer = ManualResizeObserverStub.created()[0]
    observer.dispatch([{ target: bar, contentRect: { width: 400 } as DOMRectReadOnly }])
    await flushFitPasses()
    expect(host.getDensity().fitLevel).toBe(2)
    expect(host.getDensity().fit.capacityMetrics).toBe('iconic')
    expect(host.getDensity().fit.modelThinking).toBe('iconic')
  })

  it('一直放不下 → 顶格 L3 即停（不无限升级）', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(300)
    await dispatchGeometry(200, 80, 400)
    expect(host.getDensity().fitLevel).toBe(3)
    expect(host.getDensity().fit.capacityMetrics).toBe('collapsed-to-menu')
    expect(host.getDensity().overflowMenuVisible).toBe(true)
    expect(host.getDensity().overflowItems).toContain('capacity')
  })

  it('变宽 → 逐级放松回 full（迟滞：只在更宽裕时降级）', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(300)
    await dispatchGeometry(200, 80, 400)
    expect(host.getDensity().fitLevel).toBe(3)
    // 容器变宽且右簇内容变窄 → 一路放松到 0
    await dispatchGeometry(600, 80, 200)
    expect(host.getDensity().fitLevel).toBe(0)
    expect(host.getDensity().fit.capacityMetrics).toBe('full')
  })

  it('同宽度下反复派发不抖（1↔2 来回）', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(400)
    await dispatchGeometry(400, 80, 340)
    const settled = host.getDensity().fitLevel
    for (let i = 0; i < 5; i += 1) {
      await dispatchGeometry(400, 80, 340)
    }
    expect(host.getDensity().fitLevel).toBe(settled)
  })

  it('缺簇节点（模板变更/异常宿主）→ 放弃自纠但不崩，保持当前级', async () => {
    const host = mountHost(makeSource())
    await dispatchWidth(560)
    expect(host.getDensity().tier).toBe('compact')
    hostEl('[data-testid="host-right"]').remove()
    const bar = hostEl('[data-testid="host-bar"]')
    const observer = ManualResizeObserverStub.created()[0]
    expect(() => observer.dispatch([{ target: bar, contentRect: { width: 400 } as DOMRectReadOnly }])).not.toThrow()
    await flushFitPasses()
    expect(host.getDensity().tier).toBe('narrow')
    expect(host.getDensity().fitLevel).toBe(0)
  })
})
