/**
 * useSessionLiveState —— 会话运行时状态选择器（renderer 壳，W1 会话架构四层分离）。
 *
 * 状态层（`stores/session-live-state.ts`，core createSessionLiveState 的 pinia 薄壳）的
 * 唯一读取入口。主会话 composer、btw 线 composer、subagent 视图、面板派生全部经此读，
 * 禁止自写「列表查找 / 回退其他会话」的解析。
 *
 * 语义（设计 §2.4 I5 / §7 验收项 2/3/7）：
 * - 按 sessionId 读状态层，**缓存缺失返回 undefined**（显式未知）；
 * - 不回退主会话 / 默认模型 / 其他会话的值（ADR-0122 事实驱动：无事实即未知）；
 * - 与导航列表无关——列表刷新 / 项目过滤 / 归档不影响输出；侧栏列表之外的会话
 *   （btw 线等）与主会话同一条路径。
 *
 * 形式：`useSessionLiveState(sessionIdRef)` 返回 `{ liveState, modelId, thinkingLevel }`，
 * 三者在 computed 内读状态层 Map（响应式依赖自动收集）。`sessionId` 为 null（landing 态）
 * 时全部 undefined——landing 的模型解析归 core launchConfigView（不属状态层）。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { createSessionLiveStateSelector, type SessionLiveState } from '@taiji/core'
import { useSessionLiveStateStore } from '@/stores/session-live-state'

export interface UseSessionLiveStateReturn { // oe-exempt:20261023:framework:类型契约先行——composable 返回面（脚本 setup ≤300 行约束下抽出的命名契约）
  /** 该会话的完整状态快照；undefined = 尚未观测（显式未知） */
  liveState: ComputedRef<SessionLiveState | undefined>
  /** 当前模型复合串 "provider/modelId"；undefined = 尚未观测 */
  modelId: ComputedRef<string | undefined>
  /** 思考等级；undefined = 尚未观测 */
  thinkingLevel: ComputedRef<string | undefined>
}

export function useSessionLiveState(sessionIdRef: Ref<string | null>): UseSessionLiveStateReturn {
  const liveStore = useSessionLiveStateStore()
  // 读取实现与 composer-shell 共用 core `createSessionLiveStateSelector`（单点定义，
  // 防「按 id 读状态」出现第二份实现——设计 I4 单一入口精神）
  const liveStateOf = createSessionLiveStateSelector(liveStore)

  const liveState = computed<SessionLiveState | undefined>(() => {
    const sid = sessionIdRef.value
    if (!sid) return undefined
    return liveStateOf(sid)
  })

  return {
    liveState,
    modelId: computed(() => liveState.value?.modelId),
    thinkingLevel: computed(() => liveState.value?.thinkingLevel),
  }
}
