<!--
  BrowserOverlay —— 浮层浏览器内容挂载（display-containers §6.5/§7.4，u-w2-browser-mount）。

  「BrowserPane 挂浮层壳」落点：core overlay 开合态（单一权威）驱动 OverlayShell（统一壳：
  面板 + 遮罩 + 两通道关闭 + Tab 焦点陷阱注册点 + 焦点契约，全由壳承载），BrowserPane
  （嵌入式浏览器面板）挂进壳 body。单例换内容语义（§6.5）：浮层当前内容是 browser 才渲染
  本壳；换出（browser → workflow）/ 关闭 = 整体卸载（BrowserPane onBeforeUnmount →
  browserHide keep-alive，view 不销毁）。

  view 定位浮层视口（§7.4 rect 同步适配）：BrowserPane 的 viewport 元素即壳内布局位置，
  useBrowserRectSync 观测目标随挂载点迁移到浮层视口（抽屉 splitter/纵轴变化与 view rect
  无关，观测链只余 ResizeObserver + window resize）。

  显示收口事实源（§7.4 show 统一谓词）：useBrowserOverlayStateSync 常驻本组件（宿主恒挂），
  浮层开合/内容切换先于 BrowserPane 的 show 请求上报主进程。

  Esc 不在壳内监听（§6.7 栈序编排器唯一属主，stack-order 直接关 core 开合态、kind 无关）；
  页面聚焦态 Esc 归页面自身（view 转发键清单不收 Esc），关浮层键盘兜底 = ⌘W。
-->
<template>
  <OverlayShell
    :open="isBrowserOpen"
    :label="t('panel.browserPane.overlayTitle')"
    :close-label="t('panel.browserPane.overlayClose')"
    @close="closeOverlay"
  >
    <template #title>
      <span class="truncate font-mono text-[length:var(--text-2xs)] text-neutral-mid" data-testid="browser-overlay-title">
        {{ browserContent?.url ?? '' }}
      </span>
    </template>
    <BrowserPane
      v-if="browserContent"
      :key="`${browserContent.sessionId}:${browserContent.url}`"
      :session-id="browserContent.sessionId"
      :url="browserContent.url"
    />
  </OverlayShell>
</template>

<script setup lang="ts">
/**
 * BrowserOverlay 脚本：core overlay SSOT 投影（isBrowserOpen / browserContent）+
 * 显示收口事实源上报（useBrowserOverlayStateSync，常驻）。
 * 关闭四通道（Esc/⌘W 走编排器、点遮罩/按钮走壳 close 事件）统一收敛到 core closeOverlay。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { closeOverlay, useOverlayControl } from '@taiji/core/domain/overlay'
import OverlayShell from '@/components/panel/workflow-viz/overlay/OverlayShell.vue'
import BrowserPane from '@/components/panel/BrowserPane.vue'
import { useBrowserOverlayStateSync } from '@/composables/features/browser/useBrowserOverlayStateSync'
import { useShieldsViewSync } from '@/composables/features/browser/useShieldsViewSync'

const { t } = useI18n()

const { isOpen, current } = useOverlayControl()

/** 浮层当前内容是 browser 才开本壳（单例换内容：workflow 内容归 WorkflowVizOverlay 壳） */
const isBrowserOpen = computed(() => isOpen.value && current.value?.kind === 'browser')
/** browser 载荷投影（url + 发起会话；非 browser 内容 = null → body 不挂 BrowserPane） */
const browserContent = computed(() => {
  const cur = current.value
  return cur !== null && cur.kind === 'browser' ? cur.payload : null
})

// 显示收口事实源上报（常驻：关态/换内容同样上报）
useBrowserOverlayStateSync()

// shieldsView 遮蔽面全量上报（常驻：聚合开合/overlay/resize 触发面收敛后重报，
// §5.1 规则 6② view 遮蔽联动 renderer 半边——触发面与卸载复位语义见 composable 文件头）
useShieldsViewSync()
</script>
