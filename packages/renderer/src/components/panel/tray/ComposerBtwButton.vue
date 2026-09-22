<!--
  ComposerBtwButton —— composer 左簇 btw 旁路提问入口 + badge（btw-question D7，M3-b）。

  下沉 tray/ 子单元的原因：规避 Composer.vue 300 行 script 硬门禁（D7 明示）。

  契约：
  - props.sessionId: string —— 焦点主会话 id（Composer 只在 showBtw && sessionId 时挂载本组件，
    badge 数据面 = 该主会话名下线，D7 焦点绑定②③④）
  - 点击 = openDrawerTab('btw')（D7 唯一入口；drawer 开合与 tab 状态归 core drawer 域）
  - badge 两态（§1.4 裁决，挂点 = composer 按钮聚合）：双零 → 不渲染（常态归零）；
    unread >0 → Σ 计数角标（右上角，accent 实底；清除 = 线内容进视口）；pending >0 →
    Σ 待处理徽点（右下角独立徽点，D8 终态机驱动 = 挂起请求 ∪ 回收提醒线数；M4-a 挂账
    「badge 待处理视觉消费面」的销账落点）。数据通道 = useBtwTabData，聚合 = 当前主会话
    名下线 Σ。
  - 退化序登记 = 序 0（不退化，与 `+`/发送位同档）：见 use-composer-bar-density 的
    COMPOSER_BTW_BUTTON_DEGRADATION_ORDER——badge 是后台回复/待处理唯一通知载体，任何宽度常驻。
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
    <!-- 待处理徽点（badge 两态并列呈现：右下角独立徽点，与右上计数角标分角共存；
         形态 = DESIGN §5.13 Status Dot 6-8px 圆点，色相走灰阶 neutral-mid token
         （彩色降噪，与 accent 计数角标可区分）；数据 = totalPending 待处理线数 Σ） -->
    <span
      v-if="totalPending > 0"
      data-testid="composer-btw-pending"
      class="pointer-events-none absolute -bottom-1 -right-1 size-2 rounded-full bg-neutral-mid"
    />
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
const { totalUnread, totalPending } = useBtwTabData(sidRef)

/** 常态 title = 入口语义；有未读/待处理时换成计数提示（PanelContainer unread badge
 *  同款做法）。待处理优先（等用户动作 > 信息通知）——两态视觉并列由计数角标 + 徽点
 *  各自承载，title 只取一态 */
const title = computed(() => {
  if (totalPending.value > 0) return t('btw.button.pendingTitle', { count: totalPending.value })
  if (totalUnread.value > 0) return t('btw.button.unreadTitle', { count: totalUnread.value })
  return t('btw.button.title')
})

/** D7 唯一入口：打开 drawer 并切到 btw tab（面板/线列表呈现归 BtwPanel） */
function openBtw(): void {
  openDrawerTab('btw')
}
</script>
