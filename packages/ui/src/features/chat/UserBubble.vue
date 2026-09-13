<template>
  <!--
    UserBubble：用户气泡（展示态/编辑态 + skill/file/image badge + hover actions）。
    从 Turn.vue 拆出。emit edit-state-change 通知父组件（MessageStream.onEditStateChange 按 turnKey 身份持有钉扎状态）。
  -->
  <!-- user 区：编辑态切 textarea，展示态气泡 + hover actions -->
  <div class="group/user flex flex-col items-end gap-1">
    <!-- 编辑态：编辑后 fork 新会话 -->
    <div
      v-if="isEditingThisUser"
      class="w-full max-w-[85%] min-w-0 break-words rounded-[14px] border border-accent bg-bg-input p-2 shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_22%,transparent)]"
    >
      <Textarea v-model="draftText" class="min-h-[64px] border-0 bg-transparent px-1 text-[length:var(--text-base)] leading-[1.55] focus-visible:ring-0" />
      <div class="mt-1.5 flex items-center justify-between px-1">
        <span class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.message.editAfterReplace') }}</span>
        <div class="flex gap-1.5">
          <Button variant="ghost" size="sm" class="h-7" @click="cancelEdit">{{ t('panel.message.cancel') }}</Button>
          <Button variant="default" size="sm" class="h-7 gap-1" :disabled="!draftText.trim()" @click="submitEdit">
            <ArrowRight class="size-3.5" /> {{ t('panel.composer.send') }}
          </Button>
        </div>
      </div>
    </div>
    <!-- 展示态气泡 -->
    <div
      v-else
      class="flex items-start justify-end gap-2"
    >
      <!-- 用户时刻（气泡左侧） -->
      <span v-if="turn.user?.timestamp" class="shrink-0 self-start pt-1.5 font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums" data-testid="user-timestamp">
        {{ formatClock(turn.user.timestamp) }}
      </span>
      <div
        class="max-w-[85%] min-w-0 break-words rounded-[14px_14px_4px_14px] border border-border-strong bg-[var(--bubble-bg)] px-[13px] py-[9px] text-[length:var(--text-base)] leading-[1.55] text-neutral-fg"
        :class="{ 'is-mixed': isMixedContent }"
      >
      <template v-for="(seg, i) in orderedSegments" :key="i">
        <!-- slash 段与后继段之间的边界空格：slash 段按纯文本渲染（D4-d，无 badge、
             无 mr-1 间距），空格必须显式渲染才与 segmentsToText 产物逐字一致。规则复用
             shared 的 needsBoundarySpace（单点实现），仅对 prev 为 slash 时渲染——其余
             badge 类型沿用自身 mr-1 间距，不引入额外文本节点。 -->
        <span v-if="boundarySpaceBefore(i)">{{ ' ' }}</span>
        <!-- slash 段（命令 chip 段，D4-b）：D4-d 无 badge 还原需求 → 纯文本 `/name`
             渲染（与 reload 侧 textToSegments(归位文本) 同形，live ≡ reload） -->
        <span v-if="seg.type === 'slash'">{{ '/' + seg.name }}</span>
        <span
          v-else-if="seg.type === 'skill'"
          class="mr-1 inline-flex cursor-pointer items-center gap-1 rounded-sm bg-[var(--reasoning-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-reasoning transition-colors hover:bg-[color-mix(in_oklch,var(--reasoning)_32%,transparent)]"
          style="vertical-align: middle"
          role="button"
          tabindex="0"
          :title="t('panel.message.viewCommandDoc')"
          @click.stop="openCommandDoc(`/skill:${seg.name}`)"
          @keydown.enter.stop.prevent="openCommandDoc(`/skill:${seg.name}`)"
          @keydown.space.stop.prevent="openCommandDoc(`/skill:${seg.name}`)"
        >
          <component :is="SLASH_ICON_COMPONENTS.star" class="size-[12px] shrink-0" />
          <span>{{ seg.name }}</span>
        </span>
        <span
          v-else-if="seg.type === 'file'"
          class="mr-1 inline-flex cursor-pointer items-center gap-1 rounded-sm bg-[var(--success-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-success transition-colors hover:bg-[color-mix(in_oklch,var(--success)_32%,transparent)]"
          style="vertical-align: middle"
          role="button"
          tabindex="0"
          :data-testid="`msg-file-badge-${i}`"
          :title="seg.path"
          @click.stop="openFileDetail(seg.path)"
          @keydown.enter.stop.prevent="openFileDetail(seg.path)"
          @keydown.space.stop.prevent="openFileDetail(seg.path)"
        >
          <FileText class="size-[12px] shrink-0" />
          <span>{{ fileBasename(seg.path) }}{{ formatLineRange(seg.lineRange) }}</span>
        </span>
        <ImageThumb
          v-else-if="seg.type === 'image'"
          :path="seg.path"
          :display-name="seg.displayName"
        />
        <!-- session 引用段（四符号 # session，U1）：chip 徽标显示 label（人可读标题），
             title 悬浮 sessionId。色系 --warn 金（与 composer mention-session chip 同源）。
             TODO(U2b 后续)：点击跳转该 session——本期最小实现仅显示 label，不加推测功能。 -->
        <span
          v-else-if="seg.type === 'session'"
          class="mr-1 inline-flex items-center gap-0.5 rounded-sm bg-[var(--warn-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-warn"
          style="vertical-align: middle"
          :data-testid="`msg-session-badge-${i}`"
          :title="seg.sessionId"
        >
          <span>#</span><span>{{ seg.label }}</span>
        </span>
        <!-- subagent 定向段（四符号 @，U1）：@slug 徽标作「去向标记」（该段序列化为空串，
             仅在含 subagent 段的用户消息气泡中标示消息去向）。色系 accent（与 composer
             mention-at chip 同源）。 -->
        <span
          v-else-if="seg.type === 'subagent'"
          class="mr-1 inline-flex items-center gap-0.5 rounded-sm bg-[var(--accent-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-accent"
          style="vertical-align: middle"
          :data-testid="`msg-subagent-badge-${i}`"
        >
          <span>@</span><span>{{ seg.slug }}</span>
        </span>
        <MarkdownRenderer v-else-if="seg.type === 'text' && seg.text" :content="seg.text" :session-id="sessionId" />
      </template>
      <MarkdownRenderer v-if="!userSegments.length && typeof turn.user?.content === 'string'" :content="turn.user!.content" :session-id="sessionId" />
      </div>
    </div>
    <!-- hover actions：复制常驻 hover；编辑仅 AI 停止（非活跃态）时显示。 -->
    <div
      v-if="!isEditingThisUser"
      class="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 group-focus-within/user:opacity-100"
    >
      <Button
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.message.copy')"
        @click="copy(normalizeContent(turn.user!.content), userCopyKey)"
      >
        <Check v-if="copied === userCopyKey" class="size-3 text-success" />
        <Copy v-else class="size-3" />
      </Button>
      <Button
        v-if="canEdit && !isSessionEditable"
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.message.editReplace')"
        @click="startEdit"
      >
        <Pencil class="size-3" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, Copy, FileText, Pencil } from '@lucide/vue'
// primitives 直接路径（不经 @xyz-agent/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { Textarea } from '../../primitives/textarea'
import { turnStableId } from '@xyz-agent/core/domain/chat'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { Segment } from '@xyz-agent/shared'
import { normalizeContent, needsBoundarySpace, normalizeSegmentOrder } from '@xyz-agent/shared'
import { rebuildSegmentsWithEditedText } from '../../lib/segment-rebuild'
import { useCopy } from './composables/useCopy'
import { formatClock } from './format-utils'
import { SLASH_ICON_COMPONENTS } from './slash-icons'
import { useChatViewDeps } from './chat-view-deps'
import ImageThumb from './ImageThumb.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    sessionId: string
    canEdit?: boolean
    isSessionEditable?: boolean
  }>(),
  { canEdit: false, isSessionEditable: false },
)

const emit = defineEmits<{
  // D2：turnKey = turnStableId(turn)，编辑身份由事件源携带——父组件不再把数组索引
  // 快照当钉扎状态（virtua keepMounted 越界崩溃根因），改为按稳定身份反查当前索引。
  // 本组件只渲染有 user 的 turn，实际恒取 turn.user.id，但仍走 turnStableId 保持
  // 与渲染层 renderKey 单一身份口径。
  'edit-state-change': [{ editing: boolean; turnKey: string }]
}>()

const { t } = useI18n()
const { editAndResend, openDrawer, onFileClick, isPendingSend } = useChatViewDeps()

/** 点击 skill badge → 打开 drawer Doc tab */
function openCommandDoc(commandName: string): void {
  openDrawer('doc', { commandName })
}

/** 点击 file badge → 打开 drawer Detail tab */
function openFileDetail(path: string): void {
  onFileClick(path)
  openDrawer('detail', { filePath: path })
}

/** file badge 行范围后缀 */
function formatLineRange(lineRange?: [number, number]): string {
  if (!lineRange) return ''
  const [s, e] = lineRange
  return s === e ? `:L${s}` : `:L${s}-L${e}`
}

/** file badge 显示名：路径末段 */
function fileBasename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** user message 的 content segments */
const userSegments = computed<Segment[]>(() => {
  const content = props.turn.user?.content
  if (Array.isArray(content)) return content
  return []
})

/**
 * [D12] 混排判定：段序同时含 text 段与非 text 段（badge/slash 等一切非 text 段）时为
 * 混排消息——badge 是 inline span、text 段经 MarkdownRenderer 渲染为块级（.md-render div
 * + markdown-it <p>），块级边界使 badge 前后必然换行；此时气泡容器加 is-mixed 修饰 class
 * 启用 inline 化渲染（见文件底部 scoped CSS）。纯 text 消息（无非 text 段）与纯 badge
 * 消息（无 text 段）均不算混排，不加 class——复杂块级 markdown 排版完全不受影响。
 */
const isMixedContent = computed(() => {
  let hasText = false
  let hasNonText = false
  for (const seg of orderedSegments.value) {
    if (seg.type === 'text') hasText = true
    else hasNonText = true
  }
  return hasText && hasNonText
})

/**
 * 展示序 = 归位序（slash 段提首），复用 shared 的 normalizeSegmentOrder 单一实现。
 * live content 段序是 DOM 序（命令 chip 就地插，D4-a），reload 侧是 textToSegments(归位文本)
 * 的单 text 段；只有按归位序渲染，live 与 reload 的可见文本才逐字一致（关键规则 9）。
 */
const orderedSegments = computed<Segment[]>(() => normalizeSegmentOrder(userSegments.value))

/**
 * 第 i 段之前是否需显式渲染一个边界空格（与 segmentsToText 同规则，避免第二份实现）。
 * 仅 prev 为 slash 时渲染：slash 段无 badge 的 mr-1 间距，其余 badge→text 边界沿用 mr-1，
 * 不额外插文本节点（保持既有视觉）。
 */
function boundarySpaceBefore(i: number): boolean {
  const prev = orderedSegments.value[i - 1]
  const seg = orderedSegments.value[i]
  if (!prev || !seg || prev.type !== 'slash') return false
  return needsBoundarySpace(prev, seg)
}

/** 复制反馈 */
const { copied, copy } = useCopy()
const userCopyKey = computed(() => `user-${props.turn.user?.id ?? props.turn.index}`)

/* ── 编辑（= fork）：编辑 user 消息后 fork 新会话 ── */
const editingUserId = ref<string | null>(null)
const draftText = ref('')
const isEditingThisUser = computed(
  () => !!props.turn.user && editingUserId.value === props.turn.user.id,
)

watch(isEditingThisUser, (editing) => {
  emit('edit-state-change', { editing, turnKey: turnStableId(props.turn) })
})

// D3 卸载清理（谁置位谁清理）：切 session / 数据换血等路径卸载本组件时，编辑态
// 的解除只能在这里发——watch 随组件作用域失效不再触发，cancelEdit/submitEdit 两个
// 显式动作也不会执行。缺此清理会让父组件钉扎状态残留，keepMounted 越界渲染崩溃
// （编辑身份改为 turnKey 反查后此 emit 是反查失效的信号源）。
// C2 实测（happy-dom + @vue/test-utils 2.4.11）：onUnmounted 内 emit 父监听器
// 仍可达，wrapper.emitted 能收到该条记录——无需降级 onBeforeUnmount。
onUnmounted(() => {
  if (editingUserId.value !== null) {
    emit('edit-state-change', { editing: false, turnKey: turnStableId(props.turn) })
  }
})

function startEdit(): void {
  if (!props.turn.user) return
  editingUserId.value = props.turn.user.id
  // 回填 normalizeContent 归位全文是登记过的近似路径（composer-chip-insertion-semantics D6 +
  // composer-multi-skill-injection §3.5-⑤）：
  // ① 归位全文让命令在编辑稿中可见可改——提交侧「剥离与保留段重复的前缀命令」语义以此为前提；
  // ② 含 skill/slash 段的消息在编辑框显示序列化标记文本而非 chip——视觉退化按原样接受，
  //    「从 Segment[] 重建 chip」的完整优化项经评估延期未实施（重审条件 = 用户反馈编辑重发体验）。
  // 坑：勿在此做「标记文本还原成 chip」的局部修复——提交侧 segment-rebuild 已按「剥离与保留段
  // 重复的序列化文本」收口防标记翻倍，回填侧另造一套还原会形成两套口径。
  draftText.value = normalizeContent(props.turn.user.content)
}

function cancelEdit(): void {
  editingUserId.value = null
}

async function submitEdit(): Promise<void> {
  const user = props.turn.user
  if (!user) return
  const text = draftText.value.trim()
  if (!text) return
  // [D3] 双发锁：提交在途（send 或上一次 editAndResend 的 pendingSend 瞬时态）时直接
  // return 忽略——与 Composer isSending 语义对齐，防 editAndResend 与 send 并发覆盖
  // useChat 的 pendingDirectSends（per-sid 单条 Map，后写覆盖前写致 rejected 帧误回滚）。
  // 早退置于 editingUserId=null 之前：编辑态保持、草稿不丢，用户可在提交收口后重试。
  // （isPendingSend 经 ChatViewDeps 注入，旧壳层未 provide 时不互斥，兼容降级）
  if (isPendingSend?.(props.sessionId)) return
  editingUserId.value = null
  const segments = rebuildSegmentsWithEditedText(user.content, text)
  await editAndResend(props.sessionId, user.id, segments)
}
</script>

<style scoped>
/* [D12] 混排内联渲染：仅 is-mixed 气泡（同时含 text 段与非 text 段，见 isMixedContent）生效。
   text 段的 MarkdownRenderer 根 .md-render、其内部段容器 div、markdown-it <p> 均为块级，
   与 inline badge 之间形成块级边界 → badge 前后必然换行；置为 inline 后 badge 与正文同流。
   纯 text 消息不加 is-mixed，标题/列表/表格/代码块等复杂块级排版不受影响；混排消息的
   复杂块级 markdown 排版退化为 inline 流是 D12 已接受代价（设计 §3.3 D12）。 */
.is-mixed :deep(.md-render),
.is-mixed :deep(.md-render > div),
.is-mixed :deep(.md-render p) {
  display: inline;
}
/* inline 流中相邻段落间不再有块级换行，以首段外后续段落的 ::before '\a'
   （换行符 + white-space:pre 使其实际断行）补偿段落边界。 */
.is-mixed :deep(.md-render p + p)::before {
  content: '\a';
  white-space: pre;
}
</style>
