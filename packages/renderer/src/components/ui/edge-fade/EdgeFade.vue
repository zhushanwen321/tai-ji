<script setup lang="ts">
// EdgeFade —— 滚动容器顶缘「渐焦」提示（demo chat spec 裁决 4B，OpenDesign edge-fade 同构）。
// 自包含：作为任意 overflow 滚动容器的第一个子元素挂载（sticky 钉在滚动视口顶，不随内容滚走）；
// 自行监听滚动父级的 scroll（程序赋值 scrollTop 同样触发 scroll 事件）切换显隐，
// 并直接驱动父级容器的顶部 mask（内容在渐焦带下淡出顶缘）——消费方零配置。
// 渐焦 = 失焦 + 沉色双通道：四层渐高 blur 之上叠一层底色渐变（--edge-fade-sink，默认
// --surface，峰值浓度 75%：光晕基本压平且保留失焦感），暗色压住亮字模糊的泛白光晕、
// 亮色沉入纸白；底色非 --surface 的消费方在滚动容器上覆写 --edge-fade-sink。层遮罩与
// 容器 mask 用多 stop 近似 smoothstep 的平滑剖面（线性渐变人眼感知中段偏快，多 stop
// 消台阶感）。
// z-[3] 为容器内局部层级刻意值，不取 style.css z 档（对照 z 表：--z-sticky 1 / --z-popover 10）：
// 须高于滚动容器内 sticky 内容（SessionList 组标题走 --z-sticky 档，同 z 值时按 DOM 序会盖住
// 渐焦带、滚入带内逃逸失焦+沉色），又须低于容器内交互控件（MessageStream 回到底部按钮、
// DetailPane 选区 bubble 走 --z-popover 同值 10 档）——装饰渐焦带夹两档之间。
// [贴顶前提] 消费方滚动容器禁设顶部 padding——sticky 带的正常流位置会被压到 padding 之下，
// 滚过 padding 前带悬浮于视口中部（顶缘露出未处理区）；顶部留白放滚动内容内（spacer）。
// 降级：prefers-reduced-motion 关过渡（motion-reduce 变体）；prefers-reduced-transparency
// 关整个渐焦效果（遮罩层隐藏 + 容器 mask 摘除）。
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'

const on = ref(false)
const reducedTransparency = ref(false)
const root = ref<HTMLElement | null>(null)
/** 显式指定滚动宿主：ScrollArea 封装类消费方传入（其挂载点与真滚动元素之间有内部
 *  wrapper，scroll 不冒泡、mask 须作用于滚动盒，parentElement 解析不成立）；缺省回退
 *  parentElement（原生滚动容器直接子元素的经典接线，行为不变）。prop 到位晚于挂载时
 *  经 watch 补绑。 */
const props = defineProps<{ scrollerEl?: HTMLElement | null }>()

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
/** 容器 mask 多 stop 剖面的比例点（近似 smoothstep：40px 带上 13px/26px 两档过渡）。 */
const MASK_STOP_SOFT = 0.325
const MASK_STOP_FIRM = 0.65

function sync(): void {
  if (!scroller) return
  const active = scroller.scrollTop > SCROLL_TOP_THRESHOLD && !reducedTransparency.value
  on.value = active
  const next = active
    ? `linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.4) ${Math.round(FADE_BAND_HEIGHT * MASK_STOP_SOFT)}px, rgba(0,0,0,0.8) ${Math.round(FADE_BAND_HEIGHT * MASK_STOP_FIRM)}px, #000 ${FADE_BAND_HEIGHT}px)`
    : ''
  if (scroller.style.maskImage !== next) scroller.style.maskImage = next
}

function onTransparencyChange(): void {
  reducedTransparency.value = transparencyMedia?.matches ?? false
  sync()
}

function unbind(): void {
  if (!scroller) return
  scroller.removeEventListener('scroll', sync)
  scroller.style.maskImage = ''
  scroller = null
}

function bind(el: HTMLElement | null): void {
  if (scroller === el) return
  unbind()
  scroller = el
  scroller?.addEventListener('scroll', sync, { passive: true })
  onTransparencyChange()
}

onMounted(() => {
  // matchMedia 缺失环境（happy-dom 等测试宿主）跳过 transparency 监听：reducedTransparency
  // 保持 false = 渐焦全功能生效（检查降级而非崩溃，onTransparencyChange 已容 null media）
  if (typeof window.matchMedia === 'function') {
    transparencyMedia = window.matchMedia('(prefers-reduced-transparency: reduce)')
    transparencyMedia.addEventListener('change', onTransparencyChange)
  }
  bind(props.scrollerEl ?? root.value?.parentElement ?? null)
})

// scrollerEl 到位晚于挂载（父组件 onMounted 才能拿到 ScrollArea viewport 引用）时补绑
watch(
  () => props.scrollerEl,
  (el) => bind(el ?? root.value?.parentElement ?? null),
)

onBeforeUnmount(() => {
  transparencyMedia?.removeEventListener('change', onTransparencyChange)
  unbind()
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
      class="absolute inset-x-0 top-0 block [mask-image:linear-gradient(to_bottom,#000_12%,rgba(0,0,0,0.78)_34%,rgba(0,0,0,0.42)_62%,transparent_88%)] transition-opacity duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none"
      :class="[l.blur, on ? 'opacity-100' : 'opacity-0']"
    />
    <i
      aria-hidden="true"
      class="absolute inset-x-0 top-0 block h-full bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--edge-fade-sink,var(--surface))_75%,transparent),transparent)] transition-opacity duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none"
      :class="on ? 'opacity-100' : 'opacity-0'"
    />
  </div>
</template>
