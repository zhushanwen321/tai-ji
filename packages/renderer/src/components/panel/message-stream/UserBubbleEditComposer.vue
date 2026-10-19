<!--
  split-justified: 用户气泡编辑态 = 简化版 composer（user-bubble-edit-composer）。输入范围五件
  （ComposerInput 富文本 + CommandPopover 四符号浮层 + 五路触发态机 + skill 候选源 + 键盘路由）
  与底部 Composer 同源复用，只裁掉 chrome（+ 按钮 / 底栏左簇 / 右簇 / staging / 草稿分区 /
  历史召回 / 拖拽落位）——「气泡框变成输入框」的富编辑器实现。经 ChatViewDeps.editComposerRenderer
  注入渲染（ui 的 UserBubble 只路由不实现；CommandPopover 深耦合 renderer stores，禁反向依赖）。
  与底部 Composer 的差异（裁剪清单，逐条对应「不显示」需求）：
  - 无 + 菜单（AddMenuPopover / onAddSelect）：附件与图片入口不走编辑态，引用一律经输入区
    符号触发（$ 文件 / # session / @ subagent / 行首 / 命令 / 空格后 / skill）；
  - 无底栏三簇（指标 / 模型+思考 / 发送位四态 / 托盘 / 插件 toolbar / 密度退化回路）；
  - 无 QueueBubble / Staging banner / ContextChipsBar（image chip 内联在 contenteditable 内，
    无独立管理行）/ 拖拽落位 / bash 豁免 / per-session 草稿分区 / ↑↓ 历史召回。
  保留：发送语义（⏎ 提交、⇧⏎ 换行、IME 组字放行——dom-core 免费提供）、exactMatch 直发
  （浮层内 ⏎ 精确命中 = 插 chip + 提交，与 Composer 同链）、双发锁的展示（disabled）。
  提交不回写本组件：emit('submit', segments) 交还 UserBubble（双发锁早退 + editAndResend
  收尾链在 ui 侧单点，契约见 chat-view-deps.ts EditComposerProps）。
-->
<template>
  <!-- 命令浮层：anchor = 编辑框盒子（slot），side=top 向上开、宽 = 盒宽（N3 min(72%,64ch)
       纪律内）；键盘主入口 = 组件自注册的 window capture（↑↓⏎TabEsc，activeElement 门识别源
       = 本框 ComposerInput）。 -->
  <CommandPopover
    ref="commandPopoverRef"
    v-model:open="cmdOpen"
    :type="cmdType"
    :session-id="sessionId"
    variant="panel"
    :project-skills="projectSkills"
    :global-skills="globalSkills"
    :selected-skill-names="selectedSkillNames"
    :query="popoverQuery"
    :shell-input-ref="shellInputHolder.ref"
    @select="onCmdSelect"
    @select-and-send="onSelectAndSend"
  >
    <!-- 编辑框壳：沿用原编辑态视觉（accent 边 + 3px ring + bg-bg-input + 14px 圆角 =
         「正在编辑」信号），两条编辑器路径（富编辑器 / Textarea 回退）同形。宽度纪律由父级
         UserBubble 外层容器承担（max-w-[min(72%,64ch)]），本组件不重复声明。 -->
    <div
      class="relative rounded-[14px] border border-accent bg-bg-input p-2 shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_22%,transparent)]"
      data-testid="user-bubble-edit-composer"
    >
      <!-- 输入区：contenteditable 富文本（slash chip + @/#/$ 引用 chip + image chip）。
           挂载即 setSegments(props.segments) 真 chip 还原（text/slash/skill/file/session/
           subagent/image 全覆盖，非序列化标记文本）；位置近似 = 尾部（restoreSegmentsIntoInput
           登记边界，序列化侧 slash 归位保证提交正确）。 -->
      <ComposerInput
        ref="inputRef"
        :placeholder="t('panel.composer.inputHint')"
        :disabled="disabled"
        :session-id="sessionId"
        @input="onInputChange"
        @keydown="onKeydown"
        @slash-trigger="onSlashTrigger"
        @skill-trigger="onSkillTrigger"
        @file-trigger="onFileTrigger"
        @session-trigger="onSessionTrigger"
        @subagent-trigger="onSubagentTrigger"
      />
      <!-- 底行：编辑语义提示 + 取消/提交（与 Textarea 回退路径同款按钮与 i18n key） -->
      <div class="mt-1.5 flex items-center justify-between px-1">
        <span class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.message.editAfterReplace') }}</span>
        <div class="flex gap-1.5">
          <Button variant="ghost" size="sm" class="h-7" data-testid="user-bubble-edit-cancel" @click="emit('cancel')">{{ t('panel.message.cancel') }}</Button>
          <Button variant="default" size="sm" class="h-7 gap-1" :disabled="!canSubmit" data-testid="user-bubble-edit-submit" @click="submit">
            <ArrowRight class="size-3.5" /> {{ t('panel.composer.send') }}
          </Button>
        </div>
      </div>
    </div>
  </CommandPopover>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight } from '@lucide/vue'
import type { Segment } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { ComposerInput } from '@taiji/ui/features/composer'
import CommandPopover from '../CommandPopover.vue'
import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import type { ShellInputInstance } from '@/composables/panel/composer-shell'
import { useProjectSkills, useGlobalSkills } from '@/composables/features/settings/useProjectSkills'
import { useSessionStore } from '@/stores/session'
import { provideComposerInputDeps } from '@/composables/panel/composer-input-deps'

/**
 * props 契约 = chat-view-deps.ts EditComposerProps（UserBubble 经 component :is 注入）。
 * - segments：原消息 segments，挂载整框回填为真 chip；
 * - disabled：isPendingSend 透传（双发锁的展示，语义同 Composer isSending）；
 * - messageId：编辑目标定位锚（ui 侧 editAndResend 消费），本组件仅用于目标变更重填。
 */
const props = withDefaults(
  defineProps<{
    sessionId: string
    messageId: string
    segments: Segment[]
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  submit: [segments: Segment[]]
  cancel: []
}>()

const { t } = useI18n()
// ComposerInput 三壳层能力（pasteImage IPC / renderIcon / t）——与底部 Composer 同一共享装配器
provideComposerInputDeps()

// ── 输入区实例（结构契约 ShellInputInstance）──
// 模板顶层 ref 会被渲染代理解包成值——经普通对象字段中转保活「传引用」语义给
// CommandPopover 的 shell-input-ref（activeElement 门识别源；通道缺口③，同 Composer.vue）。
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)
const shellInputRef = inputRef as Ref<ShellInputInstance | null>
const shellInputHolder = { ref: shellInputRef }
const sessionIdRef = computed<string | null>(() => props.sessionId)

// ── 命令浮层五路触发态机（与 Composer 同一 composable）──
// 第三参 = exactMatch 直发通道的 Enter 链（useCommandPopoverTrigger 的 onComposerKeydown）：
// 浮层内 ⏎ 精确命中项 → onCmdSelect 插 chip → 同步直调本处 onKeydown（原事件，禁合成事件）
// → 提交。函数声明提升保证此处先于 onKeydown 定义引用不炸。
const {
  cmdOpen,
  cmdType,
  slashQuery,
  fileQuery,
  sessionQuery,
  subagentQuery,
  skillQuery,
  commandPopoverRef,
  onSlashTrigger,
  onFileTrigger,
  onSessionTrigger,
  onSubagentTrigger,
  onSkillTrigger,
  onCmdSelect,
  onSelectAndSend,
} = useCommandPopoverTrigger(shellInputRef, sessionIdRef, (e) => onKeydown(e))

/** 浮层过滤 query 五路映射（同 Composer.vue popoverQuery） */
const popoverQuery = computed(() => {
  if (cmdType.value === 'file') return fileQuery.value
  if (cmdType.value === 'session') return sessionQuery.value
  if (cmdType.value === 'subagent') return subagentQuery.value
  if (cmdType.value === 'skill') return skillQuery.value
  return slashQuery.value
})

// ── skill 候选源（panel 态 cwd = session cwd，与 Composer.vue 同接线）──
const sessionStore = useSessionStore()
const projectSkillsCwd = computed<string | null>(
  () => sessionStore.list.find((s) => s.id === props.sessionId)?.cwd ?? null,
)
const { projectSkills } = useProjectSkills(projectSkillsCwd)
const { globalSkills } = useGlobalSkills()

// ── 草稿 + 已选 skill 集合（禁选数据范围）──
// getSegments 读 DOM 非响应式 → 随 input 显式刷新（与 Composer onInputChange 同模式）。
const draft = ref('')
const selectedSkillNames = ref<string[]>([])

function onInputChange(text: string): void {
  draft.value = text
  selectedSkillNames.value = (inputRef.value?.getSegments() ?? [])
    .filter((s) => s.type === 'skill')
    .map((s) => s.name)
}

/** 可提交：非空稿（trim 后）∧ 非提交在途。空稿检查与 ui 侧 onEditorSubmit 的
 *  segmentsToText trim 双闸同语义（主 Composer canSend = hasInput ∧ ¬isSending 同构）。 */
const canSubmit = computed(() => draft.value.trim().length > 0 && !props.disabled)

/** 整框回填原消息 segments（真 chip 还原）+ 同步草稿派生（setText 内部已 emitInput，
 *  此处显式补一次保证无 chip 的纯文本消息也有确定初值）。 */
function restore(): void {
  inputRef.value?.setSegments(props.segments)
  onInputChange(inputRef.value?.getText() ?? '')
}

// 编辑目标变更（同一实例被复用于另一条消息的边界）→ 重新回填
watch(() => props.messageId, () => restore())

onMounted(() => {
  restore()
  // setSegments 内部 setText 已 focus；chip 插入后光标落点可能位移，nextTick 补一次聚焦
  nextTick(() => inputRef.value?.focus())
})

function submit(): void {
  if (!canSubmit.value) return
  emit('submit', inputRef.value?.getSegments() ?? [])
}

/**
 * 键盘路由（浮层开/关两路，与 composer-keydown 的同构子集）：
 * - 开：主入口 = CommandPopover 自注册的 window capture（↑↓⏎TabEsc；capture 消费时
 *   stopPropagation 截断，事件到不了本 handler）——本路是兜底补位；
 * - 关：⏎ = 提交（dom-core 已 preventDefault 并分流：⇧⏎=换行不 emit、IME 组字中不 emit，
 *   到得了本路的 ⏎ 即裸 ⏎——编辑态无 steer/followUp 分叉，Alt/⌘ 修饰不改变语义）；
 *   Esc = 取消。裸 ↑/↓ 等一律不拦截：放行原生光标移动（编辑态无历史召回语义——底部
 *   Composer 的 at-edge 翻历史是草稿便捷，编辑框翻历史会替换掉正在编辑的消息原文）。
 */
function onKeydown(e: KeyboardEvent): void {
  if (cmdOpen.value && commandPopoverRef.value?.handleKeydown(e)) return
  if (e.isComposing) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
    return
  }
  if (e.key !== 'Enter') return
  submit()
}
</script>
