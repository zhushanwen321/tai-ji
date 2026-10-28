/**
 * renderer 杂项合并产物（round 5-G S5）：四文件同产物，环境全默认（happy-dom）。
 *
 * 并入来源（基名）：
 *  - panel/tray/use-composer-bar-density（useComposerBarDensity 接线件，21 例；跨目录自
 *    panel/tray/ 搬入，相对 helper import 已改写）
 *  - components/archive-list-view（ArchiveListView 组件，17 例；跨目录自 components/ 搬入）
 *  - useSidebar-session-list（useSidebar config.sessions 订阅，3 例）
 *  - api/pending-overflow（core pending 增量，4 例；原 node 环境文件并入 happy-dom——纯
 *    fake timers + core 模块逻辑，无 DOM 依赖，跨目录自 api/ 搬入，core 相对路径已改写）
 *
 * mock 注册：仅 useSidebar 节的 '@/api' 窄 mock（project/chat/session 三域 no-op，模块级
 * 泄漏对其余节无影响——静态复筛已核 ArchiveListView 与 useComposerBarDensity 链均不
 * import '@/api' 门面：前者只 vue/@lucide/shared/ui 组件/store，后者经 composer-density /
 * use-plugin-toolbar / useExtensionHostBridge 触达 @taiji/core 深路径而非 renderer 门面）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/density-archive-bundle.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, effectScope, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewCacheEntry, ViewHostSource } from '@taiji/ui/extension-host'
import { ManualResizeObserverStub } from './effects/_virtua-mock-helper'
import {
  dispatchFitGeometry as stubGeometry,
  flushFitPasses,
  makeMountPointSource as makeHelperSource,
  toolbarEntry,
} from './panel/_density-geometry-helper'
import {
  useComposerBarDensity,
  AGGREGATE_GROUP_CLASS,
  EXPANDED_GROUP_CLASS,
  EXPANDED_MODEL_THINKING_GROUP_CLASS,
} from '@/components/panel/tray/use-composer-bar-density'
import type { ComposerDensityLayout } from '@/components/panel/composer-density'
import type { ArchiveSummary, SessionGroup, SessionSummary } from '@taiji/shared'
import ArchiveListView from '@/components/sidebar/ArchiveListView.vue'
import { useProjectStore } from '@/stores/project'
import * as pending from '@taiji/core/transport/api'
import * as events from '@taiji/core/transport/api'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useSessionStore } from '@/stores/session'
import type { ServerMessage } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../../../core/src/transport/api/pending'

// ── useSidebar 节的 '@/api' 窄 mock（features 层调用 api 域；该节只验订阅链路，把 api 域
//    mock 成 no-op，订阅走真实的 @taiji/core/transport/api）。makeSummary 须留在模块级：
//    mock 工厂（延迟执行）引用它构造 session.create 默认返回值。──
function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1 }
}

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  },
}))

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：panel/tray/use-composer-bar-density（原文件顶层 hook 下沉包裹层内）
// ─────────────────────────────────────────────────────────────────────────────

describe('useComposerBarDensity（use-composer-bar-density 合并节）', () => {
  const SID = 's-hook'

  interface HostExposed { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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

  /** 挂载点数据源替身（helper 单份替身的本节绑 SID 形态；entry 缺省 = 零贡献分区） */
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
   * 打桩宿主几何并派发 RO：真差异（从 Host wrapper 查三节点）留本节，
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

    it('展开态模型+思考组容器：行 gap 4px（demo pop-anchor 行距对齐位，r4 视觉对齐）', () => {
      expect(EXPANDED_MODEL_THINKING_GROUP_CLASS).toBe('flex items-center gap-[4px]')
      expect(EXPANDED_MODEL_THINKING_GROUP_CLASS).not.toContain('truncate')
      expect(EXPANDED_MODEL_THINKING_GROUP_CLASS).not.toContain('max-w-')
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
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：components/archive-list-view（原文件顶层 beforeEach 下沉包裹层内）
// ─────────────────────────────────────────────────────────────────────────────

describe('ArchiveListView（archive-list-view 合并节）', () => {
  const MB = 1024 * 1024
  const HOUR = 3_600_000

  /** 距今 n 小时的 ISO 时刻（筛选档位判定与构造同源相对 now，无 fake timers 依赖）。 */
  function hoursAgo(n: number): string {
    return new Date(Date.now() - n * HOUR).toISOString()
  }

  /** archived 态条目（rawBytes/compressedBytes 取干净换算值）。 */
  function makeArchived(over: Partial<Extract<ArchiveSummary, { status: 'archived' }>> = {}): ArchiveSummary {
    return {
      sessionId: 'arc-1',
      name: 'v0.10 renderer 重构',
      originalFile: '2026-10-20T10-00-00_a1b2c3d4.jsonl',
      cwd: '/Users/demo/proj',
      archivedAt: '2026-10-20T12:34:56.789Z',
      rawBytes: 12.4 * MB,
      status: 'archived',
      codec: 'zstd-3',
      compressedBytes: 2.5 * MB,
      sha256: 'a'.repeat(64),
      summary: { turns: [] },
      projectId: 'proj-1',
      ...over,
    }
  }

  function makeStaging(): ArchiveSummary {
    return {
      sessionId: 'arc-staging',
      name: '压缩中的会话',
      originalFile: '2026-10-20T11-00-00_e5f6a7b8.jsonl',
      cwd: '/Users/demo/proj',
      archivedAt: '2026-10-20T12:00:00.000Z',
      rawBytes: 1024,
      status: 'staging',
      summary: null,
    }
  }

  function mountList(
    archives: ArchiveSummary[],
    opts: { loading?: boolean; listError?: string | null; batchPurging?: boolean } = {},
  ) {
    return mount(ArchiveListView, {
      props: {
        archives,
        loading: opts.loading ?? false,
        listError: opts.listError ?? null,
        restoringSessionId: null,
        purgingSessionId: null,
        batchPurging: opts.batchPurging ?? false,
      },
    })
  }

  /**
   * 两段确认态实底红样式断言（行级 purge 钮与批量钮同款）：底色 bg-danger + 悬停压色
   * hover:bg-danger（vision 验收缺陷回归锚点：确认态须抵消 ghost variant 的
   * hover:bg-surface-hover——点击后指针悬停在钮上，灰底曾覆盖红底）+ 实底前景语义
   * 令牌 text-danger-fg（token 层修复后的终态：--danger-fg 暗色族即亮字）。
   */
  function expectConfirmDangerStyle(btn: { classes(): string[] }): void {
    expect(btn.classes()).toContain('bg-danger')
    expect(btn.classes()).toContain('hover:bg-danger')
    expect(btn.classes()).toContain('text-danger-fg')
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    // projectId → 项目名解析数据源（proj-1 → taiji 项目）；默认项目（id 常量）恒在
    useProjectStore().projects = [
      { id: 'proj-1', name: 'taiji 项目', lastUsedAt: 0 },
      { id: 'proj-2', name: 'Beta', lastUsedAt: 0 },
    ]
  })

  describe('ArchiveListView 行结构（D10）', () => {
    it('archived 行：名称 + 原项目标签 + 压缩信息（12.4 MB → 2.5 MB · -80%）+ 归档时间', () => {
      const wrapper = mountList([makeArchived()])

      expect(wrapper.find('[data-testid="archive-row-arc-1"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="archive-row-arc-1"]').text()).toContain('v0.10 renderer 重构')
      expect(wrapper.find('[data-testid="archive-row-project-arc-1"]').text()).toBe('taiji 项目')
      const compression = wrapper.find('[data-testid="archive-row-compression-arc-1"]').text()
      expect(compression).toContain('12.4 MB → 2.5 MB')
      expect(compression).toMatch(/-\d+%$/)
      expect(wrapper.find('[data-testid="archive-row-time-arc-1"]').exists()).toBe(true)
      // 非 staging 行不渲染「压缩中」标注
      expect(wrapper.find('[data-testid="archive-row-compressing"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('staging 行：压缩信息显示「压缩中」+ 行内「压缩中」标注（V10 可见性）', () => {
      const wrapper = mountList([makeStaging()])

      expect(wrapper.find('[data-testid="archive-row-compressing"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="archive-row-compression-arc-staging"]').text()).toBe('压缩中')
      wrapper.unmount()
    })

    it('name 空串（提取失败合法形态）→ 未命名会话占位；未归类无项目标签段', () => {
      const wrapper = mountList([makeArchived({ name: '', projectId: undefined })])

      const row = wrapper.find('[data-testid="archive-row-arc-1"]')
      expect(row.text()).toContain('未命名会话')
      expect(wrapper.find('[data-testid="archive-row-project-arc-1"]').exists()).toBe(false)
      wrapper.unmount()
    })
  })

  describe('ArchiveListView 空态与失败态（D10）', () => {
    it('空列表 + 非 loading → 居中「暂无归档会话」占位', () => {
      const wrapper = mountList([])
      expect(wrapper.find('[data-testid="archive-list-empty"]').text()).toBe('暂无归档会话')
      wrapper.unmount()
    })

    it('loading 中不闪空态（空态判定含非 loading 条件）', () => {
      const wrapper = mountList([], { loading: true })
      expect(wrapper.find('[data-testid="archive-list-empty"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('拉取失败 → 失败态 + 重试钮 emit retry', async () => {
      const wrapper = mountList([], { listError: 'transport unavailable' })
      expect(wrapper.find('[data-testid="archive-list-error"]').exists()).toBe(true)

      await wrapper.find('[data-testid="archive-list-retry"]').trigger('click')
      expect(wrapper.emitted('retry')).toHaveLength(1)
      wrapper.unmount()
    })
  })

  describe('ArchiveListView 行交互（D10 悬停双钮 + 事件）', () => {
    it('点击行 emit select(archive)；返回钮 emit back', async () => {
      const archive = makeArchived()
      const wrapper = mountList([archive])

      await wrapper.find('[data-testid="archive-row-arc-1"]').trigger('click')
      expect(wrapper.emitted('select')).toEqual([[archive]])

      await wrapper.find('[data-testid="archive-back-btn"]').trigger('click')
      expect(wrapper.emitted('back')).toHaveLength(1)
      wrapper.unmount()
    })

    it('恢复钮（accent）emit restore', async () => {
      const archive = makeArchived()
      const wrapper = mountList([archive])

      expect(wrapper.find('[data-testid="archive-row-restore-btn"]').classes()).toContain('text-accent')
      await wrapper.find('[data-testid="archive-row-restore-btn"]').trigger('click')
      expect(wrapper.emitted('restore')).toEqual([[archive]])
      wrapper.unmount()
    })

    it('彻底删除两段确认（D6 两段红确认）：首击进 danger 确认态不 emit；再击 emit purge', async () => {
      const archive = makeArchived()
      const wrapper = mountList([archive])
      const btn = wrapper.find('[data-testid="archive-row-purge-btn"]')

      await btn.trigger('click')
      expectConfirmDangerStyle(btn)
      expect(btn.attributes('title')).toBe('确认彻底删除？')
      expect(wrapper.emitted('purge')).toBeUndefined()

      await btn.trigger('click')
      expect(wrapper.emitted('purge')).toEqual([[archive]])
      expect(btn.classes()).not.toContain('bg-danger')
      wrapper.unmount()
    })
  })

  describe('ArchiveListView 时间筛选行（mono 短码档位 + 总体积 + 批量清理）', () => {
    /** 四档各一条（互斥时间段的代表值：1 天内 3h / 2-3 天 50h / 4-7 天 5d / 7 天外 12d）。 */
    function makeFourBuckets(): ArchiveSummary[] {
      return [
        makeArchived({ sessionId: 'arc-d1', archivedAt: hoursAgo(3), rawBytes: 8 * MB, compressedBytes: 2 * MB }),
        makeArchived({ sessionId: 'arc-d23', archivedAt: hoursAgo(50), rawBytes: 12 * MB, compressedBytes: 3 * MB }),
        makeArchived({ sessionId: 'arc-d47', archivedAt: hoursAgo(5 * 24), rawBytes: 20 * MB, compressedBytes: 4 * MB }),
        makeArchived({ sessionId: 'arc-older', archivedAt: hoursAgo(12 * 24), rawBytes: 32 * MB, compressedBytes: 8 * MB }),
      ]
    }

    it('全部档（缺省）：四条全显 + 总体积 = 压缩后体积合计 + 批量钮不渲染', () => {
      const wrapper = mountList(makeFourBuckets())

      expect(wrapper.find('[data-testid="archive-list-count"]').text()).toBe('4')
      expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('17.0 MB') // 2+3+4+8
      expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('切「2-3d」档：仅该档条目可见；计数/总体积联动；批量钮出现且待发态文案为「N 项」', async () => {
      const wrapper = mountList(makeFourBuckets())

      await wrapper.find('[data-testid="archive-filter-d23"]').trigger('click')

      expect(wrapper.find('[data-testid="archive-row-arc-d1"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="archive-row-arc-d23"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="archive-list-count"]').text()).toBe('1')
      expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('3.0 MB')
      const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toBe('1 项') // 待发态精简文案（垃圾桶图标承载删除语义）
      wrapper.unmount()
    })

    it('staging 条目体积按原文件计（磁盘上是明文）', async () => {
      const staging: ArchiveSummary = {
        sessionId: 'arc-staging',
        name: '压缩中',
        originalFile: 'f.jsonl',
        cwd: '/p',
        archivedAt: hoursAgo(2),
        rawBytes: 5 * MB,
        status: 'staging',
        summary: null,
      }
      const wrapper = mountList([staging])

      await wrapper.find('[data-testid="archive-filter-d1"]').trigger('click')

      expect(wrapper.find('[data-testid="archive-list-count"]').text()).toBe('1')
      expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('5.0 MB') // rawBytes 而非（不存在的）compressedBytes
      wrapper.unmount()
    })

    it('批量清理两段确认：首击进确认态（完整文案防误触）不 emit；再击 emit purgeBatch 携带可见条目', async () => {
      const entries = makeFourBuckets().filter((a) => a.sessionId === 'arc-older')
      const wrapper = mountList(makeFourBuckets())
      await wrapper.find('[data-testid="archive-filter-older"]').trigger('click')
      const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')

      await btn.trigger('click')
      expect(btn.text()).toBe('确认删除 1 项？')
      expectConfirmDangerStyle(btn) // 同行级钮：确认态实底红（悬停压色 + 实底前景字色）
      expect(wrapper.emitted('purgeBatch')).toBeUndefined()

      await btn.trigger('click')
      expect(wrapper.emitted('purgeBatch')).toEqual([[entries]])
      expect(btn.classes()).not.toContain('bg-danger')
      wrapper.unmount()
    })

    it('确认态下后台刷新混入新条目：第二击只删确认时快照内的条目（防删未确认条目）', async () => {
      // 时序缺陷回归（PR #51 greptile P1）：两段确认之间后台广播刷新可见集（新条目落入
      // 当前筛选档、钮保持挂载确认态保持），第二击必须只删确认时快照内的条目
      const buckets = makeFourBuckets()
      const confirmed = buckets.filter((a) => a.sessionId === 'arc-older')
      const wrapper = mountList(buckets)
      await wrapper.find('[data-testid="archive-filter-older"]').trigger('click')
      await wrapper.find('[data-testid="archive-batch-purge-btn"]').trigger('click') // 首击：确认 1 项

      // 后台刷新（config.sessions 广播 → refreshArchives）：又一条 older 档新条目落入可见集
      const newcomer: ArchiveSummary = { ...confirmed[0], sessionId: 'arc-newcomer' }
      await wrapper.setProps({ archives: [...buckets, newcomer] })
      expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').text()).toBe('确认删除 2 项？')

      await wrapper.find('[data-testid="archive-batch-purge-btn"]').trigger('click') // 第二击
      expect(wrapper.emitted('purgeBatch')).toEqual([[confirmed]]) // 只含确认时快照，新混入条目不得进删除集
      wrapper.unmount()
    })

    it('档位切换复位确认态；批量在途（batchPurging）钮禁用', async () => {
      const wrapper = mountList(makeFourBuckets())
      await wrapper.find('[data-testid="archive-filter-older"]').trigger('click')
      const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')

      await btn.trigger('click') // 进入确认态
      await wrapper.find('[data-testid="archive-filter-d1"]').trigger('click') // 切档复位
      const btn2 = wrapper.find('[data-testid="archive-batch-purge-btn"]')
      expect(btn2.text()).toBe('1 项') // 回到待发态（非确认态）
      expect(wrapper.emitted('purgeBatch')).toBeUndefined()

      await wrapper.setProps({ batchPurging: true })
      expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').attributes('disabled')).toBeDefined()
      wrapper.unmount()
    })

    it('确认态下钮经后台刷新卸载重现：确认态随卸载复位，重现后首击不得执行', async () => {
      // 快照数组只构造一次复用（hoursAgo 依赖 Date.now()，两次构造毫秒不同会破坏 toEqual 比对）
      const buckets = makeFourBuckets()
      const entries = buckets.filter((a) => a.sessionId === 'arc-older')
      const wrapper = mountList(buckets)
      await wrapper.find('[data-testid="archive-filter-older"]').trigger('click')
      await wrapper.find('[data-testid="archive-batch-purge-btn"]').trigger('click') // 进入确认态
      expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').text()).toBe('确认删除 1 项？')

      // 后台刷新序列（归档域广播 → refreshArchives）：可见集空 → 钮卸载；快照恢复 → 钮重现
      await wrapper.setProps({ archives: [] })
      expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').exists()).toBe(false)
      await wrapper.setProps({ archives: buckets })
      const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toBe('1 项') // 重现为待发态，不携带 danger 确认态

      await btn.trigger('click') // 重现后首击：两段确认的第一段，不得执行
      expect(wrapper.emitted('purgeBatch')).toBeUndefined()
      expect(btn.text()).toBe('确认删除 1 项？') // 首击进确认态

      await btn.trigger('click') // 再击确认才执行
      expect(wrapper.emitted('purgeBatch')).toEqual([[entries]])
      wrapper.unmount()
    })

    it('筛选档下无结果：空态文案区分（「该时间范围内暂无归档」+ 专属 testid；总体积「—」）', async () => {
      const wrapper = mountList([makeArchived({ archivedAt: hoursAgo(12 * 24) })])

      await wrapper.find('[data-testid="archive-filter-d1"]').trigger('click')

      expect(wrapper.find('[data-testid="archive-list-empty-filtered"]').text()).toContain('该时间范围内暂无归档')
      expect(wrapper.find('[data-testid="archive-list-empty"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('—')
      expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').exists()).toBe(false)
      wrapper.unmount()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：useSidebar-session-list（原文件顶层 it / beforeEach 收进包裹层）
// ─────────────────────────────────────────────────────────────────────────────

describe('useSidebar config.sessions 订阅（useSidebar-session-list 合并节）', () => {
  function makeGroups(): SessionGroup[] {
    return [{ cwd: '/proj', sessions: [makeSummary('s1')] }]
  }

  /** 模拟 runtime broadcastSessionList：广播一条 config.sessions ServerMessage（PR #87 D1：session.list → config.sessions 重命名） */
  function broadcastSessionList(groups: SessionGroup[]): void {
    events.dispatchGlobal({ type: 'config.sessions', payload: { groups } })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('config.sessions 广播经 useSidebar 订阅更新 session store', () => {
    const scope = effectScope()
    scope.run(() => useSidebar())
    // pinia session store（ADR-0059：薄壳 useSessionStore 单例）
    expect(useSessionStore().groups).toEqual([])

    broadcastSessionList(makeGroups())
    expect(useSessionStore().groups).toEqual(makeGroups())

    scope.stop()
  })

  it('多实例 refCount 去重：N 次 useSidebar() 只注册 1 个 config.sessions handler', () => {
    // 薄壳化后 sessionStore 是 pinia 单例（所有实例共享同一 store），去重的可观测行为变为
    // 「config.sessions handler 只注册 1 次」（core bindSessionListBroadcast 模块级 sessionListSubCount），
    // 而非旧 per-instance raw store 的「不同实例 store 值不同」（ADR-0059 消除双轨）。
    const onGlobalTypeSpy = vi.spyOn(events, 'onGlobalType').mockReturnValue(() => {})

    const a = effectScope()
    a.run(() => useSidebar())!
    const b = effectScope()
    const c = effectScope()
    b.run(() => useSidebar())!
    c.run(() => useSidebar())!

    // 3 个实例只注册 1 个 config.sessions handler（refCount 去重）
    const sessionHandlerCount = onGlobalTypeSpy.mock.calls.filter(
      ([type]) => type === 'config.sessions',
    ).length
    expect(sessionHandlerCount).toBe(1)

    a.stop()
    b.stop()
    c.stop()
  })

  it('全部 scope 释放后监听取消：广播不再更新 store', () => {
    const scope = effectScope()
    scope.run(() => useSidebar())
    // 先填入一组数据，释放后广播应保持不变
    useSessionStore().applySnapshot({ groups: makeGroups() })
    const before = useSessionStore().groups

    scope.stop() // onScopeDispose → refCount 1→0 → 取消监听
    broadcastSessionList([{ cwd: '/other', sessions: [makeSummary('x')] }])

    expect(useSessionStore().groups).toEqual(before) // 未变 = 监听已取消
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：api/pending-overflow（原 node 环境文件并入 happy-dom 产物；纯 fake timers +
// core 模块逻辑，无 DOM 依赖。跨目录自 api/ 搬入，core 相对路径已改写）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 resolveEnvelope 入参（payload 用 as 断言对齐 ServerMessage 联合 payload） */
function envelopeMsg(type: string, id: string, payload: Record<string, unknown>): ServerMessage {
  return { type: type as ServerMessage['type'], id, payload } as ServerMessage
}

/**
 * 注册并立即吞掉终态 rejection——本节多数用例只观察 map/timer 状态，
 * 不 await 各 promise 结果；驱逐/rejectAll 触发的 reject 若无 handler 会报 unhandled rejection。
 */
function registerSwallowed(id: string, timeoutMs: number): void {
  pending.register(id, timeoutMs).catch(() => {})
}

describe('pending 容量上限 + 共享 sweep timer（Q1-5）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pending.rejectAll(new Error('setup cleanup'))
  })

  afterEach(() => {
    pending.rejectAll(new Error('teardown cleanup'))
    vi.useRealTimers()
  })

  it('N 个 pending 只挂 1 个共享 sweep timer（无 per-request timer 泄漏）', () => {
    expect(vi.getTimerCount()).toBe(0)

    for (let i = 0; i < 100; i++) {
      registerSwallowed(pending.createCommandId(), 60_000)
    }
    // 100 个 pending：全部共享 1 个指向最近 deadline 的 timer
    expect(vi.getTimerCount()).toBe(1)

    // 更早 deadline 的新请求加入 → 仍是 1 个（重挂到更近的 deadline）
    registerSwallowed(pending.createCommandId(), 1_000)
    expect(vi.getTimerCount()).toBe(1)

    // sweep 到期批量 reject 过期条目（1s 的那个）后，剩余条目仍有 timer 在管
    vi.advanceTimersByTime(1_000)
    expect(vi.getTimerCount()).toBe(1)

    // rejectAll 清空 map → timer 一并清除
    pending.rejectAll(new Error('cleanup'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('被驱逐 id 的迟到 error envelope 经 resolveEnvelope 静默丢弃（对称路径：error type 不抛错不误伤其他请求）', async () => {
    const victim = pending.createCommandId()
    const victimPromise = pending.register(victim, 60_000)
    // 填满至 256
    for (let i = 0; i < 255; i++) {
      registerSwallowed(pending.createCommandId(), 60_000)
    }
    // 下一个注册驱逐 victim（最老）
    const newcomer = pending.createCommandId()
    const pNew = pending.register<string>(newcomer, 60_000)

    await expect(victimPromise).rejects.toMatchObject({ code: 'overflow' })

    // 迟到的 error envelope 到达（runtime 慢回错误）：resolveEnvelope 的 pendingMap.has
    // 前置检查对 error 分支同样生效——已驱逐 id 不进 reject 展开，no-op
    expect(() =>
      pending.resolveEnvelope(
        envelopeMsg('error', victim, { code: 'permission_denied', message: 'denied' }),
      ),
    ).not.toThrow()
    // newcomer 不受影响（未被误 reject），仍可正常 settle
    pending.resolve(newcomer, 'ok')
    await expect(pNew).resolves.toBe('ok')
  })
})

describe('pending.rejectAll', () => {
  beforeEach(() => {
    // 确保模块单例 pendingMap 在每个用例前为空
    pending.rejectAll(new Error('setup cleanup'))
  })

  it('rejectAll 后新注册的请求不受影响（可正常 resolve）', async () => {
    pending.rejectAll(new Error('first batch'))

    const id = pending.createCommandId()
    const p = pending.register<string>(id, RPC_BACKSTOP_TIMEOUT_MS)
    pending.resolve(id, 'new value')

    await expect(p).resolves.toBe('new value')
  })

  it('rejectAll 透传 error 对象（含 code 等附加属性的场景）', async () => {
    const id = pending.createCommandId()
    const p = pending.register<string>(id, RPC_BACKSTOP_TIMEOUT_MS)

    const customError = Object.assign(new Error('runtime crashed'), { code: 'E_RUNTIME' })
    pending.rejectAll(customError)

    await expect(p).rejects.toMatchObject({ message: 'runtime crashed', code: 'E_RUNTIME' })
  })
})
