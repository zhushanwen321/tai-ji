<template>
  <!--
    划选评论浮条（plan 模式重设计 u1-docs-panel，设计 §3.1 步骤 5 / D6 / G3）。
    职责：监听 target 容器内的文字划选 → 浮条「评论」→ 编辑态（划选引文 + 评语输入）→
    emit submit 交父组件写 planStore 草稿（D6：草稿状态源归 store，本组件不持评论数据）。
    浮条定位照用户验收 demo 的 sel-pop 形态（验收 demo 不入库）：选区上方居中，
    越界钳制在视口内（F-R2-3：按当前态实际尺寸四边钳制——原实现只按浮条估宽钳 x 且
    只钳上边缘，编辑态 320px 右/下出视口）。fixed + Teleport body——drawer 容器
    overflow hidden 会裁剪溢出，Teleport 后浮层脱离文档流不受裁剪。
    revising 态（disabled）：浮条照常出现、「评论」按钮禁用 + title 提示（§3.1 失败路径
    「修订中评论禁用」——避免并发修订语义，恢复 = 等修订完成）。
  -->
  <Teleport to="body">
    <div
      v-if="sel"
      ref="popEl"
      data-testid="plan-comment-popover"
      class="fixed z-[var(--z-overlay)] rounded-[var(--radius)] border border-border-strong bg-bg-elevated p-1 shadow-2"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    >
      <!-- 浮条态：单按钮胶囊（demo sel-pop 形态） -->
      <Button
        v-if="!editing"
        variant="ghost"
        size="sm"
        class="gap-1.5 rounded-full px-3"
        data-testid="plan-comment-trigger"
        :disabled="disabled"
        :title="disabled ? t('plan.comment.revisingDisabled') : undefined"
        @click="startEdit"
      >
        <MessageSquare class="size-3 text-accent" aria-hidden="true" />
        {{ t('plan.comment.trigger') }}
      </Button>
      <!-- 编辑态：引文 + 评语输入（demo cm-editor 形态浮层化）。外部 mousedown 不关编辑态
           （防误触丢评语——demo 编辑器插在文档流无此问题，浮层化后需显式保护）；浮条态
           外点即关照 demo。 -->
      <div v-else data-testid="plan-comment-editor" class="flex w-80 flex-col gap-2 p-1">
        <p
          data-testid="plan-comment-quote"
          class="truncate rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
          :title="sel.quote"
        >“{{ sel.quote }}”</p>
        <Textarea
          v-model="commentText"
          data-testid="plan-comment-input"
          :placeholder="t('plan.comment.placeholder')"
          class="min-h-[56px] text-[length:var(--text-xs)]"
        />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" data-testid="plan-comment-cancel" @click="close">
            {{ t('plan.comment.cancel') }}
          </Button>
          <Button variant="secondary" size="sm" data-testid="plan-comment-save" @click="save">
            {{ t('plan.comment.add') }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * PlanCommentPopover —— 文档正文划选评论浮条（浮条 + 编辑器两态）。
 *
 * 划选捕获（demo mouseup 形态）：document 级 mouseup 上读 window.getSelection——
 * 选区非空、非折叠、锚点落在 target 容器内三条件齐备才弹浮条；定位取选区 range 的
 * boundingRect 上方居中（常量近似 demo 公式），显示坐标按当前态尺寸四边钳制在视口内
 * （F-R2-3）。引文截断 80 字符
 * （demo 同款：agent 定位段落够用，草稿列表不膨胀）。
 *
 * 提交契约：emit('submit', { quote, comment })——quote = 划选引文（锚定），comment =
 * 评语；落 planStore 草稿由父组件（PlanDocsPanel）执行，本组件 emit 后即清理选区关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquare } from '@lucide/vue'
import { Button, Textarea } from '@taiji/ui'

const props = defineProps<{
  /** 划选目标容器（PlanDocsPanel 的正文滚动区；null = 未挂载，监听器内直接忽略） */
  target: HTMLElement | null
  /** revising 态禁用评论（设计 §3.1 失败路径：修订中评论禁用） */
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', payload: { quote: string; comment: string }): void
}>()

const { t } = useI18n()

/** 引文截断上限（demo 同款 slice(0, 80)） */
const QUOTE_MAX = 80
/** 视口钳制边距（demo 同款 8px） */
const VIEWPORT_MARGIN = 8
/** 浮条态估宽（选区中心对齐浮条中心的定位近似；demo 同款常量法，渲染后精调无必要） */
const FLOAT_WIDTH = 100
/** 浮条态估高（单按钮胶囊：容器 p-1 + size-sm 按钮，估约 40px；钳制近似用） */
const FLOAT_HEIGHT = 40
/**
 * 编辑态浮层尺寸（F-R2-3 四边钳制的依据）。宽与 template 编辑器 `w-80` 同源 = 320px；
 * 高按当前结构（引文行 + textarea min-h-56 + 按钮行 + gap/padding）估约 200px 上界。
 * 常量法而非渲染后实测：jsdom 单测可断言、开合两态同步定位无二次跳动；改浮层形态
 * （w-80 / min-h / 结构增删）须同步本组常量。
 */
const EDITOR_WIDTH = 320
const EDITOR_HEIGHT = 200
/** 浮层底边与选区顶边的垂直间距（浮条态 40 + 2 = 原 FLOAT_OFFSET 42，demo 同款） */
const FLOAT_GAP = 2
/** 几何取中除数（中点 = 尺寸 / HALF；no-magic-numbers 命名化） */
const HALF = 2

/**
 * 浮层状态（null = 关闭）：quote = 划选引文；anchorX/anchorY = 选区矩形几何锚点
 * （水平中心 x / 顶边 y，视口坐标）——显示坐标按当前态（浮条/编辑）尺寸在 pos 派生。
 */
const sel = ref<{ quote: string; anchorX: number; anchorY: number } | null>(null)
const editing = ref(false)
const commentText = ref('')
const popEl = ref<HTMLElement | null>(null)

/**
 * 显示坐标（F-R2-3 四边钳制）：锚点按当前态尺寸换算 raw 坐标后 clamp 进视口（四边留
 * VIEWPORT_MARGIN）——demo 定位公式「选区上方居中（选区中心对齐浮层中心）」+ 底边距
 * 选区顶 FLOAT_GAP。editing 切换自动按编辑态尺寸（320×200）重钳，右/下不再出视口。
 */
const pos = computed<{ x: number; y: number }>(() => {
  if (!sel.value) return { x: 0, y: 0 }
  const w = editing.value ? EDITOR_WIDTH : FLOAT_WIDTH
  const h = editing.value ? EDITOR_HEIGHT : FLOAT_HEIGHT
  const rawX = sel.value.anchorX - w / HALF
  const rawY = sel.value.anchorY - h - FLOAT_GAP
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - w - VIEWPORT_MARGIN)
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - h - VIEWPORT_MARGIN)
  return {
    x: Math.min(Math.max(rawX, VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(rawY, VIEWPORT_MARGIN), maxY),
  }
})

function dismiss(): void {
  sel.value = null
  editing.value = false
  commentText.value = ''
}

function startEdit(): void {
  editing.value = true
}

function close(): void {
  dismiss()
}

/**
 * 提交评论（demo save 语义：空评语不提交不关闭，聚焦输入促补全）；成功后清选区关闭。
 * popEl 查询 textarea 而非持 input ref——编辑态由 v-if 切换，ref 时序比 DOM 查询脆。
 */
function save(): void {
  const text = commentText.value.trim()
  const quote = sel.value?.quote
  if (!text || !quote) {
    popEl.value?.querySelector('textarea')?.focus()
    return
  }
  emit('submit', { quote, comment: text })
  window.getSelection()?.removeAllRanges()
  dismiss()
}

/** 选区锚点 node → element 归一（contains 判定只接受 Element） */
function anchorElement(selObj: Selection): Element | null {
  const node = selObj.anchorNode
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

function onMouseUp(e: MouseEvent): void {
  // 浮层内部松鼠标（按钮点击 / 输入框选字）不重算
  if (popEl.value?.contains(e.target as Node)) return
  const selObj = window.getSelection()
  if (!props.target || !selObj || selObj.isCollapsed || !selObj.toString().trim()) {
    // 编辑态不受无效选区影响（用户可能在输入中间点了文档）
    if (!editing.value) dismiss()
    return
  }
  const anchor = anchorElement(selObj)
  if (!anchor || !props.target.contains(anchor)) {
    if (!editing.value) dismiss()
    return
  }
  if (selObj.rangeCount === 0) return
  const rect = selObj.getRangeAt(0).getBoundingClientRect()
  // 只记几何锚点（选区中心 x / 顶边 y）；显示坐标由 pos 按当前态尺寸派生并四边钳制
  sel.value = {
    quote: selObj.toString().trim().slice(0, QUOTE_MAX),
    anchorX: rect.left + rect.width / HALF,
    anchorY: rect.top,
  }
  editing.value = false
}

function onMouseDown(e: MouseEvent): void {
  // 编辑态不随外部 mousedown 关闭（浮层化适配：防输入被误触清除）；浮条态照 demo 外点即关
  if (editing.value) return
  if (popEl.value?.contains(e.target as Node)) return
  dismiss()
}

// 监听器常驻挂载（target 未就绪时 handler 内部忽略）——组件生命周期与面板一致，随面板卸载移除
onMounted(() => {
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('mousedown', onMouseDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('mousedown', onMouseDown)
})
</script>
