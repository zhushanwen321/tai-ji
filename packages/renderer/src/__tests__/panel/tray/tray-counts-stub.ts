/**
 * tray 测试共享的 `UseTrayCountsReturn` 替身基座（composer-tray / tray-native-panel 两文件逐字
 * 重复的 counts / lists 收敛于此）。
 *
 * 只承载「计数恒等于行集长度」的共用形状（口径与 useTrayCounts 头注契约一致）；
 * 差异字段（bashPartition）仍由各测试文件注入，避免为通用化而生的参数蔓延。
 *
 * [容器扩展点统一 §6.6/U9+U10] workflow 件的行集/加载态/oversize/errors 字段已随件
 * 迁移删（本 stub 的 workflowRunning/workflowLoading/oversize 段同步退役）。
 */
import { computed } from 'vue'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'
import type { SessionSummary } from '@taiji/shared'

export interface TrayCountsStubState {
  bashRunning: BackgroundTaskEntry[]
  bashEnded: BackgroundTaskEntry[]
  bashLoaded: boolean
  /** 第 4 件子会话行集（u7）：缺省空（既有断言无需关心；session 用例显式注入） */
  sessionChildren?: SessionSummary[]
  /** 第 5 件画布清单（u-tray-entry）：缺省空（canvas 恒渲染——外壳豁免「全无不渲染」，画布用例显式注入） */
  canvasEntries?: CanvasListEntry[]
}

export function makeTrayCountsStub(
  state: TrayCountsStubState,
): Pick<UseTrayCountsReturn, 'counts' | 'lists'> {
  const sessionChildren = () => state.sessionChildren ?? []
  const canvasEntries = () => state.canvasEntries ?? []
  const canvasActive = () => canvasEntries().filter((c) => !c.converged)
  return {
    counts: computed(() => ({
      bash: {
        running: state.bashRunning.length,
        ended: state.bashEnded.length,
        total: state.bashRunning.length + state.bashEnded.length,
      },
      session: {
        running: sessionChildren().filter((s) => s.status === 'active').length,
        ended: sessionChildren().filter((s) => s.status !== 'active').length,
        total: sessionChildren().length,
      },
      canvas: {
        running: canvasActive().length,
        ended: canvasEntries().length - canvasActive().length,
        total: canvasEntries().length,
      },
    })),
    lists: {
      bash: {
        running: computed(() => state.bashRunning),
        ended: computed(() => state.bashEnded),
      },
      session: {
        children: computed(() => sessionChildren()),
      },
      canvas: {
        entries: computed(() => canvasEntries()),
      },
    },
  }
}
