<template>
  <!--
    HtmlPreviewPane —— DetailPane 的 HTML 渲染态内容区（chat-html-support §6.4 D4）。

    三态互斥：pending（servable 预检在途，中性加载）/ unavailable（占位带原因 + 重试）/
    ready（sandbox iframe 挂载）。占位态只显「重试」——「刷新」按钮归父组件（仅 iframe
    已挂载态出现），两者是同一挂载函数的重入（§6.4 子决策④「按钮语义归一」）。

    iframe 只给 allow-scripts：不给 allow-same-origin（文档落 opaque origin，读不到主窗口
    DOM/localStorage/cookie），不给 allow-top-navigation / allow-popups / allow-forms。
    失败检测的诚实边界：父页面读不到 iframe 文档状态码，占位由「挂载前预检 + 刷新重检」
    两层主动检查触发（不承诺区分 403/404 的精确错误 UI）。
  -->
  <div class="flex min-h-0 flex-1 flex-col" data-testid="detail-html-preview">
    <!-- 预检 pending：中性加载态（不设墙钟超时——与超时默认原则一致） -->
    <div
      v-if="status === 'pending'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4"
      data-testid="detail-html-pending"
    >
      <Loader2 class="size-4 animate-spin text-neutral-dim opacity-60" />
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-60">{{ t('panel.detail.loading') }}</p>
    </div>
    <!-- 不可服务占位：带原因 + 恢复指引 + 重试（不静默空白） -->
    <div
      v-else-if="status === 'unavailable'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-html-unavailable"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.detail.cannotPreview') }}</p>
      <p
        v-if="reasonText"
        class="text-[length:var(--text-3xs)] text-neutral-mid"
        data-testid="detail-html-unavailable-reason"
      >{{ reasonText }}</p>
      <p class="text-[length:var(--text-3xs)] text-neutral-dim opacity-70">{{ t('panel.detail.htmlPreviewHint') }}</p>
      <Button
        variant="ghost"
        size="sm"
        data-testid="detail-html-retry"
        class="h-6 rounded-sm px-2 text-[length:var(--text-2xs)]"
        @click="emit('reload')"
      >{{ t('common.retry') }}</Button>
    </div>
    <!-- 渲染态：sandbox iframe 经 local-file:// 加载（路径已百分号编码，?r=n 仅触发重导航） -->
    <iframe
      v-else-if="src"
      data-testid="detail-html-frame"
      class="h-full w-full flex-1 border-0 bg-white"
      sandbox="allow-scripts"
      :src="src"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  /** 挂载状态（html-preview 状态机）：idle / pending / ready / unavailable */
  status: 'idle' | 'pending' | 'ready' | 'unavailable'
  /** 不可预览原因 i18n key（无原因时 null） */
  reasonKey: string | null
  /** iframe src（未挂载为 null） */
  src: string | null
}>()

const emit = defineEmits<{ reload: [] }>()

const { t } = useI18n()

/** 不可预览原因文案（i18n key → 当前 locale；无原因时空串，模板 v-if 隐藏） */
const reasonText = computed(() => (props.reasonKey ? t(props.reasonKey) : ''))
</script>
