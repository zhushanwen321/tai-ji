/**
 * useConstantHeightAssert —— dev-only 像素常量漂移检测（B2）。
 *
 * MessageStream 用若干像素常量（LOAD_MORE_RESERVED_HEIGHT / COMPACTING_NOTICE_HEIGHT）
 * 参与 absolute 定位 top 计算。这些常量与对应 DOM 块的真实高度强绑定——若模板调整了
 * padding / 字号 / icon size 却忘了同步常量，占位会静默漂移致重叠或留空，且生产无任何报错。
 *
 * 本 composable 在 dev 下挂 ResizeObserver 实测 DOM 高度对比常量，差值 > 1px（避开亚像素
 * 抖动）时 console.warn 提醒。生产构建被 import.meta.env.DEV 守卫裁剪，零运行时开销。
 *
 * 用法：传入 { el, expected, name } 列表，composable 返回各 el 的 ref 供模板绑定，
 * 并自动管理 observer 生命周期与条件渲染元素的重挂。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

interface ConstantSpec {
  /** 常量名，仅用于 warn 文案 */
  name: string
  /** 期望高度（像素） */
  expected: number
}

interface RegisteredConstant extends ConstantSpec {
  el: Ref<HTMLElement | null>
}

/**
 * 实测单元素高度（含 padding/border，不含 margin），元素缺失或未渲染返回 null。
 */
function measuredHeight(el: HTMLElement | null): number | null {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.height === 0) return null // 未渲染/折叠，跳过本轮
  return Math.round(rect.height)
}

export function useConstantHeightAssert(specs: ConstantSpec[]) {
  // 每个常量配一个 ref 供模板绑定（v-if 条件渲染元素会随挂载/卸载在 null↔node 间切换）
  const registered: RegisteredConstant[] = specs.map((s) => ({
    ...s,
    el: ref<HTMLElement | null>(null),
  }))
  let observer: ResizeObserver | null = null
  // W16: watch 内调度的 rAF 句柄。registered els 每次变化都请求一帧跑 assert，
  // 不保存句柄时组件在 rAF pending 期间卸载，回调仍会 fire（虽 assert 内有 observer 短路，
  // 但多个 pending rAF 会堆积泄漏）。保存句柄后可在调度前取消旧的、卸载时统一取消。
  let pendingRafId: number | null = null

  /** 对比所有注册常量的实测高度与期望值，不符时 console.warn。 */
  function assert(): void {
    for (const { name, el, expected } of registered) {
      const actual = measuredHeight(el.value)
      if (actual === null) continue
      if (Math.abs(actual - expected) > 1) {
        console.warn(
          `[MessageStream] 像素常量 ${name}=${expected} 与 DOM 实测高度 ${actual} 不符（差 ${actual - expected}px）。` +
            `改了 padding/字号/icon size 请同步常量，否则 absolute 定位会漂移。`,
        )
      }
    }
  }

  onMounted(() => {
    if (!import.meta.env.DEV || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(assert)
    for (const { el } of registered) {
      if (el.value) observer.observe(el.value)
    }
  })

  // 条件渲染元素（v-if）挂载/卸载后需把 observer 目标同步过去。
  // 元素从 null→node：observe；node→null：observer 自动断开（节点被移除）。
  watch(
    registered.map((r) => r.el),
    () => {
      if (!import.meta.env.DEV || !observer) return
      for (const { el } of registered) {
        if (el.value) observer.observe(el.value)
      }
      // 首帧布局稳定后跑一次断言（RO 仅在 size 变化时回调，挂载后首次 size 可能未变）
      // W16: 先取消上一帧 pending 的 rAF，避免 els 高频切换时多个 assert 回调堆积；
      // 句柄保存在 pendingRafId，卸载时 onBeforeUnmount 一并取消。
      if (pendingRafId !== null) cancelAnimationFrame(pendingRafId)
      pendingRafId = requestAnimationFrame(() => {
        pendingRafId = null
        assert()
      })
    },
  )

  onBeforeUnmount(() => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    // W16: 取消 watch 调度的 pending rAF，防卸载后回调仍 fire。
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
  })

  // 返回各 el 的 ref（按 specs 顺序）；调用方在模板里绑定对应节点。
  return { els: registered.map((r) => r.el) }
}
