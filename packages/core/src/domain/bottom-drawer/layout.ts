/**
 * bottom-drawer 全局布局值 —— `heightPct` 全局单键持久化 + clamp 两形态
 * （display-containers §7.1 控制态粒度裁决）。
 *
 * 粒度（§7.1）：heightPct = **全局布局值**，全局单键 `taiji:bottom-drawer-height` 持久化
 * （对齐右抽屉宽度先例 `taiji:drawer-width`——姊妹容器同构尺寸值同粒度，
 * 避免「B 拖动覆盖 A 存储值」的语义未定义）。per-session 开合态在 control.ts，两者分粒度。
 *
 * clamp 两形态（§7.1 / §5.3）：
 * - **拖拽 clamp**（写侧）：15%–70%（默认 35%，实施期真机校准 §11-1）——setBottomDrawerHeightPct
 *   先 clamp 再落值；
 * - **显示期 clamp**（读侧）：窗口太矮时按「对话流 + composer 最小可视区域」上限钳制显示高度，
 *   **不写回持久化高度值**（恢复窗口高度后回到拖拽持久值，S2 断言）——纯函数
 *   resolveBottomDrawerDisplayPct 由布局单元（u-w1-layout）在渲染期求值。
 *
 * 持久化生命周期由 foundation createKVSlot 收编（KV 单键族 D9）；core 零 localStorage
 * 直连——读写全部经 getPlatform().storage（KVStorage），未注入平台时读失败回落默认值
 * （E1 空启动语义）、写失败 console.warn 不回滚（E2 best-effort）。
 */
import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import { createKVSlot } from '../../foundation/create-kv-slot'
import {
  BOTTOM_DRAWER_HEIGHT_KEY,
  BOTTOM_DRAWER_HEIGHT_MIN_PCT,
  BOTTOM_DRAWER_HEIGHT_MAX_PCT,
  BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT,
} from './types'

/**
 * 拖拽 clamp（写侧）：区间 15%–70%（§7.1 裁决值）。非有限数回落默认值
 * （防御：拖拽数学产生 NaN 时不落脏值）。
 */
export function clampBottomDrawerHeightPct(pct: number): number {
  if (!Number.isFinite(pct)) return BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT
  return Math.min(BOTTOM_DRAWER_HEIGHT_MAX_PCT, Math.max(BOTTOM_DRAWER_HEIGHT_MIN_PCT, pct))
}

/** 百分比刻度（比例值 → 百分比的换算乘数） */
const PCT_SCALE = 100

/**
 * 显示期 clamp（读侧，§5.3「窗口太矮」失败路径）：保证对话流 + composer 共同构成的
 * 最小可视区域（minMainAreaHeightPx，阈值 §11-1 真机校准）后取有效显示高度百分比。
 *
 * 契约：
 * - **不写回**：本函数纯求值，不改 heightPct 内存值、不触发 KV 写穿（S2「clamp 未写回」）；
 * - 目标值先过拖拽 clamp（持久值被外部写脏时显示侧同界）；
 * - 主区最小可视保证优先于 15% 下限：极矮窗口（minMainAreaHeightPx ≥ viewportHeightPx）
 *   时结果可低于 15% 乃至 0（抽屉可开但显示高趋零——§11-1 校准点可再加显示下限）；
 * - viewportHeightPx ≤ 0（布局未就绪）→ 回目标值，不做除零钳制。
 */
export function resolveBottomDrawerDisplayPct(
  heightPct: number,
  viewportHeightPx: number,
  minMainAreaHeightPx: number,
): number {
  const target = clampBottomDrawerHeightPct(heightPct)
  if (!(viewportHeightPx > 0)) return target
  const maxPctByMainArea = ((viewportHeightPx - minMainAreaHeightPx) / viewportHeightPx) * PCT_SCALE
  return Math.min(target, Math.max(0, maxPctByMainArea))
}

/**
 * 内存值：模块级单例（全局布局值——多面板/多容器共享一份，§7.1 全局粒度裁决）。
 * taste:allow-no-data-owner W24-EX-B（模块级单例 UI 偏好内存镜像，登记草稿）：
 * 权威源 = KVStorage 持久化单键（taiji:bottom-drawer-height），本 ref 为内存镜像
 */
const heightPct = ref(BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT)

/** 加载窗口内是否已有本模块写入（窗口守卫：在途 KV 快照不得覆写窗口内新写值） */
let wroteInLoadWindow = false

/**
 * KV 单键槽位：持久化生命周期收编于 createKVSlot（D9）。
 * KV 值形态 = JSON 数字（如 35——与 taiji:drawer-width 的裸数值串同为可 JSON.parse 形态）。
 */
const slot = createKVSlot<number>(BOTTOM_DRAWER_HEIGHT_KEY, {
  tag: 'bottom-drawer-height',
  // 加载侧形状门：非有限数字（损坏 / 形状不符）按默认值启动
  parseSnapshot: (parsed) =>
    typeof parsed === 'number' && Number.isFinite(parsed)
      ? clampBottomDrawerHeightPct(parsed)
      : undefined,
  // 窗口守卫（createKVSlot 契约）：加载窗口内已 record 的新值比在途 KV 快照新，不被覆写
  mergeSnapshot: (value) => {
    if (!wroteInLoadWindow) heightPct.value = value
  },
  serialize: () => JSON.stringify(heightPct.value),
  // record 侧值域防线（E6 形态）：非有限数/越界值不写（写侧 API 已 clamp，此为最后一道）
  validate: (value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= BOTTOM_DRAWER_HEIGHT_MIN_PCT &&
    value <= BOTTOM_DRAWER_HEIGHT_MAX_PCT,
})

/**
 * 触发惰性预载（fire-and-forget，幂等）。由首个消费方组装时调用
 * （布局挂载点 useBottomDrawerLayout 亦自动触发）；加载完成前内存值保持默认。
 */
export function loadBottomDrawerHeightOnce(): void {
  slot.loadOnce()
}

/** 读当前全局高度百分比（内存镜像；未加载/损坏回落默认 35） */
export function getBottomDrawerHeightPct(): number {
  return heightPct.value
}

/**
 * 写全局高度百分比（拖拽手柄写入口）：先过拖拽 clamp（15%–70%）再落内存 + 写穿 KV。
 * 非有限数直接丢弃（边界防御，不落脏值）；KV 写失败仅 console.warn、内存不回滚（E2）。
 */
export function setBottomDrawerHeightPct(pct: number): void {
  if (!Number.isFinite(pct)) return
  const clamped = clampBottomDrawerHeightPct(pct)
  // 写前确保预载已启动（幂等）：KVSlot 的写穿收敛以加载完成为前提，
  // 未启动预载的写会无限期 deferred——setter 自启动保证拖拽写恒收敛落盘
  slot.loadOnce()
  slot.record(clamped, () => {
    wroteInLoadWindow = true
    heightPct.value = clamped
  })
}

/**
 * 布局视图：全局高度百分比（响应式；拖拽写入经 setBottomDrawerHeightPct）。
 * 调用即触发 KV 惰性预载（首个消费方组装点语义）。
 */
export function useBottomDrawerLayout(): {
  heightPct: ComputedRef<number>
  } {
  loadBottomDrawerHeightOnce()
  return {
    heightPct: computed(() => heightPct.value),
  }
}

/** 仅测试用：复位内存值与 KV 生命周期（跨用例隔离）。生产代码禁止调用。 */
export function _resetBottomDrawerLayoutForTest(): void {
  heightPct.value = BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT
  wroteInLoadWindow = false
  slot.__resetForTesting()
}
