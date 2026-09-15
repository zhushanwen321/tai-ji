<!--
  MermaidRenderer —— mermaid 图表渲染（对话流 markdown 内嵌）。

  两个展示态：
   1. 气泡内：静态 SVG（max-width 适配），点击图打开全屏 Dialog
   2. 全屏 Dialog：SVG + zoom-in/out/fit/1:1 控制（useMermaidZoom），复用 DialogContent 全屏遮罩

  生命周期：
   - 挂载/主题变化 → renderMermaid(source, theme) 产出 svg → 注入气泡容器
   - 渲染失败 → 显示「渲染失败」提示 + 折叠源码（可复制）
   - 流式增量下 source 变化用 renderSeq 守卫防旧渲染覆盖

  v-html 受控点：renderMermaid 产出的 SVG 由 mermaid 库生成（非用户原始 HTML）。
  mermaid 源码经 mermaid 解析生成 SVG path，不透传用户 HTML（与 shiki codeToHtml 同论证）。
  仅此受控点局部放开 taste-lint vue/no-v-html。
-->
<template>
  <div class="md-mermaid-wrap">
    <!-- 渲染中占位（mermaid 首次加载 ~3MB，极短） -->
    <div v-if="status === 'loading' && !svg" class="md-mermaid__placeholder">{{ t('panel.mermaid.rendering') }}</div>
    <!-- 渲染失败：提示 + 折叠源码（用 div toggle 替代原生 <details>，遵循禁原生交互元素规范） -->
    <!-- 仅在无上次成功 SVG 时单独显示错误占位；有上次 SVG 则下方渲染区仍展示旧图（流式增量不全屏消失） -->
    <div v-else-if="status === 'error' && !svg" class="md-mermaid__error">
      <div class="flex items-center gap-1.5 text-[length:var(--text-sm)] text-danger">
        <AlertTriangle class="size-3.5" />
        <span>{{ t('panel.mermaid.renderFailed') }}</span>
      </div>
      <Button variant="ghost" size="sm" class="mt-0.5 h-6 px-1 text-[length:var(--text-xs)] text-neutral-dim hover:text-neutral-mid" @click="showSource = !showSource">
        <ChevronRight class="size-3 transition-transform" :class="showSource ? 'rotate-90' : ''" />
        <span>{{ t('panel.mermaid.viewSource') }}</span>
      </Button>
      <div v-if="showSource" class="mt-1 flex items-start gap-1.5">
        <pre class="max-h-[200px] flex-1 overflow-auto rounded bg-surface-2 p-2 font-mono text-[length:var(--text-xs)] leading-relaxed text-neutral-mid">{{ source }}</pre>
        <Button variant="ghost" size="icon" class="size-6 shrink-0 text-neutral-dim hover:text-neutral-fg" :title="t('panel.mermaid.copySource')" @click="copySource">
          <Check v-if="copied" class="size-3 text-success" />
          <Copy v-else class="size-3" />
        </Button>
      </div>
    </div>
    <!-- 渲染成功 / 失败但保留上次 SVG：气泡内静态 SVG（点击放大） -->
    <!-- eslint-disable-next-line vue/no-v-html -- renderMermaid 产出的 SVG 由 mermaid 库生成（非用户 HTML），与 shiki codeToHtml 同论证 XSS 安全。受控注入点。 -->
    <div v-if="svg" v-html="svg" class="md-mermaid__inline cursor-pointer transition-opacity hover:opacity-90" :title="t('panel.mermaid.clickToZoom')" @click="openFullscreen" />

    <!-- 全屏 Dialog：SVG + zoom 控制 -->
    <Dialog v-model:open="fullscreenOpen">
      <DialogContent hide-close class="flex max-h-[92vh] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:rounded-lg">
        <!-- a11y：reka-ui DialogContent 要求 DialogTitle/Description（屏幕阅读器），视觉隐藏 -->
        <DialogTitle class="sr-only">{{ t('panel.mermaid.fullscreenTitle') }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t('panel.mermaid.fullscreenDesc') }}</DialogDescription>
        <!-- 标题栏：zoom 控件 + 关闭 -->
        <div class="flex items-center justify-between border-b border-border px-3 py-2">
          <div class="flex items-center gap-1">
            <Button variant="ghost" size="icon" class="size-7 text-neutral-mid hover:text-neutral-fg" :title="t('panel.mermaid.zoomIn')" @click="zoomIn">
              <ZoomIn class="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="size-7 text-neutral-mid hover:text-neutral-fg" :title="t('panel.mermaid.zoomOut')" @click="zoomOut">
              <ZoomOut class="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="size-7 text-neutral-mid hover:text-neutral-fg" :title="t('panel.mermaid.fitWindow')" @click="fit">
              <Maximize class="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="size-7 text-neutral-mid hover:text-neutral-fg" :title="t('panel.mermaid.originalSize')" @click="resetOneToOne">
              <Minimize class="size-3.5" />
            </Button>
            <span class="ml-1.5 font-mono text-[length:var(--text-xs)] text-neutral-dim">{{ zoomLabel }}</span>
          </div>
          <DialogClose as-child>
            <Button variant="ghost" size="icon" class="size-7 text-neutral-mid hover:text-neutral-fg" :title="t('panel.mermaid.close')">
              <X class="size-3.5" />
            </Button>
          </DialogClose>
        </div>
        <!-- 视口：overflow auto + 滚轮缩放（Ctrl/Cmd+wheel），普通滚轮滚动 -->
        <div
          ref="viewportEl"
          class="relative flex-1 overflow-auto bg-bg"
          @wheel="onWheel"
        >
          <!-- eslint-disable-next-line vue/no-v-html -- 全屏同 inline：mermaid 产出 SVG，受控注入。 -->
          <div ref="canvasEl" v-html="svg" class="mx-auto inline-block" :style="{ minWidth: '100%' }" />
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * Mermaid 图表渲染器。
 * - props.source 变化（流式增量 / mermaid 块更新）触发重新渲染；renderSeq 守卫防旧覆盖。
 * - 主题变化（<html data-theme>）触发重新渲染（mermaid 颜色 bake 进 SVG，需重渲）。
 * - 全屏 Dialog 内 zoom 用 useMermaidZoom（Ctrl/Cmd+wheel 缩放，按钮 zoom-in/out/fit/1:1）。
 */
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Check, ChevronRight, Copy, Maximize, Minimize, X, ZoomIn, ZoomOut } from '@lucide/vue'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../../primitives/dialog'
import { getCurrentTheme } from './composables/use-theme'
import { useCopy } from './composables/useCopy'
import { useMermaidZoom } from './composables/useMermaidZoom'
import { useChatViewDeps } from './chat-view-deps'

const { t } = useI18n()
const { renderMermaid } = useChatViewDeps()

const props = defineProps<{
  /** mermaid 源码（已从 base64 解码） */
  source: string
}>()

const svg = ref('')
const status = ref<'loading' | 'ok' | 'error'>('loading')
/** 失败态源码折叠（替代原生 <details>，遵循禁原生交互元素规范） */
const showSource = ref(false)
let renderSeq = 0

/** 当前主题（watch <html data-theme> 变化触发重渲） */
let currentTheme: 'dark' | 'light' = getCurrentTheme()
let themeObserver: MutationObserver | null = null

/** 全屏 Dialog */
const fullscreenOpen = ref(false)
const viewportEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLElement | null>(null)
const { zoomLabel, zoomIn, zoomOut, fit, resetOneToOne, syncSvg } = useMermaidZoom(viewportEl, canvasEl)

/** 复制源码（失败态用） */
const { copied, copy } = useCopy()
function copySource(): void {
  copy(props.source, 'mermaid-src')
}

/** 渲染 mermaid（序号守卫防流式增量旧覆盖） */
async function doRender(): Promise<void> {
  const seq = ++renderSeq
  const source = props.source.trim()
  if (!source) {
    status.value = 'error'
    return
  }
  status.value = 'loading'
  try {
    const { svg: rendered } = await renderMermaid(source, currentTheme)
    if (seq === renderSeq) {
      svg.value = rendered
      status.value = 'ok'
      // 若全屏打开，同步新 SVG 尺寸并 fit
      if (fullscreenOpen.value) {
        await nextTick()
        syncSvg()
      }
    }
  } catch {
    if (seq === renderSeq) {
      status.value = 'error'
    }
  }
}

/** 全屏打开：等 DOM 渲染后 syncSvg + fit */
function openFullscreen(): void {
  fullscreenOpen.value = true
  nextTick(() => {
    syncSvg()
    fit()
  })
}

/** 视口滚轮：Ctrl/Cmd+wheel 缩放，否则原生滚动 */
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    if (e.deltaY < 0) zoomIn()
    else zoomOut()
  }
}

/** 全屏打开/关闭时重新 fit（尺寸从 0 变化） */
watch(fullscreenOpen, (open) => {
  if (open) {
    nextTick(() => {
      syncSvg()
      fit()
    })
  }
})

onMounted(() => {
  doRender()
  // 监听 <html data-theme> 变化 → 主题切换重渲（HISTORICAL：应用内主题，非 prefers-color-scheme）
  themeObserver = new MutationObserver(() => {
    const next = getCurrentTheme()
    if (next !== currentTheme) {
      currentTheme = next
      doRender()
    }
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

onUnmounted(() => {
  themeObserver?.disconnect()
})

// source 变化（流式增量）→ 重新渲染
watch(() => props.source, () => doRender())
</script>
