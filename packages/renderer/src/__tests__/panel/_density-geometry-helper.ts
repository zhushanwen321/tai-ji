/**
 * composer 底栏密度两测试文件（composer-bar-density-wiring.test.ts /
 * tray/use-composer-bar-density.test.ts）共用的几何打桩 helper。
 *
 * 收编的同构段（原两文件各自维护的形态同构假差异，改一处漏一处的来源）：
 * - `flushFitPasses`：fit 收敛回路的 rAF 链排空；
 * - `makeMountPointSource` / `toolbarEntry`：挂载点数据源替身（只服务
 *   `getView(sid, 'composer.toolbar')` 的插件 toolbar 贡献面）；
 * - `dispatchFitGeometry`：打桩 clientWidth + 两簇 getBoundingClientRect + RO 派发 +
 *   rAF 链排空（右簇占宽支持定值或按 `data-fit` 分级回落两种口径）。
 *
 * 真差异留在调用方：bar/left/right 节点从各自宿主查（VTU wrapper vs 独立 Host 组件），
 * mock 面不同（Composer 全家桶 stub vs 最小宿主）。
 */
import { nextTick } from 'vue'
import { vi } from 'vitest'
import { ManualResizeObserverStub } from '../effects/_virtua-mock-helper'
import type { ViewCacheEntry, ViewHostSource } from '@taiji/ui/extension-host'

/** 等 fit 收敛回路跑完（rAF 链；happy-dom 有 rAF，兜底宏任务同样被覆盖） */
export async function flushFitPasses(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })
  }
  await nextTick()
}

/**
 * 挂载点数据源替身：**只服务 `getView(sid, 'composer.toolbar')`**（插件 toolbar 贡献面），
 * `getViewIds` 恒空——不冒充 widget 区条目（否则挂载点 view 会被托盘 widget 区当成条目）。
 * 需要测试中途变更贡献面时传 reactive Map（调用方决定响应式形态）。
 */
export function makeMountPointSource(
  sid: string,
  partition: Map<string, ViewCacheEntry>,
): ViewHostSource {
  return {
    getView: (queried, viewId) => (queried === sid ? partition.get(viewId) : undefined),
    getViewIds: () => [],
  }
}

/** 一个非空 guiTree 的挂载点条目（贡献数 > 0） */
export function toolbarEntry(): ViewCacheEntry {
  return {
    viewId: 'composer.toolbar',
    pluginId: 'ext-x',
    guiTree: [{ type: 'ansi-text', props: { lines: ['toolbar'] } }],
    updatedAt: 1_760_000_000_000,
  }
}

/** fit 打桩目标三节点（底栏 + 左右两簇；由调用方从各自宿主查得） */
export interface FitGeometryTarget {
  bar: HTMLElement
  left: HTMLElement
  right: HTMLElement
}

/**
 * 打桩底栏几何并派发 RO：可用宽（clientWidth）+ 左簇占宽（定值）+ 右簇占宽（定值，或按
 * 当前 `data-fit` 分级回落——模拟「形态聚合 → 需求宽下降」的真实收敛过程），随后等回路收敛。
 * 测试宿主无样式表 → computed padding = 0 → clientWidth 即可用宽（NaN 模拟脏可用宽同样可用）。
 */
export async function dispatchFitGeometry(
  target: FitGeometryTarget,
  avail: number,
  leftWidth: number,
  rightWidth: number | Record<string, number>,
): Promise<void> {
  const { bar, left, right } = target
  Object.defineProperty(bar, 'clientWidth', { value: avail, configurable: true })
  vi.spyOn(left, 'getBoundingClientRect').mockReturnValue({ width: leftWidth } as DOMRect)
  vi.spyOn(right, 'getBoundingClientRect').mockImplementation(() => {
    const width =
      typeof rightWidth === 'number' ? rightWidth : rightWidth[bar.getAttribute('data-fit') ?? '0']
    return { width } as DOMRect
  })
  const observer = ManualResizeObserverStub.created()[0]
  if (!observer) throw new Error('ResizeObserver 未创建：密度接线未挂载')
  observer.dispatch([{ target: bar, contentRect: { width: avail } as DOMRectReadOnly }])
  await flushFitPasses()
}
