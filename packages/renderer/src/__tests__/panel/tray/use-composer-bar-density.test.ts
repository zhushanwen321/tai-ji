/**
 * use-composer-bar-density 单测（D6 修订「三步聚合」接线件）。
 *
 * 覆盖（接线件本职，不含状态机穷举——那在 `composer-density.test.ts`）：
 * - 首帧：未实测 → fitLevel 0 全展开（不闪聚合态）；输出域无 tier 旧键。
 * - 能力标志流向：`pluginToolbarContributionCount`（挂载点 view 有无内容）+ `hasTrayItems`
 *   （三态上抛）→ `slots.leftCluster`（全无内容 = absent，不留死入口）。
 * - **测量收敛回路**：实测「两簇占宽 > 可用宽」→ 逐级升到放得下；窗口变宽 → 逐级降回；
 *   同宽度 regime 内不反复升降（迟滞）；顶格仍溢出 → **锚点保护**（中部让位、`+`/发送零裁剪），
 *   保护只在窗口变宽时解除；脏可用宽（NaN/非正）→ 落最保守（顶格+保护）。
 * - 生命周期：无 ResizeObserver 宿主跳过观测并**一次性告警**；卸载断开 observer。
 * - 导出 class（形态 → class 单点）：展开态容器与聚合位容器。
 *
 * [HISTORICAL] 旧版用例断言的 640/520 三档阈值、`overflowMenuVisible`、88/56px 截断 class、
 * `composerModelGroupClass` 四象限已随语义删除。
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
  dispatchFitGeometry as stubGeometry,
  flushFitPasses,
  makeMountPointSource as makeHelperSource,
  toolbarEntry,
} from '../_density-geometry-helper'
import {
  useComposerBarDensity,
  AGGREGATE_GROUP_CLASS,
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

/** 挂载点数据源替身（helper 单份替身的本文件绑 SID 形态；entry 缺省 = 零贡献分区） */
function makeSource(entry?: ViewCacheEntry): ViewHostSource {
  const partition = new Map<string, ViewCacheEntry>()
  if (entry) partition.set(entry.viewId, entry)
  return makeHelperSource(SID, partition)
}

let wrapper: VueWrapper | null = null

function mountHost(source?: ViewHostSource | null): HostExposed {
  wrapper = mount(Host, {
    global: source ? { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: source } } : {},
  })
  return wrapper.vm as unknown as HostExposed
}

/** 宿主内查询元素（走 VTU 包装器：根节点自身也命中，无需依赖 document 挂载） */
function hostEl(selector: string): HTMLElement {
  const node = wrapper?.find(selector)
  if (!node?.exists()) throw new Error(`宿主节点缺失（${selector}）：模板与 fit 回路不同步？`)
  return node.element as HTMLElement
}

/** 等 fit 回路跑完（helper 单份；直接消费于手动派发用例） */

/**
 * 打桩宿主几何并派发 RO：真差异（从 Host wrapper 查三节点）留本文件，
 * 打桩 + 派发 + rAF 排空同构本体在 `_density-geometry-helper` 单份。
 *
 * @param avail 底栏内容可用宽（px；NaN 模拟脏可用宽）
 * @param left 左簇占宽（px）
 * @param right 右簇占宽（px）
 */
async function dispatchGeometry(avail: number, left: number, right: number): Promise<void> {
  await stubGeometry(
    {
      bar: hostEl('[data-testid="host-bar"]'),
      left: hostEl('[data-testid="host-left"]'),
      right: hostEl('[data-testid="host-right"]'),
    },
    avail,
    left,
    right,
  )
}

/** 右簇需求宽按 fitLevel 查表的两套构造（收敛回路用例：放得下级别宽递减） */
const DEMAND_L2: Record<number, number> = { 0: 520, 1: 460, 2: 300, 3: 200 }
const DEMAND_REWIDEN: Record<number, number> = { 0: 700, 1: 500, 2: 400, 3: 300 }

/**
 * 手动打桩底栏几何并派发一次 RO（收敛/保护用例的 spy + defineProperty + dispatch
 * 逐行重复段单源）：右簇需求宽传数字（固定值）或函数（每轮 fit 重算后按当前 fitLevel
 * 取值——各级需求宽不同的收敛回路用例）；左簇固定 leftWidth（缺省 20）；bar 可用宽 =
 * avail（clientWidth 与 contentRect 同值，NaN/非正即脏可用宽用例）。每个用例只作初次
 * 打桩调用（重复派发改走 redispatchBarWidth，避免二次 spyOn 歧义）。
 */
async function dispatchStubbedGeometry(
  rightWidth: number | (() => number),
  avail: number,
  leftWidth = 20,
): Promise<void> {
  const rightEl = hostEl('[data-testid="host-right"]')
  if (typeof rightWidth === 'number') {
    vi.spyOn(rightEl, 'getBoundingClientRect').mockReturnValue({ width: rightWidth } as DOMRect)
  } else {
    vi.spyOn(rightEl, 'getBoundingClientRect').mockImplementation(
      () => ({ width: rightWidth() }) as DOMRect,
    )
  }
  const leftEl = hostEl('[data-testid="host-left"]')
  vi.spyOn(leftEl, 'getBoundingClientRect').mockReturnValue({ width: leftWidth } as DOMRect)
  const bar = hostEl('[data-testid="host-bar"]')
  Object.defineProperty(bar, 'clientWidth', { value: avail, configurable: true })
  const observer = ManualResizeObserverStub.created()[0]
  observer.dispatch([{ target: bar, contentRect: { width: avail } as DOMRectReadOnly }])
  await flushFitPasses()
}

/** 已打桩后只改 bar 可用宽并派发一次 RO（窗口放宽 / 脏值恢复共用段；几何打桩保持原状） */
async function redispatchBarWidth(avail: number): Promise<void> {
  const bar = hostEl('[data-testid="host-bar"]')
  Object.defineProperty(bar, 'clientWidth', { value: avail, configurable: true })
  const observer = ManualResizeObserverStub.created()[0]
  observer.dispatch([{ target: bar, contentRect: { width: avail } as DOMRectReadOnly }])
  await flushFitPasses()
}

/** 派发一条缺 contentRect 的脏 entry（polyfill/异常宿主形态）——回调不读 entry，不应崩 */
async function dispatchBareEntry(): Promise<void> {
  const observer = ManualResizeObserverStub.created()[0]
  if (!observer) throw new Error('ResizeObserver 未创建：接线件未挂载')
  observer.dispatch([{}])
  await flushFitPasses()
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

describe('useComposerBarDensity：首帧与输出域', () => {
  it('首帧未实测 → fitLevel 0 全展开（不闪聚合态）；输出域无 tier 旧键', () => {
    const host = mountHost(makeSource())
    const density = host.getDensity()
    expect(density.fitLevel).toBe(0)
    expect(density.slots.leftCluster).toBe('expanded')
    expect(density.anchorProtected).toBe(false)
    expect('tier' in density).toBe(false)
    expect('overflowMenuVisible' in density).toBe(false)
    expect(ManualResizeObserverStub.created()).toHaveLength(1)
  })
})

describe('useComposerBarDensity：能力标志流向', () => {
  it('插件有贡献 + 托盘全无 → leftCluster 仍可达（不 absent）', async () => {
    const host = mountHost(makeSource(toolbarEntry()))
    host.setTrayItems(false)
    await dispatchGeometry(800, 20, 300)
    expect(host.getDensity().slots.leftCluster).toBe('expanded')
  })

  it('未 provide 数据源 / 挂载点无 view + 托盘全无 → absent（不留死入口）', async () => {
    const noSource = mountHost(null)
    noSource.setTrayItems(false)
    await dispatchGeometry(800, 20, 300)
    expect(noSource.getDensity().slots.leftCluster).toBe('absent')

    wrapper?.unmount()
    const emptyView = mountHost(makeSource())
    emptyView.setTrayItems(false)
    await dispatchGeometry(800, 20, 300)
    expect(emptyView.getDensity().slots.leftCluster).toBe('absent')
  })

  it('托盘三态上抛：缺省有面；onTrayItemsChange(false)（无插件贡献）→ absent', async () => {
    const host = mountHost(makeSource())
    await dispatchGeometry(800, 20, 300)
    expect(host.getDensity().slots.leftCluster).toBe('expanded')

    host.setTrayItems(false)
    await nextTick()
    expect(host.getDensity().slots.leftCluster).toBe('absent')
  })
})

describe('useComposerBarDensity：测量收敛回路（三步聚合 + 锚点保护）', () => {
  it('放得下 → fitLevel 0（三组全展开，零退化序）', async () => {
    const host = mountHost(makeSource())
    await dispatchGeometry(600, 20, 300)
    expect(host.getDensity().fitLevel).toBe(0)
    expect(host.getDensity().appliedOrders).toEqual([])
    expect(host.getDensity().slots.modelThinking).toBe('expanded')
  })

  it('放不下 → 逐级升到放得下（两级即够则停在 L2：左簇+指标聚合、模型仍完整形态）', async () => {
    const host = mountHost(makeSource())
    await dispatchStubbedGeometry(() => DEMAND_L2[host.getDensity().fitLevel], 400)

    expect(host.getDensity().fitLevel).toBe(2)
    expect(host.getDensity().slots.leftCluster).toBe('aggregated')
    expect(host.getDensity().slots.metrics).toBe('aggregated')
    expect(host.getDensity().slots.modelThinking).toBe('expanded')
    expect(host.getDensity().anchorProtected).toBe(false)
  })

  it('一直放不下 → 顶格 L3 后进入锚点保护：中部让位，`+`/发送/模型入口恒在', async () => {
    const host = mountHost(makeSource())
    // 所有级别都放不下（5000px 需求）
    await dispatchStubbedGeometry(5000, 200)

    expect(host.getDensity().fitLevel).toBe(3)
    expect(host.getDensity().anchorProtected).toBe(true)
    expect(host.getDensity().slots.leftCluster).toBe('absent')
    expect(host.getDensity().slots.metrics).toBe('absent')
    expect(host.getDensity().slots.modelThinking).toBe('aggregated')
    expect(host.getDensity().slots.add).toBe('expanded')
    expect(host.getDensity().slots.send).toBe('expanded')
  })

  it('保护态下同宽度反复派发不抖（解除只认窗口变宽）', async () => {
    const host = mountHost(makeSource())
    await dispatchGeometry(100, 20, 5000)
    expect(host.getDensity().anchorProtected).toBe(true)
    for (let i = 0; i < 5; i += 1) {
      await dispatchGeometry(100, 20, 5000)
    }
    expect(host.getDensity().anchorProtected).toBe(true)
    expect(host.getDensity().fitLevel).toBe(3)
  })

  it('窗口变宽 → 解除保护并逐级降回（一次放宽可连续降多级，直到某级溢出重新定级）', async () => {
    const host = mountHost(makeSource())

    // 阶段 A：200px 宽 → 升到顶并进保护
    await dispatchStubbedGeometry(() => DEMAND_REWIDEN[host.getDensity().fitLevel], 200)
    expect(host.getDensity().anchorProtected).toBe(true)

    // 阶段 B：放宽到 800px（720 需求可放下）→ 解保护 + 连续降级直到 L0
    await redispatchBarWidth(800)
    expect(host.getDensity().anchorProtected).toBe(false)
    expect(host.getDensity().fitLevel).toBe(0)
    expect(host.getDensity().slots.leftCluster).toBe('expanded')
  })

  it('同宽度 regime 内反复派发不抖（迟滞：降级只认窗口变宽）', async () => {
    const host = mountHost(makeSource())
    await dispatchStubbedGeometry(() => DEMAND_L2[host.getDensity().fitLevel], 400)
    const settled = host.getDensity().fitLevel
    expect(settled).toBe(2)
    for (let i = 0; i < 5; i += 1) {
      await dispatchGeometry(400, 20, DEMAND_L2[settled])
    }
    expect(host.getDensity().fitLevel).toBe(settled)
  })

  it('内容变矮（同窗口宽）不触发降级——无窗口变宽依据时不动作（防自污染抖动回归）', async () => {
    const host = mountHost(makeSource())
    // 先在 400px 下溢出 → L1 定级（settled=400）
    await dispatchStubbedGeometry(460, 400)
    expect(host.getDensity().fitLevel).toBeGreaterThanOrEqual(1)
    // 外部内容变矮（L0 现在也放得下）→ 停在当前级（保守但稳定；窗口变宽时自会逐级还原）
    vi.spyOn(hostEl('[data-testid="host-right"]'), 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect)
    await dispatchGeometry(400, 20, 300)
    expect(host.getDensity().fitLevel).toBeGreaterThanOrEqual(1)
  })

  it('FIT_MAX_PASSES 硬闸：收敛失控（每轮 changed）时第 8 轮后停止 schedule（rAF 环兜底）', async () => {
    // 失控构造：可用宽逐轮递增（windowWidened 恒真）+ 需求宽交替「超宽 / 放得下」
    // → 升级/置保护 ↔ 解保护振荡，每轮都产生 changed=true；唯一的环终止机制 = passCount 硬闸
    const rafQueue: Array<() => void> = []
    const rafStub = vi.fn((cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('requestAnimationFrame', rafStub)

    const host = mountHost(makeSource())
    // 按测量轮的右簇需求宽：前 4 轮超宽（升到顶格 + 置保护），随后超宽/放得下交替（振荡）
    const demandByPass = [5000, 5000, 5000, 5000, 300, 5000, 300, 5000]
    let passTick = 0
    let widthTick = 0
    const leftEl = hostEl('[data-testid="host-left"]')
    const rightEl = hostEl('[data-testid="host-right"]')
    const barEl = hostEl('[data-testid="host-bar"]')
    vi.spyOn(leftEl, 'getBoundingClientRect').mockReturnValue({ width: 20 } as DOMRect)
    vi.spyOn(rightEl, 'getBoundingClientRect').mockImplementation(() => {
      const width = demandByPass[Math.min(passTick, demandByPass.length - 1)]
      return { width } as DOMRect
    })
    Object.defineProperty(barEl, 'clientWidth', {
      configurable: true,
      get: () => 200 + 100 * widthTick,
    })

    ManualResizeObserverStub.created()[0]?.dispatch([
      { target: barEl, contentRect: { width: 200 } as DOMRectReadOnly },
    ])

    // 手动逐帧驱动（rAF 已 stub：回调进 rafQueue，本循环即帧时钟；队列空 = 已停 schedule）
    for (let frame = 0; frame < 16 && rafQueue.length > 0; frame += 1) {
      passTick = frame
      widthTick = frame
      for (const cb of rafQueue.splice(0)) cb()
      await nextTick()
    }

    // schedule 次数封顶：初始 1 次 + 前 7 轮各 1 次 = 8（第 8 轮 passCount>=8 命中硬闸不再排下一帧）
    expect(rafStub.mock.calls.length).toBe(8)
    // 停环后形态冻结在顶格 + 保护
    expect(host.getDensity().fitLevel).toBe(3)
    expect(host.getDensity().anchorProtected).toBe(true)
  })
})

describe('useComposerBarDensity：脏输入与生命周期', () => {
  it('entry 缺 contentRect → 不崩（回调不读 entry 形状），几何未变则形态不动', async () => {
    const host = mountHost(makeSource())
    await dispatchGeometry(800, 20, 300)
    expect(host.getDensity().fitLevel).toBe(0)
    await dispatchBareEntry()
    expect(host.getDensity().fitLevel).toBe(0)
  })

  it('可用宽脏值（clientWidth NaN/非正）→ 落最保守（顶格 + 锚点保护），恢复后可回', async () => {
    const host = mountHost(makeSource())
    await dispatchStubbedGeometry(300, Number.NaN)

    expect(host.getDensity().fitLevel).toBe(3)
    expect(host.getDensity().anchorProtected).toBe(true)

    // 恢复正常可用宽（窗口变宽依据成立）→ 回到全展开
    await redispatchBarWidth(800)
    expect(host.getDensity().fitLevel).toBe(0)
    expect(host.getDensity().anchorProtected).toBe(false)
  })

  it('无 ResizeObserver 宿主 → 跳过观测（不崩，停留全展开）+ 降级一次性告警（多实例不刷屏）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ManualResizeObserverStub.uninstall()
    vi.stubGlobal('ResizeObserver', undefined)
    const host = mountHost(makeSource())
    expect(host.getDensity().fitLevel).toBe(0)
    expect(ManualResizeObserverStub.created()).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[composer-density] ResizeObserver 不可用，底栏停留在全展开态（可能横向溢出）',
    )
    wrapper?.unmount()
    wrapper = null
    mountHost(makeSource())
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('卸载断开 observer：派发不再触达（宿主 DOM 已消失）', async () => {
    const host = mountHost(makeSource())
    await dispatchGeometry(800, 20, 300)
    expect(host.getDensity().fitLevel).toBe(0)
    const observer = ManualResizeObserverStub.created()[0]
    wrapper?.unmount()
    wrapper = null
    expect(() =>
      observer?.dispatch([{ contentRect: { width: 700 } as DOMRectReadOnly }]),
    ).not.toThrow()
    await flushFitPasses()
    expect(document.querySelector('[data-testid="host-bar"]')).toBeNull()
  })

  it('缺簇节点（模板变更/异常宿主）→ 放弃自纠但不崩，保持当前级', async () => {
    const host = mountHost(makeSource())
    await dispatchGeometry(800, 20, 300)
    expect(host.getDensity().fitLevel).toBe(0)
    hostEl('[data-testid="host-right"]').remove()
    const bar = hostEl('[data-testid="host-bar"]')
    const observer = ManualResizeObserverStub.created()[0]
    expect(() =>
      observer.dispatch([{ target: bar, contentRect: { width: 200 } as DOMRectReadOnly }]),
    ).not.toThrow()
    await flushFitPasses()
    expect(host.getDensity().fitLevel).toBe(0)
  })
})

describe('useComposerBarDensity：导出 class（形态 → class 单点）', () => {
  it('展开态分组容器：无截断约束（模型名恒完整展示的容器前提）', () => {
    expect(EXPANDED_GROUP_CLASS).toBe('flex items-center gap-0')
    expect(EXPANDED_GROUP_CLASS).not.toContain('truncate')
    expect(EXPANDED_GROUP_CLASS).not.toContain('max-w-')
  })

  it('聚合位容器：shrink-0 + min-w-0（单图标按钮不撑宽、不参与截断）', () => {
    expect(AGGREGATE_GROUP_CLASS).toContain('shrink-0')
    expect(AGGREGATE_GROUP_CLASS).toContain('min-w-0')
    expect(AGGREGATE_GROUP_CLASS).not.toContain('truncate')
  })

  it('[HISTORICAL] 截断 class 已随语义删除（88/56px 不再存在于模块导出）', async () => {
    const mod = await import('@/components/panel/tray/use-composer-bar-density')
    expect('MODEL_MERGED_CHIP_CLASS' in mod).toBe(false)
    expect('MODEL_SIMPLIFIED_CHIP_CLASS' in mod).toBe(false)
    expect('composerModelGroupClass' in mod).toBe(false)
    expect('MERGED_CHIP_CLASS' in mod).toBe(false)
  })
})
