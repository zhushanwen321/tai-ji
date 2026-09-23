<!--
  展示组件 · 展开块限高滚动容器（BlockScrollBox）。
  设计来源：对话流系统通知渲染升级 §3.3 D6 / G5——thinking 与工具输出展开块统一限高，
  超长内容不再把对话流顶穿。

  三件套：
  1. 限高滚动：max-height = var(--block-scroll-max-height)（token 真值源 renderer style.css，
     mobile tokens.css 同批镜像）+ overflow-y auto + overscroll-behavior contain；
     细滚动条沿用 style.css base reset 的全局规则（滚动条外观 SSOT，组件不另行覆盖）。
  2. 渐隐提示：上/下渐隐条仅在该方向可滚时显形（scroll 事件切 opacity class）；
     渐隐底色按容器上下文区分（surface prop → 局部 CSS 变量 --block-scroll-fade-bg）。
  3. 底部信息条：mono 行区间 + 右侧展开全部/收起（@taiji/ui Button ghost，禁原生 button）；
     内容不超过限高时整条不渲染。

  streaming 吸底：内容增长（MutationObserver 观测 slot 子树）且用户未上滚时
  scrollTop = scrollHeight（scroll 事件维护 atBottom；上滚后停吸、回底恢复）；
  展开全部态不吸底（内容已全量可见）。
  展开态 = 块实例本地 ref：不进 store、不持久化——virtua 回收/重开 session 自然复位，
  与 Block 本地折叠态同语义（展开态入 store 的代价四要素见设计 D6 被否③）。

  接入点（Block.vue 三处）：thinking 展开区 / bash 凹槽输出区（命令头保持在凹槽内、
  本容器之外 = 恒吸顶）/ 非 bash 工具输出区（GuiComponentRenderer 输出自管理高度，不包）。
-->
<template>
  <div class="relative" :style="rootStyle" data-testid="block-scroll">
    <div class="relative">
      <!-- 限高滚动视口：max-height 内联绑定（展开态解除）；滚动条形态不在此指定——
           style.css 的 base reset（* { scrollbar-width: thin } + ::-webkit-scrollbar）是滚动条 SSOT -->
      <div
        ref="scrollEl"
        class="overflow-y-auto overscroll-contain"
        :style="viewportStyle"
        data-testid="block-scroll-viewport"
        @scroll.passive="measure"
      >
        <slot />
      </div>
      <!-- 渐隐提示条：仅在该方向可滚时显形（scroll 事件切 opacity class）；不拦截指针事件。
           渐变底色 = 容器上下文色（prop 注入的 --block-scroll-fade-bg），内容淡出到本层底色 -->
      <div
        class="pointer-events-none absolute inset-x-0 top-0 h-6 bg-[image:linear-gradient(to_bottom,var(--block-scroll-fade-bg),transparent)] opacity-0 transition-opacity duration-[var(--duration-fast)]"
        :class="canScrollUp ? 'opacity-100' : 'opacity-0'"
        data-testid="block-scroll-fade-top"
        aria-hidden="true"
      />
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-[image:linear-gradient(to_top,var(--block-scroll-fade-bg),transparent)] opacity-0 transition-opacity duration-[var(--duration-fast)]"
        :class="atBottom ? 'opacity-0' : 'opacity-100'"
        data-testid="block-scroll-fade-bottom"
        aria-hidden="true"
      />
    </div>
    <!-- 信息条：内容不超限高时整条不渲染；展开态保留（收起按钮是其唯一入口） -->
    <div
      v-if="showInfoBar"
      class="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-1"
      data-testid="block-scroll-info"
    >
      <span
        class="font-mono text-[length:var(--text-3xs)] tabular-nums text-neutral-dim"
        data-testid="block-scroll-range"
      >{{ rangeText }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-auto shrink-0 gap-1 px-1 py-0 text-[length:var(--text-3xs)] font-normal text-neutral-dim hover:text-neutral-fg"
        :aria-expanded="expanded"
        :title="toggleLabel"
        data-testid="block-scroll-toggle"
        @click="toggleExpanded"
      >
        <span data-testid="block-scroll-toggle-label">{{ toggleLabel }}</span>
        <span aria-hidden="true">{{ expanded ? ARROW_UP : ARROW_DOWN }}</span>
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合循环依赖环（同 Block.vue / BashOutputBlock.vue 注释）
import { Button } from '../../primitives/button'

const props = withDefaults(
  defineProps<{
    /** 渐隐底色上下文：canvas = thinking / 普通工具区（--bg）；recessed = bash 凹槽（--bg-input） */
    surface?: 'canvas' | 'recessed'
  }>(),
  { surface: 'canvas' },
)

const { t } = useI18n()

/** 距底容差（px）：scrollTop 取整与亚像素高度差会让「贴底」差 1px，判据统一带容差 */
const BOTTOM_EPSILON = 1
/** Tailwind leading-snug 行高系数（computed line-height 不可用时按字号估算） */
const LEADING_SNUG = 1.375
/** 兜底字号（px）= --text-sm 基准定义值；jsdom/happy-dom 无布局引擎时走此降级路径 */
const FALLBACK_FONT_SIZE = 13
const FALLBACK_LINE_HEIGHT = FALLBACK_FONT_SIZE * LEADING_SNUG
/** 展开/收起方向箭头（纯方向符号，非 emoji） */
const ARROW_DOWN = '↓'
const ARROW_UP = '↑'
/** 渐隐底色映射：上下文 → 局部 CSS 变量值（渐隐条的渐变工具类消费） */
const FADE_BG: Record<'canvas' | 'recessed', string> = {
  canvas: 'var(--bg)',
  recessed: 'var(--bg-input)',
}

const scrollEl = ref<HTMLElement | null>(null)
/** 展开全部：块实例本地态（不进 store / 不持久化） */
const expanded = ref(false)
/** 视口是否贴底——streaming 吸底判据（用户上滚后 false，回底恢复） */
const atBottom = ref(true)
/** 视口上方还有内容（上渐隐条判据） */
const canScrollUp = ref(false)
/** 内容超出限高（信息条判据；展开态保留最后一次判定，见 measure） */
const overflowed = ref(false)
/** 行区间（信息条）：from/to 为当前视口可见行，total 为内容总行数 */
const fromLine = ref(1)
const toLine = ref(1)
const totalLines = ref(1)

let contentObserver: MutationObserver | null = null

/** 根样式：注入渐隐底色（渐隐条的渐变工具类消费 --block-scroll-fade-bg） */
const rootStyle = computed<Record<string, string>>(() => ({
  '--block-scroll-fade-bg': FADE_BG[props.surface],
}))

/** 视口样式：限高 = token；展开态解除限高。
 *  走内联绑定而非 class——限高是运行时状态（展开/收起），且单测可断言（jsdom 无 CSS 引擎）。 */
const viewportStyle = computed<Record<string, string>>(() => ({
  maxHeight: expanded.value ? 'none' : 'var(--block-scroll-max-height)',
}))

/** 信息条渲染判据：超限高（常态）或展开态（收起按钮唯一入口，不能随限高消失一起消失） */
const showInfoBar = computed(() => overflowed.value || expanded.value)

/** 行区间文本：'{from}–{to} / {total} 行'（zh）/ '{from}–{to} of {total} lines'（en） */
const rangeText = computed(() =>
  t('panel.message.blockScrollLines', {
    from: fromLine.value,
    to: toLine.value,
    total: totalLines.value,
  }),
)

/** 按钮文案：展开态专用 blockScrollExpandAll（「展开全部」——既有 expand 键无「全部」语义）；
 *  收起态复用既有 collapse（不另立键） */
const toggleLabel = computed(() =>
  expanded.value ? t('panel.message.collapse') : t('panel.message.blockScrollExpandAll'),
)

/** 行高测量锚点：slot 内容首个元素（承载实际 line-height 的元素，如 .tool-result 的 leading-snug）；
 *  无元素子节点时退回滚动容器自身 */
function lineHeightAnchor(): HTMLElement | null {
  const el = scrollEl.value
  if (!el) return null
  return el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el
}

/**
 * 内容行高（px）：
 * 1. computed line-height 可解析（mono 的 leading-snug / markdown 的 leading-[1.7]）→ 实测值；
 * 2. 'normal' 或不可解析 → 字号 × leading-snug 估算；
 * 3. 字号也不可用 → 基准常量。
 * 后两条是 jsdom/happy-dom（无布局引擎）下的可测降级路径。
 */
function resolveLineHeight(): number {
  const anchor = lineHeightAnchor()
  if (!anchor) return FALLBACK_LINE_HEIGHT
  const style = getComputedStyle(anchor)
  const lineHeight = Number.parseFloat(style.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
  const fontSize = Number.parseFloat(style.fontSize)
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * LEADING_SNUG
  return FALLBACK_LINE_HEIGHT
}

/**
 * 几何测量：滚动方向可见性 + 溢出判定 + 行区间。
 * scroll 事件、内容变更、展开切换后调用（读取的是布局值，浏览器会自动 flush）。
 */
function measure(): void {
  const el = scrollEl.value
  if (!el) return
  const scrollHeight = el.scrollHeight
  const clientHeight = el.clientHeight
  const scrollTop = el.scrollTop
  atBottom.value = scrollHeight - scrollTop - clientHeight <= BOTTOM_EPSILON
  canScrollUp.value = scrollTop > BOTTOM_EPSILON
  // 展开态不受限高约束（scrollHeight === clientHeight），保留上一次溢出判定——
  // 否则展开后信息条随限高消失一起消失，收起按钮失去入口
  if (!expanded.value) overflowed.value = scrollHeight - clientHeight > BOTTOM_EPSILON
  const lineHeight = resolveLineHeight()
  totalLines.value = Math.max(1, Math.round(scrollHeight / lineHeight))
  const visibleLines = Math.max(1, Math.floor(clientHeight / lineHeight))
  const maxFrom = Math.max(1, totalLines.value - visibleLines + 1)
  fromLine.value = Math.min(maxFrom, Math.max(1, Math.floor(scrollTop / lineHeight) + 1))
  toLine.value = Math.min(totalLines.value, fromLine.value + visibleLines - 1)
}

/** 内容增长：用户未上滚且未展开时吸底到最新内容（展开态内容全量可见，无需吸底） */
function onContentMutated(): void {
  const el = scrollEl.value
  if (el && !expanded.value && atBottom.value) el.scrollTop = el.scrollHeight
  measure()
}

function toggleExpanded(): void {
  expanded.value = !expanded.value
  // 切换后视口高度/溢出状态变化，下一帧重测（展开→信息条保留、收起→信息条按溢出判定回归）
  void nextTick(measure)
}

onMounted(() => {
  const el = scrollEl.value
  if (el && typeof MutationObserver !== 'undefined') {
    contentObserver = new MutationObserver(onContentMutated)
    contentObserver.observe(el, { childList: true, characterData: true, subtree: true })
  }
  measure()
})

onBeforeUnmount(() => {
  contentObserver?.disconnect()
  contentObserver = null
})
</script>
