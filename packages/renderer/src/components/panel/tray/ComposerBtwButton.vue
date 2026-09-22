<!--
  ComposerBtwButton —— composer 左簇 btw 旁路提问入口 + badge（btw-question D7，M3-b）。

  下沉 tray/ 子单元的原因：规避 Composer.vue 300 行 script 硬门禁（D7 明示）。

  契约：
  - props.sessionId: string —— 焦点主会话 id（Composer 只在 showBtw && sessionId 时挂载本组件，
    badge 数据面 = 该主会话名下线，D7 焦点绑定②③④）
  - 点击 = openDrawerTab('btw')（D7 唯一入口；drawer 开合与 tab 状态归 core drawer 域）
  - badge 两态基础（§1.4 裁决）：0 → 不渲染（常态归零）；>0 → Σ unread 计数角标
    （数据通道 = useBtwTabData，聚合 = 当前主会话名下线 Σ，清除 = 线内容进视口）。
    「待处理」态扩展归 M3-c（同文件共改，本组件只留 badge 挂点）。
  - 退化序登记 = 序 0（不退化，与 `+`/发送位同档）：见 use-composer-bar-density 的
    COMPOSER_BTW_BUTTON_DEGRADATION_ORDER——badge 是后台回复唯一通知载体，任何宽度常驻。
-->
<template>
  <Button
    variant="ghost"
    size="icon"
    class="relative size-[28px] shrink-0 rounded-sm text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-mid"
    data-testid="composer-btw-button"
    :title="title"
    @click="openBtw"
  >
    <MessagesSquare class="size-4" />
    <!-- 计数角标（Badge 范式 = 计数角标，DESIGN §5.13；accent 实底 + accent-fg 字，
         PanelContainer unread badge 同款语义色对） -->
    <span
      v-if="totalUnread > 0"
      data-testid="composer-btw-badge"
      class="pointer-events-none absolute -right-1 -top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-0.5 font-mono text-[length:var(--text-3xs)] text-accent-fg"
    >{{ totalUnread > 9 ? '9+' : totalUnread }}</span>
  </Button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare } from '@lucide/vue'
import { openDrawerTab } from '@taiji/core/domain/drawer'
import { Button } from '@/components/ui/button'
import { useBtwTabData } from '@/composables/panel/useBtwTabData'

const props = defineProps<{
  /** 焦点主会话 id（由 Composer 透传；无 session 时 Composer 不挂载本组件） */
  sessionId: string
}>()

const { t } = useI18n()
const sidRef = computed(() => props.sessionId)
const { totalUnread } = useBtwTabData(sidRef)

/** 常态 title = 入口语义；有未读时换成计数提示（PanelContainer unread badge 同款做法） */
const title = computed(() =>
  totalUnread.value > 0
    ? t('btw.button.unreadTitle', { count: totalUnread.value })
    : t('btw.button.title'),
)

/** D7 唯一入口：打开 drawer 并切到 btw tab（面板/线列表呈现归 BtwPanel） */
function openBtw(): void {
  openDrawerTab('btw')
}
</script>
