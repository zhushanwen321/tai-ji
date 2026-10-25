<!--
  BtwPanel —— drawer btw tab 内容面板（btw-question D7，M3-a）。

  形态（D7）：线列表（W4b 起消费 session.list {surface:'btw', mainSessionId} 的 SessionSummary，
  btw.list 退役）+ 当前线完整对话界面（MessageStream
  :session-id=线 session id + Composer variant=panel :show-btw=false——show-btw 实例开关防
  drawer 内 Composer 递归出 btw 入口，prop 声明归 M3-b，本处只写调用处）+ fork pill（D3 口径）。

  焦点绑定（D7 六条的面板侧）：
  - ①线归属创建时的主会话（关联在 runtime 注册表/目录布局，面板不展示血缘）；
  - ②线列表 = 当前焦点主会话的线（:session-id=panelSessionId → session.list{surface:'btw',
    mainSessionId} 拉取；btw 线进通用列表，btw.list 随 W4b 退役）；
  - ③切走主会话线照常后台运行（面板随 drawer 分区切走即不展示，生命周期归 M4-a）；
  - ④切回恢复面板（选中线存 core drawer 分区 selectedBtwSessionId，切回保留；列表重新拉取）；
  - ⑤挂起表单提交态 per-line 隔离归 M3-c（本单元不触及交互闭环）；
  - ⑥删除主会话级联归 M4-a（本面板不自行清理，走 deleteSession 编排）。

  数据编排（M3-a 形态；M3-b 落 useBtwTabData 后可下沉同构 composable）：
  - per-main-session 状态（线列表/加载态/fork pill 记录）经 useSessionScopedState Map 分区
    （ADR-0049），异步回写一律 updateFor(capturedSid)——焦点切走后迟到响应只写旧分区；
  - 选中线不自持副本：唯一源 = core drawer 分区 selectedBtwSessionId（getViewedVids 的 D5
    豁免读同一字段，防双源漂移）；写入仅在 props.sessionId 仍为当前焦点时发生；
  - fork pill 数据源 = btw.create reply.forkState（创建期一次性，进程内记录；session.list
    条目刻意不含 forkState，结构上不可能跨重启回填——D3 pill 口径）。
  - chip 标签 = 线 label（`btw-<序号>` 可区分形态，§3.4.3 W4b 重定义——旧形态全部同名
    basename(cwd) 只能靠截断 sessionId 区分）。
-->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="drawer-btw-tab">
    <!-- 无恒渲染标题行（r5 视觉对齐 demo BtwPanel：二级 chip 条直接顶置，demo 面板无头行）。
         「新建提问」入口承载 = 空态 Primary 钮 + 有线态 chip 行右簇固定钮（demo 入口在
         composer 左簇弹层，real panel composer 禁 btw 递归入口故面板内承载；
         chip 行形态 = 实例条范式「左簇 tab 可横滚 + 右簇恒在可视区」）。 -->

    <!-- 内联错误条（P2 降级：可见失败 + 不拖垮面板；恢复动作见下方重试） -->
    <div
      v-if="state.createError"
      class="flex shrink-0 items-center gap-1.5 border-t border-hairline bg-danger-soft px-3 py-1.5 text-[length:var(--text-2xs)] text-danger"
      data-testid="btw-create-error"
    >
      <TriangleAlert class="size-3 shrink-0" />
      <span>{{ t('btw.panel.createFailed') }}</span>
      <span class="min-w-0 truncate font-mono opacity-80">{{ state.createError }}</span>
    </div>
    <div
      v-else-if="state.loadError"
      class="flex shrink-0 items-center gap-1.5 border-t border-hairline bg-danger-soft px-3 py-1.5 text-[length:var(--text-2xs)] text-danger"
      data-testid="btw-load-error"
    >
      <TriangleAlert class="size-3 shrink-0" />
      <span>{{ t('btw.panel.loadFailed') }}</span>
      <span class="min-w-0 truncate font-mono opacity-80">{{ state.loadError }}</span>
      <Button
        variant="ghost"
        class="ml-auto h-5 shrink-0 rounded px-1.5 text-[length:var(--text-2xs)]"
        data-testid="btw-load-retry"
        @click="reload"
      >
        {{ t('common.retry') }}
      </Button>
    </div>

    <!-- 空态（无线且加载未出错）：图标 + 说明 + Primary 入口（空态三要素；demo .empty 文字形态） -->
    <div
      v-if="!state.loadError && !state.loading && state.threads.length === 0"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="btw-empty"
    >
      <MessagesSquare class="size-6 text-neutral-dim opacity-40" stroke-width="1.6" />
      <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('btw.panel.emptyList') }}</p>
      <Button
        variant="default"
        class="h-7 gap-1 rounded px-3 text-[length:var(--text-xs)]"
        :disabled="!sessionId || state.creating"
        data-testid="btw-empty-new"
        @click="createThread"
      >
        <Plus class="size-3.5" />
        <span>{{ state.creating ? t('btw.panel.creating') : t('btw.panel.newThread') }}</span>
      </Button>
    </div>

    <!-- 有线：chip 行（线列表）+ 当前线会话区。
         chip 行形态对齐 demo .itabs（实例 tab 条共用范式）：底部 hairline 分隔 +
         可横滚 scrollbar 隐藏；chip = itab 胶囊（border + bg-input + mono 2xs；
         选中 border-strong + elevated + fg，非激活 hover 提亮）。real 线无关闭动作
         （demo itab 关闭叉无对应功能），不渲染叉。
         右簇固定「新建提问」钮（r5 结构对齐 demo 无头行形态后的入口承载；
         在滚动区外恒在可视区，TerminalInstanceBar 同款左右簇范式）。 -->
    <template v-else-if="state.threads.length > 0">
      <div
        class="flex shrink-0 items-center gap-0.5 border-b border-hairline py-1 pl-1 pr-[2px]"
        data-testid="btw-thread-bar"
      >
        <div
          class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="btw-thread-list"
        >
          <Button
            v-for="thread in state.threads"
            :key="thread.id"
            variant="ghost"
            class="h-6 shrink-0 rounded-sm border px-2 font-mono text-[length:var(--text-2xs)] duration-[var(--duration-fast)] ease-[var(--ease-out)]"
            :class="
              thread.id === selectedSessionId
                ? 'border-border bg-surface-hover text-neutral-fg hover:bg-surface-hover'
                : 'border-border bg-bg-input text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'
            "
            :aria-pressed="thread.id === selectedSessionId"
            data-testid="btw-thread-chip"
            :data-session-id="thread.id"
            @click="selectThread(thread.id)"
          >
            <!-- badge 待处理态 per-line 挂点（D8 终态机驱动；聚合范围 = composer btw 按钮 Σ） -->
            <span
              v-if="isBtwPending(thread.id)"
              class="size-1.5 shrink-0 rounded-full bg-warn"
              data-testid="btw-thread-pending"
              :title="t('btw.interaction.pendingLabel')"
            />
            <!-- 标签截断对齐 demo .itab-lbl 口径：max-w 128px 省略 + Button title 显全名（spec §3.4）。
                 W4b label 重定义（§3.4.3）：chip 标签 = 线 label（`btw-<序号>` 可区分形态，
                 runtime/mock 两侧同口径合成；旧形态 = 截断显示 pi 真实 id）。 -->
            <span class="min-w-0 max-w-[128px] truncate" :title="thread.label">{{ thread.label }}</span>
          </Button>
        </div>
        <Button
          variant="ghost"
          class="h-6 shrink-0 gap-1 rounded px-1.5 text-[length:var(--text-2xs)]"
          :disabled="!sessionId || state.creating"
          data-testid="btw-new-thread"
          @click="createThread"
        >
          <Plus class="size-3" />
          <span>{{ state.creating ? t('btw.panel.creating') : t('btw.panel.newThread') }}</span>
        </Button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col">
        <!-- fork pill：创建期一次性口径（D3——三态文案，进程内记录不回填） -->
        <div
          v-if="forkPillText"
          class="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[length:var(--text-2xs)] text-neutral-dim"
          data-testid="btw-fork-pill"
        >
          <GitFork class="size-3 shrink-0 text-reasoning" />
          <span>{{ forkPillText }}</span>
        </div>
        <MessageStream
          v-if="selectedSessionId"
          class="min-h-0 flex-1"
          :session-id="selectedSessionId"
          data-testid="btw-stream"
        />
        <!-- composer band 壳（与 Panel.vue 主面板同壳，类链单一来源 composer-band.ts）：
             左右缘与 MessageStream 内容列对齐（Composer.vue 宽度契约「composer 与消息流
             同宽同缘」），composer 不再贴边满宽；band gap-1.5 承接交互降档行行距，
             无交互时带内仅 composer（空闲几何与主面板一致）。
             M3-c 交互闭环（D8 降级路径唯一形态：drawer 内联确认条，富表单降档；五类请求
             按线 session id 路由本面板，主视图三模态面零浮出）。Guard 为无 DOM 渲染哨兵，包全部
             风险渲染——异常由 onErrorCaptured 在本组件收尾（return false 不外溢主面板，
             P2 隔离），错误条 + 重试在 Guard 外恒可达。 -->
        <!-- composer 带跟 chat 档位（chat-font-scope）：主面板 composer 恒在 main-area
             chat scope 内，btw 线的 composer + 内联确认条同语义（对话流配套输入区，
             非 drawer chrome）——上方 MessageStream 已自挂同款 scope。 -->
        <div v-if="selectedSessionId" :class="COMPOSER_BAND_CLASS" data-fs-scope="chat" data-testid="btw-interaction">
          <BtwInteractionGuard :key="interactionKey">
            <!-- 终态机失效支行内提示（失效支单入口 invalidateBtwRequests——事件帧一路：badge 清 + 表单撤下 + 本提示同拍收尾，D-B2-3） -->
            <div v-if="expiredNotice" class="flex items-center gap-1.5 rounded bg-danger-soft px-2.5 py-1.5 text-[length:var(--text-2xs)] text-danger" data-testid="btw-request-expired">
              <TriangleAlert class="size-3 shrink-0" />
              <span>{{ t('btw.interaction.expiredNotice') }}</span>
              <Button variant="ghost" class="ml-auto h-5 shrink-0 rounded px-1.5 text-[length:var(--text-2xs)]" data-testid="btw-request-expired-dismiss" @click="dismissExpired">{{ t('btw.interaction.dismissExpired') }}</Button>
            </div>
            <!-- [状态区退役 2026-10-15 用户裁决] btw 状态区不再渲染 extension GUI 第四面内容
                 （setStatus/setWidget per-session 源）——btw 线是轻量旁路问答，扩展状态行
                 （如 todo 扩展的「N/N 全部完成」行）在这里只余噪音；主面板托盘形态不受影响。 -->
            <!-- 内联确认条（五类请求共用；kind 分派，降档形态见 useBtwInteraction 文件头） -->
            <div v-if="active" class="overflow-hidden rounded-lg bg-bg-input" data-testid="btw-inline-confirm">
              <!-- plan 审批降档：三键（修订/执行/搁置）+ 单行意见——键集对齐主审批面
                   PlanReviewBar（协议 PlanReviewDecision 全值域），dismiss = 非破坏搁置 -->
              <template v-if="active.kind === 'planReview'">
                <div class="px-3.5 pt-2.5 text-[length:var(--text-xs)] font-medium text-neutral-fg">
                  {{ t('btw.interaction.planReviewTitle') }}
                </div>
                <div class="flex items-center gap-2 px-3.5 pb-2.5 pt-2">
                  <Input v-model="planComment" :placeholder="t('btw.interaction.revisePlaceholder')" class="h-8 text-[length:var(--text-xs)]" data-testid="btw-plan-comment" />
                  <Button variant="ghost" size="sm" class="shrink-0" data-testid="btw-plan-revise" :disabled="!planComment.trim()" @click="submitPlan('revise')">{{ t('plan.reviewBar.submitRevise') }}</Button>
                  <Button variant="default" size="sm" class="shrink-0" data-testid="btw-plan-approve" @click="submitPlan('approve')">{{ t('plan.reviewBar.confirmExecute') }}</Button>
                  <Button variant="ghost" size="sm" class="shrink-0 text-neutral-dim hover:text-neutral-mid" data-testid="btw-plan-dismiss" :title="t('plan.reviewBar.dismissTip')" @click="submitPlan('dismiss')">{{ t('plan.reviewBar.dismiss') }}</Button>
                </div>
              </template>
              <!-- 表单族降档（ask-user 富表单 / scheduler）：问题平铺 + 选项按钮 + 单行输入 -->
              <template v-else-if="active.kind === 'form'">
                <div class="flex flex-col gap-2.5 px-3.5 pb-1 pt-2.5">
                  <div v-for="q in activeQuestions" :key="questionKey(q)" class="flex flex-col gap-1.5">
                    <p class="text-[length:var(--text-xs)] font-medium text-neutral-fg">
                      {{ q.question || q.header }}
                    </p>
                    <template v-if="q.type === 'choice'">
                      <div class="flex flex-wrap gap-1.5">
                        <Button v-for="opt in q.options ?? []" :key="opt.label" variant="secondary" size="sm" class="h-7 rounded px-2 text-[length:var(--text-2xs)]" :class="isSelected(questionKey(q), opt.label) ? 'bg-accent-soft text-neutral-fg' : 'text-neutral-mid'" data-testid="btw-form-option" :data-value="opt.label" @click="toggleSelect(questionKey(q), opt.label, q.multi === true)">{{ opt.label }}</Button>
                      </div>
                      <Input v-if="q.allowOther !== false" v-model="formText[questionKey(q) + '__other']" :placeholder="t('btw.interaction.otherPlaceholder')" class="h-8 text-[length:var(--text-xs)]" data-testid="btw-form-other" />
                    </template>
                    <Input v-else-if="q.type === 'text'" v-model="formText[questionKey(q) + '__other']" :placeholder="t('btw.interaction.answerPlaceholder')" class="h-8 text-[length:var(--text-xs)]" data-testid="btw-form-text" />
                    <p v-else-if="!q.initial" class="text-[length:var(--text-2xs)] text-warn" data-testid="btw-schedule-nodraft">{{ t('btw.interaction.scheduleNoDraft') }}</p>
                  </div>
                </div>
                <div class="flex items-center justify-end gap-2 px-3.5 pb-2.5 pt-1.5">
                  <Button v-if="allowCancel" variant="ghost" data-testid="btw-form-cancel" @click="cancelActive">{{ t('common.cancel') }}</Button>
                  <Button variant="default" data-testid="btw-form-submit" :disabled="!canSubmitForm" @click="submitForm">{{ submitLabel === 'schedule' ? t('extensionUI.scheduleCreateSubmit') : t('common.submit') }}</Button>
                </div>
              </template>
              <!-- 简单 dialog（confirm·input·editor；权限审批 select 同通道） -->
              <template v-else-if="active.kind === 'dialog' && active.dialog">
                <div v-if="active.dialog.title" class="px-3.5 pt-2.5 text-[length:var(--text-xs)] font-medium text-neutral-fg" data-testid="btw-dialog-title">{{ active.dialog.title }}</div>
                <p v-if="active.dialog.message" class="px-3.5 pt-2 text-[length:var(--text-xs)] leading-1.5 text-neutral-mid" data-testid="btw-dialog-message">{{ active.dialog.message }}</p>
                <div v-if="active.dialog.method === 'confirm'" class="flex justify-end gap-2 px-3.5 pb-2.5 pt-2">
                  <Button variant="ghost" data-testid="btw-dialog-cancel" @click="cancelActive">{{ t('common.cancel') }}</Button>
                  <Button variant="default" data-testid="btw-dialog-confirm" @click="respondActive(true)">{{ t('common.confirm') }}</Button>
                </div>
                <div v-else-if="active.dialog.method === 'select'" class="flex flex-col gap-1 px-3.5 pb-2.5 pt-2">
                  <Button v-for="opt in active.dialog.options ?? []" :key="opt.value" variant="secondary" size="sm" class="h-7 justify-start rounded px-2 text-[length:var(--text-2xs)]" :class="dialogSelect === opt.value ? 'bg-accent-soft text-neutral-fg' : 'text-neutral-mid'" :data-testid="`btw-dialog-option-${opt.value}`" @click="dialogSelect = opt.value">{{ opt.label }}</Button>
                  <div class="flex justify-end gap-2 pt-1.5">
                    <Button variant="ghost" data-testid="btw-dialog-cancel" @click="cancelActive">{{ t('common.cancel') }}</Button>
                    <Button variant="default" data-testid="btw-dialog-ok" :disabled="!dialogSelect" @click="respondActive(dialogSelect)">{{ t('common.confirm') }}</Button>
                  </div>
                </div>
                <div v-else-if="active.dialog.method === 'input' || active.dialog.method === 'editor'" class="flex flex-col gap-2 px-3.5 pb-2.5 pt-2">
                  <Input v-model="dialogText" :placeholder="t('btw.interaction.answerPlaceholder')" data-testid="btw-dialog-input" />
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" data-testid="btw-dialog-cancel" @click="cancelActive">{{ t('common.cancel') }}</Button>
                    <Button variant="default" data-testid="btw-dialog-ok" @click="respondActive(dialogText)">{{ t('common.submit') }}</Button>
                  </div>
                </div>
                <p v-else class="px-3.5 pb-2.5 pt-2 text-[length:var(--text-2xs)] text-neutral-dim" data-testid="btw-dialog-unknown">{{ active.dialog.method }}</p>
              </template>
            </div>
          </BtwInteractionGuard>
          <!-- 运行期错误边界（单线失败 = 行内错误 + 可重试，不外溢主面板） -->
          <div v-if="interactionError" class="flex items-center gap-1.5 border-t border-hairline bg-danger-soft px-2.5 py-1.5 text-[length:var(--text-2xs)] text-danger" data-testid="btw-interaction-error" role="alert">
            <TriangleAlert class="size-3 shrink-0" />
            <span>{{ t('btw.interaction.error') }}</span>
            <Button variant="ghost" class="ml-auto h-5 shrink-0 rounded px-1.5 text-[length:var(--text-2xs)]" data-testid="btw-interaction-retry" @click="retryInteraction">{{ t('common.retry') }}</Button>
          </div>
          <Composer
            v-if="selectedSessionId"
            :session-id="selectedSessionId"
            variant="panel"
            :show-btw="false"
            data-testid="btw-composer"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitFork, MessagesSquare, Plus, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { btw, session } from '@/api'
import { isBtwPending } from '@/composables/panel/btw-pending-bookkeeping'
import { noteBtwLinesPulled } from '@/composables/panel/btw-line-membership'
import { useBtwPanelSurface } from '@/composables/panel/useBtwTabData'
import { useBtwInteraction } from '@/composables/panel/useBtwInteraction'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useSessionStore } from '@/stores/session'
import { useChatStore } from '@/stores/chat'
import { ensureStreamSubscription } from '@/composables/features/chat/useChat'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { setBtwView, useBtwSelection, getBoundSessionId } from '@taiji/core/domain/drawer'
import type { ServerMessageMap, SessionSummary } from '@taiji/shared'
import MessageStream from '@/components/panel/MessageStream.vue'
import Composer from '@/components/panel/Composer.vue'
import { COMPOSER_BAND_CLASS } from '@/components/panel/composer-band'

// btw.create 的 forkState 走 indexed-access（shared 包出口选择性 re-export 未挂具名——
// M2-a 登记的 SegmentsMetadataEntry 同款惯例，SSOT = shared protocol.ts）
type BtwForkState = ServerMessageMap['btw.create']['forkState']
// W4b：线条目类型 = session.list 通用查询的 SessionSummary（btw 线进通用列表，
// 原 btw.list reply 条目类型随该消息退役）
type BtwThreadInfo = SessionSummary

const props = defineProps<{
  /** 当前焦点主会话 id（PanelContainer 透传 panelSessionId）；null=无会话（入口禁用 + 空态） */
  sessionId: string | null
}>()

const { t } = useI18n()

// 线视图激活时的通道建立依赖（见下方 selectedSessionId watch 的为何注释）：chat/session
// store + core 状态层拉取入口（useSidebar 代理 core.refreshLiveState——与主会话切入链
// 步 13、重连对账同一个入口，缓存缺失门控 + fire-and-forget 语义不变）。
const chatStore = useChatStore()
const sessionStore = useSessionStore()
const { refreshLiveState } = useSidebar()

/** per-main-session 面板状态（ADR-0049 Map 分区；切 sid 不丢、切回恢复，异步回写用 updateFor） */
// @data-owner #44 —— #44 btw 线列表的 renderer 面板消费分区（session.list
// {surface:'btw', mainSessionId} 拉取 reply 喂入，与 useBtwTabData badge 分区各自拉取
// 各自收敛；权威源/唯一写入口见登记表主表 #44 行，非第二写方）
interface BtwPanelState {
  threads: BtwThreadInfo[]
  loading: boolean
  loadError: string | null
  /** 同分区加载序号：旧响应 seq 不匹配即丢弃（乱序检查，搜索 TC-2 loadSeq 同款） */
  loadSeq: number
  creating: boolean
  createError: string | null
  /** 线 session id → 创建期 forkState（一次性元信息，仅进程内；session.list 条目不携带故不可回填） */
  forkPills: Record<string, BtwForkState>
}

const sidRef = computed(() => props.sessionId)
const scoped = useSessionScopedState<BtwPanelState>(sidRef, () =>
  reactive({
    threads: [],
    loading: false,
    loadError: null,
    loadSeq: 0,
    creating: false,
    createError: null,
    forkPills: {},
  }),
)
const state = computed(() => scoped.current.value)

/** 选中线唯一源 = core btw 内容域选中态（selection/btw.ts，display-containers §6.6① 五字段
 *  迁出后的落点；D5 豁免/视口命中经复合谓词 selection/predicates.ts 读同一字段；与 props.sessionId
 *  同分区前提由系统不变量保证——PanelContainer 绑定 focusedSessionId 与 leaf.sessionId 同值，
 *  SubagentTab selectedSubagentId 同款耦合）。null=未选中（列表仅展示）。 */
const { selectedBtwSessionId } = useBtwSelection()
const selectedSessionId = computed(() => selectedBtwSessionId.value ?? null)

// ── [W2 缺陷修复] 线视图激活 = 流订阅建立 + 状态层拉取（与主会话切入链步 5/13 等同）──
// 为何在此触发：btw 线视图不走 selectSession 切入链——线是 drawer 内的旁路呈现，主会话
// 焦点不变、runtime 不 switch，切入链步 5 ensureStreamSubscription 与步 13
// refreshLiveState 对线 id 零覆盖；bindSessionStreamSync 只 watch 侧栏
// sessionStore.list（线 surface='btw' 不在列表内），同样零覆盖。本组件是线视图唯一载体
// （MessageStream/Composer 按 selectedSessionId 装配），「选中线变化 + 挂载即选中」
// （drawer 重开恢复选中，D7④）= 线被激活为当前视图的全部形态，故在此补与切入链等同的
// 两件事（语义不变：缓存缺失门控 + fire-and-forget；实现复用既有入口，不新造第二套）。
watch(
  selectedSessionId,
  (sid) => {
    if (!sid) return
    // 步 5 等同：先建订阅（线消息帧写入 chatStore 分区的唯一聚合点），再谈状态拉取
    ensureStreamSubscription(sid, chatStore, sessionStore)
    // 步 13 等同：打开视图时机（缓存缺失门控在 core refreshLiveState 内；fire-and-forget）
    void refreshLiveState(sid)
  },
  { immediate: true },
)

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 拉取线列表：回写 captured 分区（updateFor），焦点切走后迟到响应不污染新分区 */
async function loadThreads(captured: string): Promise<void> {
  let seq = 0
  scoped.updateFor(captured, (s) => {
    s.loadSeq += 1
    seq = s.loadSeq
    s.loading = true
    s.loadError = null
  })
  try {
    // W4b：线列表 = session.list { surface:'btw', mainSessionId }（btw 进通用列表，
    // btw.list 退役）——reply 与 config.sessions 同形，扁平化即该主会话名下线列表
    // （组内按 createdAt 升序，最新线在末位 → autoSelect 选最新）。
    const groups = await session.listSessions({ surface: 'btw', mainSessionId: captured })
    const threads = groups.flatMap((g) => g.sessions)
    scoped.updateFor(captured, (s) => {
      if (s.loadSeq !== seq) return // 同分区旧响应丢弃（重试双击/watch 连触乱序检查）
      s.loading = false
      s.threads = threads
    })
    // W4b 收编：本拉取产物喂入抑制类成员判别缓存（同一 session.list 来源，不另起 RPC；
    // merge 口径见 btw-line-membership 模块头——抽屉打开即是一条拉取时机，设计 §5-W4b ①）。
    noteBtwLinesPulled(threads.map((th) => th.id))
    autoSelect(captured, threads)
  } catch (e) {
    scoped.updateFor(captured, (s) => {
      if (s.loadSeq !== seq) return
      s.loading = false
      s.loadError = messageOf(e)
    })
  }
}

/** 焦点绑定②④：保留仍有效的选中线（切回恢复）；否则默认选最新线；空列表清选中 */
function autoSelect(captured: string, threads: BtwThreadInfo[]): void {
  if (!canWriteSelection(captured)) return
  if (threads.length === 0) {
    setBtwView(undefined)
    return
  }
  const current = selectedBtwSessionId.value
  if (current && threads.some((th) => th.id === current)) return
  setBtwView(threads[threads.length - 1].id)
}

/** 选中写入前置：setBtwView 落「按绑定 sid 分区」的 btw 内容域选中态——仅当面板焦点与绑定
 *  分区一致（生产不变量：focusedSessionId ≡ leaf.sessionId）才写，防焦点切换窗口期把线
 *  选中写进另一会话的分区（跨分区污染）。不一致时跳过（选中留待下次拉取/点击收敛）。 */
function canWriteSelection(captured: string): boolean {
  return sidRef.value === captured && getBoundSessionId() === captured
}

function selectThread(sessionId: string): void {
  setBtwView(sessionId)
}

/**
 * 即时入列条目的 cwd = 所属主会话 cwd（设计 §5-W4b「必填字段派生规则」：线 cwd = 主会话
 * cwd——runtime `toLineSummary` 取 `BtwLineRecord.cwd`、btw-message-handler `createLine`
 * 入参即 `resolveMain(mainSid).cwd`，mock `buildBtwLineEntries` 取主会话 fixture cwd，
 * 三处同口径）。主会话 id 不是 cwd，写进该字段即类型化错值。
 *
 * 取数顺序（同分区优先：已拉取线条目的 cwd 就是主会话 cwd 的权威投影）：
 * ① 同分区已拉取线条目（session.list 合成产物）；
 * ② session store 的主会话 summary（侧栏列表权威持有 cwd）；
 * ③ 都取不到 → 空串（该字段当前无模板 / useBtwPanelSurface 消费方，条目在下次拉取
 *    （抽屉活动触发）即被权威条目整体替换；空串是显式未知，不伪装成任何路径）。
 */
function optimisticThreadCwd(captured: string, existing: BtwThreadInfo[]): string {
  const fromLines = existing.find((th) => th.cwd)?.cwd
  if (fromLines) return fromLines
  const main = sessionStore.list.find((s) => s.id === captured)
  return main?.cwd ?? ''
}

/** 新建线（空态 Primary / 头部按钮共用）：create reply 即 pill 数据源（D3 一次性口径） */
async function createThread(): Promise<void> {
  const captured = props.sessionId
  if (!captured) return
  scoped.updateFor(captured, (s) => {
    s.creating = true
    s.createError = null
  })
  try {
    const reply = await btw.create(captured)
    scoped.updateFor(captured, (s) => {
      s.creating = false
      s.forkPills[reply.sessionId] = reply.forkState
      if (!s.threads.some((th) => th.id === reply.sessionId)) {
        // 乐观占位写入（data-source-registry #44 已登记）：create reply 后即时入列，不等
        // 下次拉取——该条目是一次性占位、不是第二套权威合成（字段与 session.list 拉取 reply
        // 合成同口径：label 暂缺（序号由下次拉取按创建次序定），先以 sessionId 占位渲染；
        // cwd = 所属主会话 cwd，见 optimisticThreadCwd §5-W4b 派生规则）。
        // 下一次拉取（抽屉活动触发）reply 整表覆写，本条即被权威条目整体替换。
        s.threads = [...s.threads, {
          id: reply.sessionId,
          label: reply.sessionId,
          cwd: optimisticThreadCwd(captured, s.threads),
          status: 'idle',
          lastActiveAt: Date.now(),
        }]
      }
    })
    if (canWriteSelection(captured)) setBtwView(reply.sessionId)
  } catch (e) {
    scoped.updateFor(captured, (s) => {
      s.creating = false
      s.createError = messageOf(e)
    })
  }
}

function reload(): void {
  if (props.sessionId) void loadThreads(props.sessionId)
}

// 焦点绑定②：切主会话即按新 mainSid 重新拉取（清空不是隔离手段——数据按 captured 分区落位，
// 迟到旧响应用 loadSeq 丢弃；watch 只负责触发拉取，不手动清空任何状态）
watch(
  () => props.sessionId,
  (sid) => {
    if (sid) void loadThreads(sid)
  },
  { immediate: true },
)

/** fork pill 三态文案（仅当前选中线有创建期记录时渲染；跨重启不回填故重开无线索即无 pill） */
const forkPillText = computed(() => {
  const sessionId = selectedSessionId.value
  if (!sessionId) return null
  const fs = state.value.forkPills[sessionId]
  if (!fs) return null
  if (fs === 'none') return t('btw.pill.none')
  if (fs === 'truncated') return t('btw.pill.truncated')
  return t('btw.pill.full')
})

// ── M3-c 交互闭环（D8 降级路径：drawer 内联确认条唯一形态）────────────────
const {
  active,
  activeQuestions,
  formText,
  planComment,
  dialogSelect,
  dialogText,
  questionKey,
  toggleSelect,
  isSelected,
  canSubmitForm,
  submitLabel,
  allowCancel,
  respondActive,
  submitForm,
  submitPlan,
  cancelActive,
} = useBtwInteraction(selectedSessionId)

// ── M3-c：失效提示 / 运行期错误边界（编排下沉 useBtwPanelSurface，
//    规则：全部风险渲染在 Guard slot 内求值，异常由 surface 注册的 onErrorCaptured 在
//    本组件收尾 return false 不外溢主面板；MessageStream/Composer 不在 Guard 内不受影响；
//    第四面状态区已随 2026-10-15 用户裁决移除，Guard slot 仅余失效提示 + 内联确认条）──
const {
  expiredNotice,
  dismissExpired,
  interactionError,
  interactionKey,
  retryInteraction,
  BtwInteractionGuard,
} = useBtwPanelSurface(selectedSessionId)
</script>
