/**
 * useShieldsViewSync —— shieldsView 遮蔽面全量上报 → `browser:shields`
 * （display-containers §5.1 规则 6② / §6.7 view 遮蔽族 / §7.4 谓词重算触发面）。
 *
 * 背景：主进程 display-gate 的 show 统一谓词含「无相交 shieldsView 面」一项，faces 事实
 * （哪些遮蔽面开着、按哪一档、几何在哪）由 renderer 上报——模态表面聚合（§6.7）只有查询
 * 接口（openShieldingSurfaces），本 composable 是它的生产消费端：把聚合报告映射为
 * `{ faces }` payload 经 IPC 通道上报，S9「权限确认被原生 view 盖住」的解除链路。
 *
 * 单一事实源 + 事件顺序（时间平抑红线：无 debounce / 无定时兜底 / 无时间窗）：
 * - **聚合开合态**是唯一事实源——watchEffect（flush 'post'）读 openShieldingSurfaces()，
 *   其响应式依赖 = 成员表版本号（挂载⇔开型成员的注册/注销）+ 各成员 isOpen getter 读到的
 *   状态本体 ref。任一翻转 ⇒ effect 重跑 ⇒ 重新收集 faces（rect 直读 DOM 实测）。
 * - **overlay 开合/内容切换**触发面（§7.4）：读 core overlay SSOT（isOpen/current）纳入
 *   依赖——内容切换不改变 faces 时 payload 等值不上报（见下），只作重算信号。
 * - **resize** 触发面（§6.7）：window resize 事件 → 立即重收集 + 比对上报（锚定面几何随
 *   视口变化，DOM 直读不经 effect 缓存）。
 * - **变化才上报**：payload 序列化与上次相同则跳过 IPC（内容比较收敛——删掉比对只是多打
 *   等值 IPC、数据仍一致，不属时间平抑逻辑）。
 *
 * flush 'post' 的顺序保证：成员开合态的响应式翻转先完成组件重渲染（DOM 定形——横幅文案
 * 随 level 切换改宽、弹出层挂载/卸载）再实测 rect，上报的是重渲染后的真实几何。
 *
 * 卸载对称：宿主卸载（renderer 重载 / 常驻宿主摘除）上报空 faces 复位主进程侧遮蔽态，
 * 与「注册 refCount 卸载对称 dispose」同一纪律。
 *
 * 挂载要求：常驻宿主（BrowserOverlay，随 AppShell 恒挂）——遮蔽态上报不随任一表面开合卸载。
 *
 * 运行时依赖：@/lib/ipc（electronAPI 唯一适配点；web/mock 环境静默 no-op）。
 */
import { onScopeDispose, watchEffect } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useOverlayControl } from '@taiji/core/domain/overlay'
import { openShieldingSurfaces } from '@/composables/features/app/modal-surface-registry'
import { browserSetShields } from '@/lib/ipc'

/** browser:shields payload 形状（与 lib/ipc.browserSetShields / main display-gate ShieldFace 对齐） */
export interface ShieldsFacesPayload { // oe-exempt:20261003:framework:聚合/view 联动契约层——payload 与 ui 桥数据契约，消费面为本批 D1/D2 单元
  faces: Array<{
    id: string
    fullscreen: boolean
    rect?: { x: number; y: number; width: number; height: number }
  }>
}

/** 收集当前遮蔽面全集（§7.4 payload 形状：fullscreen 面不带 rect；非全屏面带实测 rect；
 *  rect 缺失（成员未提供几何读点）按缺省省略——主进程保守按相交处理） */
function collectFaces(isOpen: () => boolean, current: () => unknown): ShieldsFacesPayload {
  // overlay 开合/内容切换触发面（§7.4 谓词重算触发面同源）：读 SSOT 纳入响应式依赖
  void isOpen()
  void current()
  const faces = openShieldingSurfaces().map((surface) => {
    if (surface.mode === 'unconditional') {
      return { id: surface.id, fullscreen: true }
    }
    return {
      id: surface.id,
      fullscreen: false,
      ...(surface.rect
        ? { rect: { x: surface.rect.x, y: surface.rect.y, width: surface.rect.width, height: surface.rect.height } }
        : {}),
    }
  })
  return { faces }
}

export function useShieldsViewSync(): void {
  const { isOpen, current } = useOverlayControl()
  let lastSent = ''

  function report(): void {
    const payload = collectFaces(() => isOpen.value, () => current.value)
    const serialized = JSON.stringify(payload)
    if (serialized === lastSent) return
    lastSent = serialized
    void browserSetShields(payload).catch((e: unknown) => {
      // 上报是事件提示（主进程滞回/谓词仍有 rect 推送等触发面收敛）；非法 payload reject
      // 属上报方 bug，warn 级消化防 unhandledrejection 上报 error-reporter
      console.warn('[shields-view-sync] report failed:', e)
    })
  }

  // 聚合开合态触发面：flush 'post'（重渲染后 DOM 定形再实测 rect，见文件头顺序保证）
  watchEffect(report, { flush: 'post' })

  // resize 触发面（§6.7）：锚定面几何随视口变化；事件直推，无防抖
  useEventListener(window, 'resize', report, { passive: true })

  // 卸载对称：空 faces 复位（lastSent 清空让重挂后首报必达）；renderer 关闭中投递失败静默
  onScopeDispose(() => {
    lastSent = ''
    void browserSetShields({ faces: [] }).catch(() => {})
  })
}
