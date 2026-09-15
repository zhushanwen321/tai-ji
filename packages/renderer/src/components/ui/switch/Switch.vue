<script setup lang="ts">
import type { SwitchRootEmits, SwitchRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SwitchRoot, SwitchThumb, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * Switch —— 双态滑动开关原语（reka-ui SwitchRoot 封装）。
 * 替代各 settings 页面手搓的 <div role="switch"> 与原生 <input type=checkbox> toggle。
 * 样式与 Input/SelectTrigger 对齐：冷蓝暗色、border-border、聚焦环 accent-ring。
 * 尺寸：track 36×20 / thumb 16×16，全部绝对 px（v6 spec §6.4）。
 * [HISTORICAL] 切勿改回 rem 类（h-5/w-9/size-4）：项目 html font-size=13.3px（非 16），
 * rem 类会缩放变小但 translate-x-[18px] 是绝对 px 不缩放，二者失配导致 checked thumb
 * 右沿超出 track。几何与位移统一绝对 px 即免疫 rem 缩放。
 * [HISTORICAL] 消费方同理：禁止用 h-* / w-* / size-* 覆盖轨道尺寸（track 缩了、thumb 16px
 * 与 translate 18px 不跟着缩，圆点溢出轨道；曾发生于 trace toolbar
 * `class="h-3.5 w-6 scale-90"`）。要小尺寸只能等比 scale-*（等比缩放连几何一起缩）。
 * 机器护栏：taste/no-switch-size-override（taste-lint）。
 */
const props = withDefaults(
  defineProps<SwitchRootProps & { class?: HTMLAttributes['class'] }>(),
  {},
)
const emits = defineEmits<SwitchRootEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SwitchRoot
    v-bind="forwarded"
    :class="
      cn(
        'peer inline-flex h-[20px] w-[36px] shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none focus-visible:shadow-[0_0_0_2px_var(--accent),0_0_0_4px_rgb(0_0_0_/_0.4)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-border-strong',
        props.class,
      )
    "
  >
    <SwitchThumb
      class="pointer-events-none block size-[16px] rounded-full bg-white shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[2px]"
    />
  </SwitchRoot>
</template>
