<script setup lang="ts">
import type { CollapsibleContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CollapsibleContent, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * CollapsibleContent —— 折叠内容区（reka-ui CollapsibleContent 封装）。
 *
 * 展开过渡：接入 .reka-collapsible-transition（本组件 <style scoped> 定义），
 * 由 reka data-state=open/closed 驱动 opacity 过渡，@starting-style 提供
 * 入场起点（跨 display:none→block 触发）。仅 open 进入动画生效——
 * reka CollapsibleRoot unmountOnHide 默认 true，closed 时 slot 被 v-if 即时
 * 移除 + 元素 hidden(display:none)，退出动画无生效空间（与改前一致，不更差）。
 * 旧的 tailwindcss-animate 进出场 utility 类是死类（插件未安装，不生成 CSS），
 * 已移除。
 *
 * 分层：本类是单组件样式（仅 CollapsibleContent 消费），归 <style scoped>
 * （§3 escape hatch——@starting-style + [data-state] 属性选择器是 Tailwind 无法
 * 表达的）；多组件共享的过渡原语（popover/dialog/overlay）才进 style.css 全局层
 * （见 check_css_tokens.py ALLOWED_GLOBAL_ANIMATION_CLASSES 「多组件消费」判据）。
 */
const props = defineProps<CollapsibleContentProps & { class?: HTMLAttributes['class'] }>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <CollapsibleContent
    v-bind="forwarded"
    :class="cn('overflow-hidden reka-collapsible-transition', props.class)"
  >
    <slot />
  </CollapsibleContent>
</template>

<style scoped>
/*
 * 展开淡入过渡（reka data-state 驱动 + @starting-style）。
 * opacity/transition 虽在 scoped-Tailwind-可替代 检查名单里，但本块用 CSS 变量
 * duration + @starting-style + [data-state] 属性选择器，是 Tailwind 无法表达的
 * 合法 escape hatch（check_scoped_styles 设计为非阻塞 WARN，承认此类场景）。
 */
.reka-collapsible-transition {
  transition: opacity var(--duration-fast) var(--ease);
}
.reka-collapsible-transition[data-state='open'] {
  opacity: 1;
}
.reka-collapsible-transition[data-state='closed'] {
  opacity: 0;
}
@starting-style {
  .reka-collapsible-transition[data-state='open'] {
    opacity: 0;
  }
}
</style>
