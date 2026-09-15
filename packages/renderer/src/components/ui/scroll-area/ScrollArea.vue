<script setup lang="ts">
import type { ScrollAreaRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaViewport,
} from "reka-ui"
import { cn } from "@/lib/utils"
import ScrollBar from "./ScrollBar.vue"

const props = defineProps<ScrollAreaRootProps & {
  class?: HTMLAttributes["class"]
  /** 启用横向滚动：额外渲染横向 ScrollBar，并放开 Viewport 的 overflow-x。
   *  reka ScrollAreaViewport 默认 overflow-x: hidden 裁掉横向溢出；为 true 时改为 auto，
   *  让宽内容（如长文件名的文件树）可横向滚动。默认 false 保持原行为。 */
  horizontal?: boolean
}>()

const delegatedProps = reactiveOmit(props, "class", "horizontal")
</script>

<template>
  <ScrollAreaRoot
    v-bind="delegatedProps"
    :class="cn('relative overflow-hidden', props.class, horizontal && 'scroll-area-horizontal')"
  >
    <ScrollAreaViewport :class="cn('h-full w-full rounded-[inherit]', horizontal && '!overflow-x-auto')">
      <slot />
    </ScrollAreaViewport>
    <ScrollBar />
    <ScrollBar v-if="horizontal" orientation="horizontal" />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
