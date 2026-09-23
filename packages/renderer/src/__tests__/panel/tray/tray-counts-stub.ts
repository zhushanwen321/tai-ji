/**
 * tray 测试共享的 `UseTrayCountsReturn` 替身基座（composer-tray / tray-native-panel 两文件逐字
 * 重复的 counts / lists / loading 三块收敛于此）。
 *
 * 只承载「计数恒等于行集长度」的共用形状（口径与 useTrayCounts 头注契约一致）；
 * 差异字段（bashPartition / errors / retry）仍由各测试文件注入，避免为通用化而生的参数蔓延。
 *
 * `oversize`（RT-4#8 降级标志）是共用形状的新增字段：缺省全 false（无降级），需要验降级
 * 渲染的用例经 state 显式注入——漏注入会让 TrayNativePanel 的 `tray.oversize[kind].value`
 * 读 undefined 而崩（P5 RT-4#8 落地时该 stub 未同步，composer-tray 全文件曾因此红）。
 */
import { computed } from 'vue'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SessionSummary, SubagentRecord, WorkflowRunRecord } from '@taiji/shared'

export interface TrayCountsStubState {
  bashRunning: BackgroundTaskEntry[]
  bashEnded: BackgroundTaskEntry[]
  bashLoaded: boolean
  subagentRunning: SubagentRecord[]
  subagentEnded: SubagentRecord[]
  subagentLoading: boolean
  workflowRunning: WorkflowRunRecord[]
  workflowEnded: WorkflowRunRecord[]
  workflowLoading: boolean
  /** 第 4 件子会话行集（u7）：缺省空（既有三件断言无需关心；session 用例显式注入） */
  sessionChildren?: SessionSummary[]
  /** [RT-4#8] oversize 降级标志（缺省 false = 无降级；降级渲染用例显式注入） */
  oversize?: { subagent?: boolean; workflow?: boolean }
}

export function makeTrayCountsStub(
  state: TrayCountsStubState,
): Pick<UseTrayCountsReturn, 'counts' | 'lists' | 'loading' | 'oversize'> {
  const sessionChildren = () => state.sessionChildren ?? []
  return {
    counts: computed(() => ({
      bash: {
        running: state.bashRunning.length,
        ended: state.bashEnded.length,
        total: state.bashRunning.length + state.bashEnded.length,
      },
      subagent: {
        running: state.subagentRunning.length,
        ended: state.subagentEnded.length,
        total: state.subagentRunning.length + state.subagentEnded.length,
      },
      workflow: {
        running: state.workflowRunning.length,
        ended: state.workflowEnded.length,
        total: state.workflowRunning.length + state.workflowEnded.length,
      },
      session: {
        running: sessionChildren().filter((s) => s.status === 'active').length,
        ended: sessionChildren().filter((s) => s.status !== 'active').length,
        total: sessionChildren().length,
      },
    })),
    lists: {
      bash: {
        running: computed(() => state.bashRunning),
        ended: computed(() => state.bashEnded),
      },
      subagent: {
        running: computed(() => state.subagentRunning),
        ended: computed(() => state.subagentEnded),
      },
      workflow: {
        running: computed(() => state.workflowRunning),
        ended: computed(() => state.workflowEnded),
      },
      session: {
        children: computed(() => sessionChildren()),
      },
    },
    loading: {
      bash: computed(() => !state.bashLoaded),
      subagent: computed(() => state.subagentLoading),
      workflow: computed(() => state.workflowLoading),
    },
    // [RT-4#8] 缺省 false：无降级时面板走既有渲染分支（与真实 useTrayCounts 的
    // oversizeOf(sid) ?? false 缺省语义一致）
    oversize: {
      subagent: computed(() => state.oversize?.subagent ?? false),
      workflow: computed(() => state.oversize?.workflow ?? false),
    },
  }
}
