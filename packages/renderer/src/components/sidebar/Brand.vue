<script setup lang="ts">
/**
 * 品牌区：太极双鱼 logo（旋转，currentColor 适配主题）+ 产品名 + 版本号。
 * v6-master-spec §6.2 Brand 区。
 *
 * - logo 资产从 v6 demo 复制（TaijiLogo.vue，SVG 矢量，禁止手改 path d）。
 * - 产品名走 i18n（app.title）：中文「太极」/ 英文「TaiJi」，与 v6 demo 对齐。
 * - dev 模式渲染 DEV 徽标（isDevMode()，info 色徽章范式）：dev 实例与打包版并存时
 *   GUI 内左上角一眼可辨；文案 DEV 不走 i18n（开发术语，各语言统一）。
 * - 版本号用真实 __APP_VERSION__ + piVersion（比 demo 硬编码更合理），由 Sidebar 经 props 传入。
 * - UpdateButton 由 Sidebar 通过 #trailing slot 注入（保留项目独立组件实现，
 *   审查报告 2-① 关联 #5 确认项目实现比 demo 内联更合理）。
 */
import { useI18n } from 'vue-i18n'
import { isDevMode } from '@taiji/core'
import TaijiLogo from '@/components/icons/TaijiLogo.vue'

const { t } = useI18n()

interface Props {
  /** 版本号文案（如 v0.8.40 · pi v0.82.1） */
  versionLabel?: string
}
withDefaults(defineProps<Props>(), {
  versionLabel: '',
})
</script>

<template>
  <div class="flex items-center gap-2 px-2 pb-3.5">
    <TaijiLogo :size="28" :duration="8" class="shrink-0 text-neutral-fg" />
    <div class="flex min-w-0 flex-col leading-[1.1]">
      <!-- 产品名 + DEV 徽标内层行：产品名 min-w-0 让 truncate 在窄侧栏生效（flex item
           默认 min-width:auto 会撑住不截断），徽标 shrink-0 保证不被挤掉 -->
      <div class="flex items-center gap-1.5">
        <span class="min-w-0 truncate text-[length:var(--text-sm)] font-semibold text-neutral-fg">{{ t('app.title') }}</span>
        <span v-if="isDevMode()" data-testid="brand-dev-badge"
          class="shrink-0 rounded-sm bg-info-soft px-1.5 py-0.5 text-[length:var(--text-3xs)] font-semibold text-info">DEV</span>
      </div>
      <span v-if="versionLabel" class="text-[length:var(--text-3xs)] text-neutral-mid">{{ versionLabel }}</span>
    </div>
    <!-- trailing slot：Sidebar 注入 UpdateButton（ml-auto 推到右侧） -->
    <slot name="trailing" />
  </div>
</template>
