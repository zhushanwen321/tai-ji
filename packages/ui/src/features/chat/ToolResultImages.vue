<template>
  <!--
    展示组件 · toolResult 图片渲染（crash-resilience §3.3 D6-⑨ / u7-memory-governance）。
    - 数据源：toolCall.images（pi toolResult content 的 ImageContent 块，base64）。
      渲染引用 = main 落盘后的路径（local-file:// 协议，与 ImageThumb 同协议形态）——
      base64 不直接进 img src（内存中转 + 落盘引用化是 D6-⑨ 的核心语义）。
    - 路径解析三态（core image-cache 编排层记账）：
      ready       内容 hash 记账 Map（imageKey）已有落盘路径（hydrate 批量编排 / 本组件此前写入）
      placeholder 该 session 图片缓存帽满（64MB）——设计措辞占位，不阻断消息流
      fallback    无 electronAPI（mock/headless）或写入失败/加载失败——降级 badge（与
                  ImageThumb 降级形态同族）
    - live 单图写入由本组件触发（设计「live 期新到图片在剩余额度内即写」）；hydrate
      批量（新→旧有序、超帽即停）在 core persistImagesNewestFirst（useChat.hydrateHistory
      挂点），两路共用 in-flight 去重与内容 hash 记账。
    独立子组件：Block.vue template 行数余量不足，不可内联（对齐 ImageThumb 先例）。
  -->
  <span class="tool-result-images mr-2 inline-flex flex-wrap items-center gap-1.5 align-middle">
    <template v-for="(item, i) in items" :key="i">
      <img
        v-if="item.state === 'ready' && item.path"
        :src="thumbSrc(item.path)"
        :alt="`tool-result-${i + 1}`"
        data-testid="tool-image"
        class="tool-image max-h-[120px] max-w-[200px] rounded-md border border-[var(--border-neutral-dim)] object-cover"
        @error="onImgError(i)"
      />
      <span
        v-else-if="item.state === 'placeholder'"
        data-testid="tool-image-placeholder"
        :title="t('panel.message.imagePlaceholderDetail')"
        class="inline-flex items-center gap-1 rounded-sm bg-[var(--warn-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-warn"
      >
        <ImageIcon class="size-[12px] shrink-0" />
        <span class="chip-label">{{ t('panel.message.imagePlaceholder') }}</span>
      </span>
      <span
        v-else-if="item.state === 'fallback'"
        data-testid="tool-image-fallback"
        class="inline-flex items-center gap-1 rounded-sm bg-[var(--success-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-success"
      >
        <ImageIcon class="size-[12px] shrink-0" />
        <span class="chip-label">{{ t('panel.message.imageUnavailable') }}</span>
      </span>
    </template>
  </span>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Image as ImageIcon } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import {
  getCachedImagePath,
  isSessionImageCacheFull,
  requestImageWrite,
} from '@taiji/core/domain/chat'
import type { ImageCacheWriteImage } from '@taiji/shared'

const props = defineProps<{
  /** 所属 session（落盘目录分区键；缺省时无法落盘 → fallback） */
  sessionId?: string | null
  images: ImageCacheWriteImage[]
}>()

const { t } = useI18n()

/** 单图渲染态（pending 时不出元素——IPC 往返窗口极短，避免闪烁占位）。 */
type ImageItemState = 'pending' | 'ready' | 'placeholder' | 'fallback'
interface ImageItem {
  state: ImageItemState
  path?: string
}
/** 渲染态列表（整体替换 + 元素原地终态写——ref 深响应驱动重渲染）。 */
const items = ref<ImageItem[]>([])

/** 与 ImageThumb 同协议：local-file:// + encodeURIComponent 路径（main protocol.handle 白名单含 cache/images）。 */
function thumbSrc(path: string): string {
  return 'local-file:///' + encodeURIComponent(path)
}

/** img 加载失败（文件被清理/损坏）→ 降级 badge（磁盘层幂等重建靠下次 hydrate 编排）。 */
function onImgError(i: number): void {
  const item = items.value[i]
  if (item) item.state = 'fallback'
}

/** 单图解析：记账命中 → ready；帽满 → placeholder；否则发起 live 单图写。 */
async function resolveItem(sid: string, image: ImageCacheWriteImage, item: ImageItem): Promise<void> {
  const cached = getCachedImagePath(image)
  if (cached !== undefined) {
    item.state = 'ready'
    item.path = cached
    return
  }
  if (isSessionImageCacheFull(sid)) {
    item.state = 'placeholder'
    return
  }
  const path = await requestImageWrite(sid, image)
  if (path !== undefined) {
    item.state = 'ready'
    item.path = path
    return
  }
  // 写入未产出路径：帽满（本图命中帽）→ 占位；无 port / 失败 → 降级
  item.state = isSessionImageCacheFull(sid) ? 'placeholder' : 'fallback'
}

function syncItems(): void {
  const sid = props.sessionId
  items.value = props.images.map(() => ({ state: 'pending' as const, path: undefined }))
  for (let i = 0; i < props.images.length; i++) {
    // 必须从 items.value 读**响应式代理**传给 resolveItem——初始化载体的原始对象引用
    // 不在代理链上，直接写它的 state 不会触发重渲染（reactive 深代理仅经读路径建立）
    const item = items.value[i]!
    const image = props.images[i]!
    if (!sid || !image.data) {
      item.state = 'fallback'
      continue
    }
    void resolveItem(sid, image, item)
  }
}

watch(() => [props.sessionId, props.images], syncItems, { immediate: true, deep: false })
</script>
