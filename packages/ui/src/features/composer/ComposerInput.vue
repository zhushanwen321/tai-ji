<template>
  <!--
    富文本输入区（draft-composer-states §1/§2e）。
    contenteditable div 取代 Textarea：支持 slash chip（§2e）与 @/# mention 内联 chip（§2d）。
    B 方案：富文本内联 token 必须 contenteditable，Textarea 物理上做不了。
    v-html 被项目规则禁用（vue/no-v-html），所有 DOM 操作走 ref 手动 API。

    [W4 迁移] 自 renderer components/panel/ComposerInput.vue 迁入 ui 包，
    props/emits/expose 契约不变（C1 契约），壳层 deps（pasteImage/renderIcon/t）
    经 ComposerInputDeps inject token 注入（clarify C1，对齐 w6 ChatViewDeps 范式）。
  -->
  <div
    ref="elRef"
    class="composer-input relative min-h-[60px] max-h-[120px] overflow-y-auto px-3.5 pb-1 pt-[11px] text-[length:var(--text-sm)] leading-[1.55] text-neutral-fg outline-none"
    :class="{ 'is-empty': isEmpty, 'is-focused': isFocused }"
    :contenteditable="!disabled"
    :data-placeholder="placeholder"
    role="textbox"
    aria-multiline="true"
    :aria-label="placeholder"
    spellcheck="false"
    @input="onInput"
    @keydown="onKeydown"
    @paste="onPaste"
    @focus="onInputFocus"
    @blur="onBlur"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
    @mouseup="saveSelection"
  />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  useContenteditableInput,
  useComposerChipCommands,
  findImageChipElById,
} from '@xyz-agent/dom-core/composer/input'
import { useComposerInputDeps } from './composer-input-deps'

const props = withDefaults(
  defineProps<{
    placeholder?: string
    disabled?: boolean
    /** 当前会话 id（决定图片持久化目录）；landing 态为 null → IPC 内降级 tmpdir */
    sessionId?: string | null
    /**
     * [bash 豁免短路]（设计 D6）：true 时 dom-core onInput 跳过全部符号触发检测，
     * 四路 trigger 回调统一发 null（关闭浮层语义）。bash 态（!/!! 前缀）下 $ 是变量、
     * # 是注释、@ 是语法成分，一致豁免比按符号豁免简单且无歧义。由 Composer.vue 从
     * isBashMode（draft.trimStart().startsWith('!')）传入。
     */
    suppressTriggers?: boolean
  }>(),
  { placeholder: '', disabled: false, sessionId: null, suppressTriggers: false },
)

const emit = defineEmits<{
  input: [text: string]
  keydown: [e: KeyboardEvent]
  /** slash 命令触发检测：{query} 表示 / 在行首且无 chip；null 表示应关闭触发浮层 */
  'slash-trigger': [payload: { query: string } | null]
  /**
   * $ 文件触发检测（四符号体系，文件语义换绑到 $）：{query} 表示光标前有
   * 「空格/行首 + $ + 非空白」序列；null 表示应关闭触发浮层。
   * emit 名保持 'file-trigger'（file 浮层链路复用，只换触发符号）。
   */
  'file-trigger': [payload: { query: string } | null]
  /**
   * # session 触发检测（四符号体系，# 对齐 TUI 换绑为 session 引用）：{query} 表示
   * 光标前有「空格/行首 + # + 非空白」序列；null 表示应关闭触发浮层。
   * 注：dom-core 的 onFileTrigger 回调仍绑 # 检测（contenteditable.ts 内部绑定），
   * 本组件转发层把该 payload 路由到本 emit（session 语义）。
   */
  'session-trigger': [payload: { query: string } | null]
  /**
   * @ subagent 触发检测（四符号体系新增）：{query} 表示光标前有
   * 「空格/行首 + @ + 非空白」序列；null 表示应关闭触发浮层。
   */
  'subagent-trigger': [payload: { query: string } | null]
  /**
   * skill 触发检测（多 skill 注入设计 D1）：{query} 表示光标前有「非换行空白 + / + query」
   * 序列且 query 合法（[a-z0-9-]{0,64}）；null 表示应关闭浮层。与 slash-trigger（行首命令域）
   * 触发域互斥，同一次输入至多一路非 null。
   */
  'skill-trigger': [payload: { query: string } | null]
  /** 聚焦/失焦：驱动父 Composer 的 .composer-box 聚焦态（v6 §6.1 .focused 3px ring） */
  focus: []
  blur: []
}>()

/** 壳层依赖注入（pasteImage IPC / renderIcon 图标渲染 / i18n t）——renderer Composer.vue provide */
const deps = useComposerInputDeps()

const elRef = ref<HTMLDivElement | null>(null)
/** 聚焦态：控制 placeholder 显隐（仅未聚焦且空时显）与光标可见性（未聚焦不显光标） */
const isFocused = ref(false)

// contenteditable 输入机制（getText/syncEmpty/触发检测/光标滚动/选区保存恢复/IME 守卫/换行/粘贴）
// 逻辑在 core input/contenteditable.ts（W2 迁移，deps 注入 pasteImage）。
// 两个 core 模块互依：contenteditable 的 onKeydown 要调 chip 模块的 handleBackspaceOnChip，
// chip 模块的 onChanged/restoreSelection 要用 contenteditable 的 onInput/restoreSelection。
// 解耦：handleBackspaceOnChip 仅在运行期（onKeydown 触发）被调，setup 期可暂留占位再后赋值，
// 故先声明 contenteditable，把 handleBackspaceOnChip 经 forwardRef 后赋，再声明 chip 模块。
let handleBackspaceOnChip: () => boolean = () => false
let insertImageBadgeFn: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void = () => {}
const {
  composing,
  isEmpty,
  onInput,
  onKeydown,
  onCompositionEnd,
  onPaste,
  syncEmpty,
  getText,
  getSegments,
  saveSelection,
  restoreSelection,
  clearSlashQueryText,
  clearHashQueryText,
  clearDollarFileQueryText,
  clearSubagentQueryText,
  clearSkillQueryText,
  clear,
  setText,
  insertTextAtCursor,
  moveCaretVertical,
} = useContenteditableInput(elRef, {
  onInput: (text) => emit('input', text),
  onSlashTrigger: (payload) => emit('slash-trigger', payload),
  // 四符号换绑（设计 §3.3.1）：dom-core 的 onFileTrigger 回调绑的是 # 检测
  // （contenteditable.ts 内部 onFileTrigger(detectHashTrigger())），# 已换绑 session 语义 →
  // 转发到 session-trigger；$ 检测走 onDollarFileTrigger → file-trigger（浮层链路复用）。
  onFileTrigger: (payload) => emit('session-trigger', payload),
  onDollarFileTrigger: (payload) => emit('file-trigger', payload),
  onSubagentTrigger: (payload) => emit('subagent-trigger', payload),
  onSkillTrigger: (payload) => emit('skill-trigger', payload),
  // bash 豁免短路（D6）：bash 态短路全部符号触发检测（判定源 = Composer isBashMode）
  shouldSuppressTriggers: () => props.suppressTriggers === true,
  onEnterKeydown: (e) => emit('keydown', e),
  onKeydown: (e) => emit('keydown', e),
  handleBackspaceOnChip: () => handleBackspaceOnChip(),
  // insertImageBadge 经闭包转发，chip 模块声明后回填真实实现（同 handleBackspaceOnChip 范式）
  insertImageBadge: (path, fileName, displayName, needsMigrate) => insertImageBadgeFn(path, fileName, displayName, needsMigrate),
  // sessionId 透传给 pasteImage（决定持久化目录；landing 态 undefined → null → IPC 降级 tmpdir）
  getSessionId: () => props.sessionId ?? null,
  pasteImage: deps.pasteImage,
})

// ============ 富文本 chip（§2e slash / §2d mention） ============
// chip DOM 操作在 dom-core input/chip-commands.ts（ADR-0058 迁移，deps 注入 renderIcon/t）。
const chipCommands = useComposerChipCommands(elRef, {
  onChanged: onInput,
  restoreSelection,
  renderIcon: deps.renderIcon,
  t: deps.t,
})
const insertSlashChip = chipCommands.insertSlashChip
const insertSkillChip = chipCommands.insertSkillChip
const insertMentionChip = chipCommands.insertMentionChip
const insertFileChip = chipCommands.insertFileChip
const insertImageBadge = chipCommands.insertImageBadge
const insertSessionChip = chipCommands.insertSessionChip
const insertSubagentChip = chipCommands.insertSubagentChip
// 后赋值：补回上面 forward 占位（setup 同步执行完毕，onPaste 运行期读到真实实现）
handleBackspaceOnChip = chipCommands.handleBackspaceOnChip
insertImageBadgeFn = chipCommands.insertImageBadge

/** blur：清聚焦态（隐藏光标 + 末尾不再闪），并保存选区供命令浮层后恢复光标 */
function onBlur(): void {
  isFocused.value = false
  emit('blur')
  saveSelection()
}

/** focus：设内部聚焦态（placeholder 显隐）+ emit 给父 Composer 驱动 .composer-box ring */
function onInputFocus(): void {
  isFocused.value = true
  emit('focus')
}

// clear / setText / insertTextAtCursor 不再在组件定义：DOM 写入已收口进 core composable
// （savedRange 闭包在 composable 内，组件层无法重置它；详见 contenteditable.ts 注释）。
// 组件通过 defineExpose 透传 composable 返回的同名方法，维持对外 API 契约不变。

function focus(): void {
  isFocused.value = true
  elRef.value?.focus()
}

/**
 * 按 chipId 移除 image badge（ContextChipsBar × 删除回调用）。
 * 用 dataset 遍历定位（C3：chipId 是稳定唯一 id，避免同一文件附两次时重复 path 冲突），
 * 连同相邻 ZWSP spacer 一并移除，触发 onInput 同步状态。
 */
function removeImageChip(chipId: string): void {
  const el = elRef.value
  if (!el) return
  const chip = findImageChipElById(el, chipId)
  if (!chip) return
  const next = chip.nextSibling
  if (next && next.nodeType === Node.TEXT_NODE && next.textContent === '\u200B') {
    next.remove()
  }
  chip.remove()
  onInput()
}

defineExpose({
  clear,
  focus,
  getText,
  getSegments,
  setText,
  insertTextAtCursor,
  insertSlashChip,
  insertSkillChip,
  insertMentionChip,
  insertFileChip,
  insertSessionChip,
  insertSubagentChip,
  insertImageBadge,
  removeImageChip,
  clearSlashQueryText,
  clearHashQueryText,
  /** # query 段清除（session 语义，dom-core 实现名保持 clearHashQueryText） */
  clearSessionQueryText: clearHashQueryText,
  clearDollarFileQueryText,
  clearSubagentQueryText,
  clearSkillQueryText,
  saveSelection,
  restoreSelection,
  moveCaretVertical,
})

onMounted(() => {
  syncEmpty()
})
</script>

<style scoped>
/* placeholder：伪元素 Tailwind 表达不了，走 scoped style。
   用 --subtle（三级文字/占位，design-tokens SSOT + design-system §4 明确）。
   设计意图：占位是三级最暗层，与输入正文 --fg 拉开梯度，弱化提示语。
   —— absolute 脱文档流：不占行内位，光标始终在内容区最左（开头）而非 placeholder 末尾。
   —— 仅未聚焦且空时显（is-empty && !is-focused）：聚焦即隐，光标停在开头闪烁。 */
.composer-input.is-empty:not(.is-focused)::before {
  content: attr(data-placeholder);
  position: absolute;
  inset: 0;
  padding: inherit;
  color: var(--neutral-dim);
  pointer-events: none;
}

/* slash 命令 chip（§9B v6 统一范式：无底无边 + 加粗 font-weight 600 + 前缀 icon + 语义色 + × 删除）
   去掉 reasoning-soft 底色块（旧范式），保留语义色文字 + icon。 */
.composer-input :deep(.slash-chip) {
  display: inline-flex;
  align-items: center;
  /* inline-flex 默认 vertical-align:baseline，chip 底边与文字基线对齐导致偏上。
     middle 让 chip 中线与文字 x-height 中线对齐，视觉与文字水平居中。 */
  vertical-align: middle;
  gap: 4px;
  /* 与后续文字空开约一字符宽（4px），避免 chip 贴紧正文 */
  margin-right: 4px;
  /* 无底色无边框（v6 §9B 统一范式），仅靠 icon + 语义色文字区分类型 */
  color: var(--reasoning);
  font: 600 11px / 1.4 var(--font-sans);
  user-select: none;
}
/* skill chip 前后自动空开（D13）：margin-left 4px + margin-right 提至 6px，仅 skill chip
   （用户报告面）；slash/file/session/subagent chip 维持各自单侧间距不动。行首抑制：
   chip 为其父容器首子节点（前无兄弟节点，landing / 清空后插入形态）时不缩进——
   触发路径（空格 + /）清 query 后前置空格仍在，靠文本空格分隔，不依赖本规则。
   纯视觉零数据污染：ZWSP spacer 契约与序列化层 needsBoundarySpace 空格补齐均不动。 */
.composer-input :deep(.slash-chip[data-chip-type='skill']) {
  margin-left: 4px;
  margin-right: 6px;
}
.composer-input :deep(.slash-chip[data-chip-type='skill']:first-child) {
  margin-left: 0;
}
.composer-input :deep(.slash-chip .chip-icon) {
  display: inline-flex;
  align-items: center;
  color: var(--reasoning);
}
.composer-input :deep(.slash-chip .chip-icon svg) {
  width: 13px;
  height: 13px;
}
.composer-input :deep(.slash-chip .chip-x) {
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  opacity: 0.5;
}
.composer-input :deep(.slash-chip .chip-x:hover) {
  opacity: 1;
  color: var(--danger);
}

/* @ 引用 / # 文件 mention 内联 chip（§9B v6 统一范式：无底无边 + 加粗 + 前缀 icon + 语义色） */
.composer-input :deep(.mention-chip) {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  gap: 4px;
  /* 与后续文字空开约一字符宽（4px），与 slash-chip 对齐 */
  margin-right: 4px;
  /* 无底色无边框（v6 §9B 统一范式） */
  font: 600 11px / 1.4 var(--font-sans);
  user-select: none;
}
.composer-input :deep(.mention-chip.mention-at) {
  color: var(--accent);
}
.composer-input :deep(.mention-chip.mention-file) {
  color: var(--success);
}
/* session 引用 chip（四符号体系 # session 语义）：--warn 金色——与 skill/reasoning 紫、
   file 绿、@ accent 蓝灰四色互斥，靠语义色区分 chip 类型（v6 §9B 无底无边范式）。 */
.composer-input :deep(.mention-chip.mention-session) {
  color: var(--warn);
}
/* 图片 badge（Cmd+V 富呈现通路）：复用 .mention-chip 基础样式 + .image-chip 紫色修饰，
   覆盖 mention-file 的绿色，与 ContextChipsBar image chip（text-reasoning）视觉一致（TO2）。 */
.composer-input :deep(.mention-chip.image-chip) {
  color: var(--reasoning);
}
</style>
