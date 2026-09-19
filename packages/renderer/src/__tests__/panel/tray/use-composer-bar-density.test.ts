/**
 * use-composer-bar-density 单测（u6b / D6 接线件）。
 *
 * 覆盖（接线件本职，不含状态机的穷举——那在 `composer-density.test.ts`，100% 覆盖）：
 * - 阈值边界驱动：ResizeObserver 实测宽 → 档位（640 含 → expanded / 639 → compact / 520 含 → compact
 *   / 519 → narrow）；首帧未实测 → 全展开（不闪聚合态）。
 * - 能力标志：`pluginToolbarContributionCount`（挂载点 view 有内容 → 1，无内容/未 provide → 0）；
 *   `hasTrayItems`（缺省 true，`onTrayItemsChange(false)` → 序 4 不生效）。
 * - 脏输入：entry 缺 contentRect / width 非有限值 → 不崩，非有限值落最保守档（narrow）。
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
  MERGED_CHIP_CLASS,
  MODEL_MERGED_CHIP_CLASS,
} from '@/components/panel/tray/use-composer-bar-density'
import type { ComposerDensityLayout } from '@/components/panel/composer-density'

const SID = 's-hook'

interface HostExposed {
  getDensity(): ComposerDensityLayout
  setTrayItems(value: boolean): void
}

/** 最小宿主：只把接线件暴露给断言（形态 → DOM 的映射由 Composer 级用例覆盖） */
const Host = defineComponent({
  props: { sessionId: { type: String, default: SID } },
  setup(props, { expose }) {
    const { barRef, density, onTrayItemsChange } = useComposerBarDensity(
      computed(() => props.sessionId),
    )
    expose({ getDensity: () => density.value, setTrayItems: onTrayItemsChange })
    return { barRef }
  },
  template: '<div ref="barRef" data-testid="host-bar" />',
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
  it('合流/合体类是同 chip 容器 + 内部收紧；模型容器额外单行截断', () => {
    expect(MERGED_CHIP_CLASS).toContain('bg-surface-2')
    expect(MERGED_CHIP_CLASS).toContain('[&_button]:px-1')
    expect(MODEL_MERGED_CHIP_CLASS.startsWith(MERGED_CHIP_CLASS)).toBe(true)
    expect(MODEL_MERGED_CHIP_CLASS).toContain('truncate')
  })
})
