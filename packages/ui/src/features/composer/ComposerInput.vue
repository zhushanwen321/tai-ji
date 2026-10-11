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
  <!-- 几何与字号锁 demo workbench.css composer 段：--fs-lg 14px（--text-base 档，R4 降档）+
       两行起步 min-height:calc(3em+19px)（2 行 × 1.5 行高 + 上下 padding 和 13+6=19px，
       border-box 联动）+ 5 行封顶 max-height:calc(7.5em+19px)（同式外推）；聚焦无焦点边界
       （demo R3 撤销：composer 输入区无焦点边界，光标即焦点反馈），is-focused 状态类
       保留为聚焦挂点（现行无样式消费方）。
       break-words（overflow-wrap，demo workbench.css .composer-input 同声明）：超长 URL
       等无断点长串在词内折行，防撑破横向。 -->
  <div
    ref="elRef"
    class="composer-input relative min-h-[calc(3em+19px)] max-h-[calc(7.5em+19px)] overflow-y-auto px-4 pt-[13px] pb-[6px] text-[length:var(--text-base)] leading-[1.5] text-neutral-fg outline-none break-words"
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
    @mousedown="onEditorMousedown"
    @mouseup="saveSelection"
  />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Segment } from '@taiji/shared'
import {
  useContenteditableInput,
  useComposerChipCommands,
  findImageChipElById,
  restoreSegmentsIntoInput,
} from '@taiji/dom-core/composer/input'
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
/** 聚焦态：驱动 is-focused 状态类（聚焦挂点；R3 无焦点边界，光标即焦点反馈，
 *  placeholder 空态恒显不再依赖聚焦态） */
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

/** focus：设内部聚焦态（is-focused 挂点）+ emit 给父 Composer（R3：无焦点边界，
 *  光标即焦点反馈，父层不再有聚焦环） */
function onInputFocus(): void {
  isFocused.value = true
  emit('focus')
}

/**
 * 徽章原子化（demo onEdMouseDown 同款，spec §4「mousedown 不落光标」）：mousedown 落在
 * 徽章内时 preventDefault，浏览器不把光标放进徽章边界（徽章整体不可点入，行为原子化）。
 * 类名沿用 dom-core 的 chip 判定（isDeletableChipNode 三类 class）：slash-chip / mention-chip，
 * image-chip 同时挂在 mention-chip 上故被 mention-chip 覆盖。× 删除不受影响——preventDefault
 * 只阻止光标放置与拖选启动，click 事件照常派发，chip-x 的 click 删除监听（dom-core
 * makeXButton）独立生效。
 */
function onEditorMousedown(e: MouseEvent): void {
  const target = e.target
  if (target instanceof Element && target.closest('.slash-chip, .mention-chip')) {
    e.preventDefault()
  }
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

/**
 * 输入根元素（contenteditable div）读取口——壳层键盘路由 activeElement 门
 * （command-popover-keyboard）的识别源。[HISTORICAL] 勿改回读实例 $el：本组件模板含
 * HTML 注释块，dev 构建保留注释 → subTree 根为 Fragment → $el 是注释节点（nodeType 8）
 * 而非本元素，dev 下门的 contains 判定恒 false（W1 验收 F-1）；prod 剥离注释才正常。
 * 经 expose 显式提供是唯一对两构建一致可靠的通道。
 */
function getInputElement(): HTMLDivElement | null {
  return elRef.value
}

/**
 * segments 快照整框回填（发送失败草稿恢复，remote-use D6 / §5.4 检查点4 补的接口）：
 * 委托 dom-core restoreSegmentsIntoInput 唯一实现（text 段 setText 重建 + 非 text 段
 * 经 insert* 还原真 chip，与桌面 useComposerRestore.restoreSegments 同一定义点）。
 * 消费方：移动壳 MobileComposer（send === false 时回填原文本）。
 */
function setSegments(segments: Segment[]): void {
  restoreSegmentsIntoInput(
    {
      setText,
      insertImageBadge,
      insertSlashChip,
      insertFileChip,
      insertSessionChip,
      insertSubagentChip,
      insertSkillChip,
    },
    segments,
  )
}

defineExpose({
  clear,
  focus,
  getText,
  getSegments,
  setText,
  setSegments,
  insertTextAtCursor,
  getInputElement,
  insertSlashChip,
  insertSkillChip,
  insertMentionChip,
  insertFileChip,
  insertSessionChip,
  insertSubagentChip,
  insertImageBadge,
  removeImageChip,
  clearSlashQueryText,
  /** # query 段清除（session 语义；expose 单名——dom-core 实现名保持 clearHashQueryText） */
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
   用 --neutral-dim（三级文字/占位，design-tokens SSOT）。
   设计意图：占位是三级最暗层，与输入正文 --fg 拉开梯度，弱化提示语。
   —— absolute 脱文档流：不占行内位，光标始终在内容区最左（开头）而非 placeholder 末尾。
   —— 空态恒显（含聚焦，demo textarea 原生 placeholder 同形态）：R3 无缝输入面，
      聚焦后光标与 placeholder 共存，光标即焦点反馈，无聚焦边界。 */
.composer-input.is-empty::before {
  content: attr(data-placeholder);
  position: absolute;
  inset: 0;
  padding: inherit;
  color: var(--neutral-dim);
  pointer-events: none;
}

/* ─── 行内 chip（实体化 chip 形态，方案 C 精修定稿）───
   权威源 = demo workbench.css .ichip 段 + specs/composer/composer-chips.md §2（逐项定值）。
   [HISTORICAL] 旧「无底无边 + 语义色文字」范式整体退役，被实体 chip 形态（底+边+定高）取代：
   mention-at/file/session 语义色分叉（--accent/--success/--warn）、image-chip 紫色、
   skill chip --reasoning 紫与 D13 skill margin 特例（双侧 3px 恒距已覆盖其语义）、
   × 按钮 opacity .5 常显与 :hover 红（删除反馈改中性，红色只留给真正不可逆动作）。
   --chip-* 变量（圆角/底/边/hover 提色）由 renderer style.css .composer 作用域定义
   （demo 两档同步机制：行内 20px 与上下文行 22px 共用同组变量），本文件只消费不定义，
   依赖祖先作用域注入。 */
.composer-input :deep(.slash-chip),
.composer-input :deep(.mention-chip) {
  display: inline-flex;
  align-items: center;
  /* vertical-align: baseline：徽章文字与正文共享基线，对齐由机制保证而非目测调参。
     不能用 middle——它以拉丁 x-height 中点为锚，中文场景整枚徽章下沉约 1.5px（demo §3 对照） */
  vertical-align: baseline;
  height: 20px;
  padding: 0 5px 0 7px;
  /* 中文无空格必须双侧给距（单右距左侧文字贴边框）；3px 贴合不打断阅读节奏 */
  margin-inline: 3px;
  gap: 5px;
  /* 长名截断不爆版，ellipsis 由 .chip-label 承载 */
  max-width: 240px;
  border: 1px solid var(--chip-border);
  border-radius: var(--chip-r);
  background: var(--chip-bg);
  /* 13px 与正文 14px 差一档而非两档，靠字重 + 对比立实体感，不用尺寸断层；
     line-height 18px = 20px 高 − 上下边 2px（demo 权威定值） */
  font-size: var(--text-sm);
  line-height: 18px;
  font-weight: var(--fw-mid);
  color: var(--neutral-fg-2);
  white-space: nowrap;
  user-select: none;
  /* 底/边/字三通道统一反馈过渡（demo 统一过渡组 .ichip 同参 120ms）：本体、:hover 提色、
     just-inserted 淡染起落三处状态变化共用此组，无过渡会跳变 */
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
/* 基线 strut：inline-flex 容器基线取首个 flex 项，首项是 svg（无文字基线）时退化为
   底边锚定——零宽空格把容器基线钉到 chip 字号的真实文字基线，与编辑器两侧兜底
   ZWSP spacer 互不冲突 */
.composer-input :deep(.slash-chip)::before,
.composer-input :deep(.mention-chip)::before {
  content: '\200B';
}
.composer-input :deep(.slash-chip:first-child),
.composer-input :deep(.mention-chip:first-child) {
  margin-left: 0;
}
/* hover 提底提边，前景不变暗（--chip-bg-hover / --chip-border-hover 同为 .composer 作用域变量） */
.composer-input :deep(.slash-chip:hover),
.composer-input :deep(.mention-chip:hover) {
  background: var(--chip-bg-hover);
  border-color: var(--chip-border-hover);
}
.composer-input :deep(.slash-chip .chip-icon),
.composer-input :deep(.mention-chip .chip-icon) {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--neutral-mid);
}
.composer-input :deep(.slash-chip .chip-icon svg),
.composer-input :deep(.mention-chip .chip-icon svg) {
  /* 固定 12px（demo .ichip > svg 权威值）：icon 略小于行高；替换旧 1em 随字号联动 */
  width: 12px;
  height: 12px;
}
.composer-input :deep(.slash-chip .chip-label),
.composer-input :deep(.mention-chip .chip-label) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 前缀符号（$ @ #）：类型标记弱化为元数据层，辨型交给图标与前缀，不挪用语义色
   （字重 --fw-text 同 demo .pre，mono 小字在 500 档才立得住） */
.composer-input :deep(.slash-chip .chip-pre),
.composer-input :deep(.mention-chip .chip-pre) {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: var(--fw-text);
  color: var(--neutral-dim);
}
/* × 删除钮：14px 常驻占位防宽度跳变，chip hover 才显形；hover 反馈中性
   （elevated 底 + fg 前景）。duration 用统一反馈档 --duration-fast（demo --dur-fast 同值 120ms）。
   前四行清零原生 button 的 UA 默认（demo 全局 button reset 同款语义）——× 现为
   <button type="button">（键盘可达），清掉底色/边框/内边距/字体后由本块定妆 */
.composer-input :deep(.slash-chip .chip-x),
.composer-input :deep(.mention-chip .chip-x) {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-right: -3px;
  border-radius: 3px;
  color: var(--neutral-dim);
  flex: none;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.composer-input :deep(.slash-chip:hover .chip-x),
.composer-input :deep(.mention-chip:hover .chip-x) {
  opacity: 1;
}
.composer-input :deep(.slash-chip .chip-x:hover),
.composer-input :deep(.mention-chip .chip-x:hover) {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
}
/* 插入瞬间淡染一闪（--sel-bg/--sel-edge，800ms 由 dom-core chip-commands 摘除）；
   全屏唯一 accent 染色点，在 accent 预算内 */
.composer-input :deep(.slash-chip.just-inserted),
.composer-input :deep(.mention-chip.just-inserted) {
  background: var(--sel-bg);
  border-color: var(--sel-edge);
}
</style>
