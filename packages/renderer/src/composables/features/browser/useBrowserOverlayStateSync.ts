/**
 * useBrowserOverlayStateSync —— 浮层开合/内容切换 → `browser:overlay-state` 上报
 * （display-containers §7.4 show 统一谓词事实源之一）。
 *
 * 背景：主进程 BrowserViewManager 的显示收尾谓词 =「浮层开 ∧ 内容 browser ∧ 无错误态 ∧
 * 无相交 shieldsView 范围」，其中浮层开合/内容/发起会话三项事实由 renderer 上报（preload
 * 契约：「BrowserPane 挂载/重开前先上报——谓词事实先于 show 请求；浮层关闭/换出 browser
 * 内容时立即上报」）。不上报则谓词恒假、view 永不显示。
 *
 * 实现：watch core overlay SSOT（单一权威）——开合/内容任一变化即全量上报（非增量簿记，
 * 拉为主推为辅的事件提示形态）；immediate 首挂先报关态基线。上报用默认 pre-flush watcher，
 * 先于内容组件（BrowserPane）重渲染挂载执行——show 请求（BrowserPane onMounted）在后，
 * 满足「谓词事实先于 show 请求」契约；即使乱序，主进程 setOverlayState → applyDisplay
 * 收敛也会补齐显隐差额（单一谓词求值，无双权威）。
 *
 * 挂载要求：常驻宿主（不随浮层开合卸载）——关态上报必须在浮层关闭后仍可达。
 *
 * 运行时依赖：@/lib/ipc（electronAPI 唯一适配点；web/mock 环境静默 no-op）。
 */
import { watch } from 'vue'
import { useOverlayControl } from '@taiji/core/domain/overlay'
import { browserSetOverlayState } from '@/lib/ipc'

export function useBrowserOverlayStateSync(): void {
  const { isOpen, current } = useOverlayControl()

  function report(): void {
    const cur = current.value
    void browserSetOverlayState(
      isOpen.value && cur !== null
        ? {
          open: true,
          content: cur.kind,
          // 通用判据（容器扩展点统一 §7.2 词表四方同批）：唯一消费方是 browser 显示谓词，
          // 非 browser 内容一律 sessionId: null（browser 持发起会话）。原 canvas 特判并入
          // 判据（画布归属会话仍在 core 载荷层，谓词面 null 语义不变；workflow/scheduler
          // 上报从带会话改为 null——与 main parse 通用判据成对，漏改任一侧会被 .catch 吞错）
          sessionId: cur.kind === 'browser' ? cur.payload.sessionId : null,
        }
        : { open: false, content: null, sessionId: null },
    ).catch((e: unknown) => {
      // 上报是事件提示（主进程谓词收敛仍有 rect/错误/shields 触发范围）；非法 payload reject
      // 属上报方 bug，warn 级消化防 unhandledrejection 上报 error-reporter
      console.warn('[browser-overlay-state-sync] report failed:', e)
    })
  }

  watch([isOpen, current], report, { immediate: true })
}
