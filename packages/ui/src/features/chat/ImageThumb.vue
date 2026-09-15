<template>
  <!--
    展示组件 · user 气泡内 image segment 的缩略图（W2-image-history-render P2-a）。
    - 正常态：img 直载 local-file:// 协议（main.ts protocol.handle 注册），120x80 object-cover 缩略。
    - 降级态（path 空 / 加载失败 403 白名单 / 文件损坏）：绿色 badge（与 file badge 同色系），
      ImageIcon + basename，保持 user 气泡内 badge 视觉一致。
    独立子组件：Turn.vue template 已近 400 行上限，不可内联（AGENTS.md 行数约束）。
  -->
  <span class="image-chip-badge inline-flex items-center">
    <img
      v-if="!failed && path"
      :src="thumbSrc"
      :alt="displayName"
      class="image-thumb mr-1 max-w-[120px] max-h-[80px] rounded-md border border-[var(--border-neutral-dim)] object-cover align-middle"
      @error="onError"
    />
    <!-- 降级 badge：复用 file badge 的绿色 token + 间距/字号（Turn.vue:82-96），视觉同族。
         inline svg 改用 @lucide/vue ImageIcon（与 DetailPane 降级占位同图标，前端规范 #2 禁 emoji）。 -->
    <span
      v-else
      class="image-fallback-badge mr-1 inline-flex items-center gap-1 rounded-sm bg-[var(--success-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-success"
      style="vertical-align: middle"
    >
      <ImageIcon class="size-[12px] shrink-0" />
      <span class="chip-label">{{ displayName }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Image as ImageIcon } from '@lucide/vue'

/**
 * image segment 缩略图 props。
 * - path：图片 tmpdir 绝对路径（local-file:// 协议加载用）。
 * - displayName：用户可读名（降级 badge 展示用 + img 的 alt；与 Segment image.displayName 对齐）。
 */
const props = defineProps<{
  path: string
  displayName: string
}>()

/** 图片加载失败标志（onerror 置 true 走降级 badge）。path 变化时重置。 */
const failed = ref(false)

/**
 * 图片 URL：local-file:// 协议 + encodeURIComponent 编码路径（处理中文/空格）。
 * main.ts 的 protocol.handle('local-file') 拦截并 decodeURIComponent 还原。
 */
const thumbSrc = computed(() => 'local-file:///' + encodeURIComponent(props.path))

/** img onerror：白名单 403 / 文件损坏 → 标记失败降级 badge */
function onError(): void {
  failed.value = true
}
</script>
