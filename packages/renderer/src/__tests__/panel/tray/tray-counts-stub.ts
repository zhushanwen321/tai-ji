/**
 * tray 测试共享的 `UseTrayCountsReturn` 替身基座（composer-tray / tray-native-panel 两文件逐字
 * 重复的 counts / lists / loading 三块收敛于此）。
 *
 * 只承载「计数恒等于行集长度」的共用形状（口径与 useTrayCounts 头注契约一致）；
 * 差异字段（bashPartition / errors / retry）仍由各测试文件注入，避免为通用化而生的参数蔓延。
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
}

export function makeTrayCountsStub(
  state: TrayCountsStubState,
): Pick<UseTrayCountsReturn, 'counts' | 'lists' | 'loading'> {
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
  }
}
