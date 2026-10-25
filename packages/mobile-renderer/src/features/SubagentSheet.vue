<script setup lang="ts">
// SubagentSheet —— 子代理两级 Sheet（remote-use-mobile-v2 §6.10 / §7.2 子代理行）。
//
// 两级推进 = 同 key 内部 stage（§6.13：列表态/详情态不占两个 Sheet 槽；sheet-manager 槽位
// 恒 'subagentList'，详情推进是本组件内部状态）：
// - 列表态：fetchSubagents 主动拉（broadcast 与订阅时序竞争规则）；两态显示映射（§7.2
//   收窄口径）：running→运行中（accent 脉冲）/ idle→已结束（dim）/ error 有值→失败
//   （danger + 错误文本）；oversize=true → 列表不可用降级提示（结构化回执，非空列表假象）；
// - 详情态：头部元信息取 SubagentRecord 既有字段 + 执行记录 = getSubagentHistory 最近
//   N≈8 条消息派生（assistant/user 文本截断 + 消息状态图标；不新增 runtime steps 概念，
//   demo 仿真 steps 不迁移）+ 停止（running 时可用，subagentAction cancel → 重拉收敛）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Sheet } from '@taiji/ui'
import type { SubagentRecord } from '@taiji/shared'
import {
  appendActionNotice,
  fetchSubagentHistory,
  fetchSubagents,
  stopSubagent,
  type MobileSubagentHistoryMessage,
} from '../shell/app-runtime'
import { showErrorBar } from '../shell/error-bar'

const props = defineProps<{
  /** 槽位开合（sheet-manager activeSheet === 'subagentList'） */
  open: boolean
  /** 目标会话（子代理清单按主会话拉取） */
  sessionId: string
  /**
   * 直落详情目标（remote-use-mobile-v2 u-activity：进行中屏子代理行点击 → 打开即进该
   * 子代理详情态；缺省 undefined = 列表态，既有行为不变）。清单拉取完成后按 id 定位，
   * 不在册（已结束离场等）落列表态不报错。
   */
  initialSubagentId?: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

/** 两级 stage（同 key 内部推进，§6.13） */
const stage = ref<'list' | 'detail'>('list')
const records = ref<SubagentRecord[]>([])
const oversize = ref(false)
const loaded = ref(false)
/** 详情态选中的 record（列表项点击写入；stopReason 等字段刷新随重拉同步） */
const selected = ref<SubagentRecord | null>(null)
/** 待直落的子代理 id（open watch 写入，清单拉取后消费一次——spec 直落意图只对本次打开生效） */
let pendingInitialId: string | undefined

/** 详情执行记录（最近 N≈8 条历史消息派生，§6.10） */
const HISTORY_WINDOW = 8
const history = ref<MobileSubagentHistoryMessage[]>([])
const historyLoading = ref(false)
const stopping = ref(false)

function reloadList(sid: string): void {
  fetchSubagents(sid)
    .then((reply) => {
      // 直落意图单次消费（found=false / 不在册均放弃直落落列表态——失败形态不阻塞清单呈现）
      const initial = pendingInitialId
      pendingInitialId = undefined
      // found=false = 会话不在册（pi 延迟落盘窗口/扫描竞态）——保留既有分区数据不覆盖
      if (reply.found === false) return
      records.value = reply.subagents
      oversize.value = reply.oversize === true
      loaded.value = true
      // 详情态下的重拉（停止收敛路径）同步刷新选中 record 引用
      if (selected.value) {
        selected.value = reply.subagents.find((r) => r.subagentId === selected.value?.subagentId) ?? selected.value
      }
      // 直落详情（u-activity 进行中屏子代理行；record 在册才推进，不在册保持列表态）
      const target = initial !== undefined ? reply.subagents.find((r) => r.subagentId === initial) : undefined
      if (target) openDetail(target)
    })
    .catch((e: unknown) => {
      pendingInitialId = undefined
      console.warn('[SubagentSheet] getSubagents failed:', e)
      loaded.value = true
    })
}

// 打开即重置进列表态 + 拉清单（每次打开刷新；关闭保留数据避免二次打开闪空）。
// 打开瞬间的 initialSubagentId 记为待直落意图（含 undefined——直落只对本次打开生效）。
watch(
  () => [props.open, props.sessionId] as const,
  ([open, sid]) => {
    if (!open) return
    stage.value = 'list'
    selected.value = null
    pendingInitialId = props.initialSubagentId
    reloadList(sid)
  },
  { immediate: true },
)

/** 展示名：slug 优先，空串兜底 agent 名（旧 session 数据 slug 缺省形态文案不空） */
function displayName(r: SubagentRecord): string {
  return r.slug !== '' ? r.slug : r.agent
}

/** 两态显示映射（§7.2 收窄口径）：error 有值 → 失败；running → 运行中；其余 idle → 已结束 */
type SubagentDisplayState = 'running' | 'ended' | 'failed'

function displayStateOf(r: SubagentRecord): SubagentDisplayState {
  if (r.error !== undefined) return 'failed'
  return r.status === 'running' ? 'running' : 'ended'
}

function stateLabelOf(r: SubagentRecord): string {
  const s = displayStateOf(r)
  return s === 'running' ? t('mobile.subagent.stateRunning') : s === 'failed' ? t('mobile.subagent.stateFailed') : t('mobile.subagent.stateEnded')
}

function openDetail(r: SubagentRecord): void {
  selected.value = r
  stage.value = 'detail'
  historyLoading.value = true
  history.value = []
  fetchSubagentHistory(props.sessionId, r.subagentId)
    .then((messages) => {
      // 最近 N 条窗口（§6.10「最近执行历史」；全量历史走桌面 drawer，移动只监护到哪了）
      history.value = messages.slice(-HISTORY_WINDOW)
      historyLoading.value = false
    })
    .catch((e: unknown) => {
      console.warn('[SubagentSheet] getSubagentHistory failed:', e)
      historyLoading.value = false
    })
}

function backToList(): void {
  stage.value = 'list'
  selected.value = null
}

async function onStop(): Promise<void> {
  const r = selected.value
  if (!r || stopping.value || displayStateOf(r) !== 'running') return
  stopping.value = true
  try {
    await stopSubagent(props.sessionId, r.subagentId)
    // §6.20「已停止子代理 X」流内通知（回执成功点）；收敛 = 重拉清单（消费 runtime 侧状态收敛后的快照，§7.2 停止行）
    appendActionNotice(props.sessionId, t('mobile.notices.subagentStopped', { name: r.agent }))
    reloadList(props.sessionId)
  } catch (e) {
    console.warn('[SubagentSheet] subagent cancel failed:', e)
    showErrorBar(t('mobile.subagent.stopFailed'))
  } finally {
    stopping.value = false
  }
}

/** 详情元信息行（label/value 对；字段缺省不渲染行——无信号来源的字段不显示） */
const detailMeta = computed(() => {
  const r = selected.value
  if (!r) return []
  const rows: Array<{ label: string; value: string }> = []
  rows.push({ label: t('mobile.subagent.metaAgent'), value: r.agent })
  if (r.model) rows.push({ label: t('mobile.subagent.metaModel'), value: r.model })
  if (r.thinkingLevel) rows.push({ label: t('mobile.subagent.metaThinking'), value: r.thinkingLevel })
  if (r.turns !== undefined) rows.push({ label: t('mobile.subagent.metaTurns'), value: String(r.turns) })
  if (r.totalTokens !== undefined) rows.push({ label: t('mobile.subagent.metaTokens'), value: String(r.totalTokens) })
  if (r.elapsedSeconds !== undefined) rows.push({ label: t('mobile.subagent.metaElapsed'), value: `${r.elapsedSeconds}s` })
  return rows
})

/** 历史行状态图标语义（消息三态 → 显示词；步骤列表的「跑到哪」判据） */
function historyStatusLabel(m: MobileSubagentHistoryMessage): string {
  if (m.status === 'streaming') return t('mobile.subagent.historyStreaming')
  if (m.status === 'error') return t('mobile.subagent.historyError')
  return t('mobile.subagent.historyDone')
}

const sheetTitle = computed(() =>
  stage.value === 'detail' && selected.value
    ? displayName(selected.value)
    : t('mobile.subagent.listTitle'),
)

function onClose(): void {
  emit('close')
}
</script>

<template>
  <Sheet
    :open="open"
    :title="sheetTitle"
    @update:open="!$event && onClose()"
  >
    <!-- ── 列表态 ── -->
    <div v-if="stage === 'list'" class="flex flex-col gap-1" data-testid="subagent-sheet-list">
      <p
        v-if="oversize"
        class="rounded bg-surface-hover px-2.5 py-1.5 text-[length:var(--m-text-sub)] text-warn"
        data-testid="subagent-sheet-oversize"
      >
        {{ t('mobile.subagent.oversize') }}
      </p>
      <Button
        v-for="r in records"
        :key="r.subagentId"
        variant="ghost"
        :data-testid="`subagent-sheet-item-${r.subagentId}`"
        class="min-h-[var(--m-tap)] items-center gap-2 rounded px-2.5 py-2"
        :class="displayStateOf(r) === 'running' ? 'bg-surface-2' : ''"
        @click="openDetail(r)"
      >
        <span
          class="size-2 shrink-0 rounded-full"
          :class="[
            displayStateOf(r) === 'running' ? 'animate-pulse bg-accent motion-reduce:animate-none' : '',
            displayStateOf(r) === 'failed' ? 'bg-danger' : '',
            displayStateOf(r) === 'ended' ? 'bg-border-strong' : '',
          ]"
        />
        <span class="min-w-0 flex-1 text-left">
          <span class="block truncate text-[length:var(--m-text-sub)] text-neutral-fg">{{ displayName(r) }}</span>
          <span v-if="displayStateOf(r) === 'failed'" class="block truncate text-[length:var(--m-text-sub)] text-danger">{{ r.error }}</span>
        </span>
        <span
          class="shrink-0 text-[length:var(--m-text-sub)]"
          :class="displayStateOf(r) === 'running' ? 'text-accent' : displayStateOf(r) === 'failed' ? 'text-danger' : 'text-neutral-mid'"
        >{{ stateLabelOf(r) }}</span>
      </Button>
      <p
        v-if="loaded && !oversize && records.length === 0"
        class="py-2 text-center text-[length:var(--m-text-sub)] text-neutral-mid"
        data-testid="subagent-sheet-empty"
      >
        {{ t('mobile.subagent.empty') }}
      </p>
    </div>

    <!-- ── 详情态 ── -->
    <div v-else-if="selected" class="flex flex-col gap-2" data-testid="subagent-sheet-detail">
      <!-- 两态/失败状态行 -->
      <div class="flex items-center gap-2">
        <span
          class="size-2 rounded-full"
          :class="[
            displayStateOf(selected) === 'running' ? 'animate-pulse bg-accent motion-reduce:animate-none' : '',
            displayStateOf(selected) === 'failed' ? 'bg-danger' : '',
            displayStateOf(selected) === 'ended' ? 'bg-border-strong' : '',
          ]"
          data-testid="subagent-sheet-detail-state-dot"
        />
        <span
          class="text-[length:var(--m-text-sub)]"
          :class="displayStateOf(selected) === 'failed' ? 'text-danger' : displayStateOf(selected) === 'running' ? 'text-accent' : 'text-neutral-mid'"
          data-testid="subagent-sheet-detail-state"
        >{{ stateLabelOf(selected) }}</span>
      </div>
      <p v-if="selected.error" class="break-words rounded bg-danger-soft px-2.5 py-1.5 text-[length:var(--m-text-sub)] text-danger" data-testid="subagent-sheet-detail-error">
        {{ selected.error }}
      </p>

      <!-- 头部元信息（SubagentRecord 既有字段；缺省字段不渲染行） -->
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded bg-surface-2 px-2.5 py-2" data-testid="subagent-sheet-detail-meta">
        <template v-for="row in detailMeta" :key="row.label">
          <dt class="text-[length:var(--m-text-sub)] text-neutral-mid">{{ row.label }}</dt>
          <dd class="break-all text-[length:var(--m-text-sub)] text-neutral-fg">{{ row.value }}</dd>
        </template>
      </dl>

      <!-- 执行记录 = 最近历史消息派生（§6.10，N≈8 窗口） -->
      <p class="text-[length:var(--m-text-sub)] font-medium text-neutral-fg">{{ t('mobile.subagent.historyTitle') }}</p>
      <p v-if="historyLoading" class="text-[length:var(--m-text-sub)] text-neutral-mid">{{ t('mobile.subagent.historyLoading') }}</p>
      <div v-else class="flex flex-col gap-1" data-testid="subagent-sheet-history">
        <div
          v-for="m in history"
          :key="m.id"
          :data-testid="`subagent-sheet-history-${m.id}`"
          class="flex gap-2 rounded bg-surface-2 px-2.5 py-1.5"
        >
          <span class="shrink-0 text-[length:var(--m-text-sub)] text-neutral-mid">{{ m.role === 'user' ? t('mobile.subagent.historyUser') : t('mobile.subagent.historyAssistant') }}</span>
          <span class="min-w-0 flex-1 truncate text-[length:var(--m-text-sub)] text-neutral-fg">{{ m.text }}</span>
          <span
            class="shrink-0 text-[length:var(--m-text-sub)]"
            :class="m.status === 'error' ? 'text-danger' : m.status === 'streaming' ? 'text-accent' : 'text-neutral-mid'"
          >{{ historyStatusLabel(m) }}</span>
        </div>
        <p v-if="history.length === 0" class="py-1 text-center text-[length:var(--m-text-sub)] text-neutral-mid">
          {{ t('mobile.subagent.historyEmpty') }}
        </p>
      </div>
    </div>

    <template #footer>
      <!-- 返回（详情态在左） -->
      <Button v-if="stage === 'detail'" variant="ghost" data-testid="subagent-sheet-back" @click="backToList">
        {{ t('mobile.subagent.backToList') }}
      </Button>
      <!-- 停止（详情态 + running 可用；destructive 档，spec §6.1 破坏动作） -->
      <Button
        v-if="stage === 'detail' && selected && displayStateOf(selected) === 'running'"
        variant="destructive"
        data-testid="subagent-sheet-stop"
        :disabled="stopping"
        @click="onStop"
      >
        {{ t('mobile.subagent.stop') }}
      </Button>
      <Button variant="quiet" data-testid="subagent-sheet-close" @click="onClose">
        {{ t('common.close') }}
      </Button>
    </template>
  </Sheet>
</template>
