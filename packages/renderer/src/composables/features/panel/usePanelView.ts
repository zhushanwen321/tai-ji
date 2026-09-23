/**
 * usePanelView —— panel 渲染视图派生（renderer 侧事实收集 → derivePanelView）。
 *
 * 职责边界：本 composable 只做「事实收集 + 单点派生」——把 Panel 组件里散落的七个
 * 异构状态源（session 绑定 / 消息有无 / dead / respawn 过渡态 / trace 视图 / form overlay 在场 /
 * flow 活跃）组装为 PanelViewInput，派生收敛到 core 纯函数 derivePanelView
 * （128 组合全表守卫，V5）。
 * Panel.vue 只 switch(panelView.kind)，禁止再直接组合这些状态做渲染判据（D5）。
 *
 * 互斥语义归属：dead 与 form overlay 的互斥由派生优先级吞掉（dead > form，derivePanelView
 * 内部实现），收集侧 hasFormOverlay 不判 dead——重复判定会把「dead 不应答」（W6）的
 * 职责撕成两份，派生规则演化时漏改一处即回归。
 *
 * turn 运行态（streaming/compacting）不在此收集：D2 裁决它们不再驱动输入面存在性
 * （composer 的禁用/进度模态由 Composer 内部消费 isCompacting，与存在性正交）。
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { derivePanelView } from '@taiji/core'
import type { PanelView } from '@taiji/core'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useSessionTrace } from '@/composables/features/trace/useSessionTrace'
import { useExtensionUI } from '@/composables/useExtensionUI'

/**
 * 派生 panel 渲染视图 + 统一表单 overlay 应答消费面。
 *
 * currentFormRequest/respond/cancel 一并透出：overlay 的渲染数据（formQuestions /
 * legacy scheduleDraft）与应答回调同源于 useExtensionUI，Panel 不再重复订阅。
 * currentFormRequest 语义 = 队列第一个统一表单 overlay 请求（form 键——新 form 帧
 * 与 legacy askUser/scheduleCreate 帧经归一层附加 form 后统一命中），Panel 按挂载源
 * 键分流 FormOverlay 的 questions / draft props。
 * 必须在组件 setup（或 active effectScope）内调用——useExtensionUI 内部注册
 * watch + onScopeDispose（per-sessionId 订阅生命周期）。
 */
export function usePanelView(sessionId: Ref<string | null>): {
  /** 渲染视图（discriminated union，消费方 switch (panelView.value.kind)） */
  panelView: ComputedRef<PanelView>
  /** 绑定会话是否有消息（conversation 分支子视图选择：MessageStream vs 空对话态） */
  hasMessages: ComputedRef<boolean>
  /** 队列中第一个统一表单 overlay 请求（form 键；无则 undefined） */
  currentFormRequest: ReturnType<typeof useExtensionUI>['currentFormRequest']
  /** 表单应答（answers / FormResult JSON string 回传 pi） */
  respond: ReturnType<typeof useExtensionUI>['respond']
  /** 表单取消（等价 respond(requestId, null)） */
  cancel: ReturnType<typeof useExtensionUI>['cancel']
} {
  const chat = useChatStore()
  const sessionStore = useSessionStore()
  const flow = useNewTaskFlow()
  const { partition: tracePartition } = useSessionTrace()
  // filter 走 useExtensionUI 默认值 formFilter（统一表单 overlay 渲染面）；普通 dialog
  // 请求由硬过滤 + CompanionBand 侧排除，不经 store。
  const { currentFormRequest, respond, cancel } = useExtensionUI(sessionId)

  /** 绑定会话是否有消息（getMessages 计数 > 0；null session 恒 false） */
  const hasMessages = computed(() =>
    sessionId.value ? chat.getMessages(sessionId.value).length > 0 : false,
  )

  /** session 进程已退出（per-session 事实：sessionStore 分区 status==='dead'） */
  const isSessionDead = computed(() => {
    const sid = sessionId.value
    if (!sid) return false
    return sessionStore.list.find((item) => item.id === sid)?.status === 'dead'
  })

  /** [T4] pi 意外退出后的「引擎恢复中」过渡态（chat store respawnPending 分区）：
   *  抑制 dead 终态页（对话流 + composer 保持，过渡条由 Panel 读同一分区渲染） */
  const isSessionRespawning = computed(() =>
    sessionId.value ? chat.isRespawnPending(sessionId.value) : false,
  )

  /** session-trace 视图态（per-session 分区 view 字段；分区键 focusedSessionId，单 panel 下 == props.sessionId） */
  const isTraceView = computed(() => tracePartition.value.view === 'trace')

  /** 单点派生：全部渲染判据收敛于此，组件层只消费 kind/input。
   *  hasFormOverlay 布尔语义 = 有 pending 统一表单 overlay 请求（form 键，
   *  core PanelViewInput 注释为准）——currentFormRequest 的 find 谓词同源。 */
  const panelView = computed<PanelView>(() =>
    derivePanelView({
      sessionId: sessionId.value,
      hasMessages: hasMessages.value,
      isSessionDead: isSessionDead.value,
      isSessionRespawning: isSessionRespawning.value,
      isTraceView: isTraceView.value,
      hasFormOverlay: currentFormRequest.value !== undefined,
      isFlowActive: flow.isActive.value,
    }),
  )

  return { panelView, hasMessages, currentFormRequest, respond, cancel }
}
