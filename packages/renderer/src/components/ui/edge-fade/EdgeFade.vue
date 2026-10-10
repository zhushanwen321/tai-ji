<script setup lang="ts">
// EdgeFade —— 滚动容器顶缘「渐焦」提示（demo chat spec 裁决 4B，OpenDesign edge-fade 同构）。
// 自包含：作为任意 overflow 滚动容器的第一个子元素挂载（sticky 钉在滚动视口顶，不随内容滚走）；
// 自行监听滚动父级的 scroll（程序赋值 scrollTop 同样触发 scroll 事件）切换显隐，
// 并直接驱动父级容器的顶部 mask（内容在渐焦带下淡出顶缘）——消费方零配置。
// 降级：prefers-reduced-motion 关过渡（motion-reduce 变体）；prefers-reduced-transparency
// 关整个渐焦效果（遮罩层隐藏 + 容器 mask 摘除）。
import { ref, onMounted, onBeforeUnmount } from 'vue'

const on = ref(false)
const reducedTransparency = ref(false)
const root = ref<HTMLElement | null>(null)
let scroller: HTMLElement | null = null
let transparencyMedia: MediaQueryList | null = null

const LAYERS = [
  { blur: 'h-full backdrop-blur-[1px]' },
  { blur: 'h-3/4 backdrop-blur-[2px]' },
  { blur: 'h-1/2 backdrop-blur-[4px]' },
  { blur: 'h-1/4 backdrop-blur-[8px]' },
] as const

/** 离顶判定阈值（px）：滚动不足此值视为贴顶，不启用渐焦（demo 同值）。 */
const SCROLL_TOP_THRESHOLD = 4
/** 顶缘渐焦带高度（px），同时是容器 mask 的过渡段长度（demo 同值）。 */
const FADE_BAND_HEIGHT = 40

function sync(): void {
  if (!scroller) return
  const active = scroller.scrollTop > SCROLL_TOP_THRESHOLD && !reducedTransparency.value
  on.value = active
  const next = active
    ? `linear-gradient(to bottom, transparent 0, #000 ${FADE_BAND_HEIGHT}px)`
    : ''
  if (scroller.style.maskImage !== next) scroller.style.maskImage = next
}

function onTransparencyChange(): void {
  reducedTransparency.value = transparencyMedia?.matches ?? false
  sync()
}

onMounted(() => {
  scroller = root.value?.parentElement ?? null
  transparencyMedia = window.matchMedia('(prefers-reduced-transparency: reduce)')
  transparencyMedia.addEventListener('change', onTransparencyChange)
  onTransparencyChange()
  scroller?.addEventListener('scroll', sync, { passive: true })
})

onBeforeUnmount(() => {
  transparencyMedia?.removeEventListener('change', onTransparencyChange)
  scroller?.removeEventListener('scroll', sync)
  if (scroller) scroller.style.maskImage = ''
})
</script>

<template>
  <div
    ref="root"
    data-testid="edge-fade"
    aria-hidden="true"
    class="pointer-events-none sticky top-0 z-[3] -mb-[40px] h-[40px] max-w-none"
    :class="reducedTransparency ? 'hidden' : ''"
  >
    <i
      v-for="(l, i) in LAYERS"
      :key="i"
      class="absolute inset-x-0 top-0 block [mask-image:linear-gradient(to_bottom,#000_20%,transparent)] transition-opacity duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none"
      :class="[l.blur, on ? 'opacity-100' : 'opacity-0']"
    />
  </div>
</template>
