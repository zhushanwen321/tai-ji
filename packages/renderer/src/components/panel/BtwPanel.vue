<!--
  BtwPanel —— drawer btw tab 内容面板（btw-question D7，M3-a）。

  形态（D7）：线列表（消费 btw.list threads）+ 当前线完整对话界面（MessageStream
  :session-id=vid + Composer variant=panel :show-btw=false——show-btw 实例开关防 drawer 内
  Composer 递归出 btw 入口，prop 声明归 M3-b，本处只写调用处）+ fork pill（D3 口径）。

  焦点绑定（D7 六条的面板侧）：
  - ①线归属创建时的主会话（关联在 runtime 注册表/目录布局，面板不展示血缘）；
  - ②线列表 = 当前焦点主会话的线（:session-id=panelSessionId → btw.list{mainSid} 拉取）；
  - ③切走主会话线照常后台运行（面板随 drawer 分区切走即不展示，生命周期归 M4-a）；
  - ④切回恢复面板（选中线存 core drawer 分区 selectedBtwVid，切回保留；列表重拉）；
  - ⑤挂起表单提交态 per-vid 隔离归 M3-c（本单元不触及交互闭环）；
  - ⑥删除主会话级联归 M4-a（本面板不自行清理，走 deleteSession 编排）。

  数据编排（M3-a 形态；M3-b 落 useBtwTabData 后可下沉同构 composable）：
  - per-main-session 状态（线列表/加载态/fork pill 记录）经 useSessionScopedState Map 分区
    （ADR-0049），异步回写一律 updateFor(capturedSid)——焦点切走后迟到响应只写旧分区；
  - 选中线不自持副本：唯一源 = core drawer 分区 selectedBtwVid（getViewedVids 的 D5
    豁免读同一字段，防双源漂移）；写入仅在 props.sessionId 仍为当前焦点时发生；
  - fork pill 数据源 = btw.create reply.forkState（创建期一次性，进程内记录；btw.list
    threads 刻意不含 forkState，结构上不可能跨重启回填——D3 pill 口径）。
-->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="drawer-btw-tab">
    <!-- 头部：线列表标签 + 新建入口 -->
    <div class="flex shrink-0 items-center gap-1.5 bg-surface-2 px-2.5 py-1.5">
      <MessagesSquare class="size-3.5 shrink-0 text-neutral-dim" />
      <span class="min-w-0 truncate text-[length:var(--text-xs)] font-medium text-neutral-fg">
        {{ t('btw.panel.threadsTitle') }}
      </span>
      <Button
        variant="ghost"
        class="ml-auto h-6 gap-1 rounded px-2 text-[length:var(--text-2xs)]"
        :disabled="!sessionId || state.creating"
        data-testid="btw-new-thread"
        @click="createThread"
      >
        <Plus class="size-3" />
        <span>{{ state.creating ? t('btw.panel.creating') : t('btw.panel.newThread') }}</span>
      </Button>
    </div>

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

    <!-- 空态（无线且加载未出错）：图标 + 说明 + Primary 入口（空态三要素） -->
    <div
      v-if="!state.loadError && !state.loading && state.threads.length === 0"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="btw-empty"
    >
      <MessagesSquare class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-70">{{ t('btw.panel.emptyList') }}</p>
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

    <!-- 有线：chip 行（线列表）+ 当前线会话区 -->
    <template v-else-if="state.threads.length > 0">
      <div class="flex shrink-0 gap-1 overflow-x-auto px-2 py-1.5" data-testid="btw-thread-list">
        <Button
          v-for="thread in state.threads"
          :key="thread.vid"
          variant="ghost"
          class="h-6 shrink-0 rounded-full px-2 font-mono text-[length:var(--text-2xs)]"
          :class="thread.vid === selectedVid ? 'bg-surface text-accent' : 'text-neutral-dim hover:text-neutral-fg'"
          :aria-pressed="thread.vid === selectedVid"
          data-testid="btw-thread-chip"
          :data-vid="thread.vid"
          @click="selectThread(thread.vid)"
        >
          <!-- badge 待处理态 per-line 挂点（D8 终态机驱动；聚合面 = composer btw 按钮 Σ） -->
          <span
            v-if="isBtwPending(thread.vid)"
            class="size-1.5 shrink-0 rounded-full bg-warn"
            data-testid="btw-thread-pending"
            :title="t('btw.interaction.pendingLabel')"
          />
          {{ shortVid(thread.vid) }}
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
          v-if="selectedVid"
          class="min-h-0 flex-1"
          :session-id="selectedVid"
          data-testid="btw-stream"
        />
        <!-- M3-c 交互闭环（D8 降级路径唯一形态：drawer 内联确认条，富表单降档；五类请求
             按 vid 路由本面板，主视图三模态面零浮出）。Guard 子组件包全部风险渲染——
             异常由 onErrorCaptured 在本组件收口（return false 不外溢主面板，P2 隔离），
             错误条 + 重试在 Guard 外恒可达。 -->
        <div v-if="selectedVid" class="flex shrink-0 flex-col gap-1.5 px-2 pb-1.5" data-testid="btw-interaction">
          <BtwInteractionGuard :key="interactionKey">
            <!-- 终态机失效支行内提示（badge 清 + 表单撤下 + 本提示，两路合并收口） -->
            <div v-if="expiredNotice" class="flex items-center gap-1.5 rounded bg-danger-soft px-2.5 py-1.5 text-[length:var(--text-2xs)] text-danger" data-testid="btw-request-expired">
              <TriangleAlert class="size-3 shrink-0" />
              <span>{{ t('btw.interaction.expiredNotice') }}</span>
              <Button variant="ghost" class="ml-auto h-5 shrink-0 rounded px-1.5 text-[length:var(--text-2xs)]" data-testid="btw-request-expired-dismiss" @click="dismissExpired">{{ t('btw.interaction.dismissExpired') }}</Button>
            </div>
            <!-- 第四面状态区（非模态 extension GUI：setStatus/setWidget 的 per-session 源
                 读 vid 分区，不落主视图 chrome；toolbar/tab-bar 无 session 帧不在路由面） -->
            <div v-if="statusEntries.length > 0 || widgetLines.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-surface-hover px-2.5 py-1 text-[length:var(--text-2xs)] text-neutral-dim" data-testid="btw-status-strip">
              <span v-for="item in statusEntries" :key="item.id" class="flex items-center gap-1" :title="item.tooltip" data-testid="btw-status-item">
                <i v-if="item.status" class="inline-block size-[5px] rounded-full" :class="statusDotClass(item.status)" />
                {{ item.text }}
              </span>
              <span v-for="(line, i) in widgetLines" :key="`w-${i}`" class="font-mono" data-testid="btw-widget-line">{{ line }}</span>
            </div>
            <!-- 内联确认条（五类请求共用；kind 分派，降档形态见 useBtwInteraction 文件头） -->
            <div v-if="active" class="overflow-hidden rounded-lg bg-bg-input" data-testid="btw-inline-confirm">
              <!-- plan 审批降档：两键 + 单行意见 -->
              <template v-if="active.kind === 'planReview'">
                <div class="px-3.5 pt-2.5 text-[length:var(--text-xs)] font-medium text-neutral-fg">
                  {{ t('btw.interaction.planReviewTitle') }}
                </div>
                <div class="flex items-center gap-2 px-3.5 pb-2.5 pt-2">
                  <Input v-model="planComment" :placeholder="t('btw.interaction.revisePlaceholder')" class="h-8 text-[length:var(--text-xs)]" data-testid="btw-plan-comment" />
                  <Button variant="ghost" size="sm" class="shrink-0" data-testid="btw-plan-revise" :disabled="!planComment.trim()" @click="submitPlan('revise')">{{ t('plan.reviewBar.submitRevise') }}</Button>
                  <Button variant="default" size="sm" class="shrink-0" data-testid="btw-plan-approve" @click="submitPlan('approve')">{{ t('plan.reviewBar.confirmExecute') }}</Button>
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
        </div>
        <Composer
          v-if="selectedVid"
          :session-id="selectedVid"
          variant="panel"
          :show-btw="false"
          data-testid="btw-composer"
        />
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
import { btw } from '@/api'
import { isBtwPending, useBtwPanelSurface } from '@/composables/panel/useBtwTabData'
import { useBtwInteraction } from '@/composables/useExtensionUI'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { drawerControl, useDrawerControl, getBoundSessionId } from '@taiji/core/domain/drawer'
import { isBtwVirtualId, extractBtwPiSessionId } from '@taiji/shared'
import type { ServerMessageMap } from '@taiji/shared'
import MessageStream from '@/components/panel/MessageStream.vue'
import Composer from '@/components/panel/Composer.vue'

// btw 具名类型走 indexed-access（shared 包出口选择性 re-export 未挂具名——M2-a 登记的
// SegmentsMetadataEntry 同款惯例，SSOT = shared protocol.ts）
type BtwForkState = ServerMessageMap['btw.create']['forkState']
type BtwThreadInfo = ServerMessageMap['btw.list']['threads'][number]

const props = defineProps<{
  /** 当前焦点主会话 id（PanelContainer 透传 panelSessionId）；null=无会话（入口禁用 + 空态） */
  sessionId: string | null
}>()

const { t } = useI18n()

/** per-main-session 面板状态（ADR-0049 Map 分区；切 sid 不丢、切回恢复，异步回写用 updateFor） */
interface BtwPanelState {
  threads: BtwThreadInfo[]
  loading: boolean
  loadError: string | null
  /** 同分区加载序号：旧响应 seq 不匹配即丢弃（乱序守卫，搜索 TC-2 loadSeq 同款） */
  loadSeq: number
  creating: boolean
  createError: string | null
  /** vid → 创建期 forkState（一次性元信息，仅进程内；btw.list 不携带故不可回填） */
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

/** 选中线唯一源 = core drawer 分区 selectedBtwVid（D5 豁免读同一字段；与 props.sessionId
 *  同分区前提由系统不变量保证——PanelContainer 绑定 focusedSessionId 与 leaf.sessionId 同值，
 *  SubagentTab selectedSubagentId 同款耦合）。null=未选中（列表仅展示）。 */
const { selectedBtwVid } = useDrawerControl()
const selectedVid = computed(() => selectedBtwVid.value ?? null)

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 线列表短名：映射即 extract（M1-a 工厂；非 btw 形态兜底原样展示） */
function shortVid(vid: string): string {
  return isBtwVirtualId(vid) ? extractBtwPiSessionId(vid) : vid
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
    const threads = await btw.list(captured)
    scoped.updateFor(captured, (s) => {
      if (s.loadSeq !== seq) return // 同分区旧响应丢弃（重试双击/watch 连触乱序守卫）
      s.loading = false
      s.threads = threads
    })
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
    drawerControl.setBtwView(undefined)
    return
  }
  const current = selectedBtwVid.value
  if (current && threads.some((th) => th.vid === current)) return
  drawerControl.setBtwView(threads[threads.length - 1].vid)
}

/** 选中写入前置：setBtwView 落「按绑定 sid 分区」的 drawer 控制态——仅当面板焦点与绑定
 *  分区一致（生产不变量：focusedSessionId ≡ leaf.sessionId）才写，防焦点切换窗口期把线
 *  选中写进另一会话的分区（跨分区污染）。不一致时跳过（选中留待下次拉取/点击收敛）。 */
function canWriteSelection(captured: string): boolean {
  return sidRef.value === captured && getBoundSessionId() === captured
}

function selectThread(vid: string): void {
  drawerControl.setBtwView(vid)
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
      s.forkPills[reply.vid] = reply.forkState
      if (!s.threads.some((th) => th.vid === reply.vid)) {
        s.threads = [...s.threads, { vid: reply.vid }]
      }
    })
    if (canWriteSelection(captured)) drawerControl.setBtwView(reply.vid)
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

// 焦点绑定②：切主会话即按新 mainSid 重拉（清空不是隔离手段——数据按 captured 分区落位，
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
  const vid = selectedVid.value
  if (!vid) return null
  const fs = state.value.forkPills[vid]
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
} = useBtwInteraction(selectedVid)

// ── M3-c：失效提示 / 第四面状态区 / 运行期错误边界（编排下沉 useBtwPanelSurface，
//    规则：全部风险渲染在 Guard slot 内求值，异常由 surface 注册的 onErrorCaptured 在
//    本组件收口 return false 不外溢主面板；MessageStream/Composer 不在 Guard 内不受影响）──
const {
  expiredNotice,
  dismissExpired,
  statusEntries,
  widgetLines,
  statusDotClass,
  interactionError,
  interactionKey,
  retryInteraction,
  BtwInteractionGuard,
} = useBtwPanelSurface(selectedVid)
</script>
