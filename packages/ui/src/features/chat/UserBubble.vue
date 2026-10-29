<template>
  <!--
    UserBubble：用户气泡（展示态/编辑态 + skill/file/image badge + hover actions）。
    从 Turn.vue 拆出。emit edit-state-change 通知父组件（MessageStream.onEditStateChange 按 turnKey 身份持有钉住状态）。
  -->
  <!-- user 区：编辑态 = 简化版 composer（富编辑器经 ChatViewDeps.editComposerRenderer 注入，
       见 chat-view-deps 契约；未注入的宿主回退纯 Textarea 编辑器）；展示态气泡 + hover actions。
       hover actions = 气泡下方流内固定槽位（mt-1 + h-6 常驻行，opacity 淡入淡出——2026-10 用户裁决：
       按钮在气泡框外下方固定位置，不在气泡内部；悬浮区内 hover 经 DOM 祖先传递保持 group/user
       悬停态，按钮可达）。槽位常驻使气泡→轮头距离 = mt-1(4) + 24 + 轮 gap(12) ≈ 40px
       （原 12px 紧凑档的成本，据此裁决接受）。 -->
  <div class="group/user relative flex flex-col items-end">
    <!-- 编辑态：编辑后 fork 新会话。外层容器只管宽度纪律（N3：气泡→编辑器等宽过渡不跳变），
         盒子视觉由两条分支各自承载（富编辑器 = 原编辑态壳视觉 accent 边 + ring；回退 = 同款壳）。 -->
    <div
      v-if="isEditingThisUser"
      class="w-full max-w-[min(72%,64ch)] min-w-0 [overflow-wrap:anywhere]"
    >
      <!-- 富编辑器路径（editComposerRenderer 注入）：简化版 composer——ComposerInput
           （contenteditable：slash chip + @/#/$ 引用 chip + image chip）+ CommandPopover
           四符号候选浮层，无 + 按钮 / 底栏左簇 / 右簇。提交经 @submit 回传 segments。 -->
      <component
        :is="chatViewDeps.editComposerRenderer"
        v-if="chatViewDeps.editComposerRenderer"
        :session-id="sessionId"
        :message-id="turn.user!.id"
        :segments="editSegments"
        :disabled="isPendingSend(sessionId)"
        @submit="onEditorSubmit"
        @cancel="cancelEdit"
      />
      <!-- 回退路径（测试 mock 壳 / 移动壳未注入）：纯 Textarea 编辑器。行为与富编辑器
           提交链同构（双发锁早退 + rebuild 启发式重建 segments），存量测试锁此路径。 -->
      <div
        v-else
        class="rounded-[14px] border border-accent bg-bg-input p-2 shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_22%,transparent)]"
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
    </div>
    <!-- 展示态气泡（group/ts 命名分组：用户时刻悬挂气泡上方右侧，悬停该行 / 键盘焦点进入
         该行时刻才显现——D2 四处时刻槽悬停化之一；悬挂位 = demo .user-bubble .ts
         （right 10px / top -22px，workbench.css），非首轮悬挂进上一轮 20px 边界留白） -->
    <!-- 行 self-stretch：行是 items-end 列里的收缩适配（shrink-to-fit）flex item，其内在宽度
         反由气泡的内容贡献决定，而气泡 max-width 又是行宽的 72%——循环依赖下 Chromium 解出
         的行宽会把气泡压得比内容单行自然宽更窄，造成无谓折行（「删除 Installer」被折成
         删除/installe/r，headless 复现实测气泡 118.4px < 自然宽 120px）。行占满列宽后
         百分比有了确定基准，气泡恢复内容自适应；demo 无此问题因 .user-row 是块级全宽 flex。 -->
    <div
      v-else
      class="group/ts relative flex items-start justify-end self-stretch"
    >
      <!-- 用户时刻（悬挂气泡上方右侧，demo .user-bubble .ts） -->
      <span v-if="turn.user?.timestamp" class="absolute -top-[22px] right-[10px] font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/ts:opacity-100 group-focus-within/ts:opacity-100" data-testid="user-timestamp">
        {{ formatClock(turn.user.timestamp) }}
      </span>
      <!-- N3 宽度纪律（设计决策 8）：desktop max-width min(72%, 64ch) 双约束——窄窗按容器 72% 收，
           宽窗按 64ch 封顶防长行拉伸；mobile 档（remote-use-mobile-v2 §6.2）= 82% + 右下角 6px
           （rounded-br-sm = 预设 6px 档）。overflow-wrap: anywhere（替代 break-words）让无空格
           长令牌可折行，编辑态气泡同宽同纪律。
           气泡形态（M3a demo 权威，workbench.css .user-bubble）：--bubble-bg 底 + hairline
           边框 + 12px 统一圆角（--radius-lg）+ 15px/10px 内边距 + 15px 字号（--text-md）
           1.7 行高。
           档位类整串 computed 切换（同属性类并存会落样式表序裁决——button-variants 同律注释，
           追加不构成可靠覆盖）；desktop 分支 = 原静态串逐字一致（快照用例锁）。 -->
      <div
        :class="[bubbleClass, { 'is-mixed': isMixedContent }]"
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
    <!-- hover actions：复制常驻 hover；编辑仅 AI 停止（非活跃态）时显示；撤回单入口（D6，路由判定在 core）。
         vid 视图（isVidView，subagent/agentcall 快照）只读：编辑与撤回入口整体不渲染——动作类
         RPC 被 vid 门拒绝（shared vid-rpc-gate），复制是本地动作保留。
         流内固定槽位（2026-10 用户裁决）：常驻于气泡行下方（mt-1 + h-6），不占气泡内部、
         不悬浮遮挡轮头；显隐走 opacity 零布局跳动（槽位恒在，悬停/键盘焦点才可命中——
         pointer-events 默认 none 消除「隐形按钮拦截点击」形态）。mobile 密度档例外：触屏
         无 hover，actions 常显（opacity-100 + pointer-events-auto，§6.2 撤回按钮常显），
         desktop 类串逐字不变（见 actionsClass）。DOM 序在气泡行之后 =
         「下方固定位置」的结构保证（测试锁 .group/user > [data-testid=user-bubble-actions]
         晚于 .group/ts 出现）。 -->
    <div
      v-if="!isEditingThisUser"
      data-testid="user-bubble-actions"
      :class="actionsClass"
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
        v-if="canEdit && !isSessionEditable && !isVidView"
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.message.editReplace')"
        @click="startEdit"
      >
        <Pencil class="size-3" />
      </Button>
      <!-- [U5 消息撤回 D6] 撤回按钮：生成中（isActive 置灰 + tooltip，D2 附带裁决）用伪禁用
           （aria-disabled + click 检查）而非 disabled attribute——disabled 元素不触发 hover，
           tooltip 会被一并吞掉。vid 视图（isVidView）不渲染——isActive(vid) 恒 false 使置灰
           判据失效恒可点，点击必被 vid 门拒绝。 -->
      <Button
        v-if="!isVidView"
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim"
        :class="isRevokeDisabled ? 'cursor-not-allowed opacity-40' : 'hover:text-neutral-fg'"
        :aria-disabled="isRevokeDisabled"
        data-testid="msg-revoke-button"
        :title="isRevokeDisabled ? t('panel.message.revokeGenerating') : t('panel.message.revoke')"
        @click="onRevokeClick"
      >
        <Undo2 class="size-3" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, Copy, FileText, Pencil, Undo2 } from '@lucide/vue'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会封住一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { Textarea } from '../../primitives/textarea'
import { turnStableId } from '@taiji/core/domain/chat'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { Segment } from '@taiji/shared'
import { isAgentCallVirtualId, isSubagentVirtualId, normalizeContent, needsBoundarySpace, normalizeSegmentOrder, segmentsToText, textToSegments } from '@taiji/shared'
import { rebuildSegmentsWithEditedText } from '../../lib/segment-rebuild'
import { useCopy } from './composables/useCopy'
import { formatClock } from './format-utils'
import { SLASH_ICON_COMPONENTS } from './slash-icons'
import { useChatViewDeps, useChatDensity } from './chat-view-deps'
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
  // 快照当钉住状态（virtua keepMounted 越界崩溃根因），改为按稳定身份反查当前索引。
  // 本组件只渲染有 user 的 turn，实际恒取 turn.user.id，但仍走 turnStableId 保持
  // 与渲染层 renderKey 单一身份口径。
  'edit-state-change': [{ editing: boolean; turnKey: string }]
}>()

const { t } = useI18n()
const chatViewDeps = useChatViewDeps()
const { editAndResend, openDrawer, onFileClick, isPendingSend } = chatViewDeps

/**
 * vid 视图判定（subagent 三段式 / agentcall 两段式，谓词 SSOT 在 shared）：vid 只是前端
 * 路由 key，对话流为只读快照——编辑重发 / 撤回是动作类 RPC，会被 vid 门拒绝
 * （shared vid-rpc-gate），入口裁剪在本组件单点完成（MessageStream 传 vid 无需上游各自判）。
 */
const isVidView = computed(
  () => isSubagentVirtualId(props.sessionId) || isAgentCallVirtualId(props.sessionId),
)

/** 密度档（§6.2）：setup 期一次 inject */
const density = useChatDensity()

/**
 * 展示态气泡类串（§6.2 密度维度，整串切换防同属性类并存）：
 * desktop 分支 = 原静态类串逐字一致（缺省桌面路径字节不变，快照用例锁）；
 * mobile 分支 = max 82% + 右下角 6px（rounded-br-sm），其余形态不变。
 */
const bubbleClass = computed(() =>
  density === 'mobile'
    ? 'user-bubble-md max-w-[82%] min-w-0 [overflow-wrap:anywhere] rounded-lg rounded-br-sm border border-hairline bg-[var(--bubble-bg)] px-[15px] py-[10px] text-[length:var(--text-md)] leading-[1.7] text-neutral-fg'
    : 'user-bubble-md max-w-[min(72%,64ch)] min-w-0 [overflow-wrap:anywhere] rounded-lg border border-hairline bg-[var(--bubble-bg)] px-[15px] py-[10px] text-[length:var(--text-md)] leading-[1.7] text-neutral-fg',
)

/**
 * actions 容器类串（§6.2 撤回按钮常显）：desktop 分支 = 原静态类串逐字一致（悬停/键盘
 * 焦点显隐，缺省桌面路径字节不变）；mobile 分支 = 触屏无 hover，opacity-100 +
 * pointer-events-auto 常驻可命中。
 */
const actionsClass = computed(() =>
  density === 'mobile'
    ? 'mt-1 flex h-6 items-center gap-0.5 opacity-100 pointer-events-auto transition-opacity duration-[var(--duration-fast)]'
    : 'mt-1 flex h-6 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-[var(--duration-fast)] group-hover/user:opacity-100 group-hover/user:pointer-events-auto group-focus-within/user:opacity-100 group-focus-within/user:pointer-events-auto',
)

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
 * 编辑回填用 segments（user-bubble-edit-composer）：array content 原样透传；**string
 * content（reload 侧单文档态）补 text 段**——富编辑器 setSegments 只认 Segment[]，
 * 直传 userSegments（string 态恒 []）会把原文丢成空编辑框。textToSegments 是 shared
 * 单点（纯文本 → 单 text 段），不在此复制。
 */
const editSegments = computed<Segment[]>(() => {
  const content = props.turn.user?.content
  if (Array.isArray(content)) return content
  return typeof content === 'string' ? textToSegments(content) : []
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

/* ── [U5 消息撤回 D6] 撤回单入口：UI 透传 targetId，路由判定（在途 cancel / 已送达回退）
      只在 core useChat.revokeMessage 单点（内核派生视图复核分派）；UI 仅用 isActive 谓词做
      展示态（生成中置灰 + tooltip）。 ── */

/** 撤回 targetId = 消息 id 原样（live 态 `u-<uuid>` clientUuid / 基线重开态 pi entryId，形态分派在 runtime） */
const revokeTargetId = computed(() => props.turn.user?.id ?? null)

/**
 * 生成中置灰（D2 附带裁决）：isActive = isGenerating ∨ pendingSend 的保守超集——撤回编排
 * 前置 = session 空闲，提交在途的空窗同样拦截（比 isGenerating 严一档，防撤回撞 turn 开启）。
 */
const isRevokeDisabled = computed(() => chatViewDeps.isActive(props.sessionId))

/** 撤回点击：生成中检查（伪禁用兜底）→ 单回调透传，路由分派在 core */
function onRevokeClick(): void {
  const id = revokeTargetId.value
  if (!id || isRevokeDisabled.value) return
  chatViewDeps.onRevokeMessage(props.sessionId, id)
}

/* ── 编辑（= fork）：编辑 user 消息后 fork 新会话 ── */
const editingUserId = ref<string | null>(null)
const draftText = ref('')
// isVidView 参与：vid 下编辑入口已裁剪，editingUserId 理论不可被置位——此处兜住
// 「置位残留 + sessionId 变为 vid」的极端序列，保证 vid 视图永不渲染编辑器（防御一致性）。
const isEditingThisUser = computed(
  () => !isVidView.value && !!props.turn.user && editingUserId.value === props.turn.user.id,
)

watch(isEditingThisUser, (editing) => {
  emit('edit-state-change', { editing, turnKey: turnStableId(props.turn) })
})

// D3 卸载清理（谁置位谁清理）：切 session / 数据换血等路径卸载本组件时，编辑态
// 的解除只能在这里发——watch 随组件作用域失效不再触发，cancelEdit/submitEdit 两个
// 显式动作也不会执行。缺此清理会让父组件钉住状态残留，keepMounted 越界渲染崩溃
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
  // 重复的序列化文本」收尾防标记翻倍，回填侧另造一套还原会形成两套口径。
  // [user-bubble-edit-composer] draftText 现只服务回退路径（未注入 editComposerRenderer 的
  // 宿主）：富编辑器路径自带 setSegments 真 chip 还原，草稿真源在编辑框 DOM 内，不经本 ref。
  draftText.value = normalizeContent(props.turn.user.content)
}

function cancelEdit(): void {
  editingUserId.value = null
}

/**
 * 富编辑器提交（editComposerRenderer 注入路径）：编辑框产出真 segments（chip 即段，
 * 无序列化标记文本）→ 直提 editAndResend，与主 composer send 同契约（core useChat
 * editAndResend 签名即 Segment[]；segmentsToText 内部 slash 归位，chip 在 DOM 尾部也
 * 序列化到行首，提交顺序无虞）。
 * 与回退路径 submitEdit 同一收尾链：
 * ① 空稿检查（segmentsToText 序列化 trim 为空 = 无可提交内容 → 保持编辑态不收尾）；
 * ② [D3] 双发锁早退（提交在途 → 忽略，编辑态保持、草稿不丢——与 submitEdit 同序）；
 * ③ editingUserId=null 收尾 → editAndResend（截断 + 重发）。
 */
function onEditorSubmit(segments: Segment[]): void {
  const user = props.turn.user
  if (!user) return
  if (!segmentsToText(segments).trim()) return
  if (isPendingSend(props.sessionId)) return
  editingUserId.value = null
  void editAndResend(props.sessionId, user.id, segments)
}

async function submitEdit(): Promise<void> {
  const user = props.turn.user
  if (!user) return
  const text = draftText.value.trim()
  if (!text) return
  // [D3] 双发锁：提交在途（send 或上一次 editAndResend 的 pendingSend 瞬时态）时直接
  // return 忽略——与 Composer isSending 语义对齐，防 editAndResend 与 send 并发覆盖
  // useChat 的 pendingDirectSends（per-sid 单条 Map，后写覆盖前写致 rejected 帧误回滚）。
  // 早退置于 editingUserId=null 之前：编辑态保持、草稿不丢，用户可在提交收尾后重试。
  if (isPendingSend(props.sessionId)) return
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
/* [MF-1-26] 气泡内 markdown 简化形态（demo workbench.css .user-bubble pre/table 权威，
   332-338）：pre = 无 header、无边框、padding 8px 10px、fs-md 档（--text-xs 12px）1.65
   行高、margin 6px 0 0、card-inset（--bg-input）底、r-md（--radius）圆角；table = 仅
   display:block + max-width:100% + overflow-x:auto——去外框/格线/表头底（demo 气泡表格
   是 UA 平形态，非正文 .mds 网格档）。img 限宽（demo :338）由 MarkdownRenderer img 规则
   已有（max-width:100% + height:auto），无需覆盖。
   选择器以 .md-render 中锚抬高特异性（恒压 MarkdownRenderer 同特异性规则，不依赖样式
   注入顺序）；不动共用渲染器 MarkdownRenderer 本体（其他消费点不受影响）。
   escape hatch：跨组件 :deep 宿主作用域特化。 */
.user-bubble-md :deep(.md-render .md-codeblock) {
  border: 0;
  border-radius: var(--radius);
  /* margin 归零（与下方 table 容器对称）：共享规则 margin:0.7em 0（MarkdownRenderer）在
     气泡内继续生效会使代码块上隙 ≈10.5px（BFC 不折叠）+ 内层 pre 6px ≈16.5px，demo 气泡
     pre 单层 margin 仅 6px 0 0（workbench.css:338）——上距由内层 pre 规则（:389）承担。 */
  margin: 0;
}
.user-bubble-md :deep(.md-render .md-codeblock__header) {
  display: none;
}
.user-bubble-md :deep(.md-render .md-codeblock pre.shiki) {
  margin: 6px 0 0;
  padding: 8px 10px;
  font-size: var(--text-xs);
  line-height: 1.65;
}
.user-bubble-md :deep(.md-render table) {
  border: 0;
  border-radius: 0;
  margin: 0;
}
.user-bubble-md :deep(.md-render th),
.user-bubble-md :deep(.md-render td) {
  border: 0;
}
.user-bubble-md :deep(.md-render th) {
  background: transparent;
}
</style>
