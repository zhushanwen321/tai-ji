<template>
  <!--
    容器组件 · Panel（panel/spec.md zone 编排，承载一个 Session 的 body 区）。
    自上而下：② 主区（switch(panelView.kind)）→ ④ composer（companion 带）。
    ① panel-header 已提升到 PanelContainer（共享横跨 main+drawer 全宽，D2 一体化），
    本组件只承载 body。git 状态移入 SideDrawer git tab，入口在共享 header 右侧 git 按钮。
    section 透明继承 MainPanel 的统一 surface 外壳（border/radius/shadow 只在最外层 MainPanel），
    不再有独立 rounded-lg/border（避免在统一外壳内产生内圆角视觉）。

    主区分支 = usePanelView 派生的 PanelView discriminated union（D1/D5）：组件层禁止再直接组合
    flow/chat/session 状态做渲染判据——全部判据收敛在 derivePanelView 纯函数
    （core 64 组合全表守卫），本模板只消费 kind/input。分支顺序即派生优先级：
    dead > trace > conversation（有消息 MessageStream / 无消息空对话态）> landing > empty。
    turn 运行态（streaming/compacting）不参与任何存在性判定（D2：输入面恒定，
    compacting 的禁用模态由 Composer 内部承担）。
  -->
  <section
    class="relative flex min-w-0 h-full flex-col overflow-hidden"
    :style="panelStyle"
  >
    <!-- dead session 占位：进程已退出，不渲染对话流/composer，提供重开入口（W6：dead 优先级吞掉 form overlay） -->
    <div
      v-if="panelView.kind === 'dead'"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <AlertCircle class="size-8 text-danger opacity-60" />
      <div class="space-y-1">
        <p v-if="restoreErrorCode === 'SESSION_NOT_FOUND'" class="text-sm text-text">{{ t('panel.panel.sessionFileLost') }}</p>
        <p v-else class="text-sm text-text">{{ t('panel.panel.sessionDead') }}</p>
        <p class="text-xs text-neutral-dim">{{ t('panel.panel.sessionDeadHint') }}</p>
      </div>
      <Button v-if="restoreErrorCode === 'SESSION_NOT_FOUND'" variant="ghost" size="sm" @click="onDeleteGhostSession">
        <Trash2 class="mr-1.5 size-3.5" />
        {{ t('panel.panel.deleteThisSession') }}
      </Button>
      <Button v-else variant="default" size="sm" @click="onReviveSession">
        <RotateCcw class="mr-1.5 size-3.5" />
        {{ t('panel.panel.reopen') }}
      </Button>
      <!-- [crash-forensics-and-watchdog §3.3 D6 / u3b] 死态第二入口：进程退出后导出诊断包
           （崩溃归因一键可达）。ghost 次级动作对齐「删除此项」行；知情确认与三态反馈
           收敛在 DiagnosticsExportAction（与设置页共享，行为不分叉）。 -->
      <DiagnosticsExportAction variant="ghost" :label="t('panel.panel.exportDiagnostics')" />
    </div>

    <!-- session-trace（D5a/D5c）：Trace 视图替换对话流位置（composer 保留，§3.1「不打断对话能力」）。
         trace 恒带非空 sessionId（派生类型收窄），切换仅切渲染分支，store 分区数据不动（不重建）。 -->
    <TraceView v-else-if="traceSessionId" :session-id="traceSessionId" />
    <!-- conversation 有消息 → 对话流。flow 残留免疫（G2）：conversation 判据只看 sessionId，
         无论 flow 单例因何残留活跃态，有会话 panel 恒走本分支，landing 判据读不到它。 -->
    <MessageStream v-else-if="streamSessionId" :session-id="streamSessionId" />
    <!-- conversation 无消息 → 空对话态（含「turn 活跃 + 无消息」边界组合，§5 检查点吸收）。
         [u5 mode-declaration-row] 声明行挂载点与有消息分支同锚（面板内容区顶部，即 MessageStream
         的流顶位置）：**空会话同样渲染**——可见性由 ModeDeclarationRow 自判（非默认模式 + presets
         已加载，E7 三态在组件内，否则渲染为空），故默认模式/未加载时空会话形态不变。
         空态文案在声明行之下的剩余空间居中（不改变有消息分支布局）。
         设计依据：`.tmp/tech-design/mode-system-composer-density.md` §6.5 D5 + §7.4。 -->
    <div
      v-else-if="panelView.kind === 'conversation'"
      class="flex min-h-0 flex-1 flex-col"
    >
      <div class="shrink-0 px-5 pt-2">
        <ModeDeclarationRow :session-id="conversationSessionId!" />
      </div>
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <MessageSquare class="size-6 text-neutral-dim opacity-40" />
        <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-70">{{ t('panel.panel.startConversation') }}</p>
      </div>
    </div>
    <!-- landing：仅无 session 且 flow 活跃（新建任务流程唯一承接场景；Landing 内嵌 composer 卡片） -->
    <Landing
      v-else-if="panelView.kind === 'landing'"
      :session-id="sessionId"
      :current-cwd="sessionDir || undefined"
      :git-branch="gitBranch"
      :history-error="historyError"
      @retry="onRetryHistory"
    />
    <!-- empty 兜底：无 session 且 flow 未活跃（选会话空态）。
         本兜底当前仅 empty(sessionId===null) 可达；kind==='empty' && sessionId!==null 属
         类型层防御组合（composer 判据保留），若未来派生规则演化使该组合可达，
         主区应渲染空对话态而非本兜底文案。 -->
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <MessageSquare class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-70">{{ t('panel.panel.selectSession') }}</p>
    </div>

    <!-- ④ composer companion zone（③ progress-zone 已删——真实任务态未接入，state 恒 null
         自隐藏死代码）。git 状态已移入 SideDrawer git tab（原 zone ⑤ 摘牌），此带仅 composer。
         统一表单 overlay（ui-presentation-protocol D5）：请求到达时 FormOverlay 覆盖
         composer 位置（互斥），对话历史全程可见，composer 消失输入禁止。
         [U7] overlay 移除后 composer 常驻（不再 v-if="!isViewingSubagent"）。 -->
    <div class="composer-band flex flex-shrink-0 flex-col gap-1.5 px-5 pb-3.5">
      <!-- [T4] 「引擎恢复中」过渡条（pi 意外退出 → 自动 respawn 窗口）。
           数据源 = chat store respawnPending 分区（与 usePanelView 的 isSessionRespawning
           同源）；此时 panelView.kind 恒为 conversation/trace（respawning 抑制 dead），
           对话流 + composer 保持可用，恢复窗口发消息经 runtime join 等恢复完成后送达。
           restored 到达 / 熔断 / 超时由 useMessageEffects 收口分区 → 本条随之消失。 -->
      <div
        v-if="respawnPending"
        data-testid="respawn-pending-bar"
        class="flex items-center gap-2 rounded-[var(--radius-sm)] border border-warn/40 bg-warn-soft px-3 py-2"
        role="status"
      >
        <LoaderCircle class="size-3.5 shrink-0 animate-spin text-warn" />
        <span class="text-xs text-text">{{ t('panel.message.respawnPending') }}</span>
      </div>
      <!-- [crash-forensics-and-watchdog §3.3 D8 / u10a 挂载点] 入站超界帧终止阀的会话级
           静态提示（与上方 respawnPending 同区——都是「本会话数据流异常」的带内提示，不
           打断对话流/composer）。状态源 = useInboundFrameGuard 的 trippedSessionIds
           （App 装配层 installInboundFrameGuard 已安装）；组件内部按 sessionId 自判 tripped，
           非本 session 不渲染（不连坐）。恢复动作 = 用户切走再切回本会话。 -->
      <InboundFrameDroppedNotice v-if="sessionId" :session-id="sessionId" />
      <!-- 统一表单 overlay 渲染 ⟺ (conversation || trace) && input==='form'（D5 单渲染器）：
           dead 态被派生优先级吞掉（kind==='dead'），保留 W6「dead 不应答」语义；trace 同样
           承接（session-trace 契约「不打断对话能力」，V4）；landing/empty 无 session，
           overlay 依附具体会话，天然不可达。挂载源分流在 script 单点（overlaySource）：
           questions 源（新 form 帧 / legacy askUser 帧归一后）/ draft 源（legacy scheduler 帧
           直挂）——应答形状分流在 FormOverlay 内按键判定（envelope / 扁平 FormResult）。 -->
      <FormOverlay
        v-if="overlayBandActive && overlaySource === 'questions'"
        :questions="formQuestions"
        :allow-cancel="currentOverlayRequest?.allowCancel"
        @submit="onFormSubmit"
        @cancel="onFormCancel"
      />
      <FormOverlay
        v-else-if="overlayBandActive && overlaySource === 'draft'"
        :draft="scheduleDraft!"
        @submit="onFormSubmit"
        @cancel="onFormCancel"
      />
      <!-- Composer 渲染 ⟺ conversation || trace || (empty && sessionId!==null)（D5）：
           会话中恒常驻（G1），trace 态 composer 保留（session-trace 契约「composer 保留在
           底部，不打断对话能力」）；绑定空会话（终态派生为 conversation，防御性保留
           empty-with-session 判据）band 渲染 composer 供直输；landing（内嵌 composer）/
           无 session 空态不挂。 -->
      <Composer v-else-if="showPanelComposer" :session-id="sessionId" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquare, AlertCircle, RotateCcw, Trash2, LoaderCircle } from '@lucide/vue'
import { isFormQuestion, isScheduleDraft, type FormQuestion, type ScheduleDraft } from '@zhushanwen/extension-protocol'
import MessageStream from './MessageStream.vue'
import ModeDeclarationRow from './ModeDeclarationRow.vue'
import Composer from './Composer.vue'
import TraceView from './trace/TraceView.vue'
import { Button } from '@/components/ui/button'
import Landing from '@/components/new-task/Landing.vue'
import FormOverlay from '@/components/extension/form/FormOverlay.vue'
import InboundFrameDroppedNotice from '@/components/ui/InboundFrameDroppedNotice.vue'
import DiagnosticsExportAction from './DiagnosticsExportAction.vue'
import { usePanelView } from '@/composables/features/panel/usePanelView'
import { useChatStore } from '@/stores/chat'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  panelId: string
  sessionId: string | null
  /** 工作目录（Landing current-cwd 用） */
  sessionDir: string
  /** git 分支名（Landing 用） */
  gitBranch?: string
}>()

const { t } = useI18n()
/** chat store 仅剩 historyError 消费（failedHistory 分区）；消息/turn 态判据已全部收进 usePanelView */
const chat = useChatStore()
const { error: toastError } = useToast()

/** dead session 重开：显式调 useSidebar.restoreSession（setup 内解构，避免事件回调调 composable 触发 useI18n 报错） */
const { restoreSession, retryHistory, deleteSession } = useSidebar()

/** restore 失败的错误 code（ghost session 判据）：SESSION_NOT_FOUND 时显示删除入口 */
const restoreErrorCode = ref<string | null>(null)

/**
 * 渲染视图单源（usePanelView：事实收集 + derivePanelView 单点派生）。
 * D2：isSessionActive/isCompacting 兜底已删——turn 状态不再驱动输入面存在性；
 * 「landing 残留 × 输入面消失」在派生规则上不可表达（G2 结构免疫）。
 * currentOverlayRequest 本地别名：currentFormRequest = 队列第一个统一表单 overlay 请求
 * （form 键——新 form 帧与 legacy askUser / scheduleCreate 帧归一后统一命中）。
 */
const { panelView, hasMessages, currentFormRequest: currentOverlayRequest, respond, cancel } = usePanelView(
  computed(() => props.sessionId),
)

/** conversation+有消息 分支的 session id（派生恒非空；computed 收窄供模板 string prop） */
const streamSessionId = computed<string | null>(() => {
  const v = panelView.value
  return v.kind === 'conversation' && hasMessages.value ? v.sessionId : null
})
/** conversation 分支（含有消息 MessageStream / 无消息空对话态）的 session id（派生恒非空；
 *  收窄供模板 string prop）——空会话声明行与 MessageStream 同源挂载点。 */
const conversationSessionId = computed<string | null>(() => {
  const v = panelView.value
  return v.kind === 'conversation' ? v.sessionId : null
})
/** trace 分支的 session id（派生恒非空；收窄同上） */
const traceSessionId = computed<string | null>(() =>
  panelView.value.kind === 'trace' ? panelView.value.sessionId : null,
)
/** band 内 Composer 渲染（D5）：conversation/trace 恒挂（trace 保留输入面 = session-trace
 *  契约「composer 保留在底部，不打断对话能力」）；empty 绑定会话时挂（直输，防御支现行不可达） */
const showPanelComposer = computed(() => {
  const v = panelView.value
  return (
    v.kind === 'conversation' || v.kind === 'trace' || (v.kind === 'empty' && v.sessionId !== null)
  )
})

/** form 问题集（类型守卫收窄 unknown[] → FormQuestion[]，复核守卫——非法项跳过 + warn 留痕）。
 *  formQuestions 来源双路：新 form 帧（runtime event-adapter UI_FORM_MARKER 分支透传）/
 *  legacy askUser 帧经 useExtensionUI 归一层 type 推断映射。全不合法 → 空表单
 *  （仅取消可点语义由 FormOverlay 承接，不静默丢帧不挂死）。 */
const formQuestions = computed<FormQuestion[]>(() => {
  const req = currentOverlayRequest.value
  if (!req?.form) return []
  const raw = req.formQuestions ?? []
  const valid = raw.filter(isFormQuestion)
  // 跳过必须留痕（设计 D2）：「表单少渲染一题」排查靠此区分「上游没发」vs「renderer 滤除」
  const dropped = raw.length - valid.length
  if (dropped > 0) {
    console.warn(
      `[Panel] formQuestions 复核守卫滤除非法项（requestId=${req.requestId}）: dropped=${dropped}/${raw.length}`,
    )
  }
  return valid
})

/** legacy scheduleCreate draft（isScheduleDraft 守卫收窄 unknown → ScheduleDraft；非法/无标记 → null）。
 *  守卫失败不挂载（正常路径不可达，runtime event-adapter 同守卫预检后非法降级普通 select），
 *  失败时 warn 留痕（设计 D2）——overlaySource 回落 null 挂 composer 的原因可追。 */
const scheduleDraft = computed<ScheduleDraft | null>(() => {
  const req = currentOverlayRequest.value
  if (!req?.scheduleCreate) return null
  if (isScheduleDraft(req.scheduleDraft)) return req.scheduleDraft
  console.warn(
    `[Panel] scheduleCreate 帧的 scheduleDraft 守卫失败，draft 源不挂载（requestId=${req.requestId}）:`,
    req.scheduleDraft === undefined ? 'scheduleDraft 缺失' : 'isScheduleDraft 形状校验不通过',
  )
  return null
})

/**
 * overlay 输入面带有效性（conversation/trace 且派生为 overlay 替换 composer）。
 * 抽出公共判据供 overlay / Composer 分支复用（v-if/v-else-if 互斥对的第一段）。
 */
const overlayBandActive = computed(() =>
  (panelView.value.kind === 'conversation' || panelView.value.kind === 'trace')
  && panelView.value.input === 'form',
)

/**
 * 当前 overlay 请求挂载源分型（互斥三值，分流判据单点）：
 * - 'questions'：新 form 帧 / legacy askUser 帧归一后（formQuestions 渲染，应答 envelope）；
 * - 'draft'：legacy scheduleCreate 帧直挂（draft 守卫通过才算可挂载，应答扁平 FormResult）；
 * - null：draft 守卫失败等不可挂载形态（回落 composer）。
 * 判据收敛在 script（手动 .value 读取）而非模板表达式——模板直接解引用请求对象
 * 会在「{ value } 形态的测试替身」下失真（unwrap 语义只对真 ref 生效）。
 */
const overlaySource = computed<'questions' | 'draft' | null>(() => {
  const req = currentOverlayRequest.value
  if (!req?.form) return null
  if (req.scheduleCreate === true) {
    return scheduleDraft.value !== null ? 'draft' : null
  }
  return 'questions'
})

/** 统一表单 Submit：payload 形状由 FormOverlay 按挂载源分流（envelope / 扁平 FormResult
 *  JSON string），Panel 只按 requestId 回传 pi（select method）。 */
function onFormSubmit(payload: string): void {
  const req = currentOverlayRequest.value
  if (!req) return
  respond(req.requestId, payload)
}
/** 统一表单 Cancel：等价 respond(requestId, null)（select resolve undefined → cancelled 语义）。 */
function onFormCancel(): void {
  const req = currentOverlayRequest.value
  if (!req) return
  cancel(req.requestId)
}

/** getHistory 失败态（landing 重试出口，AC-2.6） */
const historyError = computed(() =>
  props.sessionId ? chat.failedHistory.has(props.sessionId) : false,
)

/** [T4] 「引擎恢复中」过渡态（chat store respawnPending 分区；与 usePanelView 的
 *  isSessionRespawning 同源——过渡条渲染位在 composer band，不进派生 kind）。 */
const respawnPending = computed(() =>
  props.sessionId ? chat.isRespawnPending(props.sessionId) : false,
)

/** Landing 重试 → useSidebar.retryHistory（#2 AC-2.6） */
function onRetryHistory(): void {
  if (props.sessionId) void retryHistory(props.sessionId)
}

/** dead session「重新打开」：调 useSidebar.restoreSession（显式 restore RPC），成功后内部已 revive */
async function onReviveSession(): Promise<void> {
  if (!props.sessionId) return
  restoreErrorCode.value = null
  try {
    await restoreSession(props.sessionId)
  } catch (e) {
    const code = (e as Error & { code?: string }).code
    restoreErrorCode.value = code ?? null
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('panel.panel.reopenFailed', { error: msg }))
  }
}

/** ghost session 删除：session 文件丢失（SESSION_NOT_FOUND）后用户选择删除该项 */
async function onDeleteGhostSession(): Promise<void> {
  if (!props.sessionId) return
  try {
    await deleteSession(props.sessionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(msg)
  }
}

/**
 * Panel 底色 + --panel-bg CSS 变量（供子组件如 sticky turn-meta 消费，保证浮层底色与所在 panel 一致）。
 * section 透明继承 MainPanel 的 bg-surface，--panel-bg=surface 供子组件浮层对齐。
 * header 已提升到 PanelContainer，本组件仅 body 区，无边框/圆角（融入统一外壳）。
 */
const panelStyle = computed(() => ({ '--panel-bg': 'var(--surface)' }))
</script>
